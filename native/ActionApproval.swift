import AppKit
import Foundation

let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count < 8 * 1024 * 1024,
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let operation = request["operation"] as? String,
      let summary = (request["args"] as? [String:Any])?["summary"] as? String else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let alert = NSAlert()
alert.messageText = "审核 Apple2Agent 操作"
alert.informativeText = "请核对下方的目标与完整内容。只有点击允许，才会授权这一次操作。\n操作：\(operation)"
alert.addButton(withTitle: "允许这一次")
alert.addButton(withTitle: "拒绝")
alert.buttons[0].keyEquivalent=""
alert.buttons[1].keyEquivalent="\r"
let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 620, height: 360))
scroll.hasVerticalScroller = true
let text = NSTextView(frame: scroll.bounds)
text.isEditable = false; text.isSelectable = true
text.font = NSFont.systemFont(ofSize: 13)
text.string = summary
text.autoresizingMask = [.width]
scroll.documentView = text
alert.accessoryView = scroll
app.activate(ignoringOtherApps: true)
let approved = alert.runModal() == .alertFirstButtonReturn
FileHandle.standardOutput.write(Data((approved ? "{\"approved\":true}" : "{\"approved\":false}").utf8))
exit(0)
