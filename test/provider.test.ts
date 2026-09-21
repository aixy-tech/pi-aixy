import { createModels, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAixyProvider, DEFAULT_BASE_URL, normalizeBaseUrl, parseModels } from "../src/provider.ts";

afterEach(() => vi.restoreAllMocks());

function catalog(...ids: string[]): Response {
  return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });
}

async function setup(key = "gak_test") {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("aixy", async () => ({ type: "api_key", key }));
  const store = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore: store });
  models.setProvider(createAixyProvider());
  return { models, credentials, store };
}

describe("Aixy discovery", () => {
  it("authenticates, preserves qualified IDs and aliases, and deduplicates", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        catalog("openai/gpt-4.1-mini", "aixy/coding", "fireworks/accounts/acme/models/code", "aixy/coding"),
      );
    const { models, store } = await setup();
    expect((await models.refresh()).errors.size).toBe(0);
    expect(models.getModels("aixy").map((m) => m.id)).toEqual([
      "openai/gpt-4.1-mini",
      "aixy/coding",
      "fireworks/accounts/acme/models/code",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      `${DEFAULT_BASE_URL}/models`,
      expect.objectContaining({
        headers: { Authorization: "Bearer gak_test", Accept: "application/json" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(await store.read("aixy")).toBeUndefined();
  });

  it("does not contact Aixy when unconfigured or offline", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const models = createModels({
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider(createAixyProvider());
    await models.refresh();
    const configured = await setup();
    await configured.models.refresh({ allowNetwork: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(models.getModels()).toEqual([]);
  });

  it("resolves an environment key and prefers a stored key", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = createModels({
      credentials,
      authContext: {
        env: async (name) => (name === "AIXY_API_KEY" ? "gak_env" : undefined),
        fileExists: async () => false,
      },
    });
    models.setProvider(createAixyProvider());
    expect((await models.getAuth("aixy"))?.auth.apiKey).toBe("gak_env");
    await credentials.modify("aixy", async () => ({ type: "api_key", key: "gak_stored" }));
    expect((await models.getAuth("aixy"))?.auth.apiKey).toBe("gak_stored");
  });

  it("supports Pi's secret login prompt", async () => {
    const { models } = await setup();
    const prompt = vi.fn(async () => "gak_login");
    await models.login("aixy", "api_key", { prompt, notify: () => {}, signal: new AbortController().signal });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ type: "secret" }));
    expect((await models.getAuth("aixy"))?.auth.apiKey).toBe("gak_login");
  });

  it("does not restore another project's provider-wide cache", async () => {
    const { models, store } = await setup();
    await store.write("aixy", {
      models: parseModels({ data: [{ id: "aixy/other-project" }] }, DEFAULT_BASE_URL),
    });
    await models.refresh({ allowNetwork: false });
    expect(models.getModels()).toEqual([]);
  });

  it("replaces the catalog, including a successful empty result", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(catalog("aixy/old"))
      .mockResolvedValueOnce(catalog("aixy/new"))
      .mockResolvedValueOnce(catalog());
    const { models } = await setup();
    await models.refresh();
    await models.refresh();
    expect(models.getModels().map((m) => m.id)).toEqual(["aixy/new"]);
    await models.refresh();
    expect(models.getModels()).toEqual([]);
  });

  it("retains the last catalog after a transient failure without exposing response bodies", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(catalog("aixy/coding"))
      .mockResolvedValueOnce(new Response("sensitive upstream detail", { status: 503 }));
    const { models } = await setup();
    await models.refresh();
    const result = await models.refresh();
    expect(result.errors.get("aixy")?.message).toBe("Aixy model discovery failed: HTTP 503.");
    expect(models.getModels()).toHaveLength(1);
  });

  it.each([401, 403])("clears the catalog on HTTP %s", async (status) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(catalog("aixy/coding"))
      .mockResolvedValueOnce(new Response(null, { status }));
    const { models } = await setup();
    await models.refresh();
    await models.refresh();
    expect(models.getModels()).toEqual([]);
  });

  it("clears the previous project's models before trying a different key", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(catalog("aixy/private"))
      .mockRejectedValueOnce(new Error("do not expose secret request details"));
    const { models, credentials } = await setup();
    await models.refresh();
    await credentials.modify("aixy", async () => ({ type: "api_key", key: "gak_other" }));
    const result = await models.refresh();
    expect(models.getModels()).toEqual([]);
    expect(result.errors.get("aixy")?.message).not.toContain("secret");
  });

  it.each([null, {}, { data: null }, { data: [null] }, { data: [{ id: 7 }] }, { data: [{ id: " " }] }])(
    "rejects malformed catalogs",
    (body) => {
      expect(() => parseModels(body, DEFAULT_BASE_URL)).toThrow("invalid model catalog");
    },
  );

  it("keeps capabilities conservative and ignores remote endpoint/price overrides", () => {
    const [model] = parseModels(
      { data: [{ id: "aixy/coding", baseUrl: "https://wrong.example", reasoning: true, cost: 10 }] },
      DEFAULT_BASE_URL,
    );
    expect(model).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      input: ["text"],
      reasoning: false,
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0 },
    });
  });

  it("honors cancellation and does not publish a late response", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve();
      return promise;
    });
    const { models } = await setup();
    const controller = new AbortController();
    const pending = models.refresh({ signal: controller.signal });
    await started.promise;
    controller.abort();
    expect((await pending).aborted).toBe(true);
    resolve(catalog("aixy/late"));
    await new Promise((done) => setTimeout(done, 0));
    expect(models.getModels()).toEqual([]);
  });
});

describe("Aixy endpoints", () => {
  it.each([
    ["https://api.example.com", "https://api.example.com/v1"],
    ["https://api.example.com/v1/", "https://api.example.com/v1"],
    ["https://api.example.com/gateway/v1/", "https://api.example.com/gateway/v1"],
    ["http://127.0.0.1:9876", "http://127.0.0.1:9876/v1"],
  ])("normalizes %s", (input, expected) => expect(normalizeBaseUrl(input)).toBe(expected));

  it.each([
    "http://api.example.com",
    "ftp://localhost",
    "https://user:secret@example.com",
    "https://example.com?key=secret",
    "https://example.com#fragment",
  ])("rejects unsafe endpoint %s", (input) => expect(() => normalizeBaseUrl(input)).toThrow());
});

describe("Aixy streaming", () => {
  it("streams tool calls, replays their results, and reports usage through Pi's existing adapter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(catalog("aixy/coding"));
    const { models } = await setup();
    await models.refresh();
    const model = models.getModel("aixy", "aixy/coding");
    if (!model) throw new Error("Model discovery did not publish aixy/coding");
    const payloads: Record<string, unknown>[] = [];
    const mockFetch: typeof fetch = async (url, init) => {
      expect(String(url)).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer gak_test");
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const first = payloads.length === 1;
      const chunks = first
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "read", arguments: '{"path":' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"file.ts"}' } }] },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ]
        : [{ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] }];
      const usage = { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
      return new Response(
        `${[...chunks, usage]
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", model: "upstream/model", ...chunk })}\n\n`,
          )
          .join("")}data: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    };
    const user = { role: "user" as const, content: "Read file.ts", timestamp: 0 };
    const tools = [
      { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
    ];
    const first = await models.completeSimple(
      model,
      { systemPrompt: "Help with code", messages: [user], tools },
      { fetch: mockFetch },
    );
    expect(first.stopReason).toBe("toolUse");
    expect(first.content).toContainEqual({
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: { path: "file.ts" },
    });
    expect(first.usage).toMatchObject({ input: 12, output: 4, totalTokens: 16 });
    const second = await models.completeSimple(
      model,
      {
        messages: [
          user,
          first,
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "export {};" }],
            isError: false,
            timestamp: 1,
          },
        ],
        tools,
      },
      { fetch: mockFetch },
    );
    expect(second.stopReason).toBe("stop");
    expect(second.content).toContainEqual(expect.objectContaining({ type: "text", text: "Done." }));
    expect(payloads[0]).toMatchObject({ model: "aixy/coding", stream: true, max_tokens: 4096 });
    expect(payloads[0]).not.toHaveProperty("store");
    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
    expect(payloads[1].messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: "export {};" }),
    );
  });
});
