# SME Feedback Console

A small Node/Express web app that acts as the **external feedback system** for the
Kaya platform's agent **self-learning** feature. It's built around a health
insurance claims scenario, but the app itself is domain-agnostic — it just relays
whatever attributes the agent sends.

When a self-learning-enabled agent node can't confidently resolve something on its
own (e.g. missing information, an ambiguous policy question), the platform pauses
that workflow run and calls a webhook to request human input. This app:

1. **Receives** that webhook and adds the request to a queue.
2. **Displays** the queue so a subject-matter expert (SME) can review each pending
   item — what the agent captured, and why it's asking.
3. **Submits** the SME's typed response back to the platform, which resumes the
   paused workflow with that feedback.

No framework, no build step, no database — just Express, two small JSON files on
disk, and a plain HTML/JS frontend.

## How it fits into the platform

```
Workflow engine                         SME Feedback Console
────────────────                        ─────────────────────
Agent can't resolve a case
        │
        ▼
Pauses the run, POSTs a webhook  ───►   POST /webhook/feedback-request
(the "API tool" configured in                  │
 the agent's self-learning config)             ▼
                                          Queue (data.json)
                                                │
                                          SME opens the UI, reviews the
                                          case, types a response
                                                │
                                                ▼
POST /feedback/{workflow_id}     ◄───   POST /api/queue/:id/resolve
resumes the paused run with
the SME's feedback
```

The platform's webhook payload and the resume request body follow fixed contracts
defined by the workflow engine — this app builds both automatically; you don't need
to hand-construct either.

## Requirements

- Node.js 20+ (the app uses `--env-file-if-exists`, a Node 20.6+ flag, and the
  built-in `fetch`)
- A reachable Kaya workflow-engine instance and a workflow with a self-learning
  agent node configured to send feedback requests to this app (see "Platform-side
  configuration" below)

## Quick start (local)

```bash
npm install
npm start
```

This starts the console on `http://localhost:4100` (override with `PORT`). Open it
in a browser, click the **⚙ Settings** icon, and set:

- **Workflow engine base URL** — e.g. `http://localhost:8000/api/v1`
- **Workflow API key** — the API key generated for your workflow in the Kaya
  admin-frontend

These are also the values shown as `.env` variables below — either works; the UI
takes precedence once you save something there (see "Configuration" below).

### Optional: seed defaults via `.env`

```bash
cp .env.example .env
# edit .env: set WORKFLOW_ENGINE_BASE_URL and/or WORKFLOW_API_KEY
npm start
```

`.env` is only read on first boot if `settings.json` doesn't exist yet — it's a
convenience for scripted/repeatable setups, not a hard requirement.

### Dev mode (auto-restart on file changes)

```bash
npm run dev
```

## Configuration

All runtime configuration is two values: the **workflow engine base URL** and the
**workflow API key**. There are two ways to set them, and they layer as follows:

1. **First boot**: if no `settings.json` exists yet, values are seeded from
   `WORKFLOW_ENGINE_BASE_URL` / `WORKFLOW_API_KEY` environment variables (or `.env`
   if present), falling back to `http://localhost:8000/api/v1` and an empty key.
2. **From then on**: whatever you save via the **Settings** panel in the UI
   (`GET`/`PUT /api/settings`) is persisted to `settings.json` and takes precedence.
   No restart required — changes apply to the very next request.

The API key is never sent back to the browser once saved (only whether one is set),
and `settings.json` is git-ignored.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4100` | HTTP port the app listens on |
| `WORKFLOW_ENGINE_BASE_URL` | `http://localhost:8000/api/v1` | First-boot default only |
| `WORKFLOW_API_KEY` | *(empty)* | First-boot default only |
| `DATA_DIR` | the app's own directory | Where `data.json`/`settings.json` are read/written — **point this at a mounted volume/disk in any real deployment**, see Deployment below |

## Platform-side configuration (Kaya admin-frontend)

This app is the target of a webhook, not something the platform discovers
automatically. On the platform side you need:

1. An **API Tool** pointing at this app's webhook:
   - URL: `http://<this-app-host>:4100/webhook/feedback-request`
   - Method: `POST`
   - No special auth/payload template needed — the self-learning fallback node
     sends its own fixed JSON body.
2. An agent node with **self-learning enabled**, **Supervised** mode, and that API
   Tool selected as the **Feedback Requestor Tool**.
3. The workflow's **API key**, which you'll enter into this app's Settings panel (or
   `.env`) so it can call back into `POST /feedback/{workflow_id}` to resume paused
   runs.

The exact webhook URL to give the platform is also shown inside this app's Settings
panel at runtime.

## API reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhook/feedback-request` | Inbound — the platform calls this to enqueue a feedback request. Body: `{ data: { metadata: { session_id, workflow_id, agent_id, agent_name, workflow_name }, attributes, feedback_request_reason }, title, description }` |
| `GET` | `/api/queue` | List all queue items (pending + resolved) |
| `GET` | `/api/queue/:id` | Get a single queue item |
| `DELETE` | `/api/queue/:id` | Remove an item from this app's local queue only — does **not** resume or affect the platform's paused workflow or learning memory |
| `POST` | `/api/queue/:id/resolve` | SME submits `{ comment, submittedBy }`; the app calls the platform's `POST /feedback/{workflow_id}` to resume the paused run |
| `GET` | `/api/settings` | Current base URL + whether an API key is set (key itself is never returned) |
| `PUT` | `/api/settings` | Update `{ workflowEngineBaseUrl, workflowApiKey }`. Leave `workflowApiKey` blank to keep the existing key |
| `GET` | `/health` | Liveness/readiness check — returns `{ status: "ok" }` |

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Docker/Kubernetes and bare-metal/systemd
instructions, persistent-storage requirements, and security notes for anyone
running this outside a local demo.

## Known limitations

- File-backed storage (`data.json`, `settings.json`) — no database, no migrations,
  no built-in backup.
- No authentication on any endpoint, including the inbound webhook.
- Single-instance only — the queue is an in-memory array backed by one JSON file
  with no locking, so it isn't safe to run multiple replicas against the same data
  directory.

These are intentional simplifications for a demo/pilot tool. See DEPLOYMENT.md
before running this anywhere beyond a controlled internal demo.
