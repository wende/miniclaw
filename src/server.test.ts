import { describe, test, expect, afterEach } from "bun:test";
import { MiniClawServer } from "./server.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

let server: MiniClawServer;
let portCounter = 19_100;

function nextPort() {
  return portCounter++;
}

function createServer(overrides?: Record<string, unknown>) {
  const port = nextPort();
  server = new MiniClawServer({
    port,
    hostname: "127.0.0.1",
    tickIntervalMs: 600_000, // disable tick noise in tests
    healthRefreshIntervalMs: 600_000,
    ...overrides,
  });
  server.start();
  return server;
}

function connect(srv: MiniClawServer): WebSocket {
  return new WebSocket(srv.url);
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener("open", () => resolve(), { once: true });
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev) => resolve(JSON.parse(ev.data as string)),
      { once: true }
    );
  });
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000
): Promise<any[]> {
  return new Promise((resolve, reject) => {
        const msgs: any[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${count} messages, got ${msgs.length}`)),
      timeoutMs
    );
    const handler = (ev: MessageEvent) => {
      msgs.push(JSON.parse(ev.data as string));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msgs);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function collectUntil(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 5000
): Promise<any[]> {
  return new Promise((resolve, reject) => {
        const msgs: any[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for predicate, got ${msgs.length} messages`)),
      timeoutMs
    );
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string);
      msgs.push(msg);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msgs);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function handshake(
  ws: WebSocket,
  overrides?: Record<string, unknown>
): Promise<any> {
  await waitForOpen(ws);

  // Server sends hello + connect.challenge first
  const hello = await waitForMessage(ws);
  expect(hello.type).toBe("hello");

  const challenge = await waitForMessage(ws);
  expect(challenge.type).toBe("event");
  expect(challenge.event).toBe("connect.challenge");

  // Now send connect
  const req = {
    type: "req",
    id: "hs-1",
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "test-client",
        displayName: "Test",
        version: "1.0.0",
        platform: "test",
        mode: "operator",
      },
      ...overrides,
    },
  };
  ws.send(JSON.stringify(req));

  // Collect hello-ok + presence event
  const msgs = await collectMessages(ws, 2);
  const helloOk = msgs.find(
    (m) => m.type === "res" && m.id === "hs-1"
  )!;
  return helloOk;
}

/** Drain the server-initiated hello + connect.challenge messages */
async function drainServerGreeting(ws: WebSocket): Promise<void> {
  await waitForOpen(ws);
  await waitForMessage(ws); // hello
  await waitForMessage(ws); // connect.challenge
}

function sendReq(
  ws: WebSocket,
  id: string,
  method: string,
  params?: Record<string, unknown>
) {
  ws.send(JSON.stringify({ type: "req", id, method, params }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  server?.stop();
});

// ── Handshake ────────────────────────────────────────────────────────────────

describe("handshake", () => {
  test("successful connect returns hello-ok", async () => {
    const srv = createServer();
    const ws = connect(srv);

    const res = await handshake(ws);

    expect(res.type).toBe("res");
    expect(res.ok).toBe(true);
    expect((res.payload as any).type).toBe("hello-ok");
    expect((res.payload as any).protocol).toBe(3);
    expect((res.payload as any).server.connId).toMatch(/^conn_/);
    expect((res.payload as any).features.methods).toContain("chat.send");
    expect((res.payload as any).features.events).toContain("agent");
    expect((res.payload as any).snapshot.presence).toBeArray();
    expect((res.payload as any).policy.tickIntervalMs).toBeNumber();

    ws.close();
  });

  test("first message must be connect", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await drainServerGreeting(ws);

    const closedPromise = new Promise<number>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });

    sendReq(ws, "r1", "chat.send", { message: "hi" });

    const msg = await waitForMessage(ws);
    expect(msg.ok).toBe(false);
    expect((msg.error as any).code).toBe("INVALID_REQUEST");

    const code = await closedPromise;
    expect(code).toBe(1008);
  });

  test("protocol mismatch is rejected", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await drainServerGreeting(ws);

    const closedPromise = new Promise<number>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hs-1",
        method: "connect",
        params: {
          minProtocol: 99,
          maxProtocol: 99,
          client: { id: "test", version: "1.0.0", platform: "test", mode: "operator" },
        },
      })
    );

    const msg = await waitForMessage(ws);
    expect(msg.ok).toBe(false);
    expect((msg.error as any).message).toMatch(/[Pp]rotocol/);

    const code = await closedPromise;
    expect(code).toBe(1008);
  });

  test("auth token validation", async () => {
    const srv = createServer({ authToken: "secret123" });
    const ws = connect(srv);
    await drainServerGreeting(ws);

    const closedPromise = new Promise<number>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hs-1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "test", version: "1.0.0", platform: "test", mode: "operator" },
          auth: { token: "wrong" },
        },
      })
    );

    const msg = await waitForMessage(ws);
    expect(msg.ok).toBe(false);
    expect((msg.error as any).message).toMatch(/[Aa]uthentication/);

    await closedPromise;
  });

  test("auth token accepted when correct", async () => {
    const srv = createServer({ authToken: "secret123" });
    const ws = connect(srv);

    const res = await handshake(ws, { auth: { token: "secret123" } });
    expect(res.ok).toBe(true);

    ws.close();
  });

  test("malformed JSON is handled", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await drainServerGreeting(ws);

    ws.send("not json {{");
    const msg = await waitForMessage(ws);
    expect(msg.ok).toBe(false);
    expect((msg.error as any).code).toBe("INVALID_REQUEST");

    ws.close();
  });
});

// ── Presence ─────────────────────────────────────────────────────────────────

describe("presence", () => {
  test("presence updates on connect and disconnect", async () => {
    const srv = createServer();

    // Client 1 connects
    const ws1 = connect(srv);
    await handshake(ws1);

    // Client 2 connects — ws1 should receive a presence event
    const ws2 = connect(srv);
    const presencePromise = waitForMessage(ws1);
    await handshake(ws2);

    // ws1 receives presence event from ws2 joining
    const presenceEvent = await presencePromise;
    expect(presenceEvent.type).toBe("event");
    expect(presenceEvent.event).toBe("presence");
    const payload = presenceEvent.payload as any;
    expect(payload.presence.length).toBe(2);

    // Client 2 disconnects — ws1 should receive updated presence
    const disconnectPresence = waitForMessage(ws1);
    ws2.close();
    const dcEvent = await disconnectPresence;
    expect(dcEvent.event).toBe("presence");
    expect((dcEvent.payload as any).presence.length).toBe(1);

    ws1.close();
  });

  test("stateVersion.presence increments", async () => {
    const srv = createServer();
    const ws1 = connect(srv);
    const res1 = await handshake(ws1);
    const v1 = (res1.payload as any).snapshot.stateVersion.presence;

    const ws2 = connect(srv);
    const presenceEvt = waitForMessage(ws1);
    await handshake(ws2);

    const evt = await presenceEvt;
    const v2 = (evt as any).stateVersion.presence;
    expect(v2).toBeGreaterThan(v1);

    ws1.close();
    ws2.close();
  });
});

// ── Chat Flow ────────────────────────────────────────────────────────────────

describe("chat", () => {
  test("chat.send returns runId and streams events", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    // Send chat message
    sendReq(ws, "r1", "chat.send", {
      sessionKey: "main",
      message: "Hello world",
      idempotencyKey: "idem-1",
    });

    // Collect all messages until we see the chat final event
    const msgs = await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    // ACK response
    const ack = msgs.find((m) => m.type === "res" && m.id === "r1") as any;
    expect(ack).toBeDefined();
    expect(ack.ok).toBe(true);
    expect(ack.payload.runId).toMatch(/^run_/);

    // Lifecycle start
    const lifecycleStart = msgs.find(
      (m) =>
        m.type === "event" &&
        m.event === "agent" &&
        (m.payload as any).stream === "lifecycle" &&
        (m.payload as any).data.phase === "start"
    );
    expect(lifecycleStart).toBeDefined();

    // Assistant deltas
    const assistantEvents = msgs.filter(
      (m) =>
        m.type === "event" &&
        m.event === "agent" &&
        (m.payload as any).stream === "assistant"
    );
    expect(assistantEvents.length).toBeGreaterThan(0);

    // Chat final
    const chatFinal = msgs.find(
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );
    expect(chatFinal).toBeDefined();
    expect(
      (chatFinal!.payload as any).message.content[0].text
    ).toContain("MiniClaw");

    // Lifecycle end
    const lifecycleEnd = msgs.find(
      (m) =>
        m.type === "event" &&
        m.event === "agent" &&
        (m.payload as any).stream === "lifecycle" &&
        (m.payload as any).data.phase === "end"
    );
    expect(lifecycleEnd).toBeDefined();

    ws.close();
  });

  test("duplicate idempotency key is rejected", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.send", {
      sessionKey: "main",
      message: "first",
      idempotencyKey: "idem-dup",
    });

    // Wait for first run to complete
    await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    sendReq(ws, "r2", "chat.send", {
      sessionKey: "main",
      message: "second",
      idempotencyKey: "idem-dup",
    });

    const dupRes = await waitForMessage(ws);
    expect(dupRes.ok).toBe(false);
    expect((dupRes.error as any).message).toMatch(/[Dd]uplicate/);

    ws.close();
  });

  test("chat.abort cancels a running run", async () => {
    const srv = createServer();

    // Inject a slow handler so we can abort mid-stream
    srv.onAgentRun = async (run) => {
      srv.emitAgentEvent(run, "lifecycle", {
        phase: "start",
        startedAt: Date.now(),
      });

      for (let i = 0; i < 100; i++) {
        if (run.abortController.signal.aborted) {
          run.state = "aborted";
          return;
        }
        run.accumulatedText += `word${i} `;
        srv.emitAgentEvent(run, "assistant", {
          text: run.accumulatedText,
          delta: `word${i} `,
        });
        await Bun.sleep(50);
      }

      srv.finishRun(run, "completed");
    };

    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.send", {
      sessionKey: "main",
      message: "long message",
      idempotencyKey: "idem-abort",
    });

    // Wait for ACK + some events
    await collectMessages(ws, 3, 2000);

    // Abort
    sendReq(ws, "r2", "chat.abort", {
      sessionKey: "main",
    });

    const abortRes = await waitForMessage(ws);
    expect(abortRes.type).toBe("res");
    expect(abortRes.ok).toBe(true);
    expect((abortRes.payload as any).aborted).toBe(true);

    ws.close();
  });

  test("chat.history returns stored messages", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    // Send a message and wait for it to fully complete (chat final event)
    sendReq(ws, "r1", "chat.send", {
      sessionKey: "main",
      message: "test message",
      idempotencyKey: "idem-hist-1",
    });
    await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    // Fetch history
    sendReq(ws, "r2", "chat.history", { sessionKey: "main" });
    const histRes = await waitForMessage(ws);

    expect(histRes.ok).toBe(true);
    const messages = (histRes.payload as any).messages;
    expect(messages.length).toBe(2); // user + assistant
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0].text).toBe("test message");
    expect(messages[1].role).toBe("assistant");

    ws.close();
  });

  test("chat.send missing params returns error", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.send", { sessionKey: "main" });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe("INVALID_REQUEST");

    ws.close();
  });
});

// ── Agent Method ─────────────────────────────────────────────────────────────

describe("agent", () => {
  test("agent method starts a run and streams events", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "agent", {
      message: "do something",
      idempotencyKey: "idem-agent-1",
    });

    const msgs = await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    const ack = msgs.find((m) => m.type === "res" && m.id === "r1") as any;
    expect(ack.ok).toBe(true);
    expect(ack.payload.runId).toMatch(/^run_/);

    const chatFinal = msgs.find(
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );
    expect(chatFinal).toBeDefined();

    ws.close();
  });

  test("agent.wait blocks until run completes", async () => {
    const srv = createServer();

    let resolveRun: (() => void) | undefined;
    srv.onAgentRun = async (run) => {
      srv.emitAgentEvent(run, "lifecycle", { phase: "start", startedAt: Date.now() });
      await new Promise<void>((r) => { resolveRun = r; });
      run.accumulatedText = "done";
      srv.finishRun(run, "completed");
    };

    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "agent", {
      message: "wait test",
      idempotencyKey: "idem-wait-1",
    });

    // Get ACK to extract runId
    const ack = await waitForMessage(ws);
    // Skip the lifecycle start event
    await waitForMessage(ws);

    const runId = (ack.payload as any).runId;

    // Send agent.wait
    sendReq(ws, "r2", "agent.wait", { runId });

    // Complete the run after a short delay
    await Bun.sleep(50);
    resolveRun!();

    // Wait for the agent.wait response
    const msgs = await collectUntil(
      ws,
      (m) => m.type === "res" && m.id === "r2",
      3000
    );
    const waitRes = msgs.find(
      (m) => m.type === "res" && m.id === "r2"
    ) as any;
    expect(waitRes).toBeDefined();
    expect(waitRes.ok).toBe(true);
    expect(waitRes.payload.state).toBe("completed");
    expect(waitRes.payload.text).toBe("done");

    ws.close();
  });
});

// ── Send Method ──────────────────────────────────────────────────────────────

describe("send", () => {
  test("send method ACKs successfully", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "send", {
      to: "+1234567890",
      message: "Hello",
      idempotencyKey: "idem-send-1",
    });

    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).sent).toBe(true);
    expect((res.payload as any).to).toBe("+1234567890");

    ws.close();
  });

  test("send missing params returns error", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "send", { to: "+1234567890" });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(false);

    ws.close();
  });
});

// ── Tick ─────────────────────────────────────────────────────────────────────

describe("tick", () => {
  test("tick events are sent at configured interval", async () => {
    const srv = createServer({ tickIntervalMs: 100 });
    const ws = connect(srv);
    await handshake(ws);

    // Wait for at least 2 ticks
    const msgs = await collectMessages(ws, 2, 1000);
    const ticks = msgs.filter(
      (m) => m.type === "event" && m.event === "tick"
    );
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect((ticks[0]!.payload as any).ts).toBeNumber();

    ws.close();
  });
});

// ── Shutdown ─────────────────────────────────────────────────────────────────

describe("shutdown", () => {
  test("shutdown event is broadcast on stop", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    const shutdownPromise = waitForMessage(ws);
    srv.stop();

    const msg = await shutdownPromise;
    expect(msg.type).toBe("event");
    expect(msg.event).toBe("shutdown");
    expect((msg.payload as any).reason).toBe("server_stop");
  });
});

// ── Unknown Method ───────────────────────────────────────────────────────────

describe("error handling", () => {
  test("unknown method returns error", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "nonexistent.method", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe("INVALID_REQUEST");
    expect((res.error as any).message).toContain("Unknown method");

    ws.close();
  });

  test("non-req frame type is rejected", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await drainServerGreeting(ws);

    ws.send(JSON.stringify({ type: "event", event: "fake" }));
    const msg = await waitForMessage(ws);
    expect(msg.ok).toBe(false);

    ws.close();
  });

  test("missing id or method is rejected", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await drainServerGreeting(ws);

    ws.send(JSON.stringify({ type: "req" }));
    const msg = await waitForMessage(ws);
    expect(msg.ok).toBe(false);

    ws.close();
  });
});

// ── Agent Event Sequencing ───────────────────────────────────────────────────

describe("event sequencing", () => {
  test("agent event seq numbers are monotonically increasing per run", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.send", {
      sessionKey: "main",
      message: "test seq",
      idempotencyKey: "idem-seq-1",
    });

    const msgs = await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    const agentEvents = msgs
      .filter((m) => m.type === "event" && m.event === "agent")
      .map((m) => (m.payload as any).seq as number);

    // Each subsequent seq should be greater than the previous
    for (let i = 1; i < agentEvents.length; i++) {
      expect(agentEvents[i]).toBeGreaterThan(agentEvents[i - 1]!);
    }

    ws.close();
  });
});

// ── Stub Methods ──────────────────────────────────────────────────────────────
// All stub methods should return ok: true with { stub: true, todo: "#TODO ..." }

describe("stub methods", () => {
  const stubMethods = [
    // Agent (§4.1)
    "agent.identity.get",
    "wake",
    // Agent Management (§4.2)
    "agents.list",
    "agents.create",
    "agents.update",
    "agents.delete",
    "agents.files.list",
    "agents.files.get",
    "agents.files.set",
    // Sessions (§4.4)
    "sessions.preview",
    "sessions.resolve",
    "sessions.compact",
    "sessions.usage",
    "sessions.usage.timeseries",
    "sessions.usage.logs",
    // Channels (§4.5)
    "channels.status",
    "channels.logout",
    // Config (§4.6)
    "config.set",
    "config.apply",
    "config.patch",
    "config.schema",
    // Cron (§4.7)
    "cron.list",
    "cron.status",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
    "cron.runs",
    // Devices (§4.8)
    "device.pair.list",
    "device.pair.approve",
    "device.pair.reject",
    "device.pair.remove",
    "device.token.rotate",
    "device.token.revoke",
    // Nodes (§4.9)
    "node.list",
    "node.describe",
    "node.pair.request",
    "node.pair.list",
    "node.pair.approve",
    "node.pair.reject",
    "node.pair.verify",
    "node.rename",
    "node.invoke",
    "node.invoke.result",
    "node.event",
    // Execution Approvals (§4.10)
    "exec.approval.request",
    "exec.approval.waitDecision",
    "exec.approval.resolve",
    "exec.approvals.get",
    "exec.approvals.set",
    "exec.approvals.node.get",
    "exec.approvals.node.set",
    // Skills (§4.11)
    "skills.status",
    "skills.bins",
    "skills.install",
    "skills.update",
    // Talk & TTS (§4.12)
    "talk.config",
    "talk.mode",
    "tts.status",
    "tts.enable",
    "tts.disable",
    "tts.convert",
    "tts.setProvider",
    "tts.providers",
    // System (§4.13)
    "last-heartbeat",
    "set-heartbeats",
    "system-event",
    // Wizard (§4.14)
    "wizard.start",
    "wizard.next",
    "wizard.cancel",
    "wizard.status",
    // Messaging (§4.15)
    "poll",
    // Browser (§4.16)
    "browser.request",
    // Push (§4.17)
    "push.test",
    // Update (§4.18)
    "update.run",
    // Voice Wake (§4.20)
    "voicewake.get",
    "voicewake.set",
    // Web Login (§4.21)
    "web.login.start",
    "web.login.wait",
    // Usage (§4.22)
    "usage.status",
    "usage.cost",
  ];

  for (const method of stubMethods) {
    test(`${method} returns stub response`, async () => {
      const srv = createServer();
      const ws = connect(srv);
      await handshake(ws);

      sendReq(ws, "stub-1", method, {});
      const res = await waitForMessage(ws);

      expect(res.type).toBe("res");
      expect(res.id).toBe("stub-1");
      expect(res.ok).toBe(true);
      expect((res.payload as any).stub).toBe(true);
      expect((res.payload as any).todo).toBeString();
      expect((res.payload as any).todo).toStartWith("#TODO");

      ws.close();
    });
  }
});

// ── New Real Implementations ────────────────────────────────────────────────

describe("chat.inject", () => {
  test("injects a message into session history", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.inject", {
      sessionKey: "inject-test",
      message: "injected context",
    });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).injected).toBe(true);

    // Verify it shows up in history
    sendReq(ws, "r2", "chat.history", { sessionKey: "inject-test" });
    const histRes = await waitForMessage(ws);
    expect(histRes.ok).toBe(true);
    const messages = (histRes.payload as any).messages;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0].text).toBe("injected context");

    ws.close();
  });

  test("missing params returns error", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.inject", { sessionKey: "test" });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(false);
    expect((res.error as any).code).toBe("INVALID_REQUEST");

    ws.close();
  });
});

describe("sessions.list", () => {
  test("returns empty list initially", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "sessions.list", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).sessions).toBeArray();

    ws.close();
  });

  test("returns sessions after chat activity", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    // Create some chat activity
    sendReq(ws, "r1", "chat.send", {
      sessionKey: "sess-a",
      message: "hello",
      idempotencyKey: "sl-1",
    });
    await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    sendReq(ws, "r2", "sessions.list", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    const sessions = (res.payload as any).sessions;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const sessA = sessions.find((s: any) => s.key === "sess-a");
    expect(sessA).toBeDefined();
    expect(sessA.messageCount).toBeGreaterThanOrEqual(2); // user + assistant

    ws.close();
  });
});

describe("sessions.patch", () => {
  test("patches session label", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "sessions.patch", {
      key: "patch-test",
      label: "My Session",
    });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).patched).toBe(true);

    // Verify via sessions.list
    sendReq(ws, "r2", "sessions.list", {});
    const listRes = await waitForMessage(ws);
    const sessions = (listRes.payload as any).sessions;
    const patched = sessions.find((s: any) => s.key === "patch-test");
    expect(patched).toBeDefined();
    expect(patched.label).toBe("My Session");

    ws.close();
  });

  test("rejects label exceeding max length", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "sessions.patch", {
      key: "patch-test",
      label: "x".repeat(100),
    });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(false);
    expect((res.error as any).message).toContain("64");

    ws.close();
  });

  test("missing key returns error", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "sessions.patch", { label: "test" });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(false);

    ws.close();
  });
});

describe("sessions.delete", () => {
  test("deletes session history and meta", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    // Create a session with chat
    sendReq(ws, "r1", "chat.send", {
      sessionKey: "del-test",
      message: "hi",
      idempotencyKey: "sd-1",
    });
    await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    // Delete it
    sendReq(ws, "r2", "sessions.delete", { key: "del-test" });
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).deleted).toBe(true);

    // Verify history is empty
    sendReq(ws, "r3", "chat.history", { sessionKey: "del-test" });
    const histRes = await waitForMessage(ws);
    expect((histRes.payload as any).messages.length).toBe(0);

    ws.close();
  });

  test("missing key returns error", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "sessions.delete", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(false);

    ws.close();
  });
});

describe("health method", () => {
  test("returns health with stateVersion", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "health", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).stateVersion).toBeDefined();
    expect((res.payload as any).stateVersion.presence).toBeNumber();
    expect((res.payload as any).stateVersion.health).toBeNumber();

    ws.close();
  });
});

describe("status method", () => {
  test("returns server status", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "status", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    const p = res.payload as any;
    expect(p.protocol).toBe(3);
    expect(p.serverVersion).toBeString();
    expect(p.uptimeMs).toBeNumber();
    expect(p.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(p.connectedClients).toBe(1);
    expect(p.activeSessions).toBeNumber();
    expect(p.activeRuns).toBeNumber();
    expect(p.model).toBe("demo");
    expect(p.provider).toBe("miniclaw");

    ws.close();
  });
});

describe("system-presence method", () => {
  test("returns current presence list", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "system-presence", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).presence).toBeArray();
    expect((res.payload as any).presence.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });
});

describe("logs.tail method", () => {
  test("returns empty log lines", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "logs.tail", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).lines).toBeArray();
    expect((res.payload as any).cursor).toBe(0);

    ws.close();
  });
});

describe("models.list method", () => {
  test("returns current model info", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "models.list", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    const models = (res.payload as any).models;
    expect(models).toBeArray();
    expect(models.length).toBe(1);
    expect(models[0].id).toBe("demo");
    expect(models[0].provider).toBe("miniclaw");
    expect(models[0].active).toBe(true);

    ws.close();
  });
});

describe("config.get method", () => {
  test("returns server config info", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "config.get", {});
    const res = await waitForMessage(ws);
    expect(res.ok).toBe(true);
    expect((res.payload as any).protocol).toBe(3);
    expect((res.payload as any).serverVersion).toBeString();

    ws.close();
  });
});

// ── Password Auth ───────────────────────────────────────────────────────────

describe("password auth", () => {
  test("password auth rejected when wrong", async () => {
    const srv = createServer({ authPassword: "pass123" });
    const ws = connect(srv);
    await drainServerGreeting(ws);

    const closedPromise = new Promise<number>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });

    ws.send(
      JSON.stringify({
        type: "req",
        id: "hs-1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "test", version: "1.0.0", platform: "test", mode: "operator" },
          auth: { password: "wrong" },
        },
      })
    );

    const msg = await waitForMessage(ws);
    expect(msg.ok).toBe(false);
    expect((msg.error as any).message).toMatch(/[Aa]uthentication/);

    await closedPromise;
  });

  test("password auth accepted when correct", async () => {
    const srv = createServer({ authPassword: "pass123" });
    const ws = connect(srv);

    const res = await handshake(ws, { auth: { password: "pass123" } });
    expect(res.ok).toBe(true);
    expect((res.payload as any).snapshot.authMode).toBe("password");

    ws.close();
  });
});

// ── Handshake Timeout ───────────────────────────────────────────────────────

describe("handshake timeout", () => {
  test("connection closed if connect not sent within timeout", async () => {
    const srv = createServer({ handshakeTimeoutMs: 200 });
    const ws = connect(srv);
    await drainServerGreeting(ws);

    // Don't send connect, just wait
    const closedPromise = new Promise<number>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });

    const code = await closedPromise;
    expect(code).toBe(1008);
  });

  test("timeout is cleared on successful connect", async () => {
    const srv = createServer({ handshakeTimeoutMs: 200 });
    const ws = connect(srv);

    const res = await handshake(ws);
    expect(res.ok).toBe(true);

    // Wait past the timeout — should NOT be disconnected
    await Bun.sleep(300);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });
});

// ── Idempotency TTL ─────────────────────────────────────────────────────────

describe("idempotency TTL", () => {
  test("expired idempotency key can be reused", async () => {
    const srv = createServer({ dedupeTtlMs: 100 });
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.send", {
      sessionKey: "main",
      message: "first",
      idempotencyKey: "ttl-test",
    });
    await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    // Wait for TTL to expire
    await Bun.sleep(150);

    // Same key should now work
    sendReq(ws, "r2", "chat.send", {
      sessionKey: "main",
      message: "second",
      idempotencyKey: "ttl-test",
    });

    const msgs = await collectUntil(
      ws,
      (m) => m.type === "res" && m.id === "r2"
    );
    const res = msgs.find((m) => m.type === "res" && m.id === "r2");
    expect(res!.ok).toBe(true);

    ws.close();
  });
});

// ── Global Sequence Numbers ─────────────────────────────────────────────────

describe("global sequence numbers", () => {
  test("broadcast events carry monotonically increasing global seq", async () => {
    const srv = createServer();
    const ws = connect(srv);
    await handshake(ws);

    sendReq(ws, "r1", "chat.send", {
      sessionKey: "main",
      message: "seq test",
      idempotencyKey: "gseq-1",
    });

    const msgs = await collectUntil(
      ws,
      (m) =>
        m.type === "event" &&
        m.event === "chat" &&
        (m.payload as any).state === "final"
    );

    const events = msgs.filter(
      (m) => m.type === "event" && typeof m.seq === "number"
    );
    expect(events.length).toBeGreaterThan(1);

    // Every event's seq should be greater than the previous
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq as number).toBeGreaterThan(events[i - 1]!.seq as number);
    }
  });
});

// ── HTTP Endpoints ──────────────────────────────────────────────────────────

describe("HTTP endpoints", () => {
  test("POST /v1/chat/completions non-streaming", async () => {
    const srv = createServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "demo",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.id).toStartWith("chatcmpl_");
    expect(body.object).toBe("chat.completion");
    expect(body.choices).toBeArray();
    expect(body.choices.length).toBe(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBeString();
    expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toBeDefined();
  });

  test("POST /v1/chat/completions streaming", async () => {
    const srv = createServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: "demo",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();

    // Should contain SSE data lines
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(lines.length).toBeGreaterThanOrEqual(3); // role + content + done chunk

    // Last data line should be [DONE]
    expect(lines[lines.length - 1]).toBe("data: [DONE]");

    // Parse a content chunk
    const contentLine = lines.find((l) => {
      if (l === "data: [DONE]") return false;
      const obj = JSON.parse(l.slice(6));
      return obj.choices?.[0]?.delta?.content;
    });
    expect(contentLine).toBeDefined();
    const chunk = JSON.parse(contentLine!.slice(6));
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0].delta.content).toBeString();
  });

  test("POST /v1/chat/completions rejects with wrong auth token", async () => {
    const srv = createServer({ authToken: "secret" });
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(401);
  });

  test("POST /v1/chat/completions accepts correct auth token", async () => {
    const srv = createServer({ authToken: "secret" });
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.choices[0].message.content).toBeString();
  });

  test("POST /v1/responses returns 501 stub", async () => {
    const srv = createServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain("#TODO");
  });

  test("POST /hooks/wake returns 501 stub", async () => {
    const srv = createServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/hooks/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "wake up" }),
    });

    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  test("POST /hooks/agent returns 501 stub", async () => {
    const srv = createServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/hooks/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "do something" }),
    });

    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  test("POST /tools/invoke returns 501 stub", async () => {
    const srv = createServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "test", args: {} }),
    });

    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  test("unknown HTTP path falls through to WebSocket upgrade", async () => {
    const srv = createServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${baseUrl}/unknown/path`, {
      method: "GET",
    });

    // Should get 426 (WebSocket upgrade required) since it's not a known HTTP endpoint
    expect(res.status).toBe(426);
  });
});

// ── hello-ok shape ──────────────────────────────────────────────────────────

describe("hello-ok shape", () => {
  test("hello-ok contains all registered methods", async () => {
    const srv = createServer();
    const ws = connect(srv);

    const res = await handshake(ws);
    const methods = (res.payload as any).features.methods as string[];

    // Spot-check that stubs are listed
    expect(methods).toContain("agents.list");
    expect(methods).toContain("cron.add");
    expect(methods).toContain("node.invoke");
    expect(methods).toContain("exec.approval.request");
    expect(methods).toContain("tts.convert");
    expect(methods).toContain("wizard.start");
    expect(methods).toContain("usage.cost");
    expect(methods).toContain("web.login.start");
    expect(methods).toContain("voicewake.get");

    // Real implementations
    expect(methods).toContain("chat.send");
    expect(methods).toContain("agent");
    expect(methods).toContain("health");
    expect(methods).toContain("status");
    expect(methods).toContain("sessions.list");

    ws.close();
  });

  test("hello-ok events include new event types", async () => {
    const srv = createServer();
    const ws = connect(srv);

    const res = await handshake(ws);
    const events = (res.payload as any).features.events as string[];

    expect(events).toContain("agent");
    expect(events).toContain("chat");
    expect(events).toContain("tick");
    expect(events).toContain("presence");
    expect(events).toContain("health");
    expect(events).toContain("shutdown");
    expect(events).toContain("connect.challenge");
    expect(events).toContain("config.updated");
    expect(events).toContain("exec.approval");
    expect(events).toContain("node.invoke");
    expect(events).toContain("node.event");

    ws.close();
  });

  test("hello-ok policy includes maxBufferedBytes", async () => {
    const srv = createServer();
    const ws = connect(srv);

    const res = await handshake(ws);
    const policy = (res.payload as any).policy;

    expect(policy.maxPayload).toBeNumber();
    expect(policy.maxBufferedBytes).toBeNumber();
    expect(policy.maxBufferedBytes).toBeGreaterThan(policy.maxPayload);
    expect(policy.tickIntervalMs).toBeNumber();

    ws.close();
  });
});
