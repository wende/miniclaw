import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";

const MINICLAW_PORT = Number(process.env["MINICLAW_PORT"] ?? "18080");
const MOBILECLAW_PORT = Number(process.env["MOBILECLAW_PORT"] ?? "3000");
const MOBILECLAW_DIR =
  process.env["MOBILECLAW_DIR"] ??
  (process.env["HOME"]
    ? resolve(process.env["HOME"], "projects/mobileclaw")
    : resolve(process.cwd(), "../mobileclaw"));
const MINICLAW_START_CMD = process.env["MINICLAW_START_CMD"] ?? "bun run index.ts --config e2e/openclaw.e2e.json";
const MOBILECLAW_START_CMD = process.env["MOBILECLAW_START_CMD"] ?? `pnpm dev --port ${MOBILECLAW_PORT}`;
const MOBILECLAW_BASE_URL = process.env["MOBILECLAW_BASE_URL"] ?? `http://127.0.0.1:${MOBILECLAW_PORT}`;
const REUSE_EXISTING_MOBILECLAW = process.env["MOBILECLAW_REUSE_EXISTING"] !== "0";
const MOBILECLAW_GIT_URL = process.env["MOBILECLAW_GIT_URL"] ?? "https://github.com/wende/mobileclaw.git";
const MOBILECLAW_GIT_REF = process.env["MOBILECLAW_GIT_REF"];
const MOBILECLAW_AUTO_PULL = process.env["MOBILECLAW_AUTO_PULL"] === "1";
const MOBILECLAW_INSTALL_CMD = process.env["MOBILECLAW_INSTALL_CMD"] ?? "pnpm install";

let miniclawProcess: ChildProcess | undefined;
let mobileclawProcess: ChildProcess | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function startCommand(
  name: string,
  command: string,
  cwd: string
): ChildProcess {
  const child = spawn(command, {
    cwd,
    env: process.env,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (process.env["E2E_DEBUG"]) {
    child.stdout?.on("data", (chunk) => process.stdout.write(`[${name}] ${String(chunk)}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[${name}] ${String(chunk)}`));
  }

  return child;
}

function shEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runCommand(
  name: string,
  command: string,
  cwd: string,
  timeoutMs = 300_000
): Promise<void> {
  const child = spawn(command, {
    cwd,
    env: process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: string[] = [];
  const appendOutput = (chunk: Buffer | string) => {
    const text = String(chunk);
    output.push(text);
    if (process.env["E2E_DEBUG"]) process.stdout.write(`[${name}] ${text}`);
  };

  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs);

  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  clearTimeout(timeout);

  if (code === 0) return;

  const tail = output.join("").slice(-3000);
  throw new Error(
    `${name} failed (exit=${code ?? "null"} signal=${signal ?? "null"}): ${command}\n${tail}`
  );
}

async function ensureMobileclawCheckout(): Promise<void> {
  if (!existsSync(MOBILECLAW_DIR)) {
    const cloneRef = MOBILECLAW_GIT_REF ? `--branch ${shEscape(MOBILECLAW_GIT_REF)} ` : "";
    await runCommand(
      "mobileclaw:clone",
      `git clone ${cloneRef}--depth=1 ${shEscape(MOBILECLAW_GIT_URL)} ${shEscape(MOBILECLAW_DIR)}`,
      process.cwd(),
      180_000
    );
    await runCommand("mobileclaw:install", MOBILECLAW_INSTALL_CMD, MOBILECLAW_DIR, 300_000);
    return;
  }

  if (!MOBILECLAW_AUTO_PULL) return;

  await runCommand("mobileclaw:fetch", "git fetch --all --prune", MOBILECLAW_DIR, 120_000);
  if (MOBILECLAW_GIT_REF) {
    await runCommand(
      "mobileclaw:checkout",
      `git checkout ${shEscape(MOBILECLAW_GIT_REF)}`,
      MOBILECLAW_DIR
    );
    await runCommand(
      "mobileclaw:pull",
      `git pull --ff-only origin ${shEscape(MOBILECLAW_GIT_REF)}`,
      MOBILECLAW_DIR,
      120_000
    );
  } else {
    await runCommand("mobileclaw:pull", "git pull --ff-only", MOBILECLAW_DIR, 120_000);
  }
}

async function stopCommand(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null) return;

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  await Promise.race([once(child, "exit"), sleep(10_000)]);
  if (child.exitCode !== null) return;

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }

  await Promise.race([once(child, "exit"), sleep(5_000)]);
}

function canConnectToPort(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port });

    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePort(ok);
    };

    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForPort(
  name: string,
  port: number,
  processHandle: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`${name} exited early with code ${processHandle.exitCode}`);
    }
    if (await canConnectToPort(port)) return;
    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${name} on 127.0.0.1:${port}`);
}

async function waitForHttp(
  name: string,
  url: string,
  processHandle: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`${name} exited early with code ${processHandle.exitCode}`);
    }

    try {
      const res = await fetch(url);
      if (res.status < 500) {
        await sleep(500);
        if (processHandle.exitCode !== null) {
          throw new Error(`${name} exited right after startup with code ${processHandle.exitCode}`);
        }
        return;
      }
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(300);
  }

  throw new Error(`Timed out waiting for ${name} at ${url}${lastError ? ` (${lastError})` : ""}`);
}

async function isHttpReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.status < 500;
  } catch {
    return false;
  }
}

async function sendChatMessage(page: import("@playwright/test").Page, text: string): Promise<void> {
  const input = page.getByPlaceholder("Send a message...");
  await input.fill(text);
  await input.press("Enter");
}

test.describe("MobileClaw <-> MiniClaw", () => {
  test.beforeAll(async () => {
    await ensureMobileclawCheckout();

    miniclawProcess = startCommand("miniclaw", MINICLAW_START_CMD, process.cwd());
    await waitForPort("MiniClaw", MINICLAW_PORT, miniclawProcess, 45_000);

    const existingMobileclawReady = REUSE_EXISTING_MOBILECLAW
      ? await isHttpReady(MOBILECLAW_BASE_URL)
      : false;

    if (!existingMobileclawReady) {
      mobileclawProcess = startCommand("mobileclaw", MOBILECLAW_START_CMD, MOBILECLAW_DIR);
      await waitForHttp(
        "MobileClaw",
        MOBILECLAW_BASE_URL,
        mobileclawProcess,
        120_000
      );
    }
  });

  test.afterAll(async () => {
    await stopCommand(mobileclawProcess);
    await stopCommand(miniclawProcess);
  });

  test("connects, sends message, and receives response", async ({ page }) => {
    await page.addInitScript(() => {
      const browser = globalThis as any;
      browser.localStorage?.clear();
      browser.sessionStorage?.clear();
    });

    const wsUrl = `ws://127.0.0.1:${MINICLAW_PORT}`;
    const detachedUrl = `${MOBILECLAW_BASE_URL}/?detached=1&url=${encodeURIComponent(wsUrl)}`;
    await page.goto(detachedUrl);

    await expect(page.getByPlaceholder("Send a message...")).toBeVisible({ timeout: 25_000 });

    await sendChatMessage(page, "weather");

    await expect(page.getByText(/weather forecast for this week/i)).toBeVisible({
      timeout: 45_000,
    });
  });
});
