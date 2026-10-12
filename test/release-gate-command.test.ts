import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCommandCompleted, assertValidationRejected, runCommand } from "../scripts/release-gate/command.mjs";

describe("release gate validator outcomes", () => {
  it("does not mistake a timed-out validator for a rejected configuration", async () => {
    const children = new Set<number>();
    const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { children, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(() => assertValidationRejected(result)).toThrow(/timed out/i);
    expect(children.size).toBe(0);
  });

  it("accepts an actual validator failure and retains both diagnostic streams", async () => {
    const result = await runCommand(process.execPath, ["-e", 'console.log("validation started"); console.error("invalid min_confidence"); process.exitCode = 2;']);
    expect(result).toMatchObject({ code: 2, signal: null, timedOut: false });
    expect(result.output).toContain("validation started");
    expect(result.output).toContain("invalid min_confidence");
    expect(() => assertValidationRejected(result)).not.toThrow();
  });

  it("rejects a zero-exit parent when an inherited output pipe times out", async () => {
    const children = new Set<number>();
    const result = await runCommand(process.execPath, ["-e", 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", process.stdout, process.stderr] }); child.unref();'], { children, timeoutMs: 1_000 });
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: true });
    expect(() => assertCommandCompleted(result)).toThrow(/timed out/i);
    expect(children.size).toBe(0);
  });

  it("rejects a successful validator exit", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.exitCode = 0;"]);
    expect(() => assertValidationRejected(result)).toThrow(/nonzero validator exit code/);
  });

  it("does not count a signal termination as validation", async () => {
    const result = await runCommand(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM");']);
    expect(result).toMatchObject({ code: null, signal: "SIGTERM", timedOut: false });
    expect(() => assertValidationRejected(result)).toThrow(/terminated by SIGTERM/);
  });

  it("does not count a failed process launch as validation", async () => {
    const children = new Set<number>();
    const result = await runCommand(join(tmpdir(), `missing-agentmemory-validator-${randomUUID()}`), [], { children });
    expect(result.error).toContain("ENOENT");
    expect(() => assertValidationRejected(result)).toThrow(/ENOENT/);
    expect(children.size).toBe(0);
  });
});
