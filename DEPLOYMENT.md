# Deployment

This app is a single stateless-ish Node/Express process (no build step, no external
DB/cache dependency — it persists to two small JSON files on disk). It needs:

1. **Inbound reachability** from the workflow-engine (or whatever routes the
   self-learning "API tool" webhook) on `/webhook/feedback-request`.
2. **Outbound reachability** to the workflow-engine's `/api/v1/feedback/{workflow_id}`
   endpoint.
3. A **persistent volume/disk** for `data.json` (the feedback queue) and
   `settings.json` (base URL + API key) — see "Persistent state" below.
4. No inbound auth by default — see "Security notes" below before exposing this
   beyond a local/demo network.

## Option A — Docker (recommended)

A `Dockerfile` and `.dockerignore` are included in this repo.

```bash
docker build -t sme-feedback-app .

docker run -d --name sme-feedback-app \
  -p 4100:4100 \
  -v sme-feedback-data:/app/data \
  -e WORKFLOW_ENGINE_BASE_URL=http://<workflow-engine-host>:8000/api/v1 \
  -e WORKFLOW_API_KEY=<workflow api key> \
  sme-feedback-app
```

- `-v sme-feedback-data:/app/data` — a named volume mounted at `/app/data`, where
  `DATA_DIR` (baked into the image) points `data.json`/`settings.json`. Without this,
  the queue and settings reset every time the container is replaced/redeployed.
- `WORKFLOW_ENGINE_BASE_URL` / `WORKFLOW_API_KEY` env vars only seed **first-run**
  defaults (see README → Configuration) — once someone saves via the Settings UI,
  `settings.json` on the volume takes over. Safe to omit both and just configure
  everything from the UI after first boot.
- The image ships a `HEALTHCHECK` hitting `GET /health` (also usable directly as a
  Kubernetes liveness/readiness probe path) — `docker inspect` or `kubectl describe
  pod` will show container health status using it.
- Runs as the non-root `node` user inside the container.

### Kubernetes

Sketch — adapt to your cluster's conventions (Ingress class, secret store, etc.):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sme-feedback-app
spec:
  replicas: 1               # see "Scaling" below — do not run >1 replica as-is
  selector:
    matchLabels: { app: sme-feedback-app }
  template:
    metadata:
      labels: { app: sme-feedback-app }
    spec:
      containers:
        - name: sme-feedback-app
          image: <your-registry>/sme-feedback-app:<tag>
          ports: [{ containerPort: 4100 }]
          env:
            - name: WORKFLOW_ENGINE_BASE_URL
              value: "http://workflow-engine.internal:8000/api/v1"
            - name: WORKFLOW_API_KEY
              valueFrom:
                secretKeyRef: { name: sme-feedback-app-secrets, key: workflow-api-key }
          volumeMounts:
            - { name: data, mountPath: /app/data }
          readinessProbe:
            httpGet: { path: /health, port: 4100 }
          livenessProbe:
            httpGet: { path: /health, port: 4100 }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: sme-feedback-app-data }
```

## Option B — Bare process / VM, with a process manager

No Docker required — it's plain Node.

```bash
npm ci --omit=dev
cp .env.example .env   # set WORKFLOW_ENGINE_BASE_URL / WORKFLOW_API_KEY, or configure via UI after boot
npm start
```

Run it under a supervisor so it restarts on crash/reboot — e.g. `pm2 start server.js
--name sme-feedback-app`, or a `systemd` unit:

```ini
[Unit]
Description=Kaya self-learning SME feedback console
After=network.target

[Service]
WorkingDirectory=/opt/sme-feedback-app
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=PORT=4100
Environment=DATA_DIR=/var/lib/sme-feedback-app
EnvironmentFile=-/opt/sme-feedback-app/.env
User=sme-feedback-app

[Install]
WantedBy=multi-user.target
```

Create `/var/lib/sme-feedback-app` (writable by the service's user) before starting,
and point `DATA_DIR` at it so `data.json`/`settings.json` survive redeploys of
`/opt/sme-feedback-app`.

## Reverse proxy / TLS

The app itself only serves plain HTTP on `$PORT` (default `4100`) — put it behind
whatever reverse proxy/ingress/load balancer your environment standardizes on
(nginx, ALB, Kubernetes Ingress, etc.) for TLS termination and any auth in front of
it. The webhook endpoint (`/webhook/feedback-request`) must remain reachable from
the workflow-engine's network; the UI/API can be restricted to whatever
audience — the SME reviewers — should be able to submit feedback.

## Persistent state

Two files, both under `DATA_DIR` (defaults to the app's own directory if unset —
**always set `DATA_DIR` to a mounted volume/disk in any real deployment**):

| File | Contents | Sensitivity |
|---|---|---|
| `data.json` | The feedback queue (pending + resolved items, including claim attributes and SME comments) | May contain PHI/claim data depending on real usage — treat accordingly |
| `settings.json` | Workflow engine base URL + **plaintext** workflow API key | Secret — see below |

There is no database dependency; this is intentional for a demo app, but means
**no built-in encryption at rest, backup, or multi-instance consistency** — see
"Known limitations" below before treating this as more than a demo/pilot tool.

## Security notes

- **No authentication** is built into the UI or `/webhook/feedback-request` endpoint.
  Anyone who can reach the console can view claim data and submit feedback; anyone
  who can reach the webhook path can enqueue fake feedback requests. Put this behind
  your standard auth layer (SSO proxy, VPN-only network, IP allowlist, etc.) before
  using it with real data or outside a controlled demo.
- **`settings.json` stores the workflow API key in plaintext on disk.** For anything
  beyond a demo, consider swapping `loadSettings`/`saveSettings` in `server.js` for a
  secrets manager (Vault, AWS Secrets Manager, etc.) instead of the file-backed store.
- The webhook payload is trusted as-is (no signature/shared-secret verification of
  the caller). If exposed outside a private network, add a shared-secret header
  check to `POST /webhook/feedback-request` in `server.js`.

## Scaling

This app keeps its queue in an **in-memory array backed by a single JSON file** —
it is not safe to run multiple replicas/instances against the same `DATA_DIR`
simultaneously (last writer wins, no locking). For the demo/pilot use case this is a
single-instance app; horizontal scaling would require replacing the file-backed
queue with a shared store (e.g. the platform's own Postgres, or Redis) first.

## Known limitations (be upfront about these)

- File-backed storage only — no schema migrations, no built-in backup/restore.
- No authn/authz on any endpoint.
- Single-instance only (see "Scaling").
- No structured logging/metrics export — currently just `console.log`/`console.warn`
  to stdout, which containerized log collectors (CloudWatch, Loki, etc.) can still
  pick up, but there's no request tracing or log levels beyond plain text.
