# Apple2Agent

Connect AI agents to the Apple services you authorize, from your own Mac.

[中文](README.zh-CN.md) · [Quick start](docs/getting-started.md) · [Privacy](docs/permissions-and-privacy.md) · [Compatibility](docs/compatibility.md)

**Source alpha · macOS · Node.js 24 · MIT**

Apple2Agent is a local MCP server for calendars, mail, reminders, contacts, notes and selected files. It combines CalDAV, CardDAV, IMAP and SMTP with native macOS helpers. You choose the accounts and resources to expose. Mail sending uses a frozen request and an approval window on your Mac.

## Start with three workflows

- Find free time and manage events in an authorized calendar.
- Read selected mail and prepare a message for approval before sending.
- Create reminders and read back their saved due dates and alarms.

Example prompts after setup:

> Show my available 30-minute slots tomorrow. Do not change any events.
>
> List the subjects of the three most recent messages in my selected inbox.
>
> Prepare a test reminder in the list I select, then ask me for the due time.

## Install from source

Requires macOS, Node.js 24, Python 3 and Xcode Command Line Tools. Use a Git checkout; ZIP-only installation is not supported by the local installer. Clone this repository and run these commands inside it:

```sh
npm ci
APPLE2AGENT_SIGN_IDENTITY=- npm run build
npm run typecheck
npm test
npm run install:local
```

The installer changes the current user's Apple2Agent launcher and active release. **If you already run Apple2Agent, stop here and read the [upgrade instructions](docs/getting-started.md#upgrade-and-rollback) first.**

Run `~/.local/bin/apple2agent setup` locally, select only the resources you want, then configure your MCP client with the absolute launcher path. The [examples](examples/) use placeholders, not a shared account. Start with the `readonly` profile.

```json
{
  "mcpServers": {
    "apple2agent": {
      "command": "/absolute/path/to/apple2agent",
      "args": ["serve", "--profile", "readonly"]
    }
  }
}
```

Get the launcher path with `printf '%s/.local/bin/apple2agent\n' "$HOME"`. Many MCP clients do not expand `~` or shell variables in configuration.

## What has been verified?

Calendar create/read/replay/sync/delete and QQ mail read/approved-send/receipt have live validation evidence. Reminder creation and device synchronization have been observed; notification delivery is still pending. Contacts, Notes and Drive have implementation and automated coverage, with limited live resource discovery. Messages is experimental and has not had live authorization/sending acceptance. See the [compatibility matrix](docs/compatibility.md) for limitations.

The offline suite covers protocol failures, revisions, replay protection, approval state, resource boundaries and native packaging. Automated tests are not a substitute for account and device acceptance.

## Local and mobile access

Local stdio MCP is the default. An optional [private Secure MCP Tunnel](docs/mobile-tunnel.md) supports compatible remote clients. Each user supplies their own accounts, tunnel and runtime key. This repository does not include a shared cloud service, WeChat bridge or Apple Health integration.

Your Mac must be online and available for remote access. Final send approval currently requires the Mac's native window; mobile-only approval is not implemented.

## Privacy and permissions

Account secrets are entered in native setup windows. Mail credentials are stored in this application's Keychain items; the optional tunnel key is stored separately in a private file. Configuration, resource references, operation receipts and backups remain outside the source checkout by default. Do not commit or upload them.

Tool results are delivered to the agent client you use. Local hosting does not mean that retrieved data can never leave your Mac. Read the [data flow and permission guide](docs/permissions-and-privacy.md).

## Development and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

Original code is licensed under [MIT](LICENSE), including commercial use. Retain the required notices. Third-party code keeps its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
