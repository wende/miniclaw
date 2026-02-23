# MiniClaw

A lightweight gateway server implementing the [OpenClaw Gateway Protocol v3](protocol-spec.md). Connects AI models (Ollama, OpenAI-compatible APIs) to clients over WebSocket and HTTP, with MCP tool-use support.

## Features

- **WebSocket RPC** -- Full protocol v3 handshake, auth (token/password), presence, sessions, agent runs with streaming events
- **HTTP API** -- OpenAI-compatible `/v1/chat/completions` endpoint (streaming + non-streaming)
- **Provider backends** -- Ollama native API, any OpenAI-compatible API (OpenRouter, local vLLM, etc.)
- **MCP integration** -- Acts as both MCP server (expose chat/session tools via stdio) and MCP client (connect to external tool servers)
- **Tool use** -- Models can call tools mid-conversation with automatic result injection and multi-turn loops
- **Session management** -- Multi-session chat history, inject/reset/delete/patch, idempotency deduplication
- **Demo mode** -- Runs without any model backend using keyword-matched responses

## Quick Start

```bash
# Install dependencies
bun install

# Run in demo mode (no model needed)
bun run index.ts

# Run with Ollama
ollama serve &
ollama pull qwen3:4b
bun run index.ts --ollama

# Run with a specific model
bun run index.ts --ollama --model llama3.2:3b
```

The server starts on `ws://localhost:8080` by default.

## Provider Configuration

### Ollama (native API)

```bash
OLLAMA_BASE_URL=http://localhost:11434 OLLAMA_MODEL=qwen3:4b bun run index.ts --ollama
```

### OpenAI-compatible (via openclaw.json)

Copy the example config and fill in your credentials:

```bash
cp openclaw.json.example openclaw.json
```

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "openrouter/deepseek/deepseek-chat-v3-0324" }
    }
  },
  "models": {
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "${OPENROUTER_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "deepseek/deepseek-chat-v3-0324", "name": "DeepSeek V3" }
        ]
      }
    }
  }
}
```

API keys use `${ENV_VAR}` syntax -- set the env var, don't hardcode secrets.

```bash
OPENROUTER_API_KEY=sk-or-... bun run index.ts
```

### Model selection

The model ref format is `provider/model-id`. Pass `--model` to override the default:

```bash
bun run index.ts --model openrouter/google/gemini-2.5-flash-preview
```

## MCP Server Mode

MiniClaw can run as an MCP server over stdio, exposing `chat`, `clear_session`, and `list_models` tools. This lets Claude Desktop, Cursor, or any MCP client talk to your local models.

```bash
bun run mcp-server.ts
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "miniclaw": {
      "command": "bun",
      "args": ["run", "/path/to/miniclaw/mcp-server.ts"]
    }
  }
}
```

## MCP Client Mode

MiniClaw can also connect to external MCP tool servers, making their tools available to the model. Create a `mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

```bash
bun run index.ts --ollama --mcp
```

## HTTP API

The `/v1/chat/completions` endpoint is OpenAI-compatible:

```bash
# Non-streaming
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "hello"}], "stream": false}'

# Streaming
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"messages": [{"role": "user", "content": "hello"}], "stream": true}'
```

If `authToken` is configured, pass `Authorization: Bearer <token>`.

## WebSocket Protocol

Connect via WebSocket and complete the handshake:

```json
// Server sends: hello + connect.challenge
// Client sends:
{"type":"req","id":"1","method":"connect","params":{
  "minProtocol":3,"maxProtocol":3,
  "client":{"id":"my-app","version":"1.0.0","platform":"web","mode":"operator"}
}}
// Server responds: hello-ok with features, snapshot, policy

// Send a chat message:
{"type":"req","id":"2","method":"chat.send","params":{
  "sessionKey":"main","message":"What is 2+2?","idempotencyKey":"abc123"
}}
// Server streams: agent events (lifecycle, reasoning, tool, assistant) + chat events (delta, final)
```

See [protocol-spec.md](protocol-spec.md) for the full specification.

## Development

```bash
# Run tests (137 tests)
bun test

# Type check
bun run typecheck

# Lint
bun run lint

# Test with coverage
bun run test:coverage
```

## Project Structure

```
index.ts              # CLI entrypoint (WebSocket server)
mcp-server.ts         # MCP stdio entrypoint (WebSocket + MCP server)
openclaw.json.example # Provider config template
mcp.json              # MCP client tool server config
protocol-spec.md      # OpenClaw Gateway Protocol v3 specification
src/
  server.ts           # Core WebSocket server, RPC routing, session/run management
  server.test.ts      # Tests (137 tests covering all protocol methods)
  ollama.ts           # Ollama native API streaming handler + mock tools
  openai-compat.ts    # OpenAI-compatible API streaming handler
  config.ts           # openclaw.json loader and model resolution
  mcp-server.ts       # MCP server setup (chat/clear/list tools)
  mcp-client.ts       # MCP client manager (connect to external tool servers)
  types.ts            # Protocol frame types, config types
  demo-responses.ts   # Keyword-matched demo responses for no-model mode
```

## License

MIT
