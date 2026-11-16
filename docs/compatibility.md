# Compatibility and validation

This is a source alpha. macOS, Node.js 24, Python 3 and Xcode Command Line Tools are required. Helpers use EventKit, Apple Events, Keychain and local file APIs. Windows/Linux are not supported runtimes. Node's SQLite API may emit an experimental warning.

The native code has local macOS/Apple Silicon evidence. Minimum macOS version, Intel compatibility and installation on a second machine remain to be established; do not infer support from compilation alone. There is no notarized installer.

| Module | Implementation | Live evidence and limits |
| --- | --- | --- |
| Calendar | CalDAV read/write, recurring events, revisions, free-time and conflict detection | Basic create/read/replay/device sync/delete verified; complex recurring writes and scheduling boundaries need additional acceptance |
| Mail | Mac Mail automation; optional independent IMAP/SMTP, drafts, approved send, attachments and batch operations | QQ read and approved plain-text send/receipt verified; iCloud Mail and other provider/attachment combinations remain unverified |
| Reminders | EventKit lists/tasks, repeat and alarms | Create/readback/device synchronization verified; actual notification delivery pending |
| Contacts | CardDAV CRUD/groups/birthdays | Automated protocol coverage and live resource discovery; full live mutation acceptance pending |
| Notes | Apple Events read/write/move with revisions and private backups | Automated coverage and live resource discovery; full live write acceptance pending |
| Drive | Scoped roots, text extraction, conditional writes, previews | Temporary-directory native tests and live root discovery; full format and real iCloud synchronization acceptance pending |
| Messages | Scoped read history and approved iMessage submission | Experimental; synthetic tests only, no live authorization/send acceptance; SMS/MMS/RCS sending unsupported |
| Mobile | Optional private tunnel | Remote reads observed; native final send approval requires the Mac; each user's access and permissions must be verified |

A QQ Sent-folder subject search did not immediately find a message that folder enumeration could read. Do not resend mail because a search result is missing. SMTP acceptance, a saved Sent copy and recipient delivery are different states.

The IMAP/SMTP adapter currently uses independently configured credentials; it does not extract Mac Mail passwords or OAuth tokens. Providers requiring OAuth without an app-password route are not supported by that adapter. Mac Mail integration and protocol integration are separate capabilities.

Supported profiles: `readonly` restricts tools to read-only operations, `calendar` limits the module set but permits authorized calendar writes, `all` exposes enabled/granted modules, and `legacy` retains the original eight tools. Profile selection is not a substitute for account/resource grants.
