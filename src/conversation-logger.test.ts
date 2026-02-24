import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConversationLogger } from "./conversation-logger.ts";
import { MiniClawServer } from "./server.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

let logDir: string;
let server: MiniClawServer | null = null;

let portCounter = 20_100;
function nextPort() { return portCounter++; }

beforeEach(() => {
  logDir = join(
    tmpdir(),
    `miniclaw-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(logDir, { recursive: true, force: true });
});

function todayDate(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ── ConversationLogger unit tests ─────────────────────────────────────────────

describe("ConversationLogger", () => {
  test("creates the log directory on construction", () => {
    new ConversationLogger(logDir);
    expect(existsSync(logDir)).toBe(true);
  });

  test("writes a user message as a JSONL line", () => {
    const logger = new ConversationLogger(logDir);
    const ts = Date.now();

    logger.append("main", {
      role: "user",
      content: [{ type: "text", text: "Hello, world!" }],
      timestamp: ts,
    });

    const file = join(logDir, `main-${todayDate(ts)}.jsonl`);
    expect(existsSync(file)).toBe(true);

    const parsed = JSON.parse(readFileSync(file, "utf8").trim());
    expect(parsed.session).toBe("main");
    expect(parsed.role).toBe("user");
    expect(parsed.timestamp).toBe(ts);
    expect(parsed.content[0].text).toBe("Hello, world!");
  });

  test("writes an assistant message with all fields", () => {
    const logger = new ConversationLogger(logDir);
    const ts = Date.now();

    logger.append("main", {
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
      timestamp: ts,
      stopReason: "end_turn",
      model: "gpt-4o",
      provider: "openai",
    });

    const file = join(logDir, `main-${todayDate(ts)}.jsonl`);
    const parsed = JSON.parse(readFileSync(file, "utf8").trim());
    expect(parsed.role).toBe("assistant");
    expect(parsed.stopReason).toBe("end_turn");
    expect(parsed.model).toBe("gpt-4o");
    expect(parsed.provider).toBe("openai");
  });

  test("appends multiple entries as separate JSONL lines", () => {
    const logger = new ConversationLogger(logDir);
    const ts = Date.now();

    logger.append("chat", { role: "user",      content: [{ type: "text", text: "Hi" }],    timestamp: ts });
    logger.append("chat", { role: "assistant", content: [{ type: "text", text: "Hello!" }], timestamp: ts });

    const file = join(logDir, `chat-${todayDate(ts)}.jsonl`);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(lines).toHaveLength(2);
    expect(lines[0].role).toBe("user");
    expect(lines[1].role).toBe("assistant");
  });

  test("uses separate files for different session keys", () => {
    const logger = new ConversationLogger(logDir);
    const ts = Date.now();

    logger.append("alpha", { role: "user", content: [{ type: "text", text: "A" }], timestamp: ts });
    logger.append("beta",  { role: "user", content: [{ type: "text", text: "B" }], timestamp: ts });

    expect(existsSync(join(logDir, `alpha-${todayDate(ts)}.jsonl`))).toBe(true);
    expect(existsSync(join(logDir, `beta-${todayDate(ts)}.jsonl`))).toBe(true);
  });

  test("sanitizes session keys with special characters", () => {
    const logger = new ConversationLogger(logDir);
    const ts = Date.now();

    logger.append("my/session?key=42", {
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: ts,
    });

    const file = join(logDir, `my-session-key-42-${todayDate(ts)}.jsonl`);
    expect(existsSync(file)).toBe(true);
  });

  test("truncates very long session keys to 64 chars", () => {
    const logger = new ConversationLogger(logDir);
    const ts = Date.now();
    const longKey = "a".repeat(100);

    logger.append(longKey, {
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: ts,
    });

    // File name should use the 64-char truncated key
    const file = join(logDir, `${"a".repeat(64)}-${todayDate(ts)}.jsonl`);
    expect(existsSync(file)).toBe(true);
    // Stored session value is the original key
    const parsed = JSON.parse(readFileSync(file, "utf8").trim());
    expect(parsed.session).toBe(longKey);
  });
});

// ── Server integration tests ──────────────────────────────────────────────────
// Use chatAndWait() to drive conversations directly — no WebSocket complexity.

describe("server conversation logging", () => {
  test("no log files are created without logDir", async () => {
    server = new MiniClawServer({
      port: nextPort(),
      hostname: "127.0.0.1",
      tickIntervalMs: 600_000,
      healthRefreshIntervalMs: 600_000,
    });
    server.start();

    await server.chatAndWait("main", "hello");

    expect(existsSync(logDir)).toBe(false);
  });

  test("user and assistant messages are logged to disk when logDir is set", async () => {
    server = new MiniClawServer({
      port: nextPort(),
      hostname: "127.0.0.1",
      tickIntervalMs: 600_000,
      healthRefreshIntervalMs: 600_000,
      logDir,
    });
    server.start();

    await server.chatAndWait("main", "What is 2+2?");

    expect(existsSync(logDir)).toBe(true);

    const date = todayDate();
    const file = join(logDir, `main-${date}.jsonl`);
    expect(existsSync(file)).toBe(true);

    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(lines.length).toBeGreaterThanOrEqual(2);

    const userLine = lines.find((l: any) => l.role === "user");
    expect(userLine).toBeDefined();
    expect(userLine.session).toBe("main");
    expect(userLine.content[0].text).toBe("What is 2+2?");

    const assistantLine = lines.find((l: any) => l.role === "assistant");
    expect(assistantLine).toBeDefined();
    expect(assistantLine.session).toBe("main");
    expect(assistantLine.content.length).toBeGreaterThan(0);
  });

  test("logs accumulate across multiple turns", async () => {
    server = new MiniClawServer({
      port: nextPort(),
      hostname: "127.0.0.1",
      tickIntervalMs: 600_000,
      healthRefreshIntervalMs: 600_000,
      logDir,
    });
    server.start();

    await server.chatAndWait("multi", "First message");
    await server.chatAndWait("multi", "Second message");

    const file = join(logDir, `multi-${todayDate()}.jsonl`);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // 2 user + 2 assistant = 4 lines minimum
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const userLines = lines.filter((l: any) => l.role === "user");
    expect(userLines[0].content[0].text).toBe("First message");
    expect(userLines[1].content[0].text).toBe("Second message");
  });
});
