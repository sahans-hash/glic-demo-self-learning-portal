const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 4100;
const DATA_DIR =
  process.env.DATA_DIR || (process.env.VERCEL ? "/tmp" : __dirname);
const DATA_FILE = path.join(DATA_DIR, "data.json");
const HITL_DATA_FILE = path.join(DATA_DIR, "hitl-data.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// --- File-backed stores ---
function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveQueue(queue) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(queue, null, 2));
}

function loadHitlQueue() {
  try {
    return JSON.parse(fs.readFileSync(HITL_DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveHitlQueue(queue) {
  fs.writeFileSync(HITL_DATA_FILE, JSON.stringify(queue, null, 2));
}

let queue = loadQueue();
let hitlQueue = loadHitlQueue();

// --- Settings ---
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {
      workflowEngineBaseUrl: (
        process.env.WORKFLOW_ENGINE_BASE_URL || "http://localhost:8000/api/v1"
      ).replace(/\/+$/, ""),
      workflowApiKey: process.env.WORKFLOW_API_KEY || "",
      dataEngineBaseUrl: (
        process.env.DATA_ENGINE_BASE_URL ||
        "https://dflow-api.services.kayatech.ai/api/v1"
      ).replace(/\/+$/, ""),
      hitlBearerToken: process.env.HITL_BEARER_TOKEN || "",
    };
  }
}
function saveSettings(newSettings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
}
let settings = loadSettings();

function findBySession(sessionId) {
  return queue.find(
    (item) => item.sessionId === sessionId && item.status === "pending",
  );
}

// =============================================================================
// SELF-LEARNING FEEDBACK (existing workflow engine integration)
// =============================================================================

app.post("/webhook/feedback-request", (req, res) => {
  const body = req.body || {};
  const data = body.data || {};
  const metadata = data.metadata || {};
  const attributes = data.attributes || {};

  if (!metadata.session_id || !metadata.workflow_id || !metadata.agent_id) {
    return res.status(400).json({
      error: "Missing session_id / workflow_id / agent_id in data.metadata",
    });
  }

  const existing = findBySession(metadata.session_id);
  const item = existing || {
    id: crypto.randomUUID(),
    receivedAt: Date.now(),
    status: "pending",
  };

  item.sessionId = metadata.session_id;
  item.workflowId = metadata.workflow_id;
  item.agentId = metadata.agent_id;
  item.agentName = metadata.agent_name || metadata.agent_id;
  item.workflowName = metadata.workflow_name || metadata.workflow_id;
  item.title = body.title || "Feedback requested";
  item.description = body.description || "";
  item.reason = data.feedback_request_reason || "";
  item.attributes = attributes;
  item.metadata = metadata;

  if (!existing) queue.unshift(item);
  saveQueue(queue);

  console.log(
    `[webhook/feedback] pending feedback request for claim ${attributes.claim_id || "(unknown)"} — session ${item.sessionId}`,
  );
  res.status(200).json({ received: true, id: item.id });
});

app.get("/api/queue", (_req, res) => res.json(queue));

app.get("/api/queue/:id", (req, res) => {
  const item = queue.find((q) => q.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

app.delete("/api/queue/:id", (req, res) => {
  const index = queue.findIndex((q) => q.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Not found" });
  const [removed] = queue.splice(index, 1);
  saveQueue(queue);
  console.log(`[queue] removed item ${removed.id}`);
  res.json({ ok: true });
});

app.post("/api/queue/:id/resolve", async (req, res) => {
  const item = queue.find((q) => q.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  if (item.status !== "pending")
    return res.status(409).json({ error: "Already resolved" });

  const comment = (req.body?.comment || "").trim();
  const submittedBy = (req.body?.submittedBy || "SME Console").trim();
  if (!comment) return res.status(400).json({ error: "Comment is required" });

  if (!settings.workflowApiKey) {
    return res
      .status(500)
      .json({ error: "Workflow API key is not configured." });
  }

  const feedbackRequestBody = {
    session_id: item.sessionId,
    agent_id: item.agentId,
    feedback_message: comment,
    feedback_rationale: null,
    feedback_data: {},
    metadata: item.metadata,
    api_key: settings.workflowApiKey,
    provided_by: submittedBy,
  };

  const url = `${settings.workflowEngineBaseUrl}/feedback/${item.workflowId}`;

  try {
    const engineRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feedbackRequestBody),
    });
    const engineJson = await engineRes.json().catch(() => ({}));

    if (!engineRes.ok) {
      return res.status(502).json({
        error: "Workflow engine rejected the feedback",
        details: engineJson,
      });
    }

    item.status = "resolved";
    item.resolution = {
      comment,
      submittedBy,
      submittedAt: Date.now(),
      engineResponse: engineJson,
    };
    saveQueue(queue);

    console.log(
      `[resolve] session ${item.sessionId} resumed with SME feedback`,
    );
    res.json({ ok: true, item });
  } catch (err) {
    console.error("[resolve] failed to reach workflow engine:", err.message);
    res.status(502).json({
      error: `Could not reach workflow engine at ${url}: ${err.message}`,
    });
  }
});

// =============================================================================
// HITL APPROVAL (dFlow Data Engine HITL executor integration)
// =============================================================================

// Inbound webhook from Data Engine HITL executor.
// The HITL executor POSTs the request envelope here with headers:
//   x-api-key: <one-shot cleartext for resuming>
//   X-Hitl-Engine: dflow
//   X-Hitl-Resume-Url: http://<data-engine>/api/v1/hitl/<request_id>
app.post("/webhook/hitl-approval", (req, res) => {
  const body = req.body || {};
  const apiKey =
    req.headers["x-api-key"] || (body.metadata || {}).api_key || "";
  const resumeUrl =
    req.headers["x-hitl-resume-url"] || (body.metadata || {}).resume_url || "";
  const engine =
    req.headers["x-hitl-engine"] || (body.data || {}).engine_type || "dflow";

  // Data Engine sends: { type: "hitl.request", data: { request_id, request_payload, ... }, metadata: { ... } }
  const data = body.data || {};
  const metadata = body.metadata || {};
  const requestId = data.request_id || body.request_id || crypto.randomUUID();
  const payload =
    data.request_payload || body.request_payload || body.payload || body;
  const schema = data.feedback_schema || body.feedback_schema || null;
  const approvers = data.approvers || body.approvers || [];
  const attachments = metadata.attachments || body.attachments || [];

  const item = {
    id: crypto.randomUUID(),
    requestId,
    receivedAt: Date.now(),
    status: "pending",
    engine,
    resumeUrl,
    apiKey,
    payload,
    feedbackSchema: schema,
    approvers,
    attachments,
    rawBody: body,
  };

  hitlQueue.unshift(item);
  saveHitlQueue(hitlQueue);

  console.log(
    `[webhook/hitl] HITL approval request received — id=${item.id} requestId=${requestId}`,
  );
  console.log(`  Resume URL: ${resumeUrl}`);
  console.log(`  Payload keys: ${Object.keys(payload).join(", ")}`);

  res.status(200).json({ received: true, id: item.id, requestId });
});

// List HITL queue
app.get("/api/hitl/queue", (_req, res) => res.json(hitlQueue));

// Get single HITL item
app.get("/api/hitl/queue/:id", (req, res) => {
  const item = hitlQueue.find((q) => q.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

// Remove HITL item from local queue
app.delete("/api/hitl/queue/:id", (req, res) => {
  const index = hitlQueue.findIndex((q) => q.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Not found" });
  const [removed] = hitlQueue.splice(index, 1);
  saveHitlQueue(hitlQueue);
  console.log(`[hitl] removed item ${removed.id} from queue`);
  res.json({ ok: true });
});

// Resolve HITL: supports two modes:
//   1. Approval mode: { decision, comment, submittedBy }
//   2. SME input mode: { feedback: { sme_comment, submitted_by, ... }, submittedBy }
app.post("/api/hitl/queue/:id/resolve", async (req, res) => {
  const item = hitlQueue.find((q) => q.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  if (item.status !== "pending")
    return res.status(409).json({ error: "Already resolved" });

  const submittedBy = (req.body?.submittedBy || "SME Reviewer").trim();
  const isSmeInput = req.body?.feedback && !req.body?.decision;
  const decision = isSmeInput ? "submitted" : (req.body?.decision || "").trim();
  const comment = (req.body?.comment || "").trim();

  if (!isSmeInput && !decision)
    return res
      .status(400)
      .json({ error: "Decision is required (approved/rejected/modify)" });

  // Build the resume URL: use stored X-Hitl-Resume-Url if available,
  // otherwise construct from Data Engine base URL + request_id
  let resumeUrl = item.resumeUrl;
  if (!resumeUrl && item.requestId) {
    resumeUrl = `${settings.dataEngineBaseUrl}/hitl/${item.requestId}`;
  }
  if (!resumeUrl) {
    return res.status(500).json({
      error:
        "No resume URL stored for this HITL request — cannot send decision back.",
    });
  }

  // For SME input mode, send the feedback object directly
  // For approval mode, send { decision, comment }
  const feedbackBody = isSmeInput ? req.body.feedback : { decision, comment };

  // Auth: use one-shot x-api-key if available, otherwise use Bearer token from settings
  const headers = { "Content-Type": "application/json" };
  if (item.apiKey) {
    headers["x-api-key"] = item.apiKey;
  } else if (settings.hitlBearerToken) {
    headers["Authorization"] = `Bearer ${settings.hitlBearerToken}`;
  }

  try {
    const engineRes = await fetch(resumeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(feedbackBody),
    });

    const engineJson = await engineRes.json().catch(() => ({}));

    if (!engineRes.ok) {
      console.error(
        `[hitl/resolve] Data Engine rejected: ${engineRes.status}`,
        engineJson,
      );
      return res.status(502).json({
        error: `Data Engine returned ${engineRes.status}`,
        details: engineJson,
      });
    }

    item.status = "resolved";
    item.resolution = {
      decision,
      comment: isSmeInput
        ? (req.body.feedback.sme_comment || "").slice(0, 100) + "..."
        : comment,
      submittedBy,
      submittedAt: Date.now(),
      engineResponse: engineJson,
    };
    saveHitlQueue(hitlQueue);

    console.log(
      `[hitl/resolve] HITL ${item.requestId} resolved as '${decision}' by ${submittedBy}`,
    );
    res.json({ ok: true, item });
  } catch (err) {
    console.error("[hitl/resolve] failed to reach Data Engine:", err.message);
    res.status(502).json({
      error: `Could not reach Data Engine at ${item.resumeUrl}: ${err.message}`,
    });
  }
});

// =============================================================================
// TRIGGER DFLOW (start a rule update workflow with SME comment)
// =============================================================================

app.post("/api/trigger-dflow", async (req, res) => {
  const {
    ticket_id,
    ticket_type,
    target_decision,
    sme_comment,
    submitted_by,
    submitted_date,
    priority,
  } = req.body || {};

  if (
    !ticket_id ||
    !ticket_type ||
    !target_decision ||
    !sme_comment ||
    !submitted_by
  ) {
    return res.status(400).json({
      error:
        "Missing required fields: ticket_id, ticket_type, target_decision, sme_comment, submitted_by",
    });
  }

  const triggerUrl = `${settings.dataEngineBaseUrl}/tasks/trigger`;

  const triggerBody = {
    task_name: "SME_DMN_Rule_Update_Agent",
    variables: {
      ticket_id,
      ticket_type,
      target_decision,
      sme_comment,
      submitted_by,
      submitted_date:
        submitted_date ||
        new Date().toISOString().slice(0, 10).replace(/-/g, "/"),
      priority: priority || "medium",
    },
  };

  const headers = { "Content-Type": "application/json" };
  if (settings.hitlBearerToken) {
    headers["Authorization"] = `Bearer ${settings.hitlBearerToken}`;
  }

  try {
    const engineRes = await fetch(triggerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(triggerBody),
    });

    const engineJson = await engineRes.json().catch(() => ({}));

    if (!engineRes.ok) {
      console.error(
        `[trigger-dflow] Data Engine returned ${engineRes.status}:`,
        engineJson,
      );
      return res.status(502).json({
        error: `Data Engine returned ${engineRes.status}`,
        details: engineJson,
      });
    }

    console.log(
      `[trigger-dflow] dFlow triggered — job_id=${engineJson.job_id || "unknown"}`,
    );
    res.json({
      ok: true,
      job_id: engineJson.job_id || engineJson.id,
      details: engineJson,
    });
  } catch (err) {
    console.error("[trigger-dflow] failed to reach Data Engine:", err.message);
    res.status(502).json({
      error: `Could not reach Data Engine at ${triggerUrl}: ${err.message}`,
    });
  }
});

// =============================================================================
// SETTINGS
// =============================================================================

app.get("/api/settings", (_req, res) => {
  res.json({
    workflowEngineBaseUrl: settings.workflowEngineBaseUrl,
    dataEngineBaseUrl: settings.dataEngineBaseUrl,
    apiKeyConfigured: Boolean(settings.workflowApiKey),
    hitlBearerTokenConfigured: Boolean(settings.hitlBearerToken),
    feedbackWebhookUrl: `http://localhost:${PORT}/webhook/feedback-request`,
    hitlWebhookUrl: `http://localhost:${PORT}/webhook/hitl-approval`,
  });
});

app.put("/api/settings", (req, res) => {
  const workflowEngineBaseUrl = (req.body?.workflowEngineBaseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  const dataEngineBaseUrl = (req.body?.dataEngineBaseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  const workflowApiKey = (req.body?.workflowApiKey ?? "").trim();
  const hitlBearerToken = (req.body?.hitlBearerToken ?? "").trim();

  if (!workflowEngineBaseUrl) {
    return res
      .status(400)
      .json({ error: "Workflow engine base URL is required" });
  }

  settings = {
    workflowEngineBaseUrl,
    dataEngineBaseUrl: dataEngineBaseUrl || settings.dataEngineBaseUrl,
    workflowApiKey: workflowApiKey || settings.workflowApiKey,
    hitlBearerToken: hitlBearerToken || settings.hitlBearerToken,
  };
  saveSettings(settings);

  console.log(
    `[settings] updated — workflow: ${settings.workflowEngineBaseUrl}, data-engine: ${settings.dataEngineBaseUrl}`,
  );
  res.json({
    workflowEngineBaseUrl: settings.workflowEngineBaseUrl,
    dataEngineBaseUrl: settings.dataEngineBaseUrl,
    apiKeyConfigured: Boolean(settings.workflowApiKey),
    hitlBearerTokenConfigured: Boolean(settings.hitlBearerToken),
    feedbackWebhookUrl: `http://localhost:${PORT}/webhook/feedback-request`,
    hitlWebhookUrl: `http://localhost:${PORT}/webhook/hitl-approval`,
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    workflowEngineBaseUrl: settings.workflowEngineBaseUrl,
    dataEngineBaseUrl: settings.dataEngineBaseUrl,
    apiKeyConfigured: Boolean(settings.workflowApiKey),
    hitlBearerTokenConfigured: Boolean(settings.hitlBearerToken),
    feedbackWebhookUrl: `http://localhost:${PORT}/webhook/feedback-request`,
    hitlWebhookUrl: `http://localhost:${PORT}/webhook/hitl-approval`,
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SME Review Portal running on http://localhost:${PORT}`);
    console.log(
      `  Self-learning webhook: http://localhost:${PORT}/webhook/feedback-request`,
    );
    console.log(
      `  HITL approval webhook: http://localhost:${PORT}/webhook/hitl-approval`,
    );
    console.log(`  Workflow Engine: ${settings.workflowEngineBaseUrl}`);
    console.log(`  Data Engine: ${settings.dataEngineBaseUrl}`);
  });
}

module.exports = app;

//C:/Users/SahanSamarasinghe/Downloads/ngrok-v3-stable-windows-amd64/ngrok.exe http 4100
