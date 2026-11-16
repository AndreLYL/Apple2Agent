# Security

This alpha handles private personal data. Use explicit resource grants and start with a read-only profile. It is not a multi-tenant hosted service.

## Reporting

If the GitHub Security tab offers **Report a vulnerability**, use that private channel. It must be enabled by the repository maintainer. If it is unavailable, open only a request for a private reporting channel, without exploit details, credentials, account identifiers or personal records. Do not put sensitive material in a public issue or pull request.

Include the affected version, platform, minimal synthetic reproduction and expected boundary. Remove secrets and personal data from attachments. Never upload an account config, operation database, backup directory or tunnel configuration.

## Boundaries

- MCP inputs and retrieved mail/event/note content are untrusted data.
- Resource grants and a read-only profile narrow access; they do not replace operating system permissions.
- Send actions require immutable content and native human approval. An agent-provided approval flag is not approval.
- Idempotent requests must reuse the same request ID. An unknown outcome must not be retried as a new send.
- Credentials are not part of source releases. Each user supplies their own.
- Tool results can leave the Mac through the chosen client or tunnel. See [privacy](docs/permissions-and-privacy.md).

No automatic telemetry service is configured by this source distribution. Local logs, error reports and generated artifacts still require review before sharing. Publication checks are safeguards, not a guarantee that every possible secret is detected.
