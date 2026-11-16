# Contributing

Use macOS, Node.js 24, Python 3 and Xcode Command Line Tools. Install dependencies with `npm ci`, build with `APPLE2AGENT_SIGN_IDENTITY=- npm run build`, then run `npm run typecheck`, `npm test` and `npm run check:privacy`.

Tests use synthetic fixtures and temporary directories. Do not configure a real account or provide credentials to CI. Do not run scripts/validate-live.ts as an automated check: it writes real test records. Live acceptance requires explicit selection and authorization of the test objects and their cleanup.

Use example.com addresses and synthetic resource identifiers. Never attach config.json, databases, backups, private keys, real account screenshots, mail contents or unredacted logs. Keep research clones, internal plans and runtime output outside the repository.

Before proposing a change, explain the behavior, reproduction steps and relevant tests. Preserve replay protection, revision checks, resource boundaries and native approval. Bug reports should contain only minimal, redacted information. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

Run `gitleaks git --log-opts="--all" --redact` before publishing commits. The privacy check complements Gitleaks but cannot identify every personal value. Review the staged files and commit author/committer metadata manually. Use a GitHub noreply address if you do not want a personal email in public history.

Unless explicitly stated otherwise, contributions intentionally submitted for inclusion are provided under the project's MIT license. Submit only material you have permission to license, and retain third-party notices.
