# OpenClaw Gateway Protocol Specification

**Protocol Version:** 3
**Document Version:** 2026-02-23
**Transport:** WebSocket (primary), HTTP (compatibility APIs)

---

## Table of Contents

1. [Overview](#1-overview)
2. [WebSocket Transport](#2-websocket-transport)
   - [Connection Lifecycle](#21-connection-lifecycle)
   - [Frame Types](#22-frame-types)
   - [Handshake: Connect / Hello-OK](#23-handshake-connect--hello-ok)
   - [Request/Response RPC](#24-requestresponse-rpc)
   - [Server-Pushed Events](#25-server-pushed-events)
   - [Tick & Health Keepalive](#26-tick--health-keepalive)
   - [Shutdown](#27-shutdown)
   - [Backpressure & Limits](#28-backpressure--limits)
   - [Error Shape](#29-error-shape)
   - [Error Codes](#210-error-codes)
3. [Authentication & Authorization](#3-authentication--authorization)
   - [Auth Modes](#31-auth-modes)
   - [Device Identity & Pairing](#32-device-identity--pairing)
   - [Roles](#33-roles)
   - [Scopes](#34-scopes)
4. [RPC Methods (Client &rarr; Server)](#4-rpc-methods-client--server)
   - [Agent](#41-agent)
   - [Agent Management](#42-agent-management)
   - [Chat](#43-chat)
   - [Sessions](#44-sessions)
   - [Channels](#45-channels)
   - [Configuration](#46-configuration)
   - [Cron](#47-cron)
   - [Devices](#48-devices)
   - [Nodes](#49-nodes)
   - [Execution Approvals](#410-execution-approvals)
   - [Models & Skills](#411-models--skills)
   - [Talk & TTS](#412-talk--tts)
   - [System & Health](#413-system--health)
   - [Wizard](#414-wizard)
   - [Messaging (send/poll)](#415-messaging-sendpoll)
   - [Browser](#416-browser)
   - [Push](#417-push)
   - [Update](#418-update)
   - [Logs](#419-logs)
   - [Voice Wake](#420-voice-wake)
   - [Web Login](#421-web-login)
   - [Usage](#422-usage)
5. [Server-Pushed Events (Server &rarr; Client)](#5-server-pushed-events-server--client)
6. [HTTP Endpoints](#6-http-endpoints)
   - [OpenAI-Compatible: Chat Completions](#61-openai-compatible-chat-completions)
   - [OpenResponses API](#62-openresponses-api)
   - [Hooks (Webhooks)](#63-hooks-webhooks)
   - [Tools Invocation](#64-tools-invocation)
   - [Canvas & Control UI](#65-canvas--control-ui)
7. [Constants & Limits](#7-constants--limits)
8. [Enumerations Reference](#8-enumerations-reference)
9. [Sequence Diagrams](#9-sequence-diagrams)

---

## 1. Overview

OpenClaw Gateway is a multi-channel AI gateway that exposes a **WebSocket-first RPC protocol** for real-time bidirectional communication, plus **HTTP REST endpoints** for compatibility with OpenAI and OpenResponses API consumers.

The WebSocket protocol uses **JSON text frames** exclusively (no binary frames). All communication follows a typed frame envelope discriminated by a `type` field.

---

## 2. WebSocket Transport

### 2.1 Connection Lifecycle

```
CLIENT                                         SERVER
  |                                              |
  |--- HTTP Upgrade (ws://) ------------------->|
  |<-- 101 Switching Protocols -----------------|
  |                                              |
  |<-- event: connect.challenge (with nonce) ---|  (immediate)
  |                                              |
  |--- req: connect (with ConnectParams) ------>|  (must arrive within 10s)
  |    [auth, device identity, protocol ver]     |
  |                                              |
  |<-- res: hello-ok (Snapshot, features, etc) -|
  |                                              |
  |<== CONNECTED: RPC + Events bidirectional ==>|
  |                                              |
  |<-- event: tick ----------------------------- (every 30s)
  |<-- event: health --------------------------- (every 60s)
  |<-- event: presence ------------------------- (on change)
  |<-- event: agent  --------------------------- (on agent activity)
  |<-- event: chat   --------------------------- (on chat activity)
  |                                              |
  |--- req: <method> (params) ----------------->|
  |<-- res: <id> (ok/error, payload) -----------|
  |                                              |
  |<-- event: shutdown (reason) ----------------|  (before restart)
  |<-- WebSocket Close (1012) ------------------|
```

**Key timings:**
- Handshake timeout: **10 seconds** (configurable in test environments)
- Tick interval: **30 seconds**
- Health refresh interval: **60 seconds**
- Idempotency deduplication TTL: **5 minutes** (max 1000 entries)

### 2.2 Frame Types

All WebSocket messages are JSON objects with a discriminated `type` field. The top-level `GatewayFrame` is one of:

#### Request Frame (Client &rarr; Server)

```jsonc
{
  "type": "req",
  "id": "<unique-request-id>",       // string, min 1 char — correlates with response
  "method": "<method-name>",          // string, min 1 char — RPC method to invoke
  "params": { ... }                   // optional, method-specific parameters
}
```

#### Response Frame (Server &rarr; Client)

```jsonc
{
  "type": "res",
  "id": "<matching-request-id>",      // echoes the request id
  "ok": true | false,                 // success flag
  "payload": { ... },                 // optional — present on success
  "error": { ... }                    // optional ErrorShape — present on failure
}
```

#### Event Frame (Server &rarr; Client)

```jsonc
{
  "type": "event",
  "event": "<event-name>",            // string, min 1 char
  "payload": { ... },                 // optional, event-specific data
  "seq": 123,                         // optional integer >= 0, global sequence for ordering
  "stateVersion": {                   // optional, for client-side state sync
    "presence": 5,                    // integer >= 0
    "health": 3                       // integer >= 0
  }
}
```

**Notes on `seq`:**
- Broadcast events carry a monotonically increasing global `seq`.
- Targeted events (sent to specific connection IDs) have `seq: undefined`.
- Clients can use `seq` to detect missed events or reorder.

### 2.3 Handshake: Connect / Hello-OK

#### Step 1: Server Challenge

Immediately upon WebSocket upgrade, the server sends:

```jsonc
{
  "type": "event",
  "event": "connect.challenge",
  "payload": {
    "nonce": "<random-uuid>",         // challenge nonce for device signature
    "ts": 1708700000000               // server timestamp (ms)
  }
}
```

#### Step 2: Client Connect Request

```jsonc
{
  "type": "req",
  "id": "connect-1",
  "method": "connect",
  "params": {
    "minProtocol": 3,                         // integer >= 1
    "maxProtocol": 3,                         // integer >= 1, must encompass server's version
    "client": {
      "id": "<client-id>",                   // see Client IDs enum below
      "displayName": "My App",               // optional
      "version": "1.2.3",                    // required, min 1 char
      "platform": "darwin",                  // required, min 1 char
      "deviceFamily": "iPhone16,1",          // optional
      "modelIdentifier": "MacBookPro18,1",   // optional
      "mode": "ui",                          // see Client Modes enum below
      "instanceId": "abc-123"                // optional, unique per running instance
    },
    "caps": ["tool-events"],                  // optional, client capabilities
    "commands": ["bash", "python"],           // optional, allowed commands (node role)
    "permissions": { "exec": true },          // optional, declared permissions
    "pathEnv": "/usr/local/bin:/usr/bin",     // optional, PATH for node execution
    "role": "operator",                       // "operator" (default) or "node"
    "scopes": ["operator.admin"],             // authorization scopes
    "device": {                               // optional device identity
      "id": "<device-id>",                   // derived from publicKey
      "publicKey": "<base64-ed25519-pubkey>",
      "signature": "<base64-ed25519-sig>",   // signs: deviceId + signedAt + nonce
      "signedAt": 1708700000000,             // within 10 min of server time
      "nonce": "<connect-challenge-nonce>"   // must match server's challenge nonce
    },
    "auth": {                                 // optional shared-secret auth
      "token": "<device-token>",             // previously issued device token
      "password": "<shared-password>"        // shared gateway password
    },
    "locale": "en-US",                        // optional
    "userAgent": "OpenClaw-iOS/1.2.3"        // optional
  }
}
```

#### Step 3: Server Hello-OK Response

```jsonc
{
  "type": "res",
  "id": "connect-1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,                            // negotiated protocol version
    "server": {
      "version": "2026.2.20",                // gateway version string
      "commit": "abc1234",                   // optional git commit hash
      "host": "my-server.local",             // optional hostname
      "connId": "<uuid>"                     // unique connection identifier
    },
    "features": {
      "methods": [ "health", "agent", ... ], // all available RPC methods
      "events": [ "tick", "agent", ... ]     // all available event types
    },
    "snapshot": {
      "presence": [ ... ],                   // array of PresenceEntry
      "health": { ... },                     // HealthSnapshot (any)
      "stateVersion": {
        "presence": 5,
        "health": 3
      },
      "uptimeMs": 86400000,
      "configPath": "/path/to/openclaw.yml", // optional
      "stateDir": "/path/to/state",          // optional
      "sessionDefaults": {                   // optional
        "defaultAgentId": "default",
        "mainKey": "main",
        "mainSessionKey": "main:default",
        "scope": "per-sender"               // optional
      },
      "authMode": "token",                   // "none" | "token" | "password" | "trusted-proxy"
      "updateAvailable": {                   // optional
        "currentVersion": "2026.2.19",
        "latestVersion": "2026.2.20",
        "channel": "stable"
      }
    },
    "canvasHostUrl": "https://canvas.example.com/canvas?cap=...",  // optional (node role)
    "auth": {                                 // optional, only if device-authenticated
      "deviceToken": "<jwt-like-token>",
      "role": "operator",
      "scopes": ["operator.admin"],
      "issuedAtMs": 1708700000000            // optional
    },
    "policy": {
      "maxPayload": 26214400,                // 25 MB max frame size
      "maxBufferedBytes": 52428800,          // 50 MB send buffer limit
      "tickIntervalMs": 30000                // tick interval in ms
    }
  }
}
```

### 2.4 Request/Response RPC

After the handshake, the client sends `type: "req"` frames and receives `type: "res"` frames with matching `id` values. Multiple requests can be in-flight concurrently.

### 2.5 Server-Pushed Events

The server can push `type: "event"` frames at any time after the handshake. Events carry a global `seq` number for ordering. Some events are scoped to specific client permissions (see [Scopes](#34-scopes)).

### 2.6 Tick & Health Keepalive

**Tick** (every 30 seconds):
```jsonc
{
  "type": "event",
  "event": "tick",
  "payload": { "ts": 1708700030000 },
  "seq": 42
}
```
- Dropped silently for slow consumers (`dropIfSlow: true`).
- Also forwarded to subscribed node connections.

**Health** (every 60 seconds):
```jsonc
{
  "type": "event",
  "event": "health",
  "payload": { /* HealthSummary */ },
  "seq": 43,
  "stateVersion": { "presence": 5, "health": 4 }
}
```

### 2.7 Shutdown

Before stopping, the server broadcasts:

```jsonc
{
  "type": "event",
  "event": "shutdown",
  "payload": {
    "reason": "service restart",
    "restartExpectedMs": 5000           // optional, estimated restart time
  }
}
```

Then closes all connections with WebSocket close code **1012** (`"service restart"`).

### 2.8 Backpressure & Limits

| Constant | Value | Description |
|---|---|---|
| `MAX_PAYLOAD_BYTES` | **25 MB** (26,214,400) | Maximum single frame size |
| `MAX_BUFFERED_BYTES` | **50 MB** (52,428,800) | Per-connection send buffer limit |
| `DEFAULT_HANDSHAKE_TIMEOUT_MS` | **10,000** | Time to complete handshake |
| `TICK_INTERVAL_MS` | **30,000** | Keepalive tick interval |
| `HEALTH_REFRESH_INTERVAL_MS` | **60,000** | Health broadcast interval |
| `DEDUPE_TTL_MS` | **300,000** | Idempotency key TTL |
| `DEDUPE_MAX` | **1,000** | Max cached idempotency keys |
| `MAX_CHAT_HISTORY_BYTES` | **6 MB** | Chat history response size cap |

**Slow consumer handling:**
- If `socket.bufferedAmount > MAX_BUFFERED_BYTES` and the event has `dropIfSlow: true`: event is silently skipped.
- If `socket.bufferedAmount > MAX_BUFFERED_BYTES` and the event does NOT have `dropIfSlow`: the connection is terminated with close code **1008** (`"slow consumer"`).

### 2.9 Error Shape

All error responses use the same structure:

```jsonc
{
  "code": "INVALID_REQUEST",           // error code string
  "message": "human-readable message", // description
  "details": { ... },                  // optional, arbitrary context
  "retryable": true,                   // optional boolean hint
  "retryAfterMs": 5000                 // optional retry delay in ms
}
```

### 2.10 Error Codes

| Code | Description |
|---|---|
| `NOT_LINKED` | Gateway not linked to upstream service |
| `NOT_PAIRED` | Device pairing required |
| `AGENT_TIMEOUT` | Agent execution timed out |
| `INVALID_REQUEST` | Malformed request, invalid params, unknown method, unauthorized |
| `UNAVAILABLE` | Server error, rate limited, or temporarily unavailable |

---

## 3. Authentication & Authorization

### 3.1 Auth Modes

The gateway supports four authentication modes (reported in `snapshot.authMode`):

| Mode | Description |
|---|---|
| `none` | No authentication required |
| `token` | Shared secret token |
| `password` | Shared password |
| `trusted-proxy` | Trust upstream proxy headers |

### 3.2 Device Identity & Pairing

Devices authenticate using **Ed25519 key pairs**:

1. Server sends `connect.challenge` with a random `nonce`.
2. Client signs `deviceId + signedAt + nonce` with its Ed25519 private key.
3. Server verifies the signature using the device's public key.
4. If the device is already paired, a device token is returned in `auth.deviceToken`.
5. If the device is unknown, a pairing workflow is initiated.

**Constraints:**
- `signedAt` must be within **10 minutes** of server time.
- For non-loopback connections, `nonce` must match the challenge nonce.
- Device ID must be derivable from the public key.
- Auth attempts are rate-limited per IP.

### 3.3 Roles

| Role | Description |
|---|---|
| `operator` | Human user or control application (default) |
| `node` | Remote execution node (restricted method set) |

Node-role methods (only accessible by `role: "node"`):
- `node.invoke.result`
- `node.event`
- `skills.bins`

### 3.4 Scopes

| Scope | Description |
|---|---|
| `operator.admin` | Full access to all methods (superset) |
| `operator.read` | Read-only access to status, lists, and configs |
| `operator.write` | Write access to agent, chat, send, node invoke |
| `operator.approvals` | Execution approval request/resolve |
| `operator.pairing` | Device and node pairing management |

**Scope hierarchy:** `operator.admin` implies all other scopes. `operator.write` implies `operator.read` for method access.

**Default CLI scopes:** `["operator.admin", "operator.approvals", "operator.pairing"]`

**Event scope guards** (events filtered by scope):

| Event | Required Scope |
|---|---|
| `exec.approval.requested` | `operator.approvals` |
| `exec.approval.resolved` | `operator.approvals` |
| `device.pair.requested` | `operator.pairing` |
| `device.pair.resolved` | `operator.pairing` |
| `node.pair.requested` | `operator.pairing` |
| `node.pair.resolved` | `operator.pairing` |

---

## 4. RPC Methods (Client &rarr; Server)

All methods are invoked via WebSocket `type: "req"` frames. Parameters go in `params`. Response comes as `type: "res"` with matching `id`.

### 4.1 Agent

#### `agent`
Dispatch a message to an AI agent for processing.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `message` | string | yes | User message text |
| `agentId` | string | no | Target agent (default agent if omitted) |
| `to` | string | no | Delivery target address |
| `replyTo` | string | no | Reply-to address |
| `sessionId` | string | no | Existing session ID |
| `sessionKey` | string | no | Session key for routing |
| `thinking` | string | no | Extended thinking prompt level |
| `deliver` | boolean | no | Whether to deliver output to channel |
| `attachments` | any[] | no | Media attachments |
| `channel` | string | no | Source channel |
| `replyChannel` | string | no | Reply channel (if different) |
| `accountId` | string | no | Source channel account |
| `replyAccountId` | string | no | Reply channel account |
| `threadId` | string | no | Thread ID (e.g., Telegram forum topic) |
| `groupId` | string | no | Group conversation ID |
| `groupChannel` | string | no | Group channel identifier |
| `groupSpace` | string | no | Group space identifier |
| `timeout` | integer | no | Timeout in ms (>= 0) |
| `lane` | string | no | Execution lane |
| `extraSystemPrompt` | string | no | Additional system prompt |
| `inputProvenance` | object | no | Origin tracking (see below) |
| `idempotencyKey` | string | yes | Deduplication key |
| `label` | string | no | Session label (max 64 chars) |
| `spawnedBy` | string | no | Parent session key |

**InputProvenance:**
```jsonc
{
  "kind": "external_user" | "inter_session" | "internal_system",
  "sourceSessionKey": "...",  // optional
  "sourceChannel": "...",     // optional
  "sourceTool": "..."         // optional
}
```

**Response:** `{ "ok": true }` (agent events delivered asynchronously via `agent` events)

---

#### `agent.identity.get`
Get display identity for an agent.

**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | no | Agent ID (default if omitted) |
| `sessionKey` | string | no | Session key context |

**Response:**
```jsonc
{
  "agentId": "default",
  "name": "Assistant",      // optional
  "avatar": "https://...",  // optional avatar URL
  "emoji": "🤖"             // optional emoji
}
```

---

#### `agent.wait`
Wait for a running agent job to complete.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `runId` | string | yes | Run ID to wait on |
| `timeoutMs` | integer | no | Timeout in ms |

---

#### `wake`
Wake the system to trigger a heartbeat or immediate action.

**Scope:** (cron handler)

| Param | Type | Required | Description |
|---|---|---|---|
| `mode` | `"now"` \| `"next-heartbeat"` | yes | Wake mode |
| `text` | string | yes | Wake reason text |

---

### 4.2 Agent Management

#### `agents.list`
**Scope:** `operator.read`
**Params:** none

**Response:**
```jsonc
{
  "defaultId": "default",
  "mainKey": "main",
  "scope": "per-sender" | "global",
  "agents": [
    {
      "id": "default",
      "name": "Assistant",         // optional
      "identity": {                // optional
        "name": "Assistant",
        "theme": "blue",
        "emoji": "🤖",
        "avatar": "path",
        "avatarUrl": "https://..."
      }
    }
  ]
}
```

#### `agents.create`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Agent name |
| `workspace` | string | yes | Workspace path |
| `emoji` | string | no | Agent emoji |
| `avatar` | string | no | Agent avatar |

**Response:** `{ "ok": true, "agentId": "...", "name": "...", "workspace": "..." }`

#### `agents.update`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes | Agent ID |
| `name` | string | no | New name |
| `workspace` | string | no | New workspace |
| `model` | string | no | New model |
| `avatar` | string | no | New avatar |

**Response:** `{ "ok": true, "agentId": "..." }`

#### `agents.delete`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes | Agent ID |
| `deleteFiles` | boolean | no | Also delete workspace files |

**Response:** `{ "ok": true, "agentId": "...", "removedBindings": 0 }`

#### `agents.files.list`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes | Agent ID |

**Response:**
```jsonc
{
  "agentId": "default",
  "workspace": "/path/to/workspace",
  "files": [
    {
      "name": "system-prompt.md",
      "path": "/full/path",
      "missing": false,
      "size": 1234,               // optional
      "updatedAtMs": 1708700000,  // optional
      "content": "..."            // optional
    }
  ]
}
```

#### `agents.files.get`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes | Agent ID |
| `name` | string | yes | File name |

**Response:** `{ "agentId": "...", "workspace": "...", "file": { ... } }`

#### `agents.files.set`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | yes | Agent ID |
| `name` | string | yes | File name |
| `content` | string | yes | File content |

**Response:** `{ "ok": true, "agentId": "...", "workspace": "...", "file": { ... } }`

---

### 4.3 Chat

WebSocket-native chat methods for the webchat interface.

#### `chat.send`
Send a message and stream the response.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionKey` | string | yes | Session key |
| `message` | string | yes | User message text |
| `thinking` | string | no | Thinking/reasoning level |
| `deliver` | boolean | no | Deliver to channel |
| `attachments` | any[] | no | Media attachments |
| `timeoutMs` | integer | no | Timeout (>= 0) |
| `idempotencyKey` | string | yes | Deduplication key |

**Response:** `{ "ok": true, "runId": "..." }` (streaming results via `chat` events)

#### `chat.abort`
Abort an in-progress chat run.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionKey` | string | yes | Session key |
| `runId` | string | no | Specific run to abort |

#### `chat.history`
Get chat message history for a session.

**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionKey` | string | yes | Session key |
| `limit` | integer | no | Max messages (1-1000) |

#### `chat.inject`
Inject a system message into a chat session.

**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionKey` | string | yes | Session key |
| `message` | string | yes | Message to inject |
| `label` | string | no | Optional label (max 100 chars) |

---

### 4.4 Sessions

#### `sessions.list`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Max results (>= 1) |
| `activeMinutes` | integer | no | Filter: active within N minutes |
| `includeGlobal` | boolean | no | Include global sessions |
| `includeUnknown` | boolean | no | Include untyped sessions |
| `includeDerivedTitles` | boolean | no | Derive titles from first user message |
| `includeLastMessage` | boolean | no | Include last message preview |
| `label` | string | no | Filter by label |
| `spawnedBy` | string | no | Filter by parent session |
| `agentId` | string | no | Filter by agent |
| `search` | string | no | Text search |

#### `sessions.preview`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `keys` | string[] | yes | Session keys (min 1) |
| `limit` | integer | no | Messages per session (>= 1) |
| `maxChars` | integer | no | Max chars per preview (>= 20) |

#### `sessions.resolve`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | no | Session key |
| `sessionId` | string | no | Session ID |
| `label` | string | no | Session label |
| `agentId` | string | no | Agent ID |
| `spawnedBy` | string | no | Parent session |
| `includeGlobal` | boolean | no | Include global |
| `includeUnknown` | boolean | no | Include unknown |

#### `sessions.patch`
Modify session configuration.

**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Session key |
| `label` | string \| null | no | Session label (null to clear) |
| `thinkingLevel` | string \| null | no | Thinking level |
| `verboseLevel` | string \| null | no | Verbose level |
| `reasoningLevel` | string \| null | no | Reasoning level |
| `responseUsage` | `"off"` \| `"tokens"` \| `"full"` \| `"on"` \| null | no | Usage reporting |
| `elevatedLevel` | string \| null | no | Elevated privilege level |
| `execHost` | string \| null | no | Execution host |
| `execSecurity` | string \| null | no | Execution security mode |
| `execAsk` | string \| null | no | Execution approval strategy |
| `execNode` | string \| null | no | Execution node ID |
| `model` | string \| null | no | Model override |
| `spawnedBy` | string \| null | no | Parent session |
| `spawnDepth` | integer \| null | no | Spawn depth (>= 0) |
| `sendPolicy` | `"allow"` \| `"deny"` \| null | no | Outbound send policy |
| `groupActivation` | `"mention"` \| `"always"` \| null | no | Group activation mode |

#### `sessions.reset`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Session key |
| `reason` | `"new"` \| `"reset"` | no | Reset reason |

#### `sessions.delete`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Session key |
| `deleteTranscript` | boolean | no | Also delete transcript file |

#### `sessions.compact`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Session key |
| `maxLines` | integer | no | Max lines to keep (>= 1) |

#### `sessions.usage`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `key` | string | no | Specific session key |
| `startDate` | string | no | Range start (YYYY-MM-DD) |
| `endDate` | string | no | Range end (YYYY-MM-DD) |
| `limit` | integer | no | Max sessions (default 50) |
| `includeContextWeight` | boolean | no | Include context weight breakdown |

#### `sessions.usage.timeseries`
**Scope:** `operator.read`

#### `sessions.usage.logs`
**Scope:** `operator.read`

---

### 4.5 Channels

#### `channels.status`
Get status of all connected channel accounts.

**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `probe` | boolean | no | Trigger a live probe of channels |
| `timeoutMs` | integer | no | Probe timeout (>= 0) |

**Response:**
```jsonc
{
  "ts": 1708700000000,
  "channelOrder": ["discord", "telegram", "slack"],
  "channelLabels": { "discord": "Discord", ... },
  "channelDetailLabels": { ... },       // optional
  "channelSystemImages": { ... },       // optional
  "channelMeta": [                      // optional
    { "id": "discord", "label": "Discord", "detailLabel": "Discord Bot", "systemImage": "..." }
  ],
  "channels": { ... },
  "channelAccounts": {
    "discord": [
      {
        "accountId": "main",
        "name": "MyBot",
        "enabled": true,
        "configured": true,
        "linked": true,
        "running": true,
        "connected": true,
        "reconnectAttempts": 0,
        "lastConnectedAt": 1708700000000,
        "lastError": null,
        "mode": "all",
        "dmPolicy": "allow",
        "allowFrom": ["user1"],
        // ... additional channel-specific fields
      }
    ]
  },
  "channelDefaultAccountId": { "discord": "main", ... }
}
```

#### `channels.logout`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `channel` | string | yes | Channel plugin ID |
| `accountId` | string | no | Specific account (default account if omitted) |

---

### 4.6 Configuration

#### `config.get`
**Scope:** `operator.read`
**Params:** none
**Response:** Raw YAML configuration text.

#### `config.set`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `raw` | string | yes | Full YAML config |
| `baseHash` | string | no | Optimistic concurrency hash |

#### `config.apply`
Apply full configuration and trigger restart.

**Scope:** `operator.admin` (rate limited: 3 per 60s)

| Param | Type | Required | Description |
|---|---|---|---|
| `raw` | string | yes | Full YAML config |
| `baseHash` | string | no | Concurrency hash |
| `sessionKey` | string | no | Session context |
| `note` | string | no | Change note |
| `restartDelayMs` | integer | no | Delay before restart (>= 0) |

#### `config.patch`
Apply incremental YAML patch and trigger restart.

**Scope:** `operator.admin` (rate limited: 3 per 60s)

| Param | Type | Required | Description |
|---|---|---|---|
| `raw` | string | yes | YAML patch content |
| `baseHash` | string | no | Concurrency hash |
| `sessionKey` | string | no | Session context |
| `note` | string | no | Change note |
| `restartDelayMs` | integer | no | Delay before restart (>= 0) |

#### `config.schema`
**Scope:** `operator.read`
**Params:** none

**Response:**
```jsonc
{
  "schema": { ... },         // JSON Schema
  "uiHints": {               // per-field UI hints
    "fieldPath": {
      "label": "Display Name",
      "help": "Help text",
      "group": "General",
      "order": 1,
      "advanced": false,
      "sensitive": true,
      "placeholder": "Enter value...",
      "itemTemplate": { ... }
    }
  },
  "version": "2026.2.20",
  "generatedAt": "2026-02-23T00:00:00Z"
}
```

---

### 4.7 Cron

#### `cron.list`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `includeDisabled` | boolean | no | Include disabled jobs |

**Response:** Array of `CronJob` objects.

**CronJob:**
```jsonc
{
  "id": "job-uuid",
  "agentId": "default",                // optional
  "sessionKey": "main:default",        // optional
  "name": "Daily Report",
  "description": "Sends daily report", // optional
  "enabled": true,
  "deleteAfterRun": false,             // optional
  "createdAtMs": 1708700000000,
  "updatedAtMs": 1708700000000,
  "schedule": { /* see schedule types below */ },
  "sessionTarget": "main" | "isolated",
  "wakeMode": "next-heartbeat" | "now",
  "payload": { /* see payload types below */ },
  "delivery": { /* optional, see delivery types below */ },
  "state": {
    "nextRunAtMs": 1708786400000,      // optional
    "runningAtMs": null,               // optional
    "lastRunAtMs": 1708700000000,      // optional
    "lastStatus": "ok" | "error" | "skipped",  // optional
    "lastError": null,                 // optional
    "lastDurationMs": 5000,            // optional
    "consecutiveErrors": 0             // optional
  }
}
```

**Schedule types:**
```jsonc
// Fixed time
{ "kind": "at", "at": "2026-03-01T09:00:00Z" }

// Interval
{ "kind": "every", "everyMs": 3600000, "anchorMs": 0 }

// Cron expression
{ "kind": "cron", "expr": "0 9 * * *", "tz": "America/New_York", "staggerMs": 0 }
```

**Payload types:**
```jsonc
// System event
{ "kind": "systemEvent", "text": "Time to check..." }

// Agent turn
{
  "kind": "agentTurn",
  "message": "Generate the daily report",
  "model": "gpt-4",              // optional
  "thinking": "extended",         // optional
  "timeoutSeconds": 300,          // optional
  "allowUnsafeExternalContent": false,  // optional
  "deliver": true,                // optional
  "channel": "discord",           // optional
  "to": "user123",                // optional
  "bestEffortDeliver": false      // optional
}
```

**Delivery types:**
```jsonc
{ "mode": "none", "channel": "last", "bestEffort": true, "to": "..." }
{ "mode": "announce", "channel": "discord", "bestEffort": true, "to": "..." }
{ "mode": "webhook", "channel": "...", "bestEffort": true, "to": "https://..." }
```

#### `cron.status`
**Scope:** `operator.read`
**Params:** none

#### `cron.add`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Job name |
| `agentId` | string \| null | no | Agent ID |
| `sessionKey` | string \| null | no | Session key |
| `description` | string | no | Job description |
| `enabled` | boolean | no | Enabled state |
| `deleteAfterRun` | boolean | no | Self-destruct |
| `schedule` | CronSchedule | yes | Schedule definition |
| `sessionTarget` | `"main"` \| `"isolated"` | yes | Session target |
| `wakeMode` | `"next-heartbeat"` \| `"now"` | yes | Wake mode |
| `payload` | CronPayload | yes | Job payload |
| `delivery` | CronDelivery | no | Delivery config |

#### `cron.update`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `id` or `jobId` | string | yes | Job identifier |
| `patch` | object | yes | Partial job update |

#### `cron.remove`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `id` or `jobId` | string | yes | Job identifier |

#### `cron.run`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `id` or `jobId` | string | yes | Job identifier |
| `mode` | `"due"` \| `"force"` | no | Run mode |

#### `cron.runs`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `id` or `jobId` | string | yes | Job identifier |
| `limit` | integer | no | Max entries (1-5000) |

**Response:** Array of `CronRunLogEntry`:
```jsonc
{
  "ts": 1708700000000,
  "jobId": "job-uuid",
  "action": "finished",
  "status": "ok" | "error" | "skipped",
  "error": null,
  "summary": "Report generated",
  "sessionId": "...",
  "sessionKey": "...",
  "runAtMs": 1708700000000,
  "durationMs": 5000,
  "nextRunAtMs": 1708786400000
}
```

---

### 4.8 Devices

#### `device.pair.list`
**Scope:** `operator.pairing`
**Params:** none

#### `device.pair.approve`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | yes | Pairing request ID |

Broadcasts: `device.pair.resolved` event.

#### `device.pair.reject`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | yes | Pairing request ID |

Broadcasts: `device.pair.resolved` event.

#### `device.pair.remove`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `deviceId` | string | yes | Device ID to unpair |

#### `device.token.rotate`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `deviceId` | string | yes | Device ID |
| `role` | string | yes | New role |
| `scopes` | string[] | no | New scopes |

#### `device.token.revoke`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `deviceId` | string | yes | Device ID |
| `role` | string | yes | Role of token to revoke |

---

### 4.9 Nodes

#### `node.list`
**Scope:** `operator.read`
**Params:** none

#### `node.describe`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Node ID |

#### `node.pair.request`
Request to pair a new node.

**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Node ID |
| `displayName` | string | no | Display name |
| `platform` | string | no | Platform |
| `version` | string | no | Version |
| `coreVersion` | string | no | Core version |
| `uiVersion` | string | no | UI version |
| `deviceFamily` | string | no | Device family |
| `modelIdentifier` | string | no | Model identifier |
| `caps` | string[] | no | Capabilities |
| `commands` | string[] | no | Available commands |
| `remoteIp` | string | no | Remote IP |
| `silent` | boolean | no | Silent pairing |

Broadcasts: `node.pair.requested` event.

#### `node.pair.list`
**Scope:** `operator.pairing`
**Params:** none

#### `node.pair.approve`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | yes | Pairing request ID |

Broadcasts: `node.pair.resolved` event.

#### `node.pair.reject`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | yes | Pairing request ID |

Broadcasts: `node.pair.resolved` event.

#### `node.pair.verify`
Verify a node's pairing token.

**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Node ID |
| `token` | string | yes | Pairing token |

#### `node.rename`
**Scope:** `operator.pairing`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Node ID |
| `displayName` | string | yes | New display name |

#### `node.invoke`
Invoke a command on a remote node.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Target node ID |
| `command` | string | yes | Command to execute |
| `params` | any | no | Command parameters |
| `timeoutMs` | integer | no | Timeout (>= 0) |
| `idempotencyKey` | string | yes | Deduplication key |

Sends `node.invoke.request` event to the target node.

#### `node.invoke.result` (Node role only)
Return the result of a node invocation.

**Scope:** Node role

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Invocation request ID |
| `nodeId` | string | yes | Node ID |
| `ok` | boolean | yes | Success flag |
| `payload` | any | no | Result data |
| `payloadJSON` | string | no | Serialized JSON payload |
| `error` | object | no | `{ code?, message? }` |

#### `node.event` (Node role only)
Send an event from a node to the gateway.

**Scope:** Node role

| Param | Type | Required | Description |
|---|---|---|---|
| `event` | string | yes | Event name |
| `payload` | any | no | Event data |
| `payloadJSON` | string | no | Serialized JSON payload |

---

### 4.10 Execution Approvals

#### `exec.approval.request`
Request approval for a command execution.

**Scope:** `operator.approvals`

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | string | no | Request ID (auto-generated if omitted) |
| `command` | string | yes | Command to approve |
| `cwd` | string \| null | no | Working directory |
| `host` | string \| null | no | Execution host |
| `security` | string \| null | no | Security context |
| `ask` | string \| null | no | Approval strategy |
| `agentId` | string \| null | no | Agent requesting |
| `resolvedPath` | string \| null | no | Resolved command path |
| `sessionKey` | string \| null | no | Session context |
| `timeoutMs` | integer | no | Approval timeout (>= 1) |
| `twoPhase` | boolean | no | Two-phase approval |

Broadcasts: `exec.approval.requested` event.

#### `exec.approval.waitDecision`
Wait for an approval decision.

**Scope:** `operator.approvals`

#### `exec.approval.resolve`
Resolve an approval request.

**Scope:** `operator.approvals`

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Request ID |
| `decision` | string | yes | Decision (e.g., `"allow-once"`, `"allow-always"`, `"deny"`) |

Broadcasts: `exec.approval.resolved` event.

#### `exec.approvals.get`
**Scope:** `operator.admin`
**Params:** none

**Response:** `ExecApprovalsSnapshot` with file path, hash, and allowlist entries.

#### `exec.approvals.set`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `file` | object | yes | Full approvals file |
| `baseHash` | string | no | Concurrency hash |

#### `exec.approvals.node.get`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Node ID |

#### `exec.approvals.node.set`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Node ID |
| `file` | object | yes | Full approvals file |
| `baseHash` | string | no | Concurrency hash |

---

### 4.11 Models & Skills

#### `models.list`
**Scope:** `operator.read`
**Params:** none

**Response:**
```jsonc
{
  "models": [
    {
      "id": "gpt-4",
      "name": "GPT-4",
      "provider": "openai",
      "contextWindow": 128000,     // optional
      "reasoning": true            // optional
    }
  ]
}
```

#### `skills.status`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `agentId` | string | no | Agent ID context |

#### `skills.bins` (Node role only)
**Scope:** Node role
**Params:** none

**Response:** `{ "bins": ["ffmpeg", "yt-dlp", ...] }`

#### `skills.install`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Skill name |
| `installId` | string | yes | Installation ID |
| `timeoutMs` | integer | no | Timeout (>= 1000) |

#### `skills.update`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `skillKey` | string | yes | Skill key |
| `enabled` | boolean | no | Enable/disable |
| `apiKey` | string | no | API key |
| `env` | Record<string, string> | no | Environment variables |

---

### 4.12 Talk & TTS

#### `talk.config`
**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `includeSecrets` | boolean | no | Include API keys |

**Response:**
```jsonc
{
  "config": {
    "talk": {
      "voiceId": "alloy",
      "voiceAliases": { ... },
      "modelId": "tts-1",
      "outputFormat": "mp3",
      "apiKey": "***",               // only if includeSecrets
      "interruptOnSpeech": true
    },
    "session": { "mainKey": "main" },
    "ui": { "seamColor": "#000000" }
  }
}
```

#### `talk.mode`
Toggle talk mode.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | yes | Enable/disable talk mode |
| `phase` | string | no | Talk phase |

Broadcasts: `talk.mode` event.

#### `tts.status`
**Scope:** `operator.read`

#### `tts.enable`
**Scope:** `operator.write`

#### `tts.disable`
**Scope:** `operator.write`

#### `tts.convert`
Convert text to speech audio.

**Scope:** `operator.write`

#### `tts.setProvider`
**Scope:** `operator.write`

#### `tts.providers`
**Scope:** `operator.read`

---

### 4.13 System & Health

#### `health`
**Scope:** No scope required (always accessible)
**Params:** none

#### `status`
**Scope:** `operator.read`
**Params:** none

#### `system-presence`
**Scope:** `operator.read`
**Params:** none

#### `last-heartbeat`
**Scope:** `operator.read`
**Params:** none

#### `set-heartbeats`
Enable or disable heartbeat broadcasting.

**Scope:** `operator.admin`

#### `system-event`
Report a system event (triggers presence broadcast).

**Scope:** `operator.admin`

---

### 4.14 Wizard

Interactive onboarding wizard.

#### `wizard.start`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `mode` | `"local"` \| `"remote"` | no | Wizard mode |
| `workspace` | string | no | Workspace path |

**Response:**
```jsonc
{
  "sessionId": "wizard-uuid",
  "done": false,
  "step": {
    "id": "step-1",
    "type": "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action",
    "title": "Welcome",
    "message": "Let's get started...",
    "options": [                    // optional, for select/multiselect
      { "value": "opt1", "label": "Option 1", "hint": "..." }
    ],
    "initialValue": null,           // optional
    "placeholder": "Enter...",      // optional
    "sensitive": false,             // optional
    "executor": "gateway" | "client"  // optional
  },
  "status": "running",
  "error": null
}
```

#### `wizard.next`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Wizard session ID |
| `answer` | object | no | `{ stepId: string, value?: any }` |

**Response:** Same shape as `wizard.start` result (minus `sessionId`).

#### `wizard.cancel`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Wizard session ID |

#### `wizard.status`
**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | Wizard session ID |

**Response:** `{ "status": "running" | "done" | "cancelled" | "error", "error": null }`

---

### 4.15 Messaging (send/poll)

#### `send`
Send a message to an outbound channel.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `to` | string | yes | Recipient address |
| `message` | string | no | Text message |
| `mediaUrl` | string | no | Single media URL |
| `mediaUrls` | string[] | no | Multiple media URLs |
| `gifPlayback` | boolean | no | Treat media as animated GIF |
| `channel` | string | no | Channel plugin ID |
| `accountId` | string | no | Channel account ID |
| `threadId` | string | no | Thread ID |
| `sessionKey` | string | no | Mirror output to session |
| `idempotencyKey` | string | yes | Deduplication key |

#### `poll`
Create a poll in a channel.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `to` | string | yes | Recipient/channel address |
| `question` | string | yes | Poll question |
| `options` | string[] | yes | Poll options (2-12) |
| `maxSelections` | integer | no | Max selections (1-12) |
| `durationSeconds` | integer | no | Duration in seconds (1-604800) |
| `durationHours` | integer | no | Duration in hours |
| `silent` | boolean | no | Send without notification |
| `isAnonymous` | boolean | no | Anonymous voting |
| `threadId` | string | no | Thread ID |
| `channel` | string | no | Channel plugin ID |
| `accountId` | string | no | Channel account ID |
| `idempotencyKey` | string | yes | Deduplication key |

---

### 4.16 Browser

#### `browser.request`
Make a browser request via a connected node.

**Scope:** `operator.write`

---

### 4.17 Push

#### `push.test`
Send a test push notification to a node.

**Scope:** `operator.write`

| Param | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | yes | Target node ID |
| `title` | string | no | Notification title |
| `body` | string | no | Notification body |
| `environment` | `"sandbox"` \| `"production"` | no | APNS environment |

**Response:**
```jsonc
{
  "ok": true,
  "status": 200,
  "apnsId": "...",               // optional
  "reason": null,                // optional
  "tokenSuffix": "...abc",
  "topic": "com.example.app",
  "environment": "production"
}
```

---

### 4.18 Update

#### `update.run`
Trigger a gateway update and restart.

**Scope:** `operator.admin` (rate limited: 3 per 60s)

| Param | Type | Required | Description |
|---|---|---|---|
| `sessionKey` | string | no | Session context |
| `note` | string | no | Update note |
| `restartDelayMs` | integer | no | Delay before restart (>= 0) |
| `timeoutMs` | integer | no | Update timeout (>= 1) |

---

### 4.19 Logs

#### `logs.tail`
Tail the gateway log file.

**Scope:** `operator.read`

| Param | Type | Required | Description |
|---|---|---|---|
| `cursor` | integer | no | Byte offset to start from (>= 0) |
| `limit` | integer | no | Max lines (1-5000) |
| `maxBytes` | integer | no | Max bytes (1-1000000) |

**Response:**
```jsonc
{
  "file": "/path/to/log",
  "cursor": 4096,              // new cursor position
  "size": 102400,              // total file size
  "lines": ["line1", "line2"],
  "truncated": false,          // optional
  "reset": false               // optional, log file rotated
}
```

---

### 4.20 Voice Wake

#### `voicewake.get`
**Scope:** `operator.read`

#### `voicewake.set`
**Scope:** `operator.write`

Broadcasts: `voicewake.changed` event.

---

### 4.21 Web Login

#### `web.login.start`
Start a web login flow for a channel.

**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `force` | boolean | no | Force re-login |
| `timeoutMs` | integer | no | Timeout |
| `verbose` | boolean | no | Verbose logging |
| `accountId` | string | no | Specific account |

#### `web.login.wait`
Wait for web login to complete.

**Scope:** `operator.admin`

| Param | Type | Required | Description |
|---|---|---|---|
| `timeoutMs` | integer | no | Timeout |
| `accountId` | string | no | Specific account |

---

### 4.22 Usage

#### `usage.status`
**Scope:** `operator.read`

#### `usage.cost`
**Scope:** `operator.read`

---

## 5. Server-Pushed Events (Server &rarr; Client)

All events are delivered as `type: "event"` frames. The complete event catalog:

### `connect.challenge`
Sent immediately on WebSocket connection, before handshake.

```jsonc
{
  "nonce": "<uuid>",
  "ts": 1708700000000
}
```

### `tick`
Keepalive heartbeat (every 30s). `dropIfSlow: true`.

```jsonc
{ "ts": 1708700030000 }
```

### `health`
Health snapshot (every 60s). Includes `stateVersion`.

```jsonc
{
  "ok": true,
  "ts": 1708700000000,
  "durationMs": 150,
  "channels": { ... },
  "channelOrder": [...],
  "channelLabels": { ... },
  "heartbeatSeconds": 30,
  "defaultAgentId": "default",
  "agents": [...],
  "sessions": { ... }
}
```

### `presence`
Client presence changes. `dropIfSlow: true`. Includes `stateVersion`.

```jsonc
{
  "presence": [
    {
      "host": "my-server",          // optional
      "ip": "192.168.1.1",          // optional
      "version": "1.2.3",           // optional
      "platform": "darwin",         // optional
      "deviceFamily": "iPhone",     // optional
      "modelIdentifier": "...",     // optional
      "mode": "ui",                 // optional
      "lastInputSeconds": 30,       // optional
      "reason": "connected",        // optional
      "tags": ["webchat"],          // optional
      "text": "Active",             // optional
      "ts": 1708700000000,
      "deviceId": "...",            // optional
      "roles": ["operator"],        // optional
      "scopes": ["operator.admin"], // optional
      "instanceId": "..."           // optional
    }
  ]
}
```

### `agent`
Agent execution events (streamed during agent runs).

```jsonc
{
  "runId": "<uuid>",
  "seq": 0,                         // sequence within the run
  "stream": "assistant" | "tool" | "lifecycle" | "...",
  "ts": 1708700000000,
  "data": {
    // Stream-specific content. Examples:
    // assistant: { "delta": "Hello", "role": "assistant" }
    // tool: { "name": "search", "input": {...}, "output": {...} }
    // lifecycle: { "state": "started" | "completed" | "error" }
  }
}
```

**Notes:**
- Tool events are sent only to connections with `"tool-events"` capability.
- Tool details may be stripped unless `verboseLevel=full` on the session.

### `chat`
Chat message streaming (for webchat interface).

```jsonc
// Delta (streaming content)
{
  "runId": "<uuid>",
  "sessionKey": "main:default",
  "seq": 0,
  "state": "delta",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "Hello" }],
    "timestamp": 1708700000000
  }
}

// Final (completed)
{
  "runId": "<uuid>",
  "sessionKey": "main:default",
  "seq": 5,
  "state": "final",
  "message": { ... },              // optional full message
  "usage": { ... },                // optional token usage
  "stopReason": "end_turn"         // optional
}

// Aborted
{
  "runId": "<uuid>",
  "sessionKey": "main:default",
  "seq": 3,
  "state": "aborted",
  "message": { ... },              // optional partial message
  "stopReason": "user_abort"       // optional
}

// Error
{
  "runId": "<uuid>",
  "sessionKey": "main:default",
  "seq": 0,
  "state": "error",
  "errorMessage": "Provider returned 500"  // optional
}
```

**`state` values:** `"delta"` | `"final"` | `"aborted"` | `"error"`

### `heartbeat`
Heartbeat event. `dropIfSlow: true`.

### `cron`
Cron job execution events. `dropIfSlow: true`.

```jsonc
{
  "jobId": "<uuid>",
  "action": "started" | "finished",
  "status": "ok" | "error" | "skipped",
  "error": null,
  "summary": "Report generated",
  "sessionId": "...",
  "sessionKey": "...",
  "runAtMs": 1708700000000,
  "durationMs": 5000,
  "nextRunAtMs": 1708786400000,
  "model": "...",
  "provider": "...",
  "usage": { ... }
}
```

### `node.pair.requested`
A node is requesting to pair. Scope guard: `operator.pairing`.

```jsonc
{
  "nodeId": "...",
  "displayName": "My Node",
  "platform": "linux",
  "version": "1.0.0",
  "coreVersion": "...",
  "uiVersion": "...",
  "deviceFamily": "...",
  "modelIdentifier": "...",
  "caps": ["..."],
  "commands": ["bash", "python"],
  "remoteIp": "1.2.3.4"
}
```

### `node.pair.resolved`
A node pairing decision was made. Scope guard: `operator.pairing`.

```jsonc
{
  "requestId": "<uuid>",
  "nodeId": "...",
  "decision": "approved" | "rejected",
  "ts": 1708700000000
}
```

### `node.invoke.request`
Sent to a specific node to request command execution (targeted, no `seq`).

```jsonc
{
  "id": "<invocation-uuid>",
  "nodeId": "...",
  "command": "bash",
  "paramsJSON": "{...}",            // optional, serialized params
  "timeoutMs": 30000,               // optional
  "idempotencyKey": "..."           // optional
}
```

### `device.pair.requested`
A device is requesting to pair. Scope guard: `operator.pairing`.

```jsonc
{
  "requestId": "<uuid>",
  "deviceId": "...",
  "publicKey": "<base64>",
  "displayName": "My Phone",        // optional
  "platform": "ios",                 // optional
  "clientId": "openclaw-ios",        // optional
  "clientMode": "ui",                // optional
  "role": "operator",                // optional
  "roles": ["operator"],             // optional
  "scopes": ["operator.admin"],      // optional
  "remoteIp": "1.2.3.4",            // optional
  "silent": false,                   // optional
  "isRepair": false,                 // optional
  "ts": 1708700000000
}
```

### `device.pair.resolved`
A device pairing decision was made. Scope guard: `operator.pairing`.

```jsonc
{
  "requestId": "<uuid>",
  "deviceId": "...",
  "decision": "approved" | "rejected",
  "ts": 1708700000000
}
```

### `exec.approval.requested`
An execution needs approval. Scope guard: `operator.approvals`.

```jsonc
{
  "id": "<uuid>",
  "request": {
    "command": "rm -rf /tmp/cache",
    "cwd": "/home/user",
    "host": "localhost",
    "security": "...",
    "ask": "...",
    "agentId": "default",
    "resolvedPath": "/usr/bin/rm",
    "sessionKey": "main:default"
  },
  "createdAtMs": 1708700000000,
  "expiresAtMs": 1708700060000
}
```

### `exec.approval.resolved`
An execution approval decision was made. Scope guard: `operator.approvals`.

```jsonc
{
  "id": "<uuid>",
  "decision": "allow-once" | "allow-always" | "deny",
  "resolvedBy": "user@device",      // optional
  "ts": 1708700000000
}
```

### `talk.mode`
Talk mode was toggled. `dropIfSlow: true`.

```jsonc
{
  "enabled": true,
  "phase": "listening",              // optional
  "ts": 1708700000000
}
```

### `voicewake.changed`
Voice wake triggers were updated. `dropIfSlow: true`.

```jsonc
{
  "triggers": ["hey assistant", "wake up"]
}
```

### `shutdown`
Gateway shutting down.

```jsonc
{
  "reason": "service restart",
  "restartExpectedMs": 5000          // optional
}
```

### `update.available`
A gateway update is available. `dropIfSlow: true`.

```jsonc
{
  "updateAvailable": {
    "currentVersion": "2026.2.19",
    "latestVersion": "2026.2.20",
    "channel": "stable"
  }
}
```

---

## 6. HTTP Endpoints

### 6.1 OpenAI-Compatible: Chat Completions

**`POST /v1/chat/completions`**

OpenAI API-compatible endpoint for chat completions.

**Authentication:** `Authorization: Bearer <token>`
**Max Body:** 1 MB
**Content-Type:** `application/json`

**Request:**
```jsonc
{
  "model": "openclaw",                // optional (default: "openclaw")
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": false,                    // optional
  "user": "user-123"                  // optional, maps to session key
}
```

**Message roles:** `system`, `developer`, `user`, `assistant`, `function`, `tool`

**Non-streaming response:**
```jsonc
{
  "id": "chatcmpl_<uuid>",
  "object": "chat.completion",
  "created": 1708700000,
  "model": "openclaw",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello! How can I help?" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

**Streaming response (SSE):**
```
data: {"id":"chatcmpl_...","object":"chat.completion.chunk","created":...,"model":"openclaw","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl_...","object":"chat.completion.chunk","created":...,"model":"openclaw","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl_...","object":"chat.completion.chunk","created":...,"model":"openclaw","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

### 6.2 OpenResponses API

**`POST /v1/responses`**

OpenResponses API for structured response creation with tool use.

**Authentication:** `Authorization: Bearer <token>`
**Max Body:** 20 MB (configurable via `config.gateway.responses.maxBodyBytes`)
**Content-Type:** `application/json`

**Request:**
```jsonc
{
  "model": "openclaw",
  "input": "Hello!" | [                // string or array of items
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Hello!" },
        { "type": "input_image", "image_url": "https://..." },
        { "type": "input_file", "filename": "doc.pdf", "file_data": "base64..." }
      ]
    },
    {
      "type": "function_call_output",
      "call_id": "call_123",
      "output": "{\"result\": \"data\"}"
    }
  ],
  "instructions": "Be helpful",        // optional system instructions
  "tools": [                            // optional
    {
      "type": "function",
      "name": "search",
      "description": "Search the web",
      "parameters": { ... }             // JSON Schema
    }
  ],
  "tool_choice": "none" | "required" | { "type": "function", "function": { "name": "search" } },
  "max_output_tokens": 4096,           // optional
  "stream": true,                       // optional
  "user": "user-123"                    // optional
}
```

**Non-streaming response:**
```jsonc
{
  "id": "resp_<uuid>",
  "object": "response",
  "created_at": 1708700000,
  "status": "completed" | "incomplete" | "failed",
  "model": "openclaw",
  "output": [
    {
      "type": "message",
      "id": "msg_<uuid>",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "Hello!" }],
      "status": "completed"
    },
    {
      "type": "function_call",
      "id": "fc_<uuid>",
      "name": "search",
      "arguments": "{\"query\": \"...\"}"
    }
  ],
  "usage": { "input_tokens": 100, "output_tokens": 50, "total_tokens": 150 },
  "error": null
}
```

**Streaming SSE event types:**

| Event Type | Description |
|---|---|
| `response.created` | Initial response object created |
| `response.in_progress` | Response processing started |
| `response.output_item.added` | New output item (message or function_call) |
| `response.content_part.added` | New content part within an item |
| `response.output_text.delta` | Streaming text chunk: `{ "delta": "Hello" }` |
| `response.output_text.done` | Text content completed |
| `response.content_part.done` | Content part completed |
| `response.output_item.done` | Output item completed |
| `response.completed` | Full response completed |
| `response.failed` | Response failed with error |

**Input validation:**
- Image MIME type validation (configurable allowlist)
- File size limits (configurable)
- URL allowlist support
- Max URL parts limit (default: 8)

---

### 6.3 Hooks (Webhooks)

Base path is configurable (default: `/hooks`).

#### `POST {basePath}/wake`
Wake the system via webhook.

**Authentication:** `Authorization: Bearer <token>` or `X-OpenClaw-Token: <token>`
**Max Body:** 256 KB (default)

**Request:**
```jsonc
{
  "text": "Time to wake up!",
  "mode": "now" | "next-heartbeat"    // optional, default: "now"
}
```

**Response:** `{ "ok": true, "mode": "now" }`

#### `POST {basePath}/agent`
Dispatch a message to an agent via webhook.

**Authentication:** `Authorization: Bearer <token>` or `X-OpenClaw-Token: <token>`
**Max Body:** 256 KB (default)

**Request:**
```jsonc
{
  "message": "Generate the report",
  "name": "Hook",                      // optional, display name
  "agentId": "default",               // optional
  "wakeMode": "now",                   // optional: "now" | "next-heartbeat"
  "sessionKey": "...",                 // optional
  "deliver": true,                     // optional
  "channel": "discord" | "last",       // optional
  "to": "user123",                     // optional
  "model": "gpt-4",                   // optional
  "thinking": "extended",              // optional
  "timeoutSeconds": 300                // optional
}
```

**Response:** `202 Accepted` with `{ "ok": true, "runId": "<uuid>" }`

#### `POST {basePath}/{mapping}`
Custom webhook mappings (developer-defined via config).

**Authentication:** Bearer token
**Response varies** by mapping action: `200`, `202`, or `204 No Content`.

**Rate limiting:** 20 auth failures per 60 seconds per IP. Returns `429` with `Retry-After` header.

---

### 6.4 Tools Invocation

#### `POST /tools/invoke`
Directly invoke a tool.

**Authentication:** `Authorization: Bearer <token>`
**Max Body:** 2 MB (configurable)

**Optional headers:**
- `X-OpenClaw-Message-Channel` &mdash; Channel for policy inheritance
- `X-OpenClaw-Account-Id` &mdash; Account ID for policy

**Request:**
```jsonc
{
  "tool": "web-search",
  "action": "search",                 // optional
  "args": { "query": "..." },         // optional
  "sessionKey": "main:default",       // optional
  "dryRun": false                     // optional
}
```

**Success response:**
```jsonc
{ "ok": true, "result": { ... } }
```

**Error response:**
```jsonc
{
  "ok": false,
  "error": {
    "type": "not_found" | "invalid_request" | "tool_error",
    "message": "Tool 'xyz' not found"
  }
}
```

**Status codes:** `200` (success), `400` (invalid), `401` (auth), `404` (tool not found), `405` (method), `500` (error)

---

### 6.5 Canvas & Control UI

| Route | Method | Description |
|---|---|---|
| `/a2ui/*` | GET, POST, WS | Canvas A2UI application hosting |
| `/canvas/*` | GET, POST, WS | Canvas host handler |
| `/canvas/ws` | WS Upgrade | Canvas WebSocket connection |
| `{controlUiBasePath}/avatar/*` | GET | Agent avatar images |
| `{controlUiBasePath}/*` | GET | Control UI static assets (HTML/CSS/JS) |

---

## 7. Constants & Limits

| Constant | Value | Description |
|---|---|---|
| `PROTOCOL_VERSION` | `3` | Current protocol version |
| `MAX_PAYLOAD_BYTES` | 26,214,400 (25 MB) | Max WebSocket frame |
| `MAX_BUFFERED_BYTES` | 52,428,800 (50 MB) | Max send buffer per connection |
| `DEFAULT_HANDSHAKE_TIMEOUT_MS` | 10,000 | Connect handshake deadline |
| `TICK_INTERVAL_MS` | 30,000 | Tick event interval |
| `HEALTH_REFRESH_INTERVAL_MS` | 60,000 | Health event interval |
| `DEDUPE_TTL_MS` | 300,000 | Idempotency key TTL (5 min) |
| `DEDUPE_MAX` | 1,000 | Max cached dedup keys |
| `MAX_CHAT_HISTORY_BYTES` | 6,291,456 (6 MB) | Chat history response cap |
| `SESSION_LABEL_MAX_LENGTH` | 64 | Max session label length |
| `DEVICE_SIGNATURE_SKEW_MS` | 600,000 | Device signature age tolerance (10 min) |
| `CONTROL_PLANE_RATE_LIMIT` | 3 per 60s | config.apply/patch, update.run |
| `AUTH_RATE_LIMIT` | 20 per 60s | Per-IP auth failure limit |
| Hook Max Body | 262,144 (256 KB) | Default hook body size |
| OpenAI Max Body | 1,048,576 (1 MB) | OpenAI endpoint body size |
| OpenResponses Max Body | 20,971,520 (20 MB) | Responses endpoint body size |
| Tools Max Body | 2,097,152 (2 MB) | Tools invoke body size |

---

## 8. Enumerations Reference

### Client IDs

| Value | Description |
|---|---|
| `webchat-ui` | Webchat UI interface |
| `openclaw-control-ui` | Control panel UI |
| `webchat` | Webchat client |
| `cli` | Command-line interface |
| `gateway-client` | Gateway API client |
| `openclaw-macos` | macOS native app |
| `openclaw-ios` | iOS native app |
| `openclaw-android` | Android native app |
| `node-host` | Remote execution node |
| `test` | Test client |
| `fingerprint` | Fingerprint client |
| `openclaw-probe` | Health probe client |

### Client Modes

| Value | Description |
|---|---|
| `webchat` | Webchat interface mode |
| `cli` | Command-line mode |
| `ui` | General UI mode |
| `backend` | Backend/API mode |
| `node` | Node execution mode |
| `probe` | Health probe mode |
| `test` | Test mode |

### Client Capabilities

| Value | Description |
|---|---|
| `tool-events` | Client can receive tool execution events |

### Input Provenance Kinds

| Value | Description |
|---|---|
| `external_user` | Message from an external user |
| `inter_session` | Message from another session |
| `internal_system` | System-generated message |

### WebSocket Close Codes

| Code | Reason | Description |
|---|---|---|
| `1000` | `"handshake-timeout"` | Client didn't complete connect in time |
| `1002` | `"protocol mismatch"` | Protocol version negotiation failed |
| `1008` | `"slow consumer"` | Client send buffer exceeded limit |
| `1008` | `"invalid handshake"` | Authentication or validation failed |
| `1012` | `"service restart"` | Gateway shutting down for restart |

---

## 9. Sequence Diagrams

### Full Connection Lifecycle

```
CLIENT                                                  SERVER
  |                                                       |
  |========= WebSocket Upgrade (HTTP 101) ===============>|
  |                                                       |
  |<-------- event: connect.challenge { nonce, ts } ------|
  |                                                       |
  |--------- req: connect { ConnectParams } ------------->|
  |           - protocol negotiation                      |
  |           - client identity                           |
  |           - device signature + nonce                  |
  |           - auth token/password                       |
  |                                                       |
  |           [Server validates signature, auth, scopes]  |
  |           [Server registers presence]                 |
  |           [Server issues device token if new]         |
  |                                                       |
  |<-------- res: hello-ok { snapshot, features, ... } ---|
  |                                                       |
  |<-------- event: presence (initial snapshot) ----------|
  |<-------- event: health (initial snapshot) ------------|
  |                                                       |
  |--------- req: chat.send { message, ... } ------------>|
  |<-------- res: { ok: true, runId } -------------------|
  |<-------- event: chat { state:"delta", message } -----|
  |<-------- event: chat { state:"delta", message } -----|
  |<-------- event: agent { stream:"tool", ... } --------|
  |<-------- event: chat { state:"final", message } -----|
  |                                                       |
  |<-------- event: tick { ts } ---------------------- (30s)
  |<-------- event: health { ... } ------------------- (60s)
  |                                                       |
  |<-------- event: shutdown { reason } ------------------|
  |<======== WebSocket Close (1012) ======================|
```

### Agent Execution Flow

```
CLIENT                                                  SERVER
  |                                                       |
  |--------- req: agent { message, agentId, ... } ------>|
  |<-------- res: { ok: true } --------------------------|
  |                                                       |
  |<-------- event: agent { stream:"lifecycle",           |
  |                         data: { state:"started" } }  |
  |                                                       |
  |<-------- event: agent { stream:"assistant",           |
  |                         data: { delta:"Hello" } }    |
  |                                                       |
  |<-------- event: agent { stream:"tool",                |
  |                         data: { name:"search" } }    |
  |                                                       |
  |<-------- event: agent { stream:"assistant",           |
  |                         data: { delta:"Based on" } } |
  |                                                       |
  |<-------- event: agent { stream:"lifecycle",           |
  |                         data: { state:"completed" } }|
```

### Execution Approval Flow

```
CLIENT A (Node)                    SERVER              CLIENT B (Operator)
  |                                  |                       |
  |--- req: exec.approval.request ->|                       |
  |    { command: "rm -rf /tmp" }   |                       |
  |<-- res: { ok: true, id }  -----|                       |
  |                                  |--- event: exec.approval.requested -->|
  |                                  |    { id, request, expiresAtMs }      |
  |                                  |                       |
  |                                  |<-- req: exec.approval.resolve -------|
  |                                  |    { id, decision: "allow-once" }    |
  |                                  |                       |
  |<-- event: exec.approval.resolved |--- event: exec.approval.resolved -->|
  |    { id, decision }             |    { id, decision }                  |
```
