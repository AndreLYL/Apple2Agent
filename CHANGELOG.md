# Changelog

## Unreleased

- Allow SMS short codes and local/alphanumeric senders in exact-chat read selections. Sending eligibility, grants and approval requirements are unchanged.

- Add read-only `imessage_list_unread_sms` with explicit local unread state, authorized-chat scope, bounded pagination and no mark-as-read side effects. Existing tool schemas and profile defaults stay unchanged; readonly/all now expose 45/92 tools with all modules enabled.

## 0.5.0-alpha.1 — 2026-11-17

First public source alpha.

- Calendar, mail, reminders, contacts, notes, selected files and Messages modules.
- Scoped resource grants, revisions, stable request IDs and frozen native send approval.
- Optional private mobile connector; no shared backend or credentials.
- Portable configuration examples, synthetic test data and public installation/privacy documentation.
- README with an agent install prompt and an illustrated module overview.
- macOS build/test workflow and publication privacy checks.

Install from source; no prebuilt or notarized binaries are provided. See [compatibility](docs/compatibility.md) for the difference between implemented, automated-tested and live-verified capabilities.
