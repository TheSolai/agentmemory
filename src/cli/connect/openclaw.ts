import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import type { ConnectAdapter } from "./types.js";
import { backupFile, logAlreadyWired, logBackup, logInstalled, readJsonSafe, writeJsonAtomic } from "./util.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(process.env.OPENCLAW_HOME?.trim() || homedir(), ".openclaw");
const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || join(stateDir, "openclaw.json");
const defaultEntry = { command: "npx", args: ["-y", "@agentmemory/mcp"], transport: "stdio", env: { AGENTMEMORY_TOOLS: "all", AGENTMEMORY_FORCE_PROXY: "1" } };

export const adapter: ConnectAdapter = {
  name: "openclaw",
  displayName: "OpenClaw",
  category: "native",
  docs: "https://github.com/rohitg00/agentmemory/tree/main/integrations/openclaw",
  protocolNote: "→ Using MCP. Install the native plugin separately for automatic recall and capture.",
  detect: () => existsSync(configPath) || existsSync(stateDir),
  async install(opts) {
    const existing = readJsonSafe(configPath);
    if ((existsSync(configPath) && !record(existing)) ||
        (record(existing) && existing.mcp !== undefined && !record(existing.mcp))) {
      p.log.warn(`OpenClaw config is not a JSON object. Left ${configPath} unchanged; use OpenClaw's native MCP configuration command for JSON5 files.`);
      return { kind: "skipped", reason: "invalid-config" };
    }
    const next = { ...(existing ?? {}) } as Record<string, unknown>;
    const mcp = { ...((next.mcp ?? {}) as Record<string, unknown>) };
    if (mcp.servers !== undefined && !record(mcp.servers)) return { kind: "skipped", reason: "invalid-config" };
    const servers = { ...((mcp.servers ?? {}) as Record<string, unknown>) };
    const legacyServers = record(next.mcpServers) ? { ...next.mcpServers } : {};
    const legacy = legacyServers.agentmemory;
    const migrateLegacy = record(legacy) && legacy.command === "npx" && Array.isArray(legacy.args) && legacy.args.includes("@agentmemory/mcp");
    if (next.mcpServers !== undefined && (!migrateLegacy || Object.keys(legacyServers).some((key) => key !== "agentmemory"))) {
      p.log.warn("OpenClaw rejects the legacy mcpServers key. Left the file unchanged; migrate custom servers with OpenClaw's native configuration tools first.");
      return { kind: "skipped", reason: "legacy-config-needs-migration" };
    }
    if (servers.agentmemory !== undefined && !record(servers.agentmemory) && !opts.force) {
      p.log.warn("OpenClaw's AgentMemory entry is invalid. Left it unchanged; repair it or use --force.");
      return { kind: "skipped", reason: "invalid-entry" };
    }
    if (servers.agentmemory !== undefined && !opts.force && !migrateLegacy) {
      logAlreadyWired("OpenClaw", configPath);
      return { kind: "already-wired", mutatedPath: configPath };
    }
    if (opts.dryRun) {
      p.log.info(`[dry-run] Would configure mcp.servers.agentmemory in ${configPath}`);
      return { kind: "installed", mutatedPath: configPath };
    }
    const backupPath = existsSync(configPath) ? backupFile(configPath, "openclaw") : undefined;
    if (backupPath) logBackup(backupPath);
    if (servers.agentmemory === undefined || opts.force) {
      const migrated = migrateLegacy && !opts.force ? { ...legacy } : {};
      const env = { ...defaultEntry.env, ...(record(migrated.env) ? migrated.env : {}) } as Record<string, unknown>;
      for (const [key, value] of Object.entries(env)) {
        if ((key === "AGENTMEMORY_URL" && value === "${AGENTMEMORY_URL:-http://localhost:3111}") ||
            (key === "AGENTMEMORY_SECRET" && value === "${AGENTMEMORY_SECRET:-}")) delete env[key];
        if (key === "AGENTMEMORY_TOOLS" && value === "${AGENTMEMORY_TOOLS:-all}") env[key] = "all";
      }
      servers.agentmemory = { ...defaultEntry, ...migrated, transport: "stdio", env };
    }
    if (migrateLegacy) {
      delete next.mcpServers;
    }
    next.mcp = { ...mcp, servers };
    writeJsonAtomic(configPath, next);
    logInstalled("OpenClaw", configPath);
    return { kind: "installed", mutatedPath: configPath, ...(backupPath ? { backupPath } : {}) };
  },
};
