import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("Pi package integration", () => {
  it("installs the package and discovers models before --list-models with environment credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-aixy-cli-"));
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
      await run(process.execPath, [cli, "install", root], { cwd: dir, env, timeout: 20_000 });
      const result = await run(
        process.execPath,
        [
          cli,
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
      const payload = JSON.parse(body) as { model: string };
      requests.push({ path: request.url, auth: request.headers.authorization, model: payload.model });
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
        process.execPath,
        [
          cli,
          "-e",
          root,
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
