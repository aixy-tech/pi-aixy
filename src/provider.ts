import type { Model, Provider } from "@earendil-works/pi-ai";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

export const DEFAULT_BASE_URL = "https://api.aixy-gateway.com/v1";

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("AIXY_BASE_URL must use HTTPS (HTTP is allowed on localhost).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AIXY_BASE_URL must not contain credentials, a query, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}

export function parseModels(body: unknown, baseUrl: string): Model<"openai-completions">[] {
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("Aixy returned an invalid model catalog.");
  }
  const ids = new Set<string>();
  for (const entry of body.data as unknown[]) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !entry.id.trim()
    ) {
      throw new Error("Aixy returned an invalid model catalog.");
    }
    ids.add(entry.id);
  }
  return Array.from(ids, (id) => ({
    id,
    name: id,
    provider: "aixy",
    api: "openai-completions",
    baseUrl,
    // /v1/models does not advertise capabilities, limits, or prices. Users can
    // supply verified metadata through Pi's models.json modelOverrides.
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  }));
}

export function createAixyProvider(baseUrl = DEFAULT_BASE_URL): Provider<"openai-completions"> {
  const endpoint = normalizeBaseUrl(baseUrl);
  let models: Model<"openai-completions">[] = [];
  let catalogKey: string | undefined;

  return {
    id: "aixy",
    name: "Aixy",
    baseUrl: endpoint,
    auth: { apiKey: envApiKeyAuth("Aixy project API key", ["AIXY_API_KEY"]) },
    getModels: () => models,
    async refreshModels(context) {
      // Pi's persistent ModelsStore is keyed by provider, not project key. Do not
      // restore or persist a private catalog under a shared "aixy" cache entry.
      if (!context.allowNetwork || context.signal.aborted) return;
      const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
      if (!key) return;
      if (catalogKey !== key) {
        const published = await context.publish({
          update: () => {
            models = [];
            catalogKey = key;
          },
        });
        if (!published) return;
      }

      let response: Response;
      try {
        response = await fetch(`${endpoint}/models`, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]),
        });
      } catch {
        context.signal.throwIfAborted();
        throw new Error("Aixy model discovery failed or timed out. Check AIXY_BASE_URL and connectivity.");
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          await context.publish({
            update: () => {
              models = [];
            },
          });
        }
        // Error bodies may contain sensitive gateway/upstream diagnostics.
        throw new Error(`Aixy model discovery failed: HTTP ${response.status}.`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("Aixy returned an invalid model catalog.");
      }
      const refreshed = parseModels(body, endpoint);
      await context.publish({
        update: () => {
          models = refreshed;
        },
      });
    },
    stream,
    streamSimple,
  };
}
