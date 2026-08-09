# Contributing to Nodelight

Thanks for helping improve Nodelight.

## Before you begin

- Read the [Code of Conduct](CODE_OF_CONDUCT.md).
- Search existing issues before reporting a bug or requesting a feature.
- Keep one focused change per pull request.
- Do not include passwords, private addresses, or other sensitive server data in issues, screenshots, or logs.

## Local checks

Nodelight has no third-party runtime dependencies. Before opening a pull request, run:

```bash
npm test
node --check server.js
node --check web/app.js
docker compose config --quiet
```

If you change the image or Compose configuration, also build it locally:

```bash
docker compose build
```

## Pull requests

Explain the user-facing change, how you tested it, and any deployment or migration impact. Keep the dashboard usable on small screens, avoid adding telemetry, and preserve the container's least-privilege defaults.

## Reporting vulnerabilities

Please follow [SECURITY.md](SECURITY.md) for security reports. Do not disclose a security issue in a public GitHub issue.
