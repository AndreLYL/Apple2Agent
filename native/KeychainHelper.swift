import AppKit
import Foundation
import Security

// Only this application's own generic-password service is accessible here.
let service = "com.apple2agent.local"
func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(code)
}
func query(_ reference: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service, kSecAttrAccount as String: reference]
}
guard CommandLine.arguments.count >= 3 else { fail("Usage: keychain-helper setup CONFIG | get REFERENCE") }
let operation = CommandLine.arguments[1]
if operation == "store" {
    let reference=CommandLine.arguments[2]
    let data=FileHandle.standardInput.readDataToEndOfFile()
    guard UUID(uuidString:reference) != nil,data.count>0,data.count<=16384,let value=String(data:data,encoding:.utf8),!value.contains("\n") else{fail("Invalid private credential input")}
    var item=query(reference);item[kSecValueData as String]=data;item[kSecAttrLabel as String]="Apple2Agent Mail provider"
    guard SecItemAdd(item as CFDictionary,nil)==errSecSuccess else{fail("Could not create the private provider credential",2)}
    print("{\"stored\":true}");exit(0)
}
if operation == "key" {
    let reference = CommandLine.arguments[2]
    guard UUID(uuidString: reference) != nil else { fail("Invalid application key reference") }
    var q = query(reference); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    var status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { fail("Could not generate application key") }
        var item = query(reference); item[kSecValueData as String] = Data(bytes); item[kSecAttrLabel as String] = "Apple2Agent private approval key"
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess || added == errSecDuplicateItem else { fail("Could not save application key", 2) }
        result = nil; status = SecItemCopyMatching(q as CFDictionary, &result)
    }
    guard status == errSecSuccess, let data = result as? Data, data.count == 32 else { fail("Application key unavailable", 2) }
    FileHandle.standardOutput.write(Data(data.base64EncodedString().utf8)); exit(0)
}
if operation == "get" {
    var q = query(CommandLine.arguments[2]); q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
        fail("Apple2Agent Keychain item unavailable (OSStatus \(status)).", 2)
    }
    // Private child-process pipe consumed by CredentialStore; never shown by CLI.
    FileHandle.standardOutput.write(data)
    exit(0)
}
guard operation == "setup" else { fail("Unknown credential operation") }
let configURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let data = try? Data(contentsOf: configURL),
      var config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let reference = config["credential_ref"] as? String else { fail("Invalid local configuration") }

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let alert = NSAlert()
alert.messageText = "配置 Apple2Agent 的 iCloud 账户"
alert.informativeText = "仅连接你自己的一个账户。输入新建的 App 专用密码（不是 Apple 账户主密码）。密码只保存到此 Mac 的 Apple2Agent 钥匙串条目，不会出现在聊天、配置文件或命令参数中。"
alert.addButton(withTitle: "保存并验证")
alert.addButton(withTitle: "暂时取消")
alert.addButton(withTitle: "打开 Apple 账户")
let view = NSStackView()
view.orientation = .vertical; view.alignment = .leading; view.spacing = 8
view.frame = NSRect(x: 0, y: 0, width: 440, height: 175)
func field(_ label: String, _ value: String) -> NSTextField {
    view.addArrangedSubview(NSTextField(labelWithString: label))
    let field = NSTextField(string: value)
    field.translatesAutoresizingMaskIntoConstraints = false
    field.widthAnchor.constraint(equalToConstant: 440).isActive = true
    view.addArrangedSubview(field); return field
}
let apple = field("Apple 账户登录邮箱（用于日历）", config["apple_account"] as? String ?? "")
let mail = field("iCloud 邮箱地址（可留空，先使用日历；不是 QQ 登录名）", config["imap_username"] as? String ?? "")
view.addArrangedSubview(NSTextField(labelWithString: "Apple2Agent 专用密码"))
let password = NSSecureTextField(string: "")
password.translatesAutoresizingMaskIntoConstraints = false
password.widthAnchor.constraint(equalToConstant: 440).isActive = true
view.addArrangedSubview(password)
alert.accessoryView = view
app.activate(ignoringOtherApps: true)
while true {
    let response = alert.runModal()
    if response == .alertThirdButtonReturn {
        NSWorkspace.shared.open(URL(string: "https://account.apple.com/")!)
        continue
    }
    guard response == .alertFirstButtonReturn else { exit(20) }
    let appleValue = apple.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let mailValue = mail.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let secret = password.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard appleValue.contains("@"), (mailValue.isEmpty || mailValue.contains("@")),
          !secret.isEmpty, !secret.contains("\n") else {
        alert.informativeText = "请填写 Apple 账户的完整邮箱地址和新的 App 专用密码；尚未开通 iCloud 邮箱时，邮件地址可留空。"; continue
    }
    let previousAccount = (config["apple_account"] as? String ?? "").lowercased()
    let replacingAccount = !previousAccount.isEmpty && previousAccount != appleValue.lowercased()
    let targetReference = replacingAccount ? UUID().uuidString.lowercased() : reference
    let q = query(targetReference)
    let attributes = [kSecValueData as String: Data(secret.utf8)]
    var status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = q
        item[kSecValueData as String] = Data(secret.utf8)
        item[kSecAttrLabel as String] = "Apple2Agent iCloud"
        status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { fail("Unable to save Apple2Agent credential (OSStatus \(status)).", 2) }
    config["apple_account"] = appleValue
    if replacingAccount {
        config["account_id"] = UUID().uuidString.lowercased()
        config["credential_ref"] = targetReference
        config.removeValue(forKey: "default_calendar_id")
        config["writable_calendar_ids"] = [String]()
        config.removeValue(forKey:"hub") // Previously selected grants belong to the old account context.
    }
    config["caldav_username"] = appleValue
    config["imap_username"] = mailValue
    config["sender_address"] = mailValue
    do {
        let encoded = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
        try encoded.write(to: configURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
    } catch { fail("Credential saved, but unable to update configuration. Rerun setup.") }
    password.stringValue = ""
    print("Apple2Agent credentials saved to its own Keychain item.")
    exit(0)
}
