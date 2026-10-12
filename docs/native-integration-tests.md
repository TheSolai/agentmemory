# Native integration tests

Build and install the candidate before testing. Use fresh output directories and isolated host installations; do not run the fixtures against a personal daemon or host profile. The gates use synthetic content and local deterministic model responses. They do not need an external model key.

```bash
npm run build
npm run skills:gen
npm run docs:sync
npm run skills:check
npm test
npm pack --pack-destination /path/to/artifacts
npm pack ./packages/mcp --pack-destination /path/to/artifacts
npm install --prefix /path/to/isolated-runtime --no-package-lock \
  /path/to/artifacts/agentmemory-agentmemory-<version>.tgz \
  /path/to/artifacts/agentmemory-mcp-<version>.tgz
```

The root tarball must include `integrations/hermes`, `integrations/openclaw` and `plugin/skills`. Python cache files must not be included. Install both tarballs together so the MCP shim resolves the candidate package rather than an older registry release. The pinned iii engine can be cached by the standard release gate.

## Skills and HTTP/MCP contracts

Use an installed `skills` CLI supporting the `hermes-agent` and `openclaw` targets. The gate invokes its actual copy installer into separate homes, checks every skill's supporting files, executes the REST skill's quick start with an isolated port, and exercises the installed MCP shim.

```bash
npm run test:skills:packaged -- \
  --package-root /path/to/isolated-runtime/node_modules/@agentmemory/agentmemory \
  --mcp-cli /path/to/isolated-runtime/node_modules/@agentmemory/mcp/bin.mjs \
  --skills-cli /path/to/skills/bin/cli.mjs \
  --engine /path/to/iii \
  --out /tmp/agentmemory-skills-gate
```

The wire checks cover generated-secret authentication, advertised tool arguments, durable save/recall, agent and project filtering, actual deletion counts, and session pagination through REST, daemon MCP and stdio MCP. They compare returned IDs and cursor pages, not just successful exit codes.

## Hermes

Use a real Hermes checkout with its Python dependencies installed. Run once for each supported host version:

```bash
python3 test/hermes-native-e2e.py \
  --package /path/to/isolated-runtime/node_modules/@agentmemory/agentmemory \
  --host /path/to/hermes-agent \
  --python /path/to/hermes-venv/bin/python \
  --engine /path/to/iii \
  --out /tmp/agentmemory-hermes-gate
```

The harness loads the copied provider through Hermes, invokes native memory tools and lifecycle dispatch, runs its actual CLI against a deterministic model, and verifies full recalled content in model requests and captured records in the daemon. It also checks skills and the full MCP tool connection, credentials, session switching, compression, replacement and restart. Use `--python-path` if the host needs an additional isolated dependency directory.

Replacement requires the host's authoritative previous-content notification and the provider's owned ID. Older hosts without that notification must report the limitation and retain the old record. The gate measures this using the native memory tool's actual result rather than inventing metadata.

## OpenClaw

Use a Node runtime supported by the installed host. Repeat `--openclaw-cli` to exercise multiple versions:

```bash
npm run test:openclaw:packaged -- \
  --package-root /path/to/isolated-runtime/node_modules/@agentmemory/agentmemory \
  --node /path/to/node \
  --openclaw-cli /path/to/openclaw/openclaw.mjs \
  --engine /path/to/iii \
  --out /tmp/agentmemory-openclaw-gate
```

The gate uses the native connector, config validation, plugin loader, agent runner and model wire. Checks include scoped full-content recall, conversation capture, skills, disabled recall, budget limits, conversation-access denial, authentication failures and recovery, and daemon restart. Native hook unit tests additionally exercise duplicate callbacks, key-only sessions, in-flight capture completion and malformed message content.

## Interpreting results

Each gate writes a JSON summary and logs to its output directory. Check success flags, unchanged package hashes and process cleanup. The network-free Hermes contracts also run through `test/hermes-plugin.test.ts` during `npm test`.

Deterministic responses verify host discovery, tool dispatch, lifecycle wiring and serialization. They do not measure external model answer quality, chat-channel delivery, cross-profile access-control policy, crash-durable native capture or exhaustive host-version compatibility. A native provider, MCP connection and skill installation are distinct surfaces; each must be tested separately.
