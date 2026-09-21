import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "bundle/cli.js",
);
const command = process.env.PI_AIXY_TEST_CLI || process.execPath;
const cliArgs = process.env.PI_AIXY_TEST_CLI ? [] : [cli];

async function copyInstalledPackage(dir: string): Promise<string> {
  const target = join(dir, "package");
  await mkdir(target);
  // Git installs omit development dependencies. Keep the extension outside the
  // checkout so missing host-provided imports cannot resolve from our node_modules.
  for (const path of ["package.json", "index.ts", "src"]) {
    await cp(join(root, path), join(target, path), { recursive: true });
  }
  return target;
}

describe("Pi package integration", () => {
  it("installs without development dependencies and discovers models before --list-models", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-aixy-cli-"));
    const installedPackage = await copyInstalledPackage(dir);
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.url} ${request.headers.authorization}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "aixy/coding" }, { id: "openai/gpt-4.1-mini" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    // A fresh Pi directory and allowlisted environment keep personal settings,
    // credentials, extensions, and external provider endpoints out of the test.
    const env = {
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: join(dir, "agent"),
      AIXY_BASE_URL: `http://127.0.0.1:${address.port}`,
      AIXY_API_KEY: "gak_environment",
      PI_NO_LOCAL_LLM: "1",
      NO_COLOR: "1",
    };
    try {
      await run(command, [...cliArgs, "install", installedPackage], { cwd: dir, env, timeout: 20_000 });
      const result = await run(
        command,
        [
          ...cliArgs,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--list-models",
          "aixy",
        ],
        { cwd: dir, env, timeout: 20_000 },
      );
      expect(result.stdout).toContain("aixy/coding");
      expect(result.stdout).toContain("openai/gpt-4.1-mini");
      expect(requests).toEqual(["/v1/models Bearer gak_environment"]);
      expect(result.stderr).not.toContain("Failed to load extension");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it("resolves stored credential references and runs a headless prompt through the gateway", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-aixy-prompt-"));
    const installedPackage = await copyInstalledPackage(dir);
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ aixy: { type: "api_key", key: "$PROJECT_KEY" } }),
      { mode: 0o600 },
    );
    const requests: { path?: string; auth?: string; model?: string }[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/v1/models") {
        requests.push({ path: request.url, auth: request.headers.authorization });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "aixy/coding" }] }));
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const payload = JSON.parse(body) as { model: string; max_tokens?: number };
      requests.push({ path: request.url, auth: request.headers.authorization, model: payload.model });
      if (payload.max_tokens !== undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
              type: "invalid_request_error",
              param: "max_tokens",
              code: "unsupported_parameter",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", model: "upstream/model", choices: [{ index: 0, delta: { role: "assistant", content: "Hello from the test gateway." }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    try {
      const pending = run(
        command,
        [
          ...cliArgs,
          "-e",
          installedPackage,
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-session",
          "--no-tools",
          "--provider",
          "aixy",
          "--model",
          "aixy/coding",
          "-p",
          "Say hello",
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            PI_CODING_AGENT_DIR: agentDir,
            AIXY_BASE_URL: `http://127.0.0.1:${address.port}/v1/`,
            AIXY_API_KEY: "gak_lower_priority",
            PROJECT_KEY: "gak_stored",
            PI_NO_LOCAL_LLM: "1",
            NO_COLOR: "1",
          },
          timeout: 20_000,
        },
      );
      pending.child.stdin?.end();
      const result = await pending;
      expect(result.stdout).toContain("Hello from the test gateway.");
      expect(requests).toEqual([
        { path: "/v1/models", auth: "Bearer gak_stored" },
        { path: "/v1/chat/completions", auth: "Bearer gak_stored", model: "aixy/coding" },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
