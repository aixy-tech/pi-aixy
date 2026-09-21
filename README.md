# Aixy for Pi

Connect the [Pi coding agent](https://github.com/earendil-works/pi) to an [Aixy](https://aixy-gateway.com) project using a standard Pi extension.

The extension discovers models through Aixy's authenticated `/v1/models` endpoint and uses Pi's existing OpenAI Chat Completions adapter for streaming, tool calls, and token usage. Provider-qualified IDs and virtual routes such as `aixy/coding` are sent unchanged.

## Install

Requires Node.js 22.19 or newer and **Pi 0.87.0 or newer** (`@earendil-works/pi-coding-agent`). Tested against Pi 0.87.0. The older `@mariozechner/pi-coding-agent` package does not provide the native provider API used here.

```sh
pi install git:github.com/aixy-tech/pi-aixy
```

Restart Pi, or use `/reload` in an existing session. The package is installed from GitHub; it does not require an npm publication.

To update an existing installation:

```sh
pi update --extension git:github.com/aixy-tech/pi-aixy
```

To try it for one session:

```sh
pi -e git:github.com/aixy-tech/pi-aixy
```

## Connect

Create an API key for the intended project in the Aixy dashboard. In Pi:

```text
/login aixy
```

Enter the project key when prompted, then use `/model` to select an Aixy model. Available models depend on the providers, routes, and policies configured in that project. Choose a model that supports function tools for coding-agent use.

Alternatively, supply the key through the environment:

```sh
export AIXY_API_KEY="gak_..."
pi --list-models aixy
pi --provider aixy --model openai/gpt-4.1-mini
```

Replace the example model with an ID available to your project. Virtual routing models work the same way:

```sh
pi --provider aixy --model aixy/coding
pi --provider aixy --model aixy/coding -p "Explain this repository"
```

Pi stores `/login` credentials in its own `auth.json`. Stored credentials take precedence over `AIXY_API_KEY`; Pi's environment and command references in that file are resolved by Pi. Do not commit API keys.

## Custom gateway

```sh
export AIXY_BASE_URL="https://gateway.example.com/v1"
```

This setting applies to both discovery and inference. A host-only URL is normalized to `/v1`. For a path prefix, provide the full API base, such as `https://example.com/aixy/v1`. HTTPS is required except for loopback development servers.

Keep the credential aligned with the selected gateway. Configure the endpoint with `AIXY_BASE_URL`, rather than a `models.json` base URL override that would affect inference alone.

## Model metadata and offline use

Aixy's public catalog returns IDs, not context limits, prices, or capabilities. Discovered entries therefore start with these local defaults:

| Setting | Default |
| --- | --- |
| Input | Text |
| Reasoning controls | Disabled |
| Context window | 32,768 tokens |
| Maximum output | 4,096 tokens |
| Price estimate | Zero / unknown |

These are configuration defaults, **not verified model limits or a claim that inference is free**. Aixy remains the source for actual usage and billing. Override metadata using values verified for your model or all destinations behind a virtual route:

```json
{
  "providers": {
    "aixy": {
      "modelOverrides": {
        "aixy/coding": {
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      }
    }
  }
}
```

Save overrides in `~/.pi/agent/models.json`; the numbers above are examples. Pi also supports `input`, `reasoning`, `cost`, and `compat` overrides. See [Pi model configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

Discovery runs before startup model selection and during Pi's normal model refresh. It has a 10-second request timeout. The project catalog stays in memory and is not written to Pi's provider-wide catalog cache. Changing keys clears the previous project's catalog before discovery. Authentication failures clear it; transient failures preserve the same project's last successful list for the current process.

With `PI_OFFLINE` set, discovery is skipped. For offline catalog loading or unavailable discovery, define explicit models in `models.json` with `api: "openai-completions"`, a `baseUrl`, and their IDs and metadata. Model inference still needs network access to Aixy. No requests are made to upstream model providers directly by this extension.

## Troubleshooting

- **No models:** check the key, the project's configured providers/routes, and its model access policies. Refresh `/model` after changing configuration.
- **Wrong project:** replace the stored credential using `/login aixy`, or `/logout aixy` before using an environment key.
- **Discovery failed:** check the API key, `AIXY_BASE_URL`, and connectivity. Provider registration remains available so login and model refresh can recover.
- **Unsupported parameters or model limits:** set the appropriate per-model metadata/compatibility overrides. The extension does not infer capabilities from a model's name.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

Tests cover discovery, authentication, credential changes, cancellation, error handling, tool-call streaming and replay, package installation, CLI model listing, and headless inference against a local mock gateway. CLI tests load a copy outside the checkout without development dependencies, matching the runtime imports available to Git installations. They do not use real Aixy credentials or paid model inference.

To run the CLI tests with a separately installed Pi executable:

```sh
PI_AIXY_TEST_CLI="$(command -v pi)" npm test -- test/cli.test.ts
```

MIT licensed.
