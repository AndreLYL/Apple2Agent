// Fixed Apple Events program. Input is data from stdin; never evaluated as source.
ObjC.import("Foundation");
var writeStarted = false;
function run() {
  try {
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    if (Number(data.length) > 8 * 1024 * 1024)
      fail("CONTENT_TOO_LARGE", "Native input exceeds limit.");
    var e = JSON.parse(
        ObjC.unwrap(
          $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding),
        ),
      ),
      a = e.args || {},
      op = e.operation;
    if (op.indexOf("notes_") === 0)
      return JSON.stringify(notes(op.slice(6), a));
    if (op.indexOf("mail_") === 0) return JSON.stringify(mail(op.slice(5), a));
    if (op === "imessage_send") return JSON.stringify(sendMessage(a));
    fail("INVALID_INPUT", "Unknown automation operation.");
  } catch (e) {
    return JSON.stringify({
      error: {
        code:
          e.safeCode ||
          (e.errorNumber === -1743
            ? "PERMISSION_DENIED"
            : e.errorNumber === -1728
              ? "STALE_REFERENCE"
              : "NATIVE_ERROR"),
        write_state: writeStarted ? "outcome_unknown" : "failed_before_write",
        message: e.safeCode
          ? e.message
          : "Apple Events could not complete. Check app permissions and resource references.",
      },
    });
  }
}
function fail(c, m) {
  var e = new Error(m);
  e.safeCode = c;
  throw e;
}
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function textHtml(s) {
  return "<div>" + String(s).split("\n").map(esc).join("<br>") + "</div>";
}
function fingerprint(t) {
  var h = 2166136261;
  for (var i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}
var deletedNames = [
  "recently deleted",
  "最近删除",
  "最近刪除",
  "最近削除した項目",
  "onlangs verwijderd",
  "zuletzt gelöscht",
  "récemment supprimées",
  "eliminadas recientemente",
];
function deletedFolder(f) {
  return deletedNames.indexOf(String(f.name()).toLowerCase().trim()) >= 0;
}
function notes(op, a) {
  var app = Application("Notes"),
    grants = a.grants || {},
    accounts = grants.accounts || [],
    folders = grants.folders || [];
  function account(id) {
    if (accounts.indexOf(id) < 0)
      fail("PERMISSION_DENIED", "Notes account is outside grant.");
    var x = app.accounts.byId(id);
    x.id();
    return x;
  }
  function folder(id) {
    if (folders.indexOf(id) < 0)
      fail("PERMISSION_DENIED", "Notes folder is outside grant.");
    var f = app.folders.byId(id);
    f.id();
    return f;
  }
  function note() {
    var n = app.notes.byId(a.id);
    n.id();
    var f = n.container();
    folder(f.id());
    return n;
  }
  function head(n) {
    var f = n.container(),
      locked = true;
    try {
      locked = n.passwordProtected() === true;
    } catch (e) {}
    return {
      id: n.id(),
      title: n.name(),
      folder_id: f.id(),
      folder: f.name(),
      locked: locked,
      modified: String(n.modificationDate().toISOString()),
    };
  }
  function read(n, includeHtml) {
    var h = head(n);
    if (h.locked)
      fail("RESOURCE_LOCKED", "Locked notes cannot be read or edited.");
    var t = String(n.plaintext() || "");
    h.text = t.slice(0, 262144);
    h.truncated = t.length > 262144;
    h.native_hash = fingerprint(t);
    h.attachments = n.attachments.length;
    var html = String(n.body() || "");
    h.has_table = /<table[\s>]/i.test(html);
    h.recently_deleted = deletedFolder(n.container());
    if (includeHtml) h.html = html;
    return h;
  }
  function checked() {
    var n = note(),
      r = read(n, true);
    if (r.title !== a.title || r.native_hash !== a.expected_native_hash)
      fail("STALE_REVISION", "Note title or content changed.");
    if (r.truncated || r.attachments || r.has_table || r.recently_deleted)
      fail(
        "FORMAT_UNSUPPORTED",
        "This note cannot be safely edited through automation.",
      );
    return { n: n, r: r };
  }
  if (op === "discover") {
    var aa = app.accounts(),
      out = [],
      fs = [];
    for (var i = 0; i < Math.min(aa.length, 30); i++) {
      out.push({ id: aa[i].id(), name: aa[i].name() });
      var ff = aa[i].folders();
      for (var j = 0; j < Math.min(ff.length, 300); j++)
        fs.push({ id: ff[j].id(), name: ff[j].name(), account_id: aa[i].id() });
    }
    return { accounts: out, folders: fs };
  }
  if (op === "folders") {
    var all = app.folders(),
      out = [];
    for (var i = 0; i < Math.min(all.length, 500); i++) {
      var f = all[i];
      if (folders.indexOf(f.id()) >= 0)
        out.push({
          id: f.id(),
          name: f.name(),
          recently_deleted: deletedFolder(f),
        });
    }
    var selectedAccounts = [];
    for (var k = 0; k < accounts.length; k++) {
      var selected = account(accounts[k]);
      selectedAccounts.push({ id: selected.id(), name: selected.name() });
    }
    return {
      folders: out,
      accounts: selectedAccounts,
      complete: all.length <= 500,
    };
  }
  if (op === "list") {
    var f = folder(a.folder_id),
      nn = f.notes,
      count = Number(nn.length),
      out = [],
      scanned = 0;
    for (var i = 0; i < Math.min(count, 500); i++) {
      var n = nn[i],
        h = head(n);
      scanned++;
      if (a.query) {
        var hay = h.title;
        if (a.search_body && !h.locked)
          hay += "\n" + String(n.plaintext() || "").slice(0, 262144);
        if (hay.toLowerCase().indexOf(a.query.toLowerCase()) < 0) continue;
      }
      out.push(h);
    }
    out.sort(function (x, y) {
      return y.modified.localeCompare(x.modified) || x.id.localeCompare(y.id);
    });
    return {
      notes: out.slice(0, a.limit || 100),
      scanned: scanned,
      complete: count <= 500 && out.length <= (a.limit || 100),
    };
  }
  if (op === "read") return read(note(), a.include_html === true);
  if (op === "create") {
    var f = folder(a.folder_id);
    if (deletedFolder(f))
      fail("PERMISSION_DENIED", "Cannot create in Recently Deleted.");
    var n = app.Note({
      body: "<h1>" + esc(a.title) + "</h1>" + textHtml(a.text),
    });
    writeStarted = true;
    f.notes.push(n);
    return read(n, false);
  }
  if (op === "folder_create") {
    var acc = account(a.account_id),
      f = app.Folder({ name: a.name });
    writeStarted = true;
    acc.folders.push(f);
    return { id: f.id(), name: f.name(), account_id: acc.id() };
  }
  if (op === "append" || op === "rewrite") {
    var c = checked();
    writeStarted = true;
    c.n.body =
      op === "append"
        ? c.r.html + textHtml(a.text)
        : "<h1>" + esc(c.r.title) + "</h1>" + textHtml(a.text);
    return read(c.n, false);
  }
  if (op === "move") {
    var c = checked(),
      f = folder(a.folder_id);
    if (deletedFolder(f))
      fail("PERMISSION_DENIED", "Use explicit delete for Recently Deleted.");
    writeStarted = true;
    app.move(c.n, { to: f });
    return read(c.n, false);
  }
  if (op === "delete") {
    var c = checked();
    if (c.r.recently_deleted)
      fail("PERMISSION_DENIED", "Permanent deletion is not exposed.");
    writeStarted = true;
    app.delete(c.n);
    return { deleted: true, id: a.id };
  }
  fail("INVALID_INPUT", "Unknown Notes operation.");
}
function mail(op, a) {
  var app = Application("Mail"),
    allowed = (a.grants || {}).accounts || [];
  function account() {
    if (allowed.indexOf(a.account_id) < 0)
      fail("PERMISSION_DENIED", "Mail account is outside grant.");
    var x = app.accounts.byId(a.account_id);
    x.id();
    return x;
  }
  function box() {
    var ac = account(),
      parts = String(a.folder).split("/"),
      b = ac.mailboxes.byName(parts[0]);
    for (var i = 1; i < parts.length; i++) b = b.mailboxes.byName(parts[i]);
    b.name();
    return b;
  }
  function msg() {
    var b = box(),
      m = b.messages.byId(Number(a.id));
    m.id();
    if (
      !a.expected_message_id ||
      String(m.messageId()) !== a.expected_message_id
    )
      fail("STALE_REFERENCE", "Native Mail message identity changed.");
    return m;
  }
  function summary(m) {
    return {
      id: String(m.id()),
      subject: m.subject(),
      sender: m.sender(),
      received: m.dateReceived().toISOString(),
      read: m.readStatus(),
      flagged: m.flaggedStatus(),
      message_id: m.messageId(),
    };
  }
  function folders(ac) {
    var queue = [],
      out = [];
    var b = ac.mailboxes();
    for (var i = 0; i < b.length; i++)
      queue.push({ b: b[i], path: b[i].name() });
    while (queue.length && out.length < 300) {
      var x = queue.shift();
      out.push({ path: x.path, name: x.b.name(), unread: x.b.unreadCount() });
      var children = x.b.mailboxes();
      for (var j = 0; j < children.length; j++)
        queue.push({ b: children[j], path: x.path + "/" + children[j].name() });
    }
    return { folders: out, complete: queue.length === 0 };
  }
  if (op === "discover" || op === "accounts") {
    var aa = app.accounts(),
      out = [];
    for (var i = 0; i < Math.min(aa.length, 40); i++) {
      var x = aa[i];
      if (op === "accounts" && allowed.indexOf(x.id()) < 0) continue;
      out.push({
        id: x.id(),
        name: x.name(),
        emails: x.emailAddresses(),
        enabled: x.enabled(),
        backend: "mac-mail",
        supported_operations: [
          "folders",
          "search",
          "read",
          "draft_create",
          "mark",
          "move",
        ],
        unsupported_operations: [
          "raw_mime",
          "server_changes",
          "smtp_delivery_proof",
        ],
      });
    }
    return { accounts: out };
  }
  if (op === "folders") return folders(account());
  if (op === "search") {
    var b = box(),
      nn = b.messages,
      total = Number(nn.length),
      out = [],
      scanned = 0;
    for (var i = 0; i < Math.min(total, 500); i++) {
      var m = nn[i],
        s = summary(m);
      scanned++;
      if (
        a.subject &&
        s.subject.toLowerCase().indexOf(a.subject.toLowerCase()) < 0
      )
        continue;
      if (a.from && s.sender.toLowerCase().indexOf(a.from.toLowerCase()) < 0)
        continue;
      if (a.unread !== undefined && s.read === a.unread) continue;
      if (a.flagged !== undefined && s.flagged !== a.flagged) continue;
      if (a.since && s.received < a.since) continue;
      if (a.before && s.received >= a.before) continue;
      if (
        a.text &&
        String(m.content()).toLowerCase().indexOf(a.text.toLowerCase()) < 0
      )
        continue;
      out.push(s);
    }
    return {
      messages: out.slice(0, a.limit || 100),
      scanned: scanned,
      complete: false,
      result_scope: "bounded_local_mail_sync",
      local_total: total,
    };
  }
  if (op === "raw") {
    var m = msg(),
      was = m.readStatus();
    if (Number(m.messageSize()) > 8 * 1024 * 1024)
      fail("CONTENT_TOO_LARGE", "Native MIME source exceeds 8 MiB.");
    var source = String(m.source() || "");
    if (m.readStatus() !== was)
      fail("READ_SIDE_EFFECT", "Native MIME read changed unread status.");
    if (!source || source.length > 8 * 1024 * 1024)
      fail(
        "SOURCE_UNAVAILABLE",
        "Full local MIME source is unavailable or exceeds limits.",
      );
    return {
      source: source,
      verification_scope: "local",
      server_complete: false,
    };
  }
  if (op === "read") {
    var m = msg(),
      was = m.readStatus(),
      out = summary(m);
    out.text = String(m.content() || "").slice(0, 131072);
    if (m.readStatus() !== was)
      fail(
        "READ_SIDE_EFFECT",
        "Mail changed the read status; this provider needs review.",
      );
    out.attachments = [];
    var aa = m.mailAttachments();
    for (var i = 0; i < Math.min(aa.length, 100); i++)
      out.attachments.push({ name: aa[i].name(), size: aa[i].fileSize() });
    out.verification_scope = "local";
    return out;
  }
  if (op === "draft_create") {
    var ac = account(),
      emails = ac.emailAddresses();
    if (emails.indexOf(a.sender) < 0)
      fail(
        "PERMISSION_DENIED",
        "Sender does not belong to the selected account.",
      );
    var m = app.OutgoingMessage({
      subject: a.subject,
      content: a.text,
      sender: a.sender,
      visible: false,
    });
    writeStarted = true;
    app.outgoingMessages.push(m);
    ["to", "cc", "bcc"].forEach(function (k) {
      (a[k] || []).forEach(function (address) {
        m[k + "Recipients"].push(app.Recipient({ address: address }));
      });
    });
    app.save(m);
    return {
      id: String(m.id()),
      status: "draft_save_requested",
      server_verified: false,
    };
  }
  if (op === "mark") {
    var m = msg();
    if (a.read !== undefined) {
      writeStarted = true;
      m.readStatus = a.read;
    }
    if (a.flagged !== undefined) {
      writeStarted = true;
      m.flaggedStatus = a.flagged;
    }
    return summary(m);
  }
  if (op === "move") {
    var m = msg(),
      source = a.folder;
    a.folder = a.target;
    var target = box();
    a.folder = source;
    writeStarted = true;
    app.move(m, { to: target });
    return {
      id: String(m.id()),
      folder: a.target,
      verification_scope: "local",
    };
  }
  fail(
    "PROVIDER_UNSUPPORTED",
    "This Mail provider operation has no verified implementation.",
  );
}
function sendMessage(a) {
  var app = Application("Messages"),
    acc = null;
  app.accounts().forEach(function (x) {
    if (!acc && String(x.serviceType()) === "iMessage" && x.enabled()) acc = x;
  });
  if (!acc) fail("SERVICE_UNAVAILABLE", "No enabled iMessage account.");
  if (a.guid) {
    var c = app.chats.byId(a.guid);
    c.id();
    var ac = c.account();
    if (String(ac.serviceType()) !== "iMessage")
      fail("SERVICE_UNSUPPORTED", "Selected chat is not iMessage.");
    var handles = c
      .participants()
      .map(function (p) {
        return String(p.handle());
      })
      .sort();
    if (JSON.stringify(handles) !== JSON.stringify(a.handles.slice().sort()))
      fail("STALE_REVISION", "Chat participants changed.");
    writeStarted = true;
    app.send(a.text, { to: c });
    return { status: "send_submitted", delivered: false, read: false };
  }
  fail(
    "SERVICE_UNSUPPORTED",
    "Only an exact existing iMessage chat with verified participants is enabled.",
  );
}
