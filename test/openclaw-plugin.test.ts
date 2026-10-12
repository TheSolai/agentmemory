import { describe, expect, it, vi } from "vitest";

type Capability = {
  promptBuilder?: (params: {
    availableTools: Set<string>;
  }) => string[] | undefined;
};

type RegisterFn = (capability: Capability) => void;

interface FakeApi {
  registerMemoryCapability: RegisterFn;
  on: ReturnType<typeof vi.fn>;
  pluginConfig: Record<string, unknown>;
  logger: { warn: ReturnType<typeof vi.fn> };
}

function makeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  return {
    registerMemoryCapability: vi.fn(),
    on: vi.fn(),
    pluginConfig: { base_url: "http://localhost:3111" },
    logger: { warn: vi.fn() },
    ...overrides,
  };
}

describe("openclaw plugin — memory capability registration", () => {
  it("calls api.registerMemoryCapability with a promptBuilder when the host supports it", async () => {
    const mod = await import("../integrations/openclaw/plugin.mjs");
    const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
    const api = makeApi();
    plugin.register(api);
    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);
    const capability = (api.registerMemoryCapability as ReturnType<typeof vi.fn>).mock.calls[0][0] as Capability;
    expect(typeof capability.promptBuilder).toBe("function");
    const lines = capability.promptBuilder?.({ availableTools: new Set() });
    expect(Array.isArray(lines)).toBe(true);
    expect((lines as string[]).join(" ")).toMatch(/agentmemory/i);
  });

  it("still registers hooks and tolerates older OpenClaw builds without registerMemoryCapability", async () => {
    const mod = await import("../integrations/openclaw/plugin.mjs");
    const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
    const api = makeApi({ registerMemoryCapability: undefined as unknown as RegisterFn });
    expect(() => plugin.register(api)).not.toThrow();
    expect(api.on).toHaveBeenCalled();
    const events = (api.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toContain("before_prompt_build");
    expect(events).toContain("agent_end");
  });

  it("promptBuilder returns lines that mention the configured base_url", async () => {
    const mod = await import("../integrations/openclaw/plugin.mjs");
    const plugin = (mod as unknown as { default: { register(api: FakeApi): void } }).default;
    const api = makeApi({ pluginConfig: { base_url: "http://memory.internal:9999" } });
    plugin.register(api);
    const capability = (api.registerMemoryCapability as ReturnType<typeof vi.fn>).mock.calls[0][0] as Capability;
    const lines = capability.promptBuilder?.({ availableTools: new Set() }) ?? [];
    expect(lines.join("\n")).toMatch(/memory\.internal:9999/);
  });
});

describe("OpenClaw native conversation contract", () => {
  it("captures with native context session, workspace, project and agent identity", async () => {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    const api = makeApi();
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      plugin.register(api);
      const handler = api.on.mock.calls.find(([name]) => name === "agent_end")?.[1];
      await handler({ success: true, runId: "wrong-event-id", messages: [
        { role: "user", content: "Ship the fix" },
        { role: "assistant", content: [{ type: "text", text: "Verified the fix" }] },
      ] }, { sessionId: "native-session", workspaceDir: "/workspace/service", agentId: "reviewer", runId: "native-run" });
      expect(calls[0]).toMatchObject({ path: "http://localhost:3111/agentmemory/session/start", body: { sessionId: "native-session", project: "service", cwd: "/workspace/service", agentId: "reviewer" } });
      expect(calls[1]).toMatchObject({ path: "http://localhost:3111/agentmemory/observe", body: { sessionId: "native-session", project: "service", cwd: "/workspace/service", eventId: expect.stringMatching(/^openclaw-[a-f0-9]{64}$/), data: { tool_name: "conversation", tool_input: "Ship the fix", tool_output: "Verified the fix" } } });
    } finally { fetchMock.mockRestore(); }
  });
});

describe("OpenClaw native recall", () => {
  it("uses the current prompt phase once, scopes both queries and expands full content", async () => {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    const api = makeApi();
    const requests: Record<string, unknown>[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      return new Response(JSON.stringify(body.expandIds ? { results: [{ observation: { title: "Deployment", narrative: "Actual deployment code COBALT-9271", importance: 0.9 } }] } : { results: [{ obsId: "memory-1", sessionId: "memory", title: "Deployment", score: 0.9 }] }), { status: 200 });
    });
    try {
      plugin.register(api);
      expect(api.on.mock.calls.map(([name]) => name)).not.toContain("before_agent_start");
      const handler = api.on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
      expect(handler).toBeTypeOf("function");
      const result = await handler({ prompt: "How do we deploy?" }, { sessionId: "session-1", workspaceDir: "/work/service", agentId: "reviewer" });
      expect(requests).toEqual([
        { query: "How do we deploy?", limit: 5, includeLessons: false, project: "service", agentId: "reviewer", sessionId: "session-1", source: "openclaw" },
        { expandIds: [{ obsId: "memory-1", sessionId: "memory" }], project: "service", agentId: "reviewer", sessionId: "session-1", source: "openclaw" },
      ]);
      expect(result.prependContext).toContain("COBALT-9271");
    } finally { fetchMock.mockRestore(); }
  });
});

describe("OpenClaw recall limits and errors", () => {
  async function invoke(config: Record<string, unknown>, responses: unknown[], context = { sessionId: "s", workspaceDir: "/work/service" }) {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    const api = makeApi({ pluginConfig: config });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response instanceof Response ? response : new Response(JSON.stringify(response));
    });
    try {
      plugin.register(api);
      const handler = api.on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
      return { result: await handler({ prompt: "recall" }, context), warnings: api.logger.warn.mock.calls, requests: fetchMock.mock.calls };
    } finally { fetchMock.mockRestore(); }
  }
  it("enforces the confidence threshold before expansion and bounds the full injected context", async () => {
    const result = await invoke({ min_confidence: 0.8, token_budget: 30 }, [
      { results: [{ obsId: "low", score: 0.2 }, { obsId: "high", score: 0.9 }] },
      { results: [{ observation: { title: "High", narrative: "Useful memory. ".repeat(100) } }] },
    ]);
    expect(JSON.parse(String(result.requests[1][1]?.body)).expandIds).toEqual([{ obsId: "high" }]);
    expect(Buffer.byteLength(result.result.prependContext, "utf8")).toBeLessThanOrEqual(120);
    expect(result.result.prependContext).toContain("Useful");
  });
  it("a zero budget disables recall and a zero confidence includes low scoring matches", async () => {
    const disabled = await invoke({ token_budget: 0 }, []);
    expect(disabled.requests).toHaveLength(0);
    const zero = await invoke({ min_confidence: 0 }, [{ results: [{ obsId: "zero", score: 0 }] }, { results: [{ observation: { title: "Zero", narrative: "Zero confidence retained" } }] }]);
    expect(zero.result.prependContext).toContain("Zero confidence retained");
  });
  it.each([new Response('{"error":"secret-do-not-log"}', { status: 401 }), new Error("network detail secret-do-not-log")])("logs a safe, visible failure under fallback", async (failure) => {
    const got = await invoke({}, [failure]);
    expect(got.result).toBeUndefined();
    expect(got.warnings).toHaveLength(1);
    expect(JSON.stringify(got.warnings)).not.toContain("secret-do-not-log");
    expect(JSON.stringify(got.warnings)).toContain("smart-search");
  });
  it("throws on failed requests when fallback is disabled", async () => {
    await expect(invoke({ fallback_on_error: false }, [new Response("bad", { status: 401 })])).rejects.toThrow(/401/);
  });
  it("missing native metadata never triggers a global search", async () => {
    const got = await invoke({}, [], {} as never);
    expect(got.requests).toHaveLength(0);
    expect(got.warnings).toHaveLength(1);
  });
});

describe("OpenClaw capture edge cases", () => {
  const messages = [{ role: "user", content: "A question" }, { role: "assistant", content: "Its answer" }];
  const ctx = { sessionKey: "native-key", workspaceDir: "/work/service", agentId: "main" };
  async function exercise(events: unknown[], config: Record<string, unknown> = {}, responses: Array<Response | Error> = []) {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    const api = makeApi({ pluginConfig: config });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response ?? new Response('{"success":true}');
    });
    try {
      plugin.register(api);
      const handler = api.on.mock.calls.find(([name]) => name === "agent_end")?.[1];
      for (const event of events) await handler?.(event, ctx);
      return { calls: fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers, redirect: init?.redirect })), warnings: api.logger.warn.mock.calls };
    } finally { fetchMock.mockRestore(); }
  }
  it("does not pair an old assistant response with a new unanswered prompt", async () => {
    const result = await exercise([{ success: true, messages: [...messages, { role: "user", content: "New unanswered request" }] }]);
    expect(result.calls).toHaveLength(0);
    const imageTurn = await exercise([{ success: true, messages: [...messages, { role: "user", content: [{ type: "image", data: "ignored" }] }, { role: "assistant", content: "An image description" }] }]);
    expect(imageTurn.calls).toHaveLength(0);
  });
  it("skips disabled, unsuccessful, missing and non-text turns", async () => {
    for (const event of [{ success: false, messages }, { success: true }, { success: true, messages: [null] }, { success: true, messages: [{ role: "user", content: [{ type: "image", text: "ignored" }] }, messages[1]] }]) {
      expect((await exercise([event])).calls).toHaveLength(0);
    }
    expect((await exercise([{ success: true, messages }], { enabled: false })).calls).toHaveLength(0);
  });
  it("keeps event IDs stable on retry and starts a session only once", async () => {
    const event = { success: true, runId: "r1", messages };
    const result = await exercise([event, event]);
    expect(result.calls).toHaveLength(3);
    expect(result.calls[1].body.eventId).toBe(result.calls[2].body.eventId);
    expect(result.calls[1].body.sessionId).toBe("native-key");
  });
  it("retries session startup after a failed request instead of capturing under an unbound agent", async () => {
    const event = { success: true, messages };
    const result = await exercise([event, event], {}, [new Response("unauthorized", { status: 401 })]);
    expect(result.calls.map((call) => call.url.split("/agentmemory/")[1])).toEqual(["session/start", "session/start", "observe"]);
  });
  it("sends explicit auth and refuses redirects", async () => {
    vi.stubEnv("AGENTMEMORY_SECRET", "synthetic-token");
    try {
      const got = await exercise([{ success: true, messages }]);
      expect(got.calls.every((call) => (call.headers as Record<string, string>).Authorization === "Bearer synthetic-token" && call.redirect === "error")).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([{ token_budget: -1 }, { token_budget: Infinity }, { token_budget: 1.5 }, { min_confidence: 1.1 }, { min_confidence: NaN }, { timeout_ms: 0 }])("rejects unsupported config %j", async (config) => {
    await expect(exercise([], config)).rejects.toThrow(/invalid/);
  });
});

describe("OpenClaw session finalization", () => {
  it("waits for in-flight capture before ending the native session and clears startup state", async () => {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    const api = makeApi();
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const paths: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      paths.push(String(url).split("/agentmemory/")[1]);
      if (String(url).endsWith("observe")) await held;
      return new Response('{"success":true}');
    });
    try {
      plugin.register(api);
      const capture = api.on.mock.calls.find(([name]) => name === "agent_end")?.[1];
      const end = api.on.mock.calls.find(([name]) => name === "session_end")?.[1];
      expect(end).toBeTypeOf("function");
      const event = { success: true, messages: [{ role: "user", content: "request" }, { role: "assistant", content: "reply" }] };
      const capturing = capture(event, { sessionId: "s", workspaceDir: "/project" });
      const ending = end({ sessionId: "s", reason: "reset" }, { sessionId: "s" });
      await vi.waitFor(() => expect(paths).toContain("observe"));
      expect(paths).not.toContain("session/end");
      release(); await Promise.all([capturing, ending]);
      expect(paths).toEqual(["session/start", "observe", "session/end"]);
      await capture(event, { sessionId: "s", workspaceDir: "/project" });
      expect(paths.filter((path) => path === "session/start")).toHaveLength(2);
    } finally { release(); fetchMock.mockRestore(); }
  });
});


describe("OpenClaw credential configuration", () => {
  it("reads the URL environment override and rotating explicit credentials per request", async () => {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    vi.stubEnv("AGENTMEMORY_URL", "https://memory.example.test");
    vi.stubEnv("AGENTMEMORY_SECRET", "synthetic-first");
    const api = makeApi({ pluginConfig: {} });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"results":[]}'));
    try {
      plugin.register(api);
      const handler = api.on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
      await handler({ prompt: "first" }, { sessionId: "s", workspaceDir: "/workspace" });
      vi.stubEnv("AGENTMEMORY_SECRET", "synthetic-second");
      await handler({ prompt: "second" }, { sessionId: "s", workspaceDir: "/workspace" });
      expect(fetchMock.mock.calls[0][0]).toBe("https://memory.example.test/agentmemory/smart-search");
      expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-first");
      expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-second");
    } finally { fetchMock.mockRestore(); vi.unstubAllEnvs(); }
  });
  it.each(["file:///private/memory", "https://user:password@example.test", "https://example.test/?secret=hidden", "https://example.test?", "https://example.test#"])("rejects unsafe base URL %s without echoing it", async (url) => {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    expect(() => plugin.register(makeApi({ pluginConfig: { base_url: url } }))).toThrow("agentmemory: base_url must be an HTTP(S) URL without credentials, query, or fragment");
  });
  it.each(["https://example.test/memory%3F", "https://example.test/memory%23"])("preserves encoded URL path delimiters %s", async (url) => {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    expect(() => plugin.register(makeApi({ pluginConfig: { base_url: url } }))).not.toThrow();
  });
});

describe("OpenClaw key-only session lifecycle", () => {
  it("finalizes the recorded key when an older capture context lacks the later native UUID", async () => {
    const { default: plugin } = await import("../integrations/openclaw/plugin.mjs");
    const api = makeApi();
    const requests: Array<{ path: string; sessionId: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({ path: String(url).split("/agentmemory/")[1], sessionId: JSON.parse(String(init?.body)).sessionId });
      return new Response('{"success":true}');
    });
    try {
      plugin.register(api);
      const capture = api.on.mock.calls.find(([name]) => name === "agent_end")?.[1];
      const end = api.on.mock.calls.find(([name]) => name === "session_end")?.[1];
      await capture({ success: true, messages: [{ role: "user", content: "request" }, { role: "assistant", content: "reply" }] }, { sessionKey: "agent:main:current", workspaceDir: "/project" });
      await end({ sessionId: "native-uuid", sessionKey: "agent:main:current" }, { sessionId: "native-uuid", sessionKey: "agent:main:current" });
      expect(requests.map((request) => request.sessionId)).toEqual(["agent:main:current", "agent:main:current", "agent:main:current"]);
    } finally { fetchMock.mockRestore(); }
  });
});
