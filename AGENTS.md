# Development

This repository is an independent Pi extension. Use Pi's public extension and provider APIs; do not fork or patch Pi's core.

- Keep source, documentation, and commit metadata in English.
- Pin development dependencies. Keep Pi packages as peer dependencies supplied by the host.
- Install dependencies with `npm ci --ignore-scripts`.
- Run `npm run check`, `npm test`, and `npm pack --dry-run --ignore-scripts` before submitting changes.
- Use fake credentials and mocked endpoints in tests. Do not make paid inference calls or read personal Pi configuration.
- Keep discovery scoped to the effective gateway and project key. Never persist credentials in model metadata or log response bodies.
- Do not infer model capabilities, availability, or prices from model IDs.
- Do not manually dispatch, rerun, or re-enable GitHub Actions without explicit authorization.
