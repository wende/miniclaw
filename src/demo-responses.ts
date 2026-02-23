// ── Demo Response Definitions ────────────────────────────────────────────────

export interface ToolCall {
  name: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: string;
  isError?: boolean;
  delayMs: number;
}

export interface DemoResponse {
  thinking?: string;
  toolCalls?: ToolCall[];
  text: string;
  instant?: boolean; // deliver entire text at once (for slash commands)
}

// ── Responses ────────────────────────────────────────────────────────────────

const WEATHER_RESPONSE: DemoResponse = {
  toolCalls: [
    {
      name: "web_search",
      toolCallId: "tc_ws_1",
      args: { query: "weather forecast this week" },
      result: JSON.stringify({
        results: [
          { title: "7-Day Forecast", snippet: "Partly cloudy, highs near 68°F" },
          { title: "Weekend Outlook", snippet: "Rain expected Saturday, clearing Sunday" },
        ],
      }),
      delayMs: 1200,
    },
  ],
  text: `Here's the weather forecast for this week:

| Day | High | Low | Condition |
|-----|------|-----|-----------|
| Monday | 68°F | 52°F | Partly Cloudy |
| Tuesday | 71°F | 54°F | Sunny |
| Wednesday | 65°F | 50°F | Overcast |
| Thursday | 63°F | 48°F | Light Rain |
| Friday | 66°F | 51°F | Partly Cloudy |
| Saturday | 59°F | 47°F | Rain |
| Sunday | 70°F | 53°F | Sunny |

> **Tip:** Saturday looks like the only rainy day — plan outdoor activities for Sunday instead.`,
};

const CODE_RESPONSE: DemoResponse = {
  toolCalls: [
    {
      name: "read_file",
      toolCallId: "tc_rf_1",
      args: { path: "src/utils/validate.ts" },
      result: `export function validateEmail(email: string): boolean {
  const re = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return re.test(email);
}`,
      delayMs: 600,
    },
  ],
  text: `I found the validation utility. Here's an improved version with better error handling:

\`\`\`typescript
export function validateEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  // RFC 5322 simplified pattern
  const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_\`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return re.test(email);
}

export function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
\`\`\`

Key improvements:
- **Null safety** — guards against \`null\`/\`undefined\` inputs
- **RFC compliance** — uses a more complete email pattern
- **Added \`validateUrl\`** — bonus utility using the built-in \`URL\` constructor`,
};

const EDIT_RESPONSE: DemoResponse = {
  toolCalls: [
    {
      name: "read_file",
      toolCallId: "tc_rf_2",
      args: { path: "src/config.ts" },
      result: `export const config = {
  port: 3000,
  host: "localhost",
  debug: false,
};`,
      delayMs: 500,
    },
    {
      name: "edit_file",
      toolCallId: "tc_ef_1",
      args: { path: "src/config.ts", old_string: 'debug: false', new_string: 'debug: true,\n  logLevel: "verbose"' },
      result: "File edited successfully.",
      delayMs: 400,
    },
  ],
  text: `Done! I've updated \`src/config.ts\` to enable debug mode and add verbose logging. The changes:

- Set \`debug: true\`
- Added \`logLevel: "verbose"\` for detailed output

You can revert by changing \`debug\` back to \`false\` and removing the \`logLevel\` line.`,
};

const THINK_RESPONSE: DemoResponse = {
  thinking: `Let me think through this step by step.

First, I need to consider the architecture. The user wants a solution that's both performant and maintainable. There are several approaches:

1. We could use a simple hash map for O(1) lookups
2. A trie would give us prefix matching
3. A bloom filter could help with the "does not exist" fast path

Given the requirements, I think approach #1 with a fallback to #2 for prefix queries is the best balance. The hash map handles exact matches instantly, and the trie only kicks in when needed.

Memory usage: ~O(n) for the hash map, ~O(n*k) for the trie where k is average key length. For most workloads this is acceptable.`,
  text: `After careful analysis, here's my recommendation:

## Approach: Hybrid Lookup

Use a **hash map** for exact matches with a **trie** fallback for prefix queries.

\`\`\`typescript
class HybridLookup<T> {
  private exact = new Map<string, T>();
  private prefixTree = new TrieNode<T>();

  set(key: string, value: T): void {
    this.exact.set(key, value);
    this.prefixTree.insert(key, value);
  }

  get(key: string): T | undefined {
    return this.exact.get(key);
  }

  getByPrefix(prefix: string): T[] {
    return this.prefixTree.search(prefix);
  }
}
\`\`\`

### Why this approach?

| Operation | Time Complexity | Notes |
|-----------|----------------|-------|
| Exact lookup | O(1) | Hash map |
| Prefix search | O(k + m) | k=prefix len, m=matches |
| Insert | O(k) | Updates both structures |
| Memory | O(n·k) | n=entries, k=avg key len |

This gives you the best of both worlds — **instant exact matches** and **flexible prefix queries**.`,
};

const ERROR_RESPONSE: DemoResponse = {
  toolCalls: [
    {
      name: "exec",
      toolCallId: "tc_ex_1",
      args: { command: "npm run build" },
      result: "Error: Module not found: Can't resolve './missing-module'\n  at /src/index.ts:3:1",
      isError: true,
      delayMs: 1500,
    },
    {
      name: "read_file",
      toolCallId: "tc_rf_3",
      args: { path: "src/index.ts" },
      result: `import { app } from "./app";\nimport { logger } from "./missing-module";\n\napp.listen(3000);`,
      delayMs: 500,
    },
    {
      name: "edit_file",
      toolCallId: "tc_ef_2",
      args: { path: "src/index.ts", old_string: 'import { logger } from "./missing-module";', new_string: 'import { createLogger } from "pino";\nconst logger = createLogger();' },
      result: "File edited successfully.",
      delayMs: 400,
    },
  ],
  text: `Fixed the build error. The issue was an import from a non-existent module \`./missing-module\`.

**What I did:**
1. Identified the broken import in \`src/index.ts:2\`
2. Replaced it with \`pino\`, a production-ready logging library
3. Created the logger instance inline

Run \`npm run build\` again to verify the fix.`,
};

const LONG_RESPONSE: DemoResponse = {
  text: `# Understanding Modern Web Architecture

## Introduction

The modern web has evolved dramatically over the past decade. What started as simple HTML pages served from a single server has become a complex ecosystem of **microservices**, **edge computing**, and **real-time protocols**.

## The Three Pillars

### 1. Server-Side Rendering (SSR)

SSR remains crucial for SEO and initial page load performance. Frameworks like Next.js and Nuxt make this straightforward:

\`\`\`typescript
// Next.js App Router - Server Component
export default async function Page() {
  const data = await fetchPosts(); // runs on server
  return (
    <main>
      {data.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </main>
  );
}
\`\`\`

### 2. Edge Computing

Edge functions bring computation closer to users, reducing latency by 40-60%:

| Deployment | Avg Latency | Cold Start |
|-----------|-------------|------------|
| Origin (US-East) | 180ms | 500ms |
| CDN Edge | 45ms | 80ms |
| Edge Function | 12ms | 15ms |

### 3. Real-Time Communication

WebSockets, Server-Sent Events, and WebRTC enable live experiences:

- **WebSocket** — bidirectional, full-duplex (chat, gaming)
- **SSE** — server-to-client only, auto-reconnect (notifications, feeds)
- **WebRTC** — peer-to-peer, low latency (video calls, screen sharing)

## Best Practices

> **Always measure before optimizing.** Premature optimization is the root of all evil — but so is shipping a 5-second loading screen.

1. Use \`lighthouse\` for performance audits
2. Implement progressive loading with \`Suspense\`
3. Cache aggressively at the edge
4. Compress assets with Brotli (20% smaller than gzip)
5. Use HTTP/3 where available for multiplexed streams

## Conclusion

The best architecture is the one your team can **understand**, **maintain**, and **evolve**. Start simple, measure everything, and scale only where the data tells you to.

---

*Further reading: [Web.dev](https://web.dev), [Patterns.dev](https://patterns.dev)*`,
};

const DEFAULT_RESPONSE: DemoResponse = {
  text: `I'm **MiniClaw**, a demo server implementing the OpenClaw WebSocket protocol.

Try these keywords to see different features:
- **"weather"** — tool call + markdown table
- **"code"** or **"function"** — file read + code blocks
- **"edit"** or **"fix"** — multi-tool file editing
- **"think"** or **"reason"** — extended reasoning block
- **"error"** or **"fail"** — error recovery chain
- **"long"** or **"essay"** — long-form streaming
- **"/new"** — reset session

All responses include streaming text, markdown rendering, and proper lifecycle events.`,
};

const NEW_SESSION_RESPONSE: DemoResponse = {
  text: `Session cleared. How can I help you?`,
  instant: true,
};

const HELP_RESPONSE: DemoResponse = {
  text: `## Available Commands

| Command | Description |
|---------|-------------|
| \`/new\` | Start a fresh session |
| \`/help\` | Show this help message |

## Demo Keywords

Type any message containing these words:

- **weather** — Weather forecast with web search tool
- **code** / **function** — Code analysis with file read
- **edit** / **fix** — Multi-step file editing
- **think** / **reason** — Extended reasoning block
- **error** / **fail** — Error recovery demo
- **long** / **essay** — Long-form content streaming`,
  instant: true,
};

// ── Keyword Matching ─────────────────────────────────────────────────────────

const KEYWORD_MAP: Array<[string[], DemoResponse]> = [
  [["weather", "forecast"], WEATHER_RESPONSE],
  [["code", "function"], CODE_RESPONSE],
  [["edit", "fix"], EDIT_RESPONSE],
  [["think", "reason"], THINK_RESPONSE],
  [["error", "fail"], ERROR_RESPONSE],
  [["long", "essay"], LONG_RESPONSE],
];

export function matchResponse(message: string): { response: DemoResponse; isNew: boolean } {
  const lower = message.trim().toLowerCase();

  if (lower === "/new") return { response: NEW_SESSION_RESPONSE, isNew: true };
  if (lower === "/help") return { response: HELP_RESPONSE, isNew: false };

  for (const [keywords, response] of KEYWORD_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return { response, isNew: false };
    }
  }

  return { response: DEFAULT_RESPONSE, isNew: false };
}
