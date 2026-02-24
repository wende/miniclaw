import type { Server, ServerWebSocket } from "bun";
import { ConversationLogger } from "./conversation-logger.ts";
import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
  ConnectParams,
  ChatSendParams,
  ChatAbortParams,
  ChatHistoryParams,
  ChatInjectParams,
  AgentParams,
  AgentWaitParams,
  SendParams,
  SessionsResetParams,
  SessionsDeleteParams,
  SessionsPatchParams,
  PresenceEntry,
  StateVersion,
  ServerConfig,
  ContentPart,
  Role,
  ErrorCode,
} from "./types.ts";
import { matchResponse, type ToolCall } from "./demo-responses.ts";

// ── Constants (§7) ──────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 3;
const DEFAULT_TICK_INTERVAL_MS = 30_000;           // §7
const DEFAULT_HEALTH_REFRESH_INTERVAL_MS = 60_000; // §7
const DEFAULT_MAX_PAYLOAD = 26_214_400;            // 25 MB per §7
const DEFAULT_MAX_BUFFERED_BYTES = 52_428_800;     // 50 MB per §7
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;       // §7
const DEFAULT_DEDUPE_TTL_MS = 300_000;             // 5 min per §7
const DEFAULT_DEDUPE_MAX = 1_000;                  // §7
const SESSION_LABEL_MAX_LENGTH = 64;               // §7

// ── Connection State ─────────────────────────────────────────────────────────

interface ConnectionData {
  connId: string;
  authenticated: boolean;
  challengeSent: boolean;
  nonce: string;
  clientInfo?: ConnectParams["client"];
  role?: Role;
  scopes?: string[];
  caps?: string[];
}

// ── Run State ────────────────────────────────────────────────────────────────

export interface Run {
  runId: string;
  sessionKey: string;
  message: string;
  seq: number;
  state: "running" | "completed" | "error" | "aborted";
  accumulatedText: string;
  accumulatedThinking: string;
  abortController: AbortController;
  waitResolvers: Array<(result: Record<string, unknown>) => void>;
}

// ── Chat History Entry ───────────────────────────────────────────────────────

export interface HistoryEntry {
  role: "user" | "assistant";
  content: ContentPart[];
  timestamp: number;
  stopReason?: string;
  model?: string;
  provider?: string;
}

// ── Resolved Config ──────────────────────────────────────────────────────────

interface ResolvedConfig {
  port: number;
  hostname: string;
  authToken: string;
  authPassword: string;
  serverVersion: string;
  tickIntervalMs: number;
  healthRefreshIntervalMs: number;
  maxPayload: number;
  handshakeTimeoutMs: number;
  dedupeMaxKeys: number;
  dedupeTtlMs: number;
  greeting?: string;
}

// ── Method Handler ───────────────────────────────────────────────────────────

type MethodHandler = (
  ws: ServerWebSocket<ConnectionData>,
  id: string,
  params: Record<string, unknown>
) => void | Promise<void>;

// ── MiniClaw Server ──────────────────────────────────────────────────────────

export class MiniClawServer {
  private server: Server<ConnectionData> | null = null;
  private config: ResolvedConfig;
  private clients = new Set<ServerWebSocket<ConnectionData>>();
  private presence: PresenceEntry[] = [];
  private stateVersion: StateVersion = { presence: 0, health: 0 };
  private health: Record<string, unknown> = {};
  private runs = new Map<string, Run>();
  private chatHistory = new Map<string, HistoryEntry[]>();
  private idempotencyKeys = new Map<string, number>(); // key → timestamp (§2.8)
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private dedupeCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private handshakeTimeouts = new Map<
    ServerWebSocket<ConnectionData>,
    ReturnType<typeof setTimeout>
  >();
  private startTime = Date.now();
  private connCounter = 0;
  private runCounter = 0;
  private globalSeq = 0;
  private methods: Map<string, MethodHandler>;
  private sessionMeta = new Map<
    string,
    { label?: string; createdAt: number; lastActiveAt: number; patches: Record<string, unknown> }
  >();

  // Allow external agent handler injection
  onAgentRun?: (run: Run, ws: ServerWebSocket<unknown> | null) => Promise<void>;

  // Current model name (set by Ollama handler or default)
  currentModel = "demo";
  currentProvider = "miniclaw";

  private logger: ConversationLogger | null = null;

  constructor(config: ServerConfig) {
    this.config = {
      port: config.port,
      hostname: config.hostname ?? "localhost",
      authToken: config.authToken ?? "",
      authPassword: config.authPassword ?? "",
      serverVersion: config.serverVersion ?? "2026.2.23",
      tickIntervalMs: config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
      healthRefreshIntervalMs:
        config.healthRefreshIntervalMs ?? DEFAULT_HEALTH_REFRESH_INTERVAL_MS,
      maxPayload: config.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      handshakeTimeoutMs:
        config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      dedupeMaxKeys: config.dedupeMaxKeys ?? DEFAULT_DEDUPE_MAX,
      dedupeTtlMs: config.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS,
      greeting: config.greeting,
    };

    if (config.logDir) {
      this.logger = new ConversationLogger(config.logDir);
    }

    // ── Method Registry ─────────────────────────────────────────────────────
    // Methods with real implementations have named handler methods.
    // Stubs use inline arrow functions returning a TODO response.

    this.methods = new Map<string, MethodHandler>([
      // ── Agent (§4.1) ──────────────────────────────────────────────────────
      ["agent", this.handleAgent.bind(this)],
      ["agent.identity.get", (ws, id) =>
        this.stub(ws, id, "Return agent identity — §4.1 agent.identity.get")],
      ["agent.wait", this.handleAgentWait.bind(this)],
      ["wake", (ws, id) =>
        this.stub(ws, id, "Wake agent for voice/push — §4.1 wake")],

      // ── Agent Management (§4.2) ───────────────────────────────────────────
      ["agents.list", (ws, id) =>
        this.stub(ws, id, "List all agents — §4.2 agents.list")],
      ["agents.create", (ws, id) =>
        this.stub(ws, id, "Create a new agent — §4.2 agents.create")],
      ["agents.update", (ws, id) =>
        this.stub(ws, id, "Update agent settings — §4.2 agents.update")],
      ["agents.delete", (ws, id) =>
        this.stub(ws, id, "Delete an agent — §4.2 agents.delete")],
      ["agents.files.list", (ws, id) =>
        this.stub(ws, id, "List agent files — §4.2 agents.files.list")],
      ["agents.files.get", (ws, id) =>
        this.stub(ws, id, "Get agent file content — §4.2 agents.files.get")],
      ["agents.files.set", (ws, id) =>
        this.stub(ws, id, "Set agent file content — §4.2 agents.files.set")],

      // ── Chat (§4.3) ───────────────────────────────────────────────────────
      ["chat.send", this.handleChatSend.bind(this)],
      ["chat.abort", this.handleChatAbort.bind(this)],
      ["chat.history", this.handleChatHistory.bind(this)],
      ["chat.inject", this.handleChatInject.bind(this)],
      ["chat.subscribe", this.handleChatSubscribe.bind(this)],

      // ── Sessions (§4.4) ───────────────────────────────────────────────────
      ["sessions.list", this.handleSessionsList.bind(this)],
      ["sessions.preview", (ws, id) =>
        this.stub(ws, id, "Preview session transcripts — §4.4 sessions.preview")],
      ["sessions.resolve", (ws, id) =>
        this.stub(ws, id, "Resolve session by criteria — §4.4 sessions.resolve")],
      ["sessions.patch", this.handleSessionsPatch.bind(this)],
      ["sessions.reset", this.handleSessionsReset.bind(this)],
      ["sessions.delete", this.handleSessionsDelete.bind(this)],
      ["sessions.compact", (ws, id) =>
        this.stub(ws, id, "Compact session transcript — §4.4 sessions.compact")],
      ["sessions.usage", (ws, id) =>
        this.stub(ws, id, "Get session usage stats — §4.4 sessions.usage")],
      ["sessions.usage.timeseries", (ws, id) =>
        this.stub(ws, id, "Get usage timeseries — §4.4 sessions.usage.timeseries")],
      ["sessions.usage.logs", (ws, id) =>
        this.stub(ws, id, "Get usage logs — §4.4 sessions.usage.logs")],

      // ── Channels (§4.5) ───────────────────────────────────────────────────
      ["channels.status", (ws, id) =>
        this.stub(ws, id, "Get channel connection status — §4.5 channels.status")],
      ["channels.logout", (ws, id) =>
        this.stub(ws, id, "Logout from a channel — §4.5 channels.logout")],

      // ── Configuration (§4.6) ──────────────────────────────────────────────
      ["config.get", this.handleConfigGet.bind(this)],
      ["config.set", (ws, id) =>
        this.stub(ws, id, "Set full config YAML — §4.6 config.set")],
      ["config.apply", (ws, id) =>
        this.stub(ws, id, "Apply config and restart — §4.6 config.apply")],
      ["config.patch", (ws, id) =>
        this.stub(ws, id, "Patch config YAML — §4.6 config.patch")],
      ["config.schema", (ws, id) =>
        this.stub(ws, id, "Get config JSON schema — §4.6 config.schema")],

      // ── Cron (§4.7) ───────────────────────────────────────────────────────
      ["cron.list", (ws, id) =>
        this.stub(ws, id, "List cron jobs — §4.7 cron.list")],
      ["cron.status", (ws, id) =>
        this.stub(ws, id, "Get cron scheduler status — §4.7 cron.status")],
      ["cron.add", (ws, id) =>
        this.stub(ws, id, "Add a cron job — §4.7 cron.add")],
      ["cron.update", (ws, id) =>
        this.stub(ws, id, "Update a cron job — §4.7 cron.update")],
      ["cron.remove", (ws, id) =>
        this.stub(ws, id, "Remove a cron job — §4.7 cron.remove")],
      ["cron.run", (ws, id) =>
        this.stub(ws, id, "Trigger a cron job manually — §4.7 cron.run")],
      ["cron.runs", (ws, id) =>
        this.stub(ws, id, "List cron job run history — §4.7 cron.runs")],

      // ── Devices (§4.8) ────────────────────────────────────────────────────
      ["device.pair.list", (ws, id) =>
        this.stub(ws, id, "List paired/pending devices — §4.8 device.pair.list")],
      ["device.pair.approve", (ws, id) =>
        this.stub(ws, id, "Approve device pairing — §4.8 device.pair.approve")],
      ["device.pair.reject", (ws, id) =>
        this.stub(ws, id, "Reject device pairing — §4.8 device.pair.reject")],
      ["device.pair.remove", (ws, id) =>
        this.stub(ws, id, "Remove a paired device — §4.8 device.pair.remove")],
      ["device.token.rotate", (ws, id) =>
        this.stub(ws, id, "Rotate device token — §4.8 device.token.rotate")],
      ["device.token.revoke", (ws, id) =>
        this.stub(ws, id, "Revoke device token — §4.8 device.token.revoke")],

      // ── Nodes (§4.9) ──────────────────────────────────────────────────────
      ["node.list", (ws, id) =>
        this.stub(ws, id, "List connected nodes — §4.9 node.list")],
      ["node.describe", (ws, id) =>
        this.stub(ws, id, "Describe a node — §4.9 node.describe")],
      ["node.pair.request", (ws, id) =>
        this.stub(ws, id, "Request node pairing — §4.9 node.pair.request")],
      ["node.pair.list", (ws, id) =>
        this.stub(ws, id, "List node pairing requests — §4.9 node.pair.list")],
      ["node.pair.approve", (ws, id) =>
        this.stub(ws, id, "Approve node pairing — §4.9 node.pair.approve")],
      ["node.pair.reject", (ws, id) =>
        this.stub(ws, id, "Reject node pairing — §4.9 node.pair.reject")],
      ["node.pair.verify", (ws, id) =>
        this.stub(ws, id, "Verify node pairing — §4.9 node.pair.verify")],
      ["node.rename", (ws, id) =>
        this.stub(ws, id, "Rename a node — §4.9 node.rename")],
      ["node.invoke", (ws, id) =>
        this.stub(ws, id, "Invoke command on node — §4.9 node.invoke")],
      ["node.invoke.result", (ws, id) =>
        this.stub(ws, id, "Return invoke result (node→server) — §4.9 node.invoke.result")],
      ["node.event", (ws, id) =>
        this.stub(ws, id, "Send node event — §4.9 node.event")],

      // ── Execution Approvals (§4.10) ───────────────────────────────────────
      ["exec.approval.request", (ws, id) =>
        this.stub(ws, id, "Request execution approval — §4.10 exec.approval.request")],
      ["exec.approval.waitDecision", (ws, id) =>
        this.stub(ws, id, "Wait for approval decision — §4.10 exec.approval.waitDecision")],
      ["exec.approval.resolve", (ws, id) =>
        this.stub(ws, id, "Resolve approval request — §4.10 exec.approval.resolve")],
      ["exec.approvals.get", (ws, id) =>
        this.stub(ws, id, "Get approval rules — §4.10 exec.approvals.get")],
      ["exec.approvals.set", (ws, id) =>
        this.stub(ws, id, "Set approval rules — §4.10 exec.approvals.set")],
      ["exec.approvals.node.get", (ws, id) =>
        this.stub(ws, id, "Get node approval rules — §4.10 exec.approvals.node.get")],
      ["exec.approvals.node.set", (ws, id) =>
        this.stub(ws, id, "Set node approval rules — §4.10 exec.approvals.node.set")],

      // ── Models & Skills (§4.11) ───────────────────────────────────────────
      ["models.list", this.handleModelsList.bind(this)],
      ["skills.status", (ws, id) =>
        this.stub(ws, id, "Get skills status — §4.11 skills.status")],
      ["skills.bins", (ws, id) =>
        this.stub(ws, id, "List skill binaries (node) — §4.11 skills.bins")],
      ["skills.install", (ws, id) =>
        this.stub(ws, id, "Install a skill — §4.11 skills.install")],
      ["skills.update", (ws, id) =>
        this.stub(ws, id, "Update skill config — §4.11 skills.update")],

      // ── Talk & TTS (§4.12) ────────────────────────────────────────────────
      ["talk.config", (ws, id) =>
        this.stub(ws, id, "Get talk/voice config — §4.12 talk.config")],
      ["talk.mode", (ws, id) =>
        this.stub(ws, id, "Toggle talk mode — §4.12 talk.mode")],
      ["tts.status", (ws, id) =>
        this.stub(ws, id, "Get TTS status — §4.12 tts.status")],
      ["tts.enable", (ws, id) =>
        this.stub(ws, id, "Enable TTS — §4.12 tts.enable")],
      ["tts.disable", (ws, id) =>
        this.stub(ws, id, "Disable TTS — §4.12 tts.disable")],
      ["tts.convert", (ws, id) =>
        this.stub(ws, id, "Convert text to speech — §4.12 tts.convert")],
      ["tts.setProvider", (ws, id) =>
        this.stub(ws, id, "Set TTS provider — §4.12 tts.setProvider")],
      ["tts.providers", (ws, id) =>
        this.stub(ws, id, "List TTS providers — §4.12 tts.providers")],

      // ── System & Health (§4.13) ───────────────────────────────────────────
      ["health", this.handleHealth.bind(this)],
      ["status", this.handleStatus.bind(this)],
      ["system-presence", (ws, id) =>
        this.sendResponse(ws, id, { presence: this.presence })],
      ["last-heartbeat", (ws, id) =>
        this.stub(ws, id, "Get last heartbeat info — §4.13 last-heartbeat")],
      ["set-heartbeats", (ws, id) =>
        this.stub(ws, id, "Configure heartbeat behavior — §4.13 set-heartbeats")],
      ["system-event", (ws, id) =>
        this.stub(ws, id, "Emit system event — §4.13 system-event")],

      // ── Wizard (§4.14) ────────────────────────────────────────────────────
      ["wizard.start", (ws, id) =>
        this.stub(ws, id, "Start setup wizard — §4.14 wizard.start")],
      ["wizard.next", (ws, id) =>
        this.stub(ws, id, "Advance wizard step — §4.14 wizard.next")],
      ["wizard.cancel", (ws, id) =>
        this.stub(ws, id, "Cancel wizard — §4.14 wizard.cancel")],
      ["wizard.status", (ws, id) =>
        this.stub(ws, id, "Get wizard status — §4.14 wizard.status")],

      // ── Messaging (§4.15) ─────────────────────────────────────────────────
      ["send", this.handleSend.bind(this)],
      ["poll", (ws, id) =>
        this.stub(ws, id, "Create a poll — §4.15 poll")],

      // ── Browser (§4.16) ───────────────────────────────────────────────────
      ["browser.request", (ws, id) =>
        this.stub(ws, id, "Request browser action — §4.16 browser.request")],

      // ── Push (§4.17) ──────────────────────────────────────────────────────
      ["push.test", (ws, id) =>
        this.stub(ws, id, "Send test push notification — §4.17 push.test")],

      // ── Update (§4.18) ────────────────────────────────────────────────────
      ["update.run", (ws, id) =>
        this.stub(ws, id, "Run server update — §4.18 update.run")],

      // ── Logs (§4.19) ──────────────────────────────────────────────────────
      ["logs.tail", this.handleLogsTail.bind(this)],

      // ── Voice Wake (§4.20) ────────────────────────────────────────────────
      ["voicewake.get", (ws, id) =>
        this.stub(ws, id, "Get voice wake config — §4.20 voicewake.get")],
      ["voicewake.set", (ws, id) =>
        this.stub(ws, id, "Set voice wake config — §4.20 voicewake.set")],

      // ── Web Login (§4.21) ─────────────────────────────────────────────────
      ["web.login.start", (ws, id) =>
        this.stub(ws, id, "Start web login flow — §4.21 web.login.start")],
      ["web.login.wait", (ws, id) =>
        this.stub(ws, id, "Wait for web login completion — §4.21 web.login.wait")],

      // ── Usage (§4.22) ─────────────────────────────────────────────────────
      ["usage.status", (ws, id) =>
        this.stub(ws, id, "Get usage status — §4.22 usage.status")],
      ["usage.cost", (ws, id) =>
        this.stub(ws, id, "Get usage cost breakdown — §4.22 usage.cost")],
    ]);
  }

  // ── Server Lifecycle ──────────────────────────────────────────────────────

  start(): Server<ConnectionData> {
    const self = this;

    this.server = Bun.serve<ConnectionData>({
      port: this.config.port,
      hostname: this.config.hostname,
      fetch(req, server) {
        const url = new URL(req.url);

        // §6: HTTP Endpoints — route before attempting WebSocket upgrade
        const httpResponse = self.handleHttpRequest(req, url);
        if (httpResponse) return httpResponse;

        // WebSocket upgrade
        const upgraded = server.upgrade(req, {
          data: {
            connId: "",
            authenticated: false,
            challengeSent: false,
            nonce: "",
          } satisfies ConnectionData,
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        return undefined;
      },
      websocket: {
        maxPayloadLength: self.config.maxPayload,
        open(ws) {
          self.handleOpen(ws);
        },
        message(ws, message) {
          self.handleMessage(ws, message as string);
        },
        close(ws) {
          self.handleClose(ws);
        },
      },
    });

    this.startTime = Date.now();
    this.startTick();
    this.startHealthRefresh();
    this.startDedupeCleanup();

    return this.server;
  }

  // ── HTTP Endpoint Routing (§6) ──────────────────────────────────────────

  private handleHttpRequest(req: Request, url: URL): Response | null {
    const method = req.method;
    const path = url.pathname;

    // Only handle known HTTP paths; return null to fall through to WebSocket
    if (path === "/v1/chat/completions" && method === "POST") {
      return this.handleHttpChatCompletions(req);
    }

    if (path === "/v1/responses" && method === "POST") {
      // #TODO Implement OpenResponses API — §6.2
      return Response.json(
        { ok: false, error: { type: "not_implemented", message: "#TODO OpenResponses API — §6.2" } },
        { status: 501 }
      );
    }

    if (path === "/hooks/wake" && method === "POST") {
      // #TODO Implement wake webhook — §6.3
      return Response.json(
        { ok: false, error: { type: "not_implemented", message: "#TODO Wake webhook — §6.3" } },
        { status: 501 }
      );
    }

    if (path === "/hooks/agent" && method === "POST") {
      // #TODO Implement agent webhook — §6.3
      return Response.json(
        { ok: false, error: { type: "not_implemented", message: "#TODO Agent webhook — §6.3" } },
        { status: 501 }
      );
    }

    if (path === "/tools/invoke" && method === "POST") {
      // #TODO Implement tools invocation — §6.4
      return Response.json(
        { ok: false, error: { type: "not_implemented", message: "#TODO Tools invocation — §6.4" } },
        { status: 501 }
      );
    }

    // Not an HTTP endpoint — fall through to WebSocket upgrade
    return null;
  }

  private handleHttpChatCompletions(req: Request): Response {
    // Auth check (§6.1)
    const authHeader = req.headers.get("authorization");
    if (this.config.authToken) {
      if (authHeader !== `Bearer ${this.config.authToken}`) {
        return Response.json(
          { error: { message: "Unauthorized", type: "auth_error" } },
          { status: 401 }
        );
      }
    }

    // Parse body and create a streaming/non-streaming response
    // This is a simplified implementation that uses chatAndWait internally
    const self = this;

    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            const body = await req.json() as {
              model?: string;
              messages?: Array<{ role: string; content: string }>;
              stream?: boolean;
              user?: string;
            };

            const messages = body.messages ?? [];
            const lastUserMsg = messages.filter((m) => m.role === "user").pop();
            const message = lastUserMsg?.content ?? "";
            const sessionKey = body.user ?? "http-default";
            const isStream = body.stream ?? false;
            const completionId = `chatcmpl_${crypto.randomUUID().slice(0, 8)}`;
            const created = Math.floor(Date.now() / 1000);
            const model = body.model ?? self.currentModel;

            // Inject system messages into history
            for (const msg of messages) {
              if (msg.role === "system" || msg.role === "developer") {
                self.appendHistory(sessionKey, {
                  role: "user",
                  content: [{ type: "text", text: `[System] ${msg.content}` }],
                  timestamp: Date.now(),
                });
              }
            }

            const responseText = await self.chatAndWait(sessionKey, message);

            if (isStream) {
              // SSE streaming (§6.1)
              const encoder = new TextEncoder();

              // Role chunk
              const roleChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

              // Content chunk
              const contentChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

              // Done chunk
              const doneChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } else {
              // Non-streaming response (§6.1)
              const result = {
                id: completionId,
                object: "chat.completion",
                created,
                model,
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: responseText },
                  finish_reason: "stop",
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              };
              controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
            }

            controller.close();
          } catch (err) {
            const errResponse = JSON.stringify({
              error: { message: String(err), type: "server_error" },
            });
            controller.enqueue(new TextEncoder().encode(errResponse));
            controller.close();
          }
        },
      }),
      {
        headers: {
          "Content-Type": req.headers.get("accept")?.includes("text/event-stream")
            ? "text/event-stream"
            : "application/json",
        },
      }
    );
  }

  stop() {
    this.broadcastEvent("shutdown", { reason: "server_stop" });

    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.dedupeCleanupInterval) clearInterval(this.dedupeCleanupInterval);

    // Clear handshake timeouts
    for (const timer of this.handshakeTimeouts.values()) {
      clearTimeout(timer);
    }
    this.handshakeTimeouts.clear();

    // Abort all running runs
    for (const run of this.runs.values()) {
      if (run.state === "running") {
        run.abortController.abort();
        run.state = "aborted";
      }
    }

    this.server?.stop(true);
    this.server = null;
  }

  get port(): number {
    return this.server?.port ?? this.config.port;
  }

  get url(): string {
    return `ws://${this.config.hostname}:${this.port}`;
  }

  getChatHistory(sessionKey: string): HistoryEntry[] {
    return this.chatHistory.get(sessionKey) ?? [];
  }

  async chatAndWait(sessionKey: string, message: string): Promise<string> {
    const run = this.createRun(sessionKey, message);

    this.appendHistory(sessionKey, {
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    });

    const promise = new Promise<string>((resolve) => {
      run.waitResolvers.push((result) => {
        resolve((result["text"] as string) ?? "");
      });
    });

    // Execute without a WebSocket — events broadcast to connected clients (if any)
    this.executeRun(run, null);

    return promise;
  }

  clearSession(sessionKey: string): void {
    this.chatHistory.delete(sessionKey);
    this.sessionMeta.delete(sessionKey);
  }

  // ── Connection Lifecycle ──────────────────────────────────────────────────

  private handleOpen(ws: ServerWebSocket<ConnectionData>) {
    this.connCounter++;
    ws.data.connId = `conn_${this.connCounter.toString(36)}`;

    // §2.1: Handshake timeout — close if connect not received within timeout
    const timer = setTimeout(() => {
      if (!ws.data.authenticated) {
        ws.close(1008, "Handshake timeout");
      }
      this.handshakeTimeouts.delete(ws);
    }, this.config.handshakeTimeoutMs);
    this.handshakeTimeouts.set(ws, timer);

    // Server-initiated handshake: send hello + connect.challenge
    const nonce = crypto.randomUUID();
    ws.data.nonce = nonce;
    ws.data.challengeSent = true;

    // Step 1: Send hello
    ws.send(
      JSON.stringify({
        type: "hello",
        sessionId: ws.data.connId,
        mode: "webchat",
        clientName: "miniclaw",
      })
    );

    // Step 2: Send connect.challenge event (§2.3)
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce, ts: Date.now() },
        seq: 0,
      })
    );
  }

  private handleMessage(
    ws: ServerWebSocket<ConnectionData>,
    raw: string
  ) {
    // §2.8: Check payload size
    if (raw.length > this.config.maxPayload) {
      this.sendError(ws, "unknown", "INVALID_REQUEST", "Payload too large");
      ws.close(1009, "Payload too large");
      return;
    }

    let frame: RequestFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.sendError(ws, "unknown", "INVALID_REQUEST", "Malformed JSON");
      return;
    }

    if (frame.type !== "req") {
      this.sendError(ws, "unknown", "INVALID_REQUEST", "Expected type: req");
      return;
    }

    if (!frame.id || !frame.method) {
      this.sendError(
        ws,
        frame.id ?? "unknown",
        "INVALID_REQUEST",
        "Missing id or method"
      );
      return;
    }

    // First message must be connect (§2.1)
    if (!ws.data.authenticated) {
      if (frame.method !== "connect") {
        this.sendError(
          ws,
          frame.id,
          "INVALID_REQUEST",
          "First message must be connect"
        );
        ws.close(1008, "First message must be connect");
        return;
      }
      this.handleConnect(ws, frame);
      return;
    }

    // Route to method handler
    const handler = this.methods.get(frame.method);
    if (!handler) {
      this.sendError(
        ws,
        frame.id,
        "INVALID_REQUEST",
        `Unknown method: ${frame.method}`
      );
      return;
    }

    handler(ws, frame.id, frame.params ?? {});
  }

  private handleClose(ws: ServerWebSocket<ConnectionData>) {
    // Clear handshake timeout if still pending
    const timer = this.handshakeTimeouts.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimeouts.delete(ws);
    }

    this.clients.delete(ws);
    if (ws.data.authenticated) {
      this.removePresence(ws.data.connId);
      this.broadcastPresence();
    }
  }

  // ── Handshake (§2.3) ─────────────────────────────────────────────────────

  private handleConnect(
    ws: ServerWebSocket<ConnectionData>,
    frame: RequestFrame
  ) {
    // Clear handshake timeout
    const timer = this.handshakeTimeouts.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.handshakeTimeouts.delete(ws);
    }

    const params = frame.params as unknown as ConnectParams | undefined;

    if (!params?.client?.id || !params?.client?.version) {
      this.sendError(
        ws,
        frame.id,
        "INVALID_REQUEST",
        "Missing client.id or client.version"
      );
      ws.close(1008, "Invalid connect params");
      return;
    }

    // Protocol version check (§2.3)
    const min = params.minProtocol ?? 1;
    const max = params.maxProtocol ?? 1;
    if (PROTOCOL_VERSION < min || PROTOCOL_VERSION > max) {
      this.sendError(ws, frame.id, "INVALID_REQUEST", "Protocol mismatch");
      ws.close(1008, "Protocol mismatch");
      return;
    }

    // Auth check (§3.1) — supports token, password, or deviceToken modes
    if (this.config.authToken) {
      if (params.auth?.token !== this.config.authToken) {
        this.sendError(ws, frame.id, "INVALID_REQUEST", "Authentication failed");
        ws.close(1008, "Authentication failed");
        return;
      }
    } else if (this.config.authPassword) {
      if (params.auth?.password !== this.config.authPassword) {
        this.sendError(ws, frame.id, "INVALID_REQUEST", "Authentication failed");
        ws.close(1008, "Authentication failed");
        return;
      }
    }
    // #TODO Device token authentication — §3.2 device.pair flow

    // Mark authenticated
    ws.data.authenticated = true;
    ws.data.clientInfo = params.client;
    ws.data.role = params.role;
    ws.data.scopes = params.scopes;
    ws.data.caps = params.caps;

    this.clients.add(ws);

    // Add presence (§5 presence event)
    const presenceEntry: PresenceEntry = {
      host: params.client.displayName ?? params.client.id,
      version: params.client.version,
      platform: params.client.platform,
      deviceFamily: params.client.deviceFamily,
      modelIdentifier: params.client.modelIdentifier,
      mode: params.client.mode,
      ts: Date.now(),
      instanceId: ws.data.connId,
      reason: "connect",
      roles: params.role ? [params.role] : undefined,
      scopes: params.scopes,
    };
    this.presence.push(presenceEntry);
    this.stateVersion.presence++;

    // Determine auth mode for snapshot
    let authMode = "none";
    if (this.config.authToken) authMode = "token";
    else if (this.config.authPassword) authMode = "password";

    // Build supported methods/events lists (§2.3 hello-ok)
    const supportedMethods = Array.from(this.methods.keys());
    const supportedEvents = [
      "agent",
      "chat",
      "tick",
      "presence",
      "health",
      "shutdown",
      "connect.challenge",
      "config.updated",
      "exec.approval",
      "node.invoke",
      "node.event",
    ];

    // Send hello-ok response (§2.3)
    const response: ResponseFrame = {
      type: "res",
      id: frame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: PROTOCOL_VERSION,
        server: {
          version: this.config.serverVersion,
          connId: ws.data.connId,
        },
        features: {
          methods: supportedMethods,
          events: supportedEvents,
        },
        snapshot: {
          presence: this.presence,
          health: this.health,
          stateVersion: { ...this.stateVersion },
          uptimeMs: Date.now() - this.startTime,
          authMode,
          sessionDefaults: { mainSessionKey: "main" },
        },
        policy: {
          maxPayload: this.config.maxPayload,
          maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
          tickIntervalMs: this.config.tickIntervalMs,
        },
      },
    };
    ws.send(JSON.stringify(response));

    // Broadcast presence to all other clients
    this.broadcastPresence();
  }

  // ── Stub Helper ───────────────────────────────────────────────────────────

  private stub(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    todo: string
  ) {
    this.sendResponse(ws, id, { stub: true, todo: `#TODO ${todo}` });
  }

  // ── Chat Methods (§4.3) ───────────────────────────────────────────────────

  private handleChatSend(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as ChatSendParams;

    if (!p.sessionKey || !p.message || !p.idempotencyKey) {
      this.sendError(
        ws,
        id,
        "INVALID_REQUEST",
        "Missing sessionKey, message, or idempotencyKey"
      );
      return;
    }

    // Idempotency check (§2.8)
    if (this.isDuplicateKey(p.idempotencyKey)) {
      this.sendError(ws, id, "INVALID_REQUEST", "Duplicate idempotency key");
      return;
    }
    this.recordIdempotencyKey(p.idempotencyKey);

    // Ensure session meta exists
    this.ensureSessionMeta(p.sessionKey);

    const run = this.createRun(p.sessionKey, p.message);

    // Store user message in history
    this.appendHistory(p.sessionKey, {
      role: "user",
      content: [{ type: "text", text: p.message }],
      timestamp: Date.now(),
    });

    // ACK immediately
    const response: ResponseFrame = {
      type: "res",
      id,
      ok: true,
      payload: { runId: run.runId, sessionKey: p.sessionKey },
    };
    ws.send(JSON.stringify(response));

    // Start the agent run
    this.executeRun(run, ws);
  }

  private handleChatAbort(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as ChatAbortParams;

    if (!p.sessionKey) {
      this.sendError(ws, id, "INVALID_REQUEST", "Missing sessionKey");
      return;
    }

    // Find run to abort
    let targetRun: Run | undefined;
    if (p.runId) {
      targetRun = this.runs.get(p.runId);
    } else {
      // Abort the latest running run for this session
      for (const run of this.runs.values()) {
        if (run.sessionKey === p.sessionKey && run.state === "running") {
          targetRun = run;
        }
      }
    }

    if (!targetRun || targetRun.state !== "running") {
      this.sendError(ws, id, "INVALID_REQUEST", "No active run to abort");
      return;
    }

    targetRun.abortController.abort();
    targetRun.state = "aborted";

    this.sendResponse(ws, id, { runId: targetRun.runId, aborted: true });
  }

  private handleChatHistory(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as ChatHistoryParams;

    if (!p.sessionKey) {
      this.sendError(ws, id, "INVALID_REQUEST", "Missing sessionKey");
      return;
    }

    const limit = Math.min(p.limit ?? 50, 1000);
    const history = this.chatHistory.get(p.sessionKey) ?? [];
    const messages = history.slice(-limit);

    this.sendResponse(ws, id, {
      sessionKey: p.sessionKey,
      messages,
    });

    // Emit a synthetic greeting to this client when the session is empty
    if (history.length === 0 && this.config.greeting) {
      const event: EventFrame = {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: p.sessionKey,
          seq: 0,
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: this.config.greeting }],
            timestamp: Date.now(),
          },
        },
      };
      ws.send(JSON.stringify(event));
      this.appendHistory(p.sessionKey, {
        role: "assistant",
        content: [{ type: "text", text: this.config.greeting }],
        timestamp: Date.now(),
        stopReason: "end_turn",
      });
    }
  }

  private handleChatInject(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as ChatInjectParams;

    if (!p.sessionKey || !p.message) {
      this.sendError(ws, id, "INVALID_REQUEST", "Missing sessionKey or message");
      return;
    }

    // Inject a system/user message into the session history (§4.3 chat.inject)
    this.appendHistory(p.sessionKey, {
      role: "user",
      content: [{ type: "text", text: p.message }],
      timestamp: Date.now(),
    });

    this.sendResponse(ws, id, { sessionKey: p.sessionKey, injected: true });
  }

  private handleChatSubscribe(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    _params: Record<string, unknown>
  ) {
    // #TODO Track per-connection chat subscriptions for targeted event delivery
    this.sendResponse(ws, id, { subscribed: true });
  }

  // ── Agent Methods (§4.1) ──────────────────────────────────────────────────

  private handleAgent(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as AgentParams;

    if (!p.message || !p.idempotencyKey) {
      this.sendError(
        ws,
        id,
        "INVALID_REQUEST",
        "Missing message or idempotencyKey"
      );
      return;
    }

    if (this.isDuplicateKey(p.idempotencyKey)) {
      this.sendError(ws, id, "INVALID_REQUEST", "Duplicate idempotency key");
      return;
    }
    this.recordIdempotencyKey(p.idempotencyKey);

    const sessionKey = p.sessionKey ?? "default";
    this.ensureSessionMeta(sessionKey);
    const run = this.createRun(sessionKey, p.message);

    this.sendResponse(ws, id, { runId: run.runId });
    this.executeRun(run, ws);
  }

  private handleAgentWait(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as AgentWaitParams;

    if (!p.runId) {
      this.sendError(ws, id, "INVALID_REQUEST", "Missing runId");
      return;
    }

    const run = this.runs.get(p.runId);
    if (!run) {
      this.sendError(ws, id, "INVALID_REQUEST", "Unknown runId");
      return;
    }

    // Already done
    if (run.state !== "running") {
      this.sendResponse(ws, id, {
        runId: run.runId,
        state: run.state,
        text: run.accumulatedText,
      });
      return;
    }

    // Wait for completion
    const timeoutMs = p.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      this.sendError(ws, id, "AGENT_TIMEOUT", "Wait timed out");
    }, timeoutMs);

    run.waitResolvers.push((result) => {
      clearTimeout(timer);
      this.sendResponse(ws, id, result);
    });
  }

  // ── Session Methods (§4.4) ────────────────────────────────────────────────

  private handleSessionsList(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    _params: Record<string, unknown>
  ) {
    // Return all known sessions with basic metadata
    const sessions: Array<Record<string, unknown>> = [];
    for (const [key, meta] of this.sessionMeta) {
      const history = this.chatHistory.get(key);
      sessions.push({
        key,
        label: meta.label,
        createdAt: meta.createdAt,
        lastActiveAt: meta.lastActiveAt,
        messageCount: history?.length ?? 0,
      });
    }
    // Also include sessions that only have history but no meta
    for (const key of this.chatHistory.keys()) {
      if (!this.sessionMeta.has(key)) {
        const history = this.chatHistory.get(key)!;
        sessions.push({
          key,
          messageCount: history.length,
          lastActiveAt: history[history.length - 1]?.timestamp ?? 0,
        });
      }
    }
    this.sendResponse(ws, id, { sessions });
  }

  private handleSessionsPatch(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as SessionsPatchParams;

    if (!p.key) {
      this.sendError(ws, id, "INVALID_REQUEST", "Missing key");
      return;
    }

    if (p.label !== undefined && p.label !== null && p.label.length > SESSION_LABEL_MAX_LENGTH) {
      this.sendError(ws, id, "INVALID_REQUEST", `Label exceeds ${SESSION_LABEL_MAX_LENGTH} chars`);
      return;
    }

    const meta = this.ensureSessionMeta(p.key);
    // Apply patches
    const { key: _key, ...patches } = p;
    Object.assign(meta.patches, patches);
    if (p.label !== undefined) meta.label = p.label ?? undefined;

    this.sendResponse(ws, id, { key: p.key, patched: true });
  }

  private handleSessionsReset(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as SessionsResetParams;
    const sessionKey = p.key ?? (params["sessionKey"] as string) ?? "main";
    this.chatHistory.delete(sessionKey);
    this.sendResponse(ws, id, { sessionKey, reset: true });
  }

  private handleSessionsDelete(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as SessionsDeleteParams;

    if (!p.key) {
      this.sendError(ws, id, "INVALID_REQUEST", "Missing key");
      return;
    }

    this.chatHistory.delete(p.key);
    this.sessionMeta.delete(p.key);
    this.sendResponse(ws, id, { key: p.key, deleted: true });
  }

  // ── Config & Models (§4.6, §4.11) ────────────────────────────────────────

  private handleConfigGet(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    _params: Record<string, unknown>
  ) {
    // Return current runtime config (non-sensitive)
    this.sendResponse(ws, id, {
      providers: {},
      serverVersion: this.config.serverVersion,
      protocol: PROTOCOL_VERSION,
      // #TODO Return full openclaw.json parsed config — §4.6 config.get
    });
  }

  private handleModelsList(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    _params: Record<string, unknown>
  ) {
    // Return current model info
    this.sendResponse(ws, id, {
      models: [
        {
          id: this.currentModel,
          provider: this.currentProvider,
          active: true,
        },
      ],
    });
  }

  // ── Send Method (§4.15) ───────────────────────────────────────────────────

  private handleSend(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    params: Record<string, unknown>
  ) {
    const p = params as unknown as SendParams;

    if (!p.to || !p.message || !p.idempotencyKey) {
      this.sendError(
        ws,
        id,
        "INVALID_REQUEST",
        "Missing to, message, or idempotencyKey"
      );
      return;
    }

    if (this.isDuplicateKey(p.idempotencyKey)) {
      this.sendError(ws, id, "INVALID_REQUEST", "Duplicate idempotency key");
      return;
    }
    this.recordIdempotencyKey(p.idempotencyKey);

    // #TODO Route message to channel/contact — §4.15 send
    this.sendResponse(ws, id, { sent: true, to: p.to });
  }

  // ── System & Health (§4.13) ───────────────────────────────────────────────

  private handleHealth(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    _params: Record<string, unknown>
  ) {
    this.sendResponse(ws, id, {
      ...this.health,
      stateVersion: { ...this.stateVersion },
    });
  }

  private handleStatus(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    _params: Record<string, unknown>
  ) {
    this.sendResponse(ws, id, {
      protocol: PROTOCOL_VERSION,
      serverVersion: this.config.serverVersion,
      uptimeMs: Date.now() - this.startTime,
      connectedClients: this.clients.size,
      activeSessions: this.chatHistory.size,
      activeRuns: [...this.runs.values()].filter((r) => r.state === "running").length,
      model: this.currentModel,
      provider: this.currentProvider,
    });
  }

  // ── Logs (§4.19) ──────────────────────────────────────────────────────────

  private handleLogsTail(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    _params: Record<string, unknown>
  ) {
    // #TODO Implement log ring buffer and tail — §4.19 logs.tail
    this.sendResponse(ws, id, { lines: [], cursor: 0 });
  }

  // ── Slash Commands ────────────────────────────────────────────────────────

  private handleSlashCommand(
    run: Run,
    lower: string
  ): { text: string; stopReason?: string; model?: string; provider?: string } | null {
    if (lower === "/new") {
      this.chatHistory.delete(run.sessionKey);
      return { text: "Session cleared. How can I help you?" };
    }

    if (lower === "/models") {
      return {
        text: `Available models:\n- ${this.currentModel} (${this.currentProvider})`,
        model: this.currentModel,
        provider: this.currentProvider,
      };
    }

    if (lower === "/model") {
      return {
        text: `Current model: ${this.currentModel}`,
        model: this.currentModel,
        provider: this.currentProvider,
      };
    }

    if (lower.startsWith("/model ")) {
      const requested = run.message.trim().slice("/model ".length).trim();
      if (requested) {
        this.currentModel = requested;
        return {
          text: `Model set to ${requested}`,
          model: requested,
          provider: this.currentProvider,
        };
      }
      return {
        text: `Current model: ${this.currentModel}`,
        model: this.currentModel,
        provider: this.currentProvider,
      };
    }

    if (lower === "/help") {
      return {
        text: [
          "Available commands:",
          "  /new     — Start a new session",
          "  /model   — Show current model",
          "  /model <name> — Switch model",
          "  /models  — List available models",
          "  /help    — Show this help",
        ].join("\n"),
      };
    }

    // Unknown slash command — handle it so it doesn't go to the model
    return { text: `Unknown command: ${lower.split(" ")[0]}. Type /help for available commands.` };
  }

  // ── Run Execution ─────────────────────────────────────────────────────────

  private createRun(sessionKey: string, message: string): Run {
    this.runCounter++;
    const run: Run = {
      runId: `run_${this.runCounter.toString(36)}`,
      sessionKey,
      message,
      seq: 0,
      state: "running",
      accumulatedText: "",
      accumulatedThinking: "",
      abortController: new AbortController(),
      waitResolvers: [],
    };
    this.runs.set(run.runId, run);
    return run;
  }

  private async executeRun(run: Run, ws: ServerWebSocket<ConnectionData> | null) {
    // Intercept slash commands before any handler (demo or external)
    const trimmed = run.message.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith("/")) {
      const result = this.handleSlashCommand(run, lower);
      if (result) {
        this.emitAgentEvent(run, "lifecycle", { phase: "start", startedAt: Date.now() });
        run.accumulatedText = result.text;
        this.emitChatEvent(run, "delta", result.text);
        this.appendHistory(run.sessionKey, {
          role: "assistant",
          content: [{ type: "text", text: result.text }],
          timestamp: Date.now(),
          stopReason: result.stopReason ?? "stop",
          model: result.model ?? this.currentModel,
          provider: result.provider ?? this.currentProvider,
        });
        this.finishRun(run, "completed", undefined, [{ type: "text", text: result.text }]);
        return;
      }
    }

    // If external handler is set, use it
    if (this.onAgentRun) {
      try {
        await this.onAgentRun(run, ws);
      } catch (err) {
        if (run.state === "running") {
          this.finishRun(run, "error", String(err));
        }
      }
      return;
    }

    // Demo mode: use keyword-matched responses
    const { response } = matchResponse(run.message);

    try {
      // Lifecycle: start
      this.emitAgentEvent(run, "lifecycle", { phase: "start", startedAt: Date.now() });

      if (this.isAborted(run)) return;

      // Phase 1: Thinking/reasoning (if present)
      if (response.thinking) {
        await this.streamThinking(run, response.thinking);
        if (this.isAborted(run)) return;
      }

      // Phase 2: Tool calls (if present)
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          if (this.isAborted(run)) return;
          await this.executeToolCall(run, tc);
        }
      }

      if (this.isAborted(run)) return;

      // Phase 3: Stream text response
      if (response.instant) {
        run.accumulatedText = response.text;
        this.emitAgentEvent(run, "assistant", { text: response.text, delta: response.text });
        this.emitChatEvent(run, "delta", response.text);
      } else {
        await this.streamText(run, response.text);
      }

      if (this.isAborted(run)) return;

      this.finishRun(run, "completed");
    } catch (err) {
      if (run.state === "running") {
        this.finishRun(run, "error", String(err));
      }
    }
  }

  private isAborted(run: Run): boolean {
    if (run.abortController.signal.aborted) {
      run.state = "aborted";
      return true;
    }
    return false;
  }

  private async streamThinking(run: Run, thinking: string) {
    const words = thinking.split(/(\s+)/);
    let accumulated = "";

    for (const word of words) {
      if (this.isAborted(run)) return;
      accumulated += word;
      this.emitAgentEvent(run, "reasoning", {
        text: accumulated,
        delta: word,
      });
      if (word.trim()) await Bun.sleep(15 + Math.random() * 10);
    }
  }

  private async executeToolCall(run: Run, tc: ToolCall) {
    // Emit tool start
    this.emitAgentEvent(run, "tool", {
      phase: "start",
      name: tc.name,
      toolCallId: tc.toolCallId,
      args: tc.args,
    });

    // Simulate execution time
    await Bun.sleep(tc.delayMs);

    if (this.isAborted(run)) return;

    // Emit tool result
    this.emitAgentEvent(run, "tool", {
      phase: "result",
      name: tc.name,
      toolCallId: tc.toolCallId,
      result: tc.result,
      isError: tc.isError ?? false,
    });
  }

  private async streamText(run: Run, text: string) {
    const words = text.split(/(\s+)/);
    let accumulated = "";
    let lastDeltaAt = 0;

    for (const word of words) {
      if (this.isAborted(run)) return;
      accumulated += word;
      run.accumulatedText = accumulated;

      // Agent assistant event for every word
      this.emitAgentEvent(run, "assistant", {
        text: accumulated,
        delta: word,
      });

      // Throttle chat deltas to ~150ms like the real server
      const now = Date.now();
      if (now - lastDeltaAt >= 150) {
        this.emitChatEvent(run, "delta", accumulated);
        lastDeltaAt = now;
      }

      // Variable delay based on punctuation
      if (word.trim()) {
        const trimmedWord = word.trim();
        const last = trimmedWord[trimmedWord.length - 1];
        if (last === "." || last === "!" || last === "?") {
          await Bun.sleep(60 + Math.random() * 40);
        } else if (last === "," || last === ";" || last === ":") {
          await Bun.sleep(30 + Math.random() * 20);
        } else {
          await Bun.sleep(15 + Math.random() * 15);
        }
      }
    }

    // Final delta to ensure client has the complete text
    this.emitChatEvent(run, "delta", accumulated);
  }

  /** Publicly accessible for external agent handlers */
  emitAgentEvent(
    run: Run,
    stream: string,
    data: Record<string, unknown>
  ) {
    run.seq++;
    const event: EventFrame = {
      type: "event",
      event: "agent",
      payload: {
        runId: run.runId,
        sessionKey: run.sessionKey,
        seq: run.seq,
        stream,
        ts: Date.now(),
        data,
      },
    };
    this.broadcast(event);
  }

  /** Publicly accessible for external agent handlers */
  emitChatEvent(
    run: Run,
    state: "delta" | "final" | "error",
    textOrError: string
  ) {
    const payload: Record<string, unknown> = {
      runId: run.runId,
      sessionKey: run.sessionKey,
      seq: run.seq,
      state,
    };

    if (state === "error") {
      payload["errorMessage"] = textOrError;
    } else {
      const content: Array<Record<string, unknown>> = [];
      if (run.accumulatedThinking) {
        content.push({ type: "thinking", thinking: run.accumulatedThinking });
      }
      content.push({ type: "text", text: textOrError });
      payload["message"] = {
        role: "assistant",
        content,
        timestamp: Date.now(),
      };
    }

    const event: EventFrame = {
      type: "event",
      event: "chat",
      payload,
    };
    this.broadcast(event);
  }

  /** Publicly accessible for external agent handlers */
  finishRun(
    run: Run,
    state: "completed" | "error",
    errorMessage?: string,
    externalContentParts?: ContentPart[]
  ) {
    run.state = state;

    if (state === "completed") {
      this.emitAgentEvent(run, "lifecycle", {
        phase: "end",
        endedAt: Date.now(),
      });
      this.emitChatEvent(run, "final", run.accumulatedText);

      let contentParts: ContentPart[];

      if (externalContentParts) {
        // Use externally-provided content parts (e.g. from Ollama handler)
        contentParts = externalContentParts;
      } else {
        // Build content with tool calls + text for history (demo mode)
        const { response } = matchResponse(run.message);
        contentParts = [];

        if (response.toolCalls) {
          for (const tc of response.toolCalls) {
            contentParts.push({
              type: "tool_call",
              name: tc.name,
              toolCallId: tc.toolCallId,
              arguments: JSON.stringify(tc.args),
              status: tc.isError ? "error" : "success",
              result: tc.result,
              resultError: tc.isError,
            });
          }
        }
        contentParts.push({ type: "text", text: run.accumulatedText });
      }

      // Store in history
      this.appendHistory(run.sessionKey, {
        role: "assistant",
        content: contentParts,
        timestamp: Date.now(),
        stopReason: "end_turn",
      });
    } else {
      this.emitAgentEvent(run, "lifecycle", {
        phase: "error",
        error: errorMessage ?? "Unknown error",
        endedAt: Date.now(),
      });
      this.emitChatEvent(run, "error", errorMessage ?? "Unknown error");
    }

    // Update session lastActiveAt
    const meta = this.sessionMeta.get(run.sessionKey);
    if (meta) meta.lastActiveAt = Date.now();

    // Resolve waiters
    const result = {
      runId: run.runId,
      state: run.state,
      text: run.accumulatedText,
    };
    for (const resolve of run.waitResolvers) {
      resolve(result);
    }
    run.waitResolvers.length = 0;
  }

  // ── Presence ──────────────────────────────────────────────────────────────

  private removePresence(connId: string) {
    this.presence = this.presence.filter((p) => p.instanceId !== connId);
    this.stateVersion.presence++;
  }

  private broadcastPresence() {
    const event: EventFrame = {
      type: "event",
      event: "presence",
      payload: { presence: this.presence },
      stateVersion: { ...this.stateVersion },
    };
    this.broadcast(event);
  }

  // ── Tick & Health ─────────────────────────────────────────────────────────

  private startTick() {
    this.tickInterval = setInterval(() => {
      const event: EventFrame = {
        type: "event",
        event: "tick",
        payload: { ts: Date.now() },
      };
      this.broadcast(event);
    }, this.config.tickIntervalMs);
  }

  private startHealthRefresh() {
    this.healthInterval = setInterval(() => {
      this.stateVersion.health++;
      const event: EventFrame = {
        type: "event",
        event: "health",
        payload: { ...this.health },
        stateVersion: { ...this.stateVersion },
      };
      this.broadcast(event);
    }, this.config.healthRefreshIntervalMs);
  }

  // ── Idempotency Deduplication (§2.8) ──────────────────────────────────────

  private isDuplicateKey(key: string): boolean {
    const ts = this.idempotencyKeys.get(key);
    if (ts === undefined) return false;
    // Expired entries are not duplicates
    if (Date.now() - ts > this.config.dedupeTtlMs) {
      this.idempotencyKeys.delete(key);
      return false;
    }
    return true;
  }

  private recordIdempotencyKey(key: string): void {
    // Evict oldest if at capacity (§7: max 1000)
    if (this.idempotencyKeys.size >= this.config.dedupeMaxKeys) {
      const oldest = this.idempotencyKeys.keys().next().value;
      if (oldest) this.idempotencyKeys.delete(oldest);
    }
    this.idempotencyKeys.set(key, Date.now());
  }

  private startDedupeCleanup() {
    // Periodically clean expired idempotency keys
    this.dedupeCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.idempotencyKeys) {
        if (now - ts > this.config.dedupeTtlMs) {
          this.idempotencyKeys.delete(key);
        }
      }
    }, this.config.dedupeTtlMs);
  }

  // ── Session Meta ──────────────────────────────────────────────────────────

  private ensureSessionMeta(key: string) {
    let meta = this.sessionMeta.get(key);
    if (!meta) {
      meta = { createdAt: Date.now(), lastActiveAt: Date.now(), patches: {} };
      this.sessionMeta.set(key, meta);
    }
    return meta;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private broadcast(event: EventFrame) {
    // Assign global sequence number to broadcast events (§2.2)
    this.globalSeq++;
    event.seq = this.globalSeq;

    const msg = JSON.stringify(event);
    for (const client of this.clients) {
      try {
        // §2.8: Backpressure — check buffered amount for slow consumers
        // #TODO Bun's ServerWebSocket may not expose getBufferedAmount;
        //       implement slow-consumer detection when API is available
        client.send(msg);
      } catch {
        // Client may have disconnected
      }
    }
  }

  private broadcastEvent(
    eventName: string,
    payload: Record<string, unknown>
  ) {
    const event: EventFrame = {
      type: "event",
      event: eventName,
      payload,
    };
    this.broadcast(event);
  }

  private sendResponse(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    payload: Record<string, unknown>
  ) {
    const response: ResponseFrame = {
      type: "res",
      id,
      ok: true,
      payload,
    };
    ws.send(JSON.stringify(response));
  }

  private sendError(
    ws: ServerWebSocket<ConnectionData>,
    id: string,
    code: string,
    message: string
  ) {
    const response: ResponseFrame = {
      type: "res",
      id,
      ok: false,
      error: {
        code: code as ErrorCode,
        message,
      },
    };
    ws.send(JSON.stringify(response));
  }

  private appendHistory(sessionKey: string, entry: HistoryEntry) {
    let history = this.chatHistory.get(sessionKey);
    if (!history) {
      history = [];
      this.chatHistory.set(sessionKey, history);
    }
    history.push(entry);

    // Update session meta
    const meta = this.ensureSessionMeta(sessionKey);
    meta.lastActiveAt = Date.now();

    // Persist to disk if logging is enabled
    this.logger?.append(sessionKey, entry);
  }
}
