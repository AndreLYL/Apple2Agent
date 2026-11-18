# Permissions and privacy

## Data flow

Local: agent client ↔ stdio MCP server on your Mac ↔ authorized Apple services or mail provider.

Optional remote: remote client ↔ OpenAI Secure MCP Tunnel ↔ your Mac's tunnel client ↔ local MCP server.

The server returns requested content to the agent client. That client and its model/service may process it remotely. Local hosting does not guarantee that retrieved content stays on the Mac. Apple and mail-provider protocols also contact their respective servers.

## Credentials and private state

Default private directory: `~/Library/Application Support/Apple2Agent`. `APPLE2AGENT_DATA_DIR` can select a separate directory; never point it inside a public checkout.

- Mail/account credentials: Apple2Agent's own macOS Keychain items.
- Optional tunnel runtime key: a private file in the connector directory, not a Keychain item.
- config.json: account metadata, resource grants, references and signing material; private even without a mailbox password.
- operations.sqlite: replay receipts, operation/approval metadata and snapshots; never publish it. Approval content is encrypted using a Keychain-protected key.
- backups: previous calendar/note/file content retained for recovery. Treat all backups as personal data.

Configuration/key files use restricted permissions. This does not make them safe to upload. No release should contain the private directory, certificates, runtime logs or screenshots of real resources.

## Grants and native permissions

Configure only needed modules and select exact resources in the local windows. Reminders needs EventKit access; Mail/Notes/Messages automation needs macOS Automation permission. Messages history additionally needs Full Disk Access for the actual runtime host. A terminal grant does not prove a background tunnel host is authorized.

Ad-hoc signing supports local source builds but updates may require reauthorization. Stable signing identities are optional and belong to the individual developer; do not share their certificates or keys.

Calendar defaults and writable scope are separate. `calendar-access all-writable` broadens access to all server-confirmed writable calendars, including newly discovered ones; do not enable it merely to get past a setup error. `calendar-access selected` retains the selected scope.

Sending follows: frozen request → native human review → execute the same action. Do not automate approval clicks. An uncertain send result requires reconciliation, not a new request ID.

## Sharing diagnostics

Share only versions, error codes and synthetic reproductions. Do not upload config, signed resource references, operation databases, raw protocol traces, account screenshots or content backups. Review all output before posting it.

## Unread SMS

`imessage_list_unread_sms` is available in `readonly` and `all` when Messages is enabled. It reads incoming records labeled SMS across explicitly selected chats already synced to this Mac, using `message.is_read = 0`. It does not send, mark messages as read, or grant access to new chats. No sender allowlist is needed for reading. The local picker includes short-code, local-number and alphanumeric SMS chats under the read-chat choices. Selecting a chat does not grant sending rights; existing iMessage recipient choices remain separate. New chats still require explicit selection.

The query defaults to 50 messages (maximum 100), newest first. Follow `next_cursor` until it is null; `complete=false` can also indicate unknown read states, unsupported bodies or truncated text. Results reflect local state, not a live query of the iPhone. Pagination is not a frozen snapshot: restart without a cursor for new arrivals or changed read states. Cursors expire after 15 minutes and are invalidated by changed chat grants. Missing `is_read` produces `SCHEMA_UNSUPPORTED`; zero authorized chats produces `NOT_CONFIGURED`, not an empty inbox claim. Neither delivery nor read-receipt timestamps are used to infer unread state.
