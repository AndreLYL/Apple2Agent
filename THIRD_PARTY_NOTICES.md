# References and dependencies

Apple2Agent was implemented against its own v0.2 specification. The following repositories were inspected for architectural ideas and edge cases; architectural references are listed below. v0.5 additionally adapts the MIT EventKit Reminders helper as described below:

- boutquin/apple-bridge, commit 951c11af2b621fc34debd2d57432b9ea856c7198 (MIT).
- epinethrone/icloud-mcp, commit c6aff4fef0a5246ec3419ec277562c2ec89d539b (MIT).
- MrZhongzq/apple-icloud-mcp, commit dd64a388a3d9aad769428cf1071ce4c823939b8a (no explicit license found in the reviewed snapshot; no source copied).
- AndreLYL/wechat2dot, commit 1615d6ab14fe7afd895c9610796239b381373e93 (MIT; upstream notices retained in the reference clone). Inspected for future private Tunnel / connector architecture; no application source copied.

The independent reference clones and their pinned versions are listed in REFERENCE_REPOSITORIES.md. They are not part of this repository, its submodules, or its tracked application source.

Runtime dependencies and exact versions are recorded in package.json and package-lock.json. Each dependency retains its own license and copyright in its installed package. These include the official MCP SDK, tsdav, ImapFlow, ical.js, mailparser, Nodemailer's MIME composer, Temporal polyfill, Zod, html-to-text and debug. The v0.5 development implementation includes SMTP transport behind immutable trusted approval, alongside the original MIME-only draft contract.

The project's original code is offered under MIT; see LICENSE and NOTICE. Third-party code remains under its own license.

## Dependency license boundaries

The source release contains dependency manifests, not a vendored node_modules tree.
The lockfile identifies the exact installed packages. Keep the license files
supplied by those packages when redistributing installed dependencies or binaries.

- `ical.js` is MPL-2.0. It is consumed as a dependency and is not modified or
  relicensed here. Its MPL-covered files remain under MPL-2.0.
- `nodemailer` is MIT-0, not the project's MIT license.
- The transitive `@zone-eu/mailsplit` package offers MIT OR EUPL-1.1+; this
  distribution relies on its MIT option.
- Other dependencies include permissively licensed MIT, ISC, BSD, Apache-2.0
  and BlueOak-1.0.0 packages. This statement does not replace their notices.

Do not apply the project's MIT label to third-party files as if they were all
authored by this project. Consult installed package licenses before distributing
a bundled application.

## Adapted EventKit helper

`native/Reminders.swift` is adapted from `mac-helper/eventkit/reminders-eventkit.swift` in epinethrone/icloud-mcp at commit c6aff4fef0a5246ec3419ec277562c2ec89d539b. Apple2Agent changes include structured stdin, grant checks, stable references/revisions, date-only preservation, explicit sources, previews and standalone value validation. This does not incorporate the upstream Python server. The following license applies to the adapted portion:

MIT License

Copyright (c) 2026 epinethrone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
