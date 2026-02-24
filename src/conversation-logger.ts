// ── Conversation Logger ──────────────────────────────────────────────────────
// Persists conversation history to JSONL files on disk.
// One file per session per day: {logDir}/{sanitizedSessionKey}-{YYYY-MM-DD}.jsonl
// Each line is a JSON-encoded HistoryEntry augmented with the session key.

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { HistoryEntry } from "./server.ts";

function sanitizeKey(key: string): string {
  // Replace any char that isn't safe for filenames with "-", cap at 64 chars
  return key.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export class ConversationLogger {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** Append a single history entry to the session's log file. */
  append(sessionKey: string, entry: HistoryEntry): void {
    const date = isoDate(entry.timestamp);
    const safe = sanitizeKey(sessionKey);
    const filename = join(this.dir, `${safe}-${date}.jsonl`);
    const line = JSON.stringify({ session: sessionKey, ...entry }) + "\n";
    appendFileSync(filename, line, "utf8");
  }
}
