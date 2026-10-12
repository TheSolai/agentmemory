import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("OpenClaw connector", () => {
  let home: string;
  let path: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openclaw-connect-"));
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    vi.stubEnv("OPENCLAW_HOME", "");
    vi.resetModules();
    mkdirSync(join(home, ".openclaw"));
    path = join(home, ".openclaw", "openclaw.json");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  it("writes the native registry without overriding unrelated configuration, then stays unchanged", async () => {
    const existing = { agents: { defaults: { workspace: "/custom" } }, mcp: { servers: { other: { command: "custom" } } } };
    writeFileSync(path, JSON.stringify(existing));
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    expect((await adapter.install({ dryRun: false, force: false })).kind).toBe("installed");
    const text = readFileSync(path, "utf8"); const config = JSON.parse(text);
    expect(config.agents).toEqual(existing.agents);
    expect(config.mcp.servers.other).toEqual({ command: "custom" });
    expect(config.mcp.servers.agentmemory).toEqual({ command: "npx", args: ["-y", "@agentmemory/mcp"], transport: "stdio", env: { AGENTMEMORY_TOOLS: "all", AGENTMEMORY_FORCE_PROXY: "1" } });
    expect(config.mcpServers).toBeUndefined();
    expect((await adapter.install({ dryRun: false, force: false })).kind).toBe("already-wired");
    expect(readFileSync(path, "utf8")).toBe(text);
  });
  it("migrates the old AgentMemory block and preserves custom values", async () => {
    const legacy = { command: "npx", args: ["-y", "@agentmemory/mcp"], env: { AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}", AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}", CUSTOM: "preserved" } };
    writeFileSync(path, JSON.stringify({ mcpServers: { agentmemory: legacy }, agents: { defaults: {} } }));
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    expect((await adapter.install({ dryRun: false, force: false })).kind).toBe("installed");
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.mcpServers).toBeUndefined();
    expect(config.mcp.servers.agentmemory.env).toEqual({ CUSTOM: "preserved", AGENTMEMORY_TOOLS: "all", AGENTMEMORY_FORCE_PROXY: "1" });
    expect(config.mcp.servers.agentmemory.transport).toBe("stdio");
  });
  it("preserves an explicit legacy proxy override during migration", async () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { agentmemory: { command: "npx", args: ["@agentmemory/mcp"], env: { AGENTMEMORY_FORCE_PROXY: "0" } } } }));
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    await adapter.install({ dryRun: false, force: false });
    expect(JSON.parse(readFileSync(path, "utf8")).mcp.servers.agentmemory.env.AGENTMEMORY_FORCE_PROXY).toBe("0");
  });
  it.each(["{ broken", "null", "[]", '{"mcp":{"servers":[]}}'])("does not overwrite malformed config %s", async (raw) => {
    writeFileSync(path, raw);
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    expect((await adapter.install({ dryRun: false, force: true })).kind).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
  it("dry-run neither migrates nor creates backups", async () => {
    const raw = JSON.stringify({ mcpServers: { agentmemory: { command: "npx", args: ["@agentmemory/mcp"] } } });
    writeFileSync(path, raw);
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    await adapter.install({ dryRun: true, force: false });
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(existsSync(join(home, ".agentmemory"))).toBe(false);
  });
  it("preserves a customized native server until force is requested", async () => {
    const raw = JSON.stringify({ mcp: { servers: { agentmemory: { command: "custom", env: { CUSTOM: "yes" } } } } });
    writeFileSync(path, raw);
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    await adapter.install({ dryRun: false, force: false });
    expect(readFileSync(path, "utf8")).toBe(raw);
    await adapter.install({ dryRun: false, force: true });
    expect(JSON.parse(readFileSync(path, "utf8")).mcp.servers.agentmemory.command).toBe("npx");
  });

  it("targets the native custom state directory", async () => {
    const state = join(home, "profile-state"); mkdirSync(state);
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    expect(adapter.detect()).toBe(true);
    await adapter.install({ dryRun: false, force: false });
    expect(existsSync(join(state, "openclaw.json"))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
  it("leaves mixed legacy registries untouched and explains why native validation needs migration", async () => {
    const raw = JSON.stringify({ mcpServers: { agentmemory: { command: "npx", args: ["@agentmemory/mcp"] }, custom: { command: "custom" } } });
    writeFileSync(path, raw);
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    expect((await adapter.install({ dryRun: false, force: false })).kind).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
  it("does not report a null native entry as connected", async () => {
    writeFileSync(path, '{"mcp":{"servers":{"agentmemory":null}}}');
    const { adapter } = await import("../src/cli/connect/openclaw.js");
    expect((await adapter.install({ dryRun: false, force: false })).kind).toBe("skipped");
  });

});
