import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAixyProvider, DEFAULT_BASE_URL } from "./src/provider.ts";

export default async function aixy(pi: ExtensionAPI): Promise<void> {
  const provider = createAixyProvider(process.env.AIXY_BASE_URL || DEFAULT_BASE_URL);
  let startupWarning: string | undefined;

  if (process.env.PI_OFFLINE === undefined) {
    try {
      // Use Pi's public runtime to resolve auth.json, command/env references, and
      // AIXY_API_KEY consistently. No other provider catalogs are fetched.
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(provider);
      const signal = AbortSignal.timeout(15_000);
      const auth = await runtime.getAuth("aixy", { signal });
      if (auth?.auth.apiKey) {
        await provider.refreshModels?.({
          credential: { type: "api_key", key: auth.auth.apiKey, env: auth.env },
          allowNetwork: true,
          signal,
          publish: async ({ update }) => {
            if (signal.aborted) return false;
            update?.();
            return true;
          },
        });
      }
    } catch {
      // Register even after a failed discovery so /login and /model can recover.
      startupWarning =
        "Aixy model discovery failed. Check /login aixy, AIXY_BASE_URL, and connectivity, then refresh /model.";
      console.error(startupWarning);
    }
  }

  // The async factory finishes before CLI model resolution, including --list-models.
  pi.registerProvider(provider);
  if (startupWarning) {
    const warning = startupWarning;
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    });
  }
}
