// ═══════════════════════════════════════════════════════════════════════════
// OpenClaw Gateway Protocol v3 — Type Definitions
// See: protocol-spec.md
// ═══════════════════════════════════════════════════════════════════════════

// ── Content Part ─────────────────────────────────────────────────────────────

export type ContentPart = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  toolCallId?: string;
  arguments?: string;
  status?: string;
  result?: string;
  resultError?: boolean;
};

// ── Error Codes (§2.10) ─────────────────────────────────────────────────────

export type ErrorCode =
  | "NOT_LINKED"
  | "NOT_PAIRED"
  | "AGENT_TIMEOUT"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

// ── Frame Types (§2.2) ──────────────────────────────────────────────────────

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: ResponseError;
}

export interface EventFrame {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
  seq?: number;
  stateVersion?: StateVersion;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// ── State Version (§2.3) ────────────────────────────────────────────────────

export interface StateVersion {
  presence: number;
  health: number;
}

// ── Connect Params (§2.3) ───────────────────────────────────────────────────

export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    displayName?: string;
    version: string;
    platform: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    mode: string;
    instanceId?: string;
  };
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  role?: "operator" | "node";
  scopes?: string[];
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
  auth?: {
    token?: string;
    password?: string;
    deviceToken?: string;
  };
  locale?: string;
  userAgent?: string;
}

// ── Presence (§5 presence event) ────────────────────────────────────────────

export interface PresenceEntry {
  host: string;
  ip?: string;
  version: string;
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  mode: string;
  lastInputSeconds?: number;
  ts: number;
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  instanceId?: string;
  reason?: string;
  tags?: string[];
  text?: string;
}

// ── Chat Params (§4.3) ──────────────────────────────────────────────────────

export interface ChatSendParams {
  sessionKey: string;
  message: string;
  thinking?: string;
  deliver?: boolean;
  attachments?: unknown[];
  timeoutMs?: number;
  idempotencyKey: string;
}

export interface ChatAbortParams {
  sessionKey: string;
  runId?: string;
}

export interface ChatHistoryParams {
  sessionKey: string;
  limit?: number;
}

export interface ChatInjectParams {
  sessionKey: string;
  message: string;
  label?: string;
}

// ── Agent Params (§4.1) ─────────────────────────────────────────────────────

export interface AgentParams {
  message: string;
  agentId?: string;
  to?: string;
  replyTo?: string;
  sessionId?: string;
  sessionKey?: string;
  thinking?: string;
  deliver?: boolean;
  attachments?: unknown[];
  channel?: string;
  replyChannel?: string;
  accountId?: string;
  replyAccountId?: string;
  threadId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  timeout?: number;
  lane?: string;
  extraSystemPrompt?: string;
  inputProvenance?: {
    kind: "external_user" | "inter_session" | "internal_system";
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
  };
  idempotencyKey: string;
  label?: string;
  spawnedBy?: string;
}

export interface AgentWaitParams {
  runId: string;
  timeoutMs?: number;
}

export interface AgentIdentityGetParams {
  agentId?: string;
  sessionKey?: string;
}

export interface WakeParams {
  mode: "now" | "next-heartbeat";
  text: string;
}

// ── Agent Management Params (§4.2) ──────────────────────────────────────────

export interface AgentsCreateParams {
  name: string;
  workspace: string;
  emoji?: string;
  avatar?: string;
}

export interface AgentsUpdateParams {
  agentId: string;
  name?: string;
  workspace?: string;
  model?: string;
  avatar?: string;
}

export interface AgentsDeleteParams {
  agentId: string;
  deleteFiles?: boolean;
}

export interface AgentsFilesListParams {
  agentId: string;
}

export interface AgentsFilesGetParams {
  agentId: string;
  name: string;
}

export interface AgentsFilesSetParams {
  agentId: string;
  name: string;
  content: string;
}

// ── Sessions Params (§4.4) ──────────────────────────────────────────────────

export interface SessionsListParams {
  limit?: number;
  activeMinutes?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  label?: string;
  spawnedBy?: string;
  agentId?: string;
  search?: string;
}

export interface SessionsPreviewParams {
  keys: string[];
  limit?: number;
  maxChars?: number;
}

export interface SessionsResolveParams {
  key?: string;
  sessionId?: string;
  label?: string;
  agentId?: string;
  spawnedBy?: string;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
}

export interface SessionsPatchParams {
  key: string;
  label?: string | null;
  thinkingLevel?: string | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  responseUsage?: "off" | "tokens" | "full" | "on" | null;
  elevatedLevel?: string | null;
  execHost?: string | null;
  execSecurity?: string | null;
  execAsk?: string | null;
  execNode?: string | null;
  model?: string | null;
  spawnedBy?: string | null;
  spawnDepth?: number | null;
  sendPolicy?: "allow" | "deny" | null;
  groupActivation?: "mention" | "always" | null;
}

export interface SessionsResetParams {
  key: string;
  reason?: "new" | "reset";
}

export interface SessionsDeleteParams {
  key: string;
  deleteTranscript?: boolean;
}

export interface SessionsCompactParams {
  key: string;
  maxLines?: number;
}

export interface SessionsUsageParams {
  key?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  includeContextWeight?: boolean;
}

// ── Channels Params (§4.5) ──────────────────────────────────────────────────

export interface ChannelsStatusParams {
  probe?: boolean;
  timeoutMs?: number;
}

export interface ChannelsLogoutParams {
  channel: string;
  accountId?: string;
}

// ── Config Params (§4.6) ────────────────────────────────────────────────────

export interface ConfigSetParams {
  raw: string;
  baseHash?: string;
}

export interface ConfigApplyParams {
  raw: string;
  baseHash?: string;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}

export interface ConfigPatchParams {
  raw: string;
  baseHash?: string;
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
}

// ── Cron Params (§4.7) ──────────────────────────────────────────────────────

export interface CronListParams {
  includeDisabled?: boolean;
}

export interface CronAddParams {
  name: string;
  agentId?: string | null;
  sessionKey?: string | null;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: Record<string, unknown>;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payload: Record<string, unknown>;
  delivery?: Record<string, unknown>;
}

export interface CronUpdateParams {
  id?: string;
  jobId?: string;
  patch: Record<string, unknown>;
}

export interface CronRemoveParams {
  id?: string;
  jobId?: string;
}

export interface CronRunParams {
  id?: string;
  jobId?: string;
  mode?: "due" | "force";
}

export interface CronRunsParams {
  id?: string;
  jobId?: string;
  limit?: number;
}

// ── Device Params (§4.8) ────────────────────────────────────────────────────

export interface DevicePairApproveParams {
  requestId: string;
}

export interface DevicePairRejectParams {
  requestId: string;
}

export interface DevicePairRemoveParams {
  deviceId: string;
}

export interface DeviceTokenRotateParams {
  deviceId: string;
  role: string;
  scopes?: string[];
}

export interface DeviceTokenRevokeParams {
  deviceId: string;
  role: string;
}

// ── Node Params (§4.9) ──────────────────────────────────────────────────────

export interface NodeDescribeParams {
  nodeId: string;
}

export interface NodePairRequestParams {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  remoteIp?: string;
  silent?: boolean;
}

export interface NodeRenameParams {
  nodeId: string;
  displayName: string;
}

export interface NodeInvokeParams {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey: string;
}

export interface NodeInvokeResultParams {
  id: string;
  nodeId: string;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
}

export interface NodeEventParams {
  event: string;
  payload?: unknown;
  payloadJSON?: string;
}

// ── Execution Approval Params (§4.10) ───────────────────────────────────────

export interface ExecApprovalRequestParams {
  id?: string;
  command: string;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  timeoutMs?: number;
  twoPhase?: boolean;
}

export interface ExecApprovalResolveParams {
  id: string;
  decision: string;
}

export interface ExecApprovalsSetParams {
  file: Record<string, unknown>;
  baseHash?: string;
}

export interface ExecApprovalsNodeGetParams {
  nodeId: string;
}

export interface ExecApprovalsNodeSetParams {
  nodeId: string;
  file: Record<string, unknown>;
  baseHash?: string;
}

// ── Skills Params (§4.11) ───────────────────────────────────────────────────

export interface SkillsStatusParams {
  agentId?: string;
}

export interface SkillsInstallParams {
  name: string;
  installId: string;
  timeoutMs?: number;
}

export interface SkillsUpdateParams {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}

// ── Talk & TTS Params (§4.12) ───────────────────────────────────────────────

export interface TalkConfigParams {
  includeSecrets?: boolean;
}

export interface TalkModeParams {
  enabled: boolean;
  phase?: string;
}

// ── Wizard Params (§4.14) ───────────────────────────────────────────────────

export interface WizardStartParams {
  mode?: "local" | "remote";
  workspace?: string;
}

export interface WizardNextParams {
  sessionId: string;
  answer?: { stepId: string; value?: unknown };
}

export interface WizardCancelParams {
  sessionId: string;
}

export interface WizardStatusParams {
  sessionId: string;
}

// ── Send & Poll Params (§4.15) ──────────────────────────────────────────────

export interface SendParams {
  to: string;
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  gifPlayback?: boolean;
  channel?: string;
  accountId?: string;
  threadId?: string;
  sessionKey?: string;
  idempotencyKey: string;
}

export interface PollParams {
  to: string;
  question: string;
  options: string[];
  maxSelections?: number;
  durationSeconds?: number;
  durationHours?: number;
  silent?: boolean;
  isAnonymous?: boolean;
  threadId?: string;
  channel?: string;
  accountId?: string;
  idempotencyKey: string;
}

// ── Push Params (§4.17) ─────────────────────────────────────────────────────

export interface PushTestParams {
  nodeId: string;
  title?: string;
  body?: string;
  environment?: "sandbox" | "production";
}

// ── Update Params (§4.18) ───────────────────────────────────────────────────

export interface UpdateRunParams {
  sessionKey?: string;
  note?: string;
  restartDelayMs?: number;
  timeoutMs?: number;
}

// ── Logs Params (§4.19) ─────────────────────────────────────────────────────

export interface LogsTailParams {
  cursor?: number;
  limit?: number;
  maxBytes?: number;
}

// ── Web Login Params (§4.21) ────────────────────────────────────────────────

export interface WebLoginStartParams {
  force?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  accountId?: string;
}

export interface WebLoginWaitParams {
  timeoutMs?: number;
  accountId?: string;
}

// ── Agent Event Stream Types (§5 agent event) ───────────────────────────────

export type AgentStreamType = "lifecycle" | "assistant" | "tool" | "reasoning";

export interface AgentEventPayload {
  runId: string;
  sessionKey: string;
  seq: number;
  stream: AgentStreamType;
  ts: number;
  data: Record<string, unknown>;
}

// ── Chat Event Payload (§5 chat event) ──────────────────────────────────────

export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: {
    role: "assistant";
    content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
    >;
    timestamp: number;
  };
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
}

// ── Server Config ────────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  hostname?: string;
  authToken?: string;
  authPassword?: string;
  serverVersion?: string;
  tickIntervalMs?: number;
  healthRefreshIntervalMs?: number;
  maxPayload?: number;
  handshakeTimeoutMs?: number;
  dedupeMaxKeys?: number;
  dedupeTtlMs?: number;
  /** Directory to write conversation JSONL logs. Omit to disable disk logging. */
  logDir?: string;
}

// ── Scopes & Roles (§3.3, §3.4) ────────────────────────────────────────────

export type Role = "operator" | "node";

export type Scope =
  | "operator.admin"
  | "operator.read"
  | "operator.write"
  | "operator.approvals"
  | "operator.pairing";
