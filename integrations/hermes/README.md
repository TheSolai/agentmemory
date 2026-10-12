# agentmemory for Hermes Agent

The native memory provider adds automatic recall, conversation capture and three memory tools to Hermes. A separate MCP connection exposes all 54 AgentMemory tools. Start the AgentMemory server before using either integration.

## Native provider

Install the AgentMemory package, then copy its provider into your active Hermes home:

```bash
npm install --prefix ./agentmemory-runtime @agentmemory/agentmemory
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins/agentmemory"
cp -R ./agentmemory-runtime/node_modules/@agentmemory/agentmemory/integrations/hermes/. \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/agentmemory/"
```

Add this to the active Hermes `config.yaml`:

```yaml
memory:
  provider: agentmemory
```

Start the server in a separate terminal:

```bash
npx @agentmemory/agentmemory
```

Use `hermes memory status` to confirm that the provider loads. Availability checks validate configuration without contacting the server. An actual `memory_save` or `memory_recall` call verifies connectivity and authentication.

The provider uses these lifecycle hooks:

- `system_prompt_block` retrieves project context at session start.
- `prefetch` retrieves project memories before a model call.
- `sync_turn` captures conversation text through the host's serialized background worker.
- `on_session_switch` completes the previous session and binds subsequent writes to the new session.
- `on_session_end` completes the current session, with failed completion requests remaining retryable.
- `on_pre_compress` returns bounded context for the summary prompt without modifying the transcript.
- `on_memory_write` saves native add and replacement content to AgentMemory.

Conversation capture currently retains up to 500 user characters and 2,000 assistant characters per turn. It does not capture individual tool executions. Native replacement evolves an owned mirrored record only when Hermes supplies its full `previous_content` and the provider has the exact daemon ID from its own earlier write. The server atomically rejects a version that another client has already evolved, rather than changing that client's history. A profile-local ownership file preserves that mapping across restarts. Notifications from older hosts without this identity save the replacement and report that the previous record could not be superseded; the provider never guesses using a text search. Superseded versions remain in their version chain. Removing an entry from Hermes does not delete matching AgentMemory records. Use an explicit AgentMemory deletion tool with verified durable-memory IDs for that operation.

Compression context is a best-effort contribution, not a durable transcript checkpoint. The provider does not opt into Hermes checkpoint API v2. Shutdown waits for in-flight provider writes within a bounded deadline and reports a pending write if the deadline expires. This is not an offline spool or a guarantee against process termination.

## Credentials and configuration

URL precedence is the shell's `AGENTMEMORY_URL`, the active Hermes home's `agentmemory.json`, the local AgentMemory dotenv file, then `http://localhost:3111`. `hermes memory setup agentmemory` saves its URL in that active Hermes home. Secret fields remain managed by Hermes rather than being written to the provider's JSON file.

For a local daemon, the provider reads the secret from `~/.agentmemory/.env`, `$XDG_CONFIG_HOME/agentmemory/.env`, or `~/.agentmemory/secret`. These saved local credentials are used only for exact `localhost` or numeric loopback IP addresses. They are never promoted into the process environment or attached to remote DNS names. For a remote daemon, explicitly supply `AGENTMEMORY_SECRET` for that endpoint. Legacy secrets already present in `agentmemory.json` apply only to that file's endpoint, not an overridden URL. Same-endpoint credential rotations are picked up on the next request. Changing the endpoint requires restarting the session. Hermes's scoped secret accessor is used when available; routed profiles do not inherit local daemon credentials.

| Variable | Default | Purpose |
|---|---|---|
| `AGENTMEMORY_URL` | `http://localhost:3111` | HTTP or HTTPS daemon endpoint |
| `AGENTMEMORY_SECRET` | Local daemon secret on loopback | Explicit bearer credential |
| `AGENTMEMORY_PROJECT_NAME` | Git repository name or working directory name | Canonical project scope |
| `AGENTMEMORY_REQUIRE_HTTPS` | Off | Refuse bearer authentication over remote plaintext HTTP |

Remote plaintext HTTP otherwise emits a warning. Redirects are refused so credentials and memory payloads stay on the configured endpoint. Authentication failures and unavailable servers produce actionable errors, rather than empty successful recall results.

The native tools accept `project` and `agentId`. Save also accepts CSV `concepts` and `files`; recall/search preserve backend result IDs and metadata. Project defaults to the current project. These fields provide explicit scope controls, not automatic multi-profile or gateway identity isolation.

## MCP and skills

For the complete tool surface, add a separate MCP connection to the active Hermes `config.yaml`:

```yaml
mcp_servers:
  agentmemory:
    command: npx
    args: ["-y", "@agentmemory/mcp"]
    env:
      AGENTMEMORY_URL: "${AGENTMEMORY_URL}"
      AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET}"
      AGENTMEMORY_FORCE_PROXY: "1"
```

This alone does not install or enable the native provider. Keep the `memory.provider` configuration only when its provider files are installed.

Hermes resolves these environment references using its active credential scope. Unset values remain placeholders, which the AgentMemory MCP bridge treats as unset: the URL defaults to localhost and the local secret is read automatically. For a custom port or remote daemon, set `AGENTMEMORY_URL` in the Hermes environment so both the native provider and MCP bridge use the same endpoint. The MCP bridge does not read the provider's `agentmemory.json`. Supply remote authentication through `AGENTMEMORY_SECRET`. Explicit proxy mode reports an unavailable daemon instead of quietly saving into a separate standalone store.

Install the shared skills separately:

```bash
npx skills add rohitg00/agentmemory --agent hermes-agent --global
```

The native provider folder does not contain the shared skills. Verify discovery with Hermes's `skills_list` and `skill_view` tools. A workflow needing tools beyond native save/recall/search also requires the MCP connection; use the actual names shown by the host's tool catalog.

## Verification

Run the network-free regression suite with `python3 test/hermes-provider-contracts.py` or `npx vitest run test/hermes-plugin.test.ts`. The native integration harness in `test/hermes-native-e2e.py` installs the provider from an already installed package and runs the actual Hermes loader and CLI against the packaged AgentMemory daemon with a local deterministic model. Its `--help` lists the isolated runtime inputs.
