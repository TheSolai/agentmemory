# agentmemory for OpenClaw

Use the native plugin for automatic recall and conversation capture. MCP tools and AgentMemory skills are separate, optional installations that use the same backend.

## Start the backend

```bash
npx @agentmemory/agentmemory
```

The local backend stores its generated credential in `~/.agentmemory/secret`. `base_url` overrides `AGENTMEMORY_URL`; the default is localhost:3111. The native plugin prefers `AGENTMEMORY_SECRET`, then `~/.agentmemory/.env`, then the generated credential. Saved credentials are read only for loopback URLs and refreshed on each request. For a remote server, set `AGENTMEMORY_SECRET` explicitly and use HTTPS. The plugin refuses redirects so credentials are not forwarded to another endpoint.

## Install the native plugin

Copy `integrations/openclaw` from the repository or the extracted `@agentmemory/agentmemory` npm package into `~/.openclaw/extensions/agentmemory`:

```bash
mkdir -p ~/.openclaw/extensions
cp -r integrations/openclaw ~/.openclaw/extensions/agentmemory
```

Merge this configuration into `~/.openclaw/openclaw.json`, preserving other plugins and settings:

```json
{
  "plugins": {
    "allow": ["agentmemory"],
    "slots": { "memory": "agentmemory" },
    "entries": {
      "agentmemory": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "base_url": "http://localhost:3111",
          "token_budget": 2000,
          "min_confidence": 0.5,
          "fallback_on_error": true,
          "timeout_ms": 5000
        }
      }
    }
  }
}
```

Restart OpenClaw after installation. OpenClaw requires the conversation-access grant for capture. Recall uses the separate prompt-injection permission; `hooks.allowPromptInjection: false` disables recalled context. Manually copied plugins can also produce an installation-provenance warning; use the host's plugin installation command when managed provenance is required.

The plugin uses `before_prompt_build`, supported by both tested OpenClaw versions, 2026.7.1-2 and 2026.10.2. It registers one recall phase, so hosts that still expose `before_agent_start` do not inject memory twice. It expands compact search results before injection, scopes both requests to the workspace's project name and native agent, and captures completed user/assistant turns through `agent_end`.

Native hook context supplies the session ID or session key, workspace directory and agent ID. Project resolution follows `AGENTMEMORY_PROJECT_NAME`, the canonical Git repository name (including nested directories and linked worktrees), then the workspace directory's basename. A missing session or workspace skips the operation with a warning instead of performing an unscoped search. Session startup binds the native agent before capture. Repeated callbacks use the same durable event ID; failed session startup can be retried. Native `session_end` waits for in-flight captures before finalizing the backend session and clearing local startup state.

`min_confidence` is the minimum normalized retrieval score, from 0 to 1. `token_budget` bounds the complete injected block using an approximate allowance of four UTF-8 bytes per token; it is not a model-specific tokenizer. A zero budget disables recall. `timeout_ms` bounds each request. With `fallback_on_error: true`, failed requests warn and allow the turn to continue; this does not queue offline captures for later delivery. Setting it to `false` exposes errors to the host.

The memory-slot registration supplies a prompt builder. It does not implement OpenClaw's in-process `MemoryPluginRuntime`; recall and capture use the authenticated AgentMemory REST API.

## Add MCP tools

```bash
npx @agentmemory/agentmemory connect openclaw
```

The connector writes `mcp.servers.agentmemory`, preserves other native settings, backs up changed files, and supports `--dry-run`. It migrates the AgentMemory entry written by older connector versions under `mcpServers`. Customized native entries are left unchanged unless `--force` is supplied. JSON5 or malformed files are left unchanged with guidance to use OpenClaw's native configuration tools. Files with other legacy `mcpServers` entries are left untouched for a separate migration, because the host rejects that top-level key.

The native configuration shape is:

```json
{
  "mcp": {
    "servers": {
      "agentmemory": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@agentmemory/mcp"],
        "env": { "AGENTMEMORY_TOOLS": "all", "AGENTMEMORY_FORCE_PROXY": "1" }
      }
    }
  }
}
```

The connector enables `AGENTMEMORY_FORCE_PROXY=1` so backend failures remain visible instead of silently using a separate local store. Existing custom overrides are preserved during migration. The MCP process inherits environment settings. Keep credentials in the environment or the local AgentMemory credential files rather than putting their values in this JSON. Validate the result with `openclaw config validate`.

## Add skills

Install the `plugin/skills` bundle separately using the AgentMemory skill installer, or configure OpenClaw's `skills.load.extraDirs` to the bundle's absolute directory. The root npm package includes both the native integration and the skills; copying only `integrations/openclaw` does not install skills or MCP tools. Skill instructions require the corresponding REST or MCP connection.

## Verification

The packaged native gate accepts an installed AgentMemory package, a Node runtime supported by the native hosts, their CLI entrypoints, and a cached pinned iii engine:

```bash
node scripts/release-gate/openclaw.mjs \
  --package-root /path/to/node_modules/@agentmemory/agentmemory \
  --node /path/to/node \
  --openclaw-cli /path/to/openclaw/openclaw.mjs \
  --engine /path/to/iii \
  --out /tmp/agentmemory-openclaw-gate
```

Repeat `--openclaw-cli` to test multiple installed hosts. The gate uses isolated homes and synthetic credentials, inspects actual native model and backend traffic, and stops its own processes. Deterministic model fixtures verify hook/tool wiring and payloads, not external model answer quality or channel delivery.
