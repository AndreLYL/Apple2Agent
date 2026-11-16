# Getting started

## Requirements

Use your own Mac with Node.js 24, Python 3, Git and Xcode Command Line Tools (`xcode-select --install` if missing). A notarized binary installer is not provided. Compatibility outside the locally tested platform is pending; see [compatibility](compatibility.md).

Clone this repository with Git, then in its directory:

```sh
npm ci
APPLE2AGENT_SIGN_IDENTITY=- npm run build
npm run typecheck
npm test
```

`APPLE2AGENT_SIGN_IDENTITY=-` chooses ad-hoc signing without using a personal developer certificate. To use your own stable signing identity, explicitly provide it instead. Do not share signing material.

## Install and configure

The installer switches the current user's active Apple2Agent release and launcher. If an existing service uses that launcher, schedule the update deliberately; do not run it just to inspect a candidate.

From a clean Git checkout with a built version:

```sh
npm run install:local
~/.local/bin/apple2agent --version
~/.local/bin/apple2agent setup
```

The installer verifies artifacts and signatures and places releases under `~/.local/share/apple2agent/releases/`, with `current` and, after an upgrade, `previous` links. It creates `~/.local/bin/apple2agent`. It does not configure launchd or connect a tunnel automatically.

Setup runs native windows for credentials and calendar selection. Choose resources intentionally. Configure additional modules only when needed:

```sh
~/.local/bin/apple2agent configure reminders
~/.local/bin/apple2agent configure mail
~/.local/bin/apple2agent configure contacts
~/.local/bin/apple2agent configure notes
~/.local/bin/apple2agent configure drive
```

For independent IMAP/SMTP capabilities use `apple2agent link-mail-provider`. Messages is experimental and should not be enabled as a routine setup step.

## Connect a local MCP client

Use `examples/mcp.json` or `examples/codex.toml`, replacing `/absolute/path/to/apple2agent` with your launcher path. Obtain it with:

```sh
printf '%s/.local/bin/apple2agent\n' "$HOME"
```

Start with `serve --profile readonly`. Restart/reconnect the MCP client after changing grants. Ask for an account/calendar list before a content query, then confirm the exact target before any write. The `calendar` profile is not read-only.

`doctor` contacts configured services. Do not run it against a real account as an offline CI check. `scripts/validate-live.ts` writes real test records and must not be part of automated onboarding.

## Upgrade and rollback

Keep private state outside the source checkout. Save a private backup before upgrading. An active tunnel or MCP session retains its loaded code; schedule reconnects deliberately.

Build/test the selected version from a clean checkout, then run `npm run install:local`. Check the CLI version and reconnect only the clients you intend to migrate. The installer preserves a `previous` release link when switching to a different release.

For rollback, stop the relevant clients, inspect `~/.local/share/apple2agent/previous`, and point `current` back to that verified release before reconnecting. Review data-format compatibility first: switching code does not restore or downgrade private data. Keep the previous release until the new version is accepted.

## Uninstall

Remove the MCP entry from your client and stop any runtime you explicitly configured. The source installer does not install a system daemon. If you separately configured one, disable it using its own installation procedure.

The application launcher and releases are under `~/.local/bin/apple2agent` and `~/.local/share/apple2agent`. Review these paths before removing them. Personal state and Keychain items are separate: retain them for recovery, or delete only the items you explicitly choose. Uninstalling code should not silently delete calendars, mail, reminders, backups or private keys.
