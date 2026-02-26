# MiniClaw — Protocol Implementation Status

**Protocol:** OpenClaw Gateway Protocol v3
**Document date:** 2026-02-26
**Reference:** `protocol-spec.md`

This document maps every endpoint and feature defined in the protocol spec to its implementation status in MiniClaw.

**Legend:**
- **REAL** — Fully implemented with working logic and tests
- **PARTIAL** — Implemented but incomplete or missing some sub-features
- **STUB** — Method is registered and returns a `#TODO` response (no real logic)
- **N/A** — Not defined as an RPC method / handled differently

---

## 1. WebSocket Transport (§2)

| Feature | Status | Notes |
|---------|--------|-------|
| JSON text frames | REAL | All communication uses typed JSON envelopes |
| Connection lifecycle | REAL | Upgrade, hello, connect, disconnect |
| Frame types: `request`, `response`, `event` | REAL | Fully discriminated by `type` field |
| Handshake (`hello` → `connect` → `hello-ok`) | REAL | Protocol version negotiation, capability exchange |
| Handshake timeout | REAL | 10s default |
| Request/Response RPC | REAL | Sequence-numbered, routed to method handlers |
| Server-pushed events | REAL | Global sequence numbering, broadcast |
| Tick keepalive | REAL | 30s interval |
| Health keepalive | REAL | 60s interval |
| Shutdown event | REAL | Sent on graceful shutdown |
| Backpressure & limits | PARTIAL | Max message size enforced; no per-client rate limiting |
| Error shape / error codes | REAL | Structured `{code, message}` errors |

---

## 2. Authentication & Authorization (§3)

| Feature | Status | Notes |
|---------|--------|-------|
| Token auth (`auth.token`) | REAL | Validated during connect handshake |
| Password auth (`auth.password`) | REAL | Validated during connect handshake |
| Device token auth | STUB | Comment: `#TODO Device token authentication — §3.2` |
| HTTP Bearer token | REAL | For `/v1/chat/completions` |
| Challenge-response (nonce) | REAL | `connect.challenge` event emitted |
| Roles (§3.3) | STUB | No role enforcement |
| Scopes (§3.4) | STUB | No scope enforcement |

---

## 3. RPC Methods (§4)

### 3.1 Agent (§4.1)

| Method | Status | Notes |
|--------|--------|-------|
| `agent` | REAL | Creates run, starts async execution, returns runId |
| `agent.wait` | REAL | Waits for completion with configurable timeout (default 60s) |
| `agent.identity.get` | STUB | |
| `wake` | STUB | Voice/push notification wake |

### 3.2 Agent Management (§4.2)

| Method | Status | Notes |
|--------|--------|-------|
| `agents.list` | STUB | |
| `agents.create` | STUB | |
| `agents.update` | STUB | |
| `agents.delete` | STUB | |
| `agents.files.list` | STUB | |
| `agents.files.get` | STUB | |
| `agents.files.set` | STUB | |

### 3.3 Chat (§4.3)

| Method | Status | Notes |
|--------|--------|-------|
| `chat.send` | REAL | Idempotency (5-min TTL), slash commands (`/new`, `/model`, `/models`, `/tools`, `/help`), returns ACK with runId |
| `chat.abort` | REAL | Aborts by runId or latest for session |
| `chat.history` | REAL | Configurable limit (max 1000), greeting injection, `noHistory` mode |
| `chat.inject` | REAL | Direct history injection without idempotency |
| `chat.subscribe` | STUB | Returns `{subscribed: true}`, no per-connection targeting |

### 3.4 Sessions (§4.4)

| Method | Status | Notes |
|--------|--------|-------|
| `sessions.list` | REAL | Returns all sessions with metadata (key, label, createdAt, lastActiveAt, messageCount) |
| `sessions.patch` | REAL | Patch label/custom fields, 64-char label limit |
| `sessions.reset` | REAL | Clears chat history for a session |
| `sessions.delete` | REAL | Deletes metadata and history |
| `sessions.preview` | STUB | |
| `sessions.resolve` | STUB | |
| `sessions.compact` | STUB | |
| `sessions.usage` | STUB | |
| `sessions.usage.timeseries` | STUB | |
| `sessions.usage.logs` | STUB | |

### 3.5 Channels (§4.5)

| Method | Status | Notes |
|--------|--------|-------|
| `channels.status` | STUB | |
| `channels.logout` | STUB | |

### 3.6 Configuration (§4.6)

| Method | Status | Notes |
|--------|--------|-------|
| `config.get` | PARTIAL | Returns serverVersion and protocol only; does not return full parsed config |
| `config.set` | STUB | |
| `config.apply` | STUB | |
| `config.patch` | STUB | |
| `config.schema` | STUB | |

### 3.7 Cron (§4.7)

| Method | Status | Notes |
|--------|--------|-------|
| `cron.list` | STUB | |
| `cron.status` | STUB | |
| `cron.add` | STUB | |
| `cron.update` | STUB | |
| `cron.remove` | STUB | |
| `cron.run` | STUB | |
| `cron.runs` | STUB | |

### 3.8 Devices (§4.8)

| Method | Status | Notes |
|--------|--------|-------|
| `device.pair.list` | STUB | |
| `device.pair.approve` | STUB | |
| `device.pair.reject` | STUB | |
| `device.pair.remove` | STUB | |
| `device.token.rotate` | STUB | |
| `device.token.revoke` | STUB | |

### 3.9 Nodes (§4.9)

| Method | Status | Notes |
|--------|--------|-------|
| `node.list` | STUB | |
| `node.describe` | STUB | |
| `node.pair.request` | STUB | |
| `node.pair.list` | STUB | |
| `node.pair.approve` | STUB | |
| `node.pair.reject` | STUB | |
| `node.pair.verify` | STUB | |
| `node.rename` | STUB | |
| `node.invoke` | STUB | |
| `node.invoke.result` | STUB | |
| `node.event` | STUB | |

### 3.10 Execution Approvals (§4.10)

| Method | Status | Notes |
|--------|--------|-------|
| `exec.approval.request` | STUB | |
| `exec.approval.waitDecision` | STUB | |
| `exec.approval.resolve` | STUB | |
| `exec.approvals.get` | STUB | |
| `exec.approvals.set` | STUB | |
| `exec.approvals.node.get` | STUB | |
| `exec.approvals.node.set` | STUB | |

### 3.11 Models & Skills (§4.11)

| Method | Status | Notes |
|--------|--------|-------|
| `models.list` | REAL | Returns current model id, provider, active flag |
| `skills.status` | STUB | |
| `skills.bins` | STUB | |
| `skills.install` | STUB | |
| `skills.update` | STUB | |

### 3.12 Talk & TTS (§4.12)

| Method | Status | Notes |
|--------|--------|-------|
| `talk.config` | STUB | |
| `talk.mode` | STUB | |
| `tts.status` | STUB | |
| `tts.enable` | STUB | |
| `tts.disable` | STUB | |
| `tts.convert` | STUB | |
| `tts.setProvider` | STUB | |
| `tts.providers` | STUB | |

### 3.13 System & Health (§4.13)

| Method | Status | Notes |
|--------|--------|-------|
| `health` | REAL | Returns health state + stateVersion |
| `status` | REAL | Protocol, serverVersion, uptime, connected clients, active sessions/runs, model/provider |
| `system-presence` | REAL | Returns list of connected clients |
| `last-heartbeat` | STUB | |
| `set-heartbeats` | STUB | |
| `system-event` | STUB | |

### 3.14 Wizard (§4.14)

No methods registered. Entire section unimplemented.

### 3.15 Messaging (§4.15)

| Method | Status | Notes |
|--------|--------|-------|
| `send` | STUB | Returns `{sent: true}` with idempotency dedup, but no actual message routing |
| `poll` | STUB | |

### 3.16 Browser (§4.16)

| Method | Status | Notes |
|--------|--------|-------|
| `browser.request` | STUB | |

### 3.17 Push (§4.17)

| Method | Status | Notes |
|--------|--------|-------|
| `push.test` | STUB | |

### 3.18 Update (§4.18)

| Method | Status | Notes |
|--------|--------|-------|
| `update.run` | STUB | |

### 3.19 Logs (§4.19)

| Method | Status | Notes |
|--------|--------|-------|
| `logs.tail` | STUB | Returns empty array; no log ring buffer |

### 3.20 Voice Wake (§4.20)

| Method | Status | Notes |
|--------|--------|-------|
| `voicewake.get` | STUB | |
| `voicewake.set` | STUB | |

### 3.21 Web Login (§4.21)

| Method | Status | Notes |
|--------|--------|-------|
| `web.login.start` | STUB | |
| `web.login.wait` | STUB | |

### 3.22 Usage (§4.22)

| Method | Status | Notes |
|--------|--------|-------|
| `usage.status` | STUB | |
| `usage.cost` | STUB | |

---

## 4. Server-Pushed Events (§5)

| Event | Status | Notes |
|-------|--------|-------|
| `hello` | REAL | Sent immediately on WebSocket connection |
| `connect.challenge` | REAL | Nonce challenge for auth |
| `tick` | REAL | 30s keepalive |
| `health` | REAL | 60s health snapshot |
| `presence` | REAL | Broadcast on client connect/disconnect |
| `agent` | REAL | Streaming with lifecycle, reasoning, tool, assistant sub-streams |
| `chat` | REAL | States: delta, final, error |
| `shutdown` | REAL | Sent on graceful server shutdown |
| `config.updated` | PARTIAL | Event type defined, never emitted |
| `exec.approval` | PARTIAL | Event type defined, never emitted |
| `node.invoke` | PARTIAL | Event type defined, never emitted |
| `node.event` | PARTIAL | Event type defined, never emitted |

---

## 5. HTTP Endpoints (§6)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `POST /v1/chat/completions` (§6.1) | REAL | OpenAI-compatible; streaming (SSE) and non-streaming; Bearer auth; model override; session key via `user` field |
| `POST /v1/responses` (§6.2) | STUB | Returns 501 — `#TODO OpenResponses API` |
| `POST /hooks/wake` (§6.3) | STUB | Returns 501 — `#TODO Wake webhook` |
| `POST /hooks/agent` (§6.3) | STUB | Returns 501 — `#TODO Agent webhook` |
| `POST /tools/invoke` (§6.4) | STUB | Returns 501 — `#TODO Tools invocation` |
| Canvas & Control UI (§6.5) | STUB | No routes registered |

---

## 6. Model Provider Backends

| Backend | Status | Notes |
|---------|--------|-------|
| Ollama (native API) | REAL | Streaming NDJSON `/api/chat`; tool support; reasoning mode; availability check; model pull verification |
| OpenAI-compatible API | REAL | SSE streaming; Bearer auth; tool definitions; works with OpenRouter, etc. |
| Demo mode | REAL | Keyword-matched responses; simulates tool calls, reasoning, and streaming delays |

---

## 7. MCP Integration

| Feature | Status | Notes |
|---------|--------|-------|
| MCP Server (stdio) | REAL | Exposes 3 tools: `chat`, `clear_session`, `list_models` |
| MCP Client | REAL | Connects to external tool servers; tool discovery; namespaced invocation (`server__tool`) |

---

## 8. Cross-Cutting Features

| Feature | Status | Notes |
|---------|--------|-------|
| Idempotency deduplication | REAL | 5-min TTL on `chat.send` and `agent` |
| Run management | REAL | Unique runIds, state tracking, abort propagation, async completion |
| Presence tracking | REAL | Connected clients list, broadcast on change |
| Conversation logging | REAL | Optional disk logging |
| Session memory cleanup | REAL | Clears session state on connection close |
| Greeting injection | REAL | Once per session, excluded from agent context via `stopReason="greeting"` |
| `noHistory` mode | REAL | Configured via `openclaw.json`, prevents history storage |

---

## Summary

| Category | Real | Partial | Stub | Total |
|----------|------|---------|------|-------|
| Agent (§4.1) | 2 | 0 | 2 | 4 |
| Agent Management (§4.2) | 0 | 0 | 7 | 7 |
| Chat (§4.3) | 4 | 0 | 1 | 5 |
| Sessions (§4.4) | 4 | 0 | 6 | 10 |
| Channels (§4.5) | 0 | 0 | 2 | 2 |
| Configuration (§4.6) | 0 | 1 | 4 | 5 |
| Cron (§4.7) | 0 | 0 | 7 | 7 |
| Devices (§4.8) | 0 | 0 | 6 | 6 |
| Nodes (§4.9) | 0 | 0 | 11 | 11 |
| Execution Approvals (§4.10) | 0 | 0 | 7 | 7 |
| Models & Skills (§4.11) | 1 | 0 | 4 | 5 |
| Talk & TTS (§4.12) | 0 | 0 | 8 | 8 |
| System & Health (§4.13) | 3 | 0 | 3 | 6 |
| Wizard (§4.14) | 0 | 0 | 0 | 0 |
| Messaging (§4.15) | 0 | 0 | 2 | 2 |
| Browser (§4.16) | 0 | 0 | 1 | 1 |
| Push (§4.17) | 0 | 0 | 1 | 1 |
| Update (§4.18) | 0 | 0 | 1 | 1 |
| Logs (§4.19) | 0 | 0 | 1 | 1 |
| Voice Wake (§4.20) | 0 | 0 | 2 | 2 |
| Web Login (§4.21) | 0 | 0 | 2 | 2 |
| Usage (§4.22) | 0 | 0 | 2 | 2 |
| HTTP Endpoints (§6) | 1 | 0 | 4 | 5 |
| Server Events (§5) | 8 | 4 | 0 | 12 |
| **Total** | **23** | **5** | **84** | **112** |

**Implementation coverage:** ~21% real, ~4% partial, ~75% stub

The core chat/agent pipeline, session management, model backends, and MCP integration are fully operational. The stub methods are primarily for advanced features (multi-agent management, cron scheduling, device mesh, node federation, voice/TTS, and webhooks) that are defined in the protocol spec but not yet needed for the primary gateway use case.
