import AppKit
import Foundation
func fail(_ text: String) -> Never { FileHandle.standardError.write(Data((text+"\n").utf8)); exit(1) }
guard CommandLine.arguments.count == 3 else { fail("Usage: calendar-picker CONFIG CHOICES") }
let configURL=URL(fileURLWithPath:CommandLine.arguments[1])
guard let data=try? Data(contentsOf:configURL), var config=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
      let choicesData=try? Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2])),
      let choices=(try? JSONSerialization.jsonObject(with:choicesData)) as? [[String:Any]], !choices.isEmpty else {fail("Invalid calendar selection data")}
let app=NSApplication.shared; app.setActivationPolicy(.regular)
let alert=NSAlert();alert.messageText="选择 Apple2Agent 默认新建日历"
alert.informativeText="未指定目标的新日程将放入此日历。此选择保留已有的日历写入范围。"
alert.addButton(withTitle:"使用这个日历");alert.addButton(withTitle:"取消")
let popup=NSPopUpButton(frame:NSRect(x:0,y:0,width:400,height:32))
for choice in choices {popup.addItem(withTitle:choice["name"] as? String ?? "Calendar")}
alert.accessoryView=popup;app.activate(ignoringOtherApps:true)
guard alert.runModal() == .alertFirstButtonReturn else {exit(20)}
guard let id=choices[popup.indexOfSelectedItem]["calendar_id"] as? String else {fail("Invalid calendar")}
config["default_calendar_id"]=id
var permitted=config["writable_calendar_ids"] as? [String] ?? []
if !permitted.contains(id) { permitted.append(id) }
config["writable_calendar_ids"]=permitted
do {try JSONSerialization.data(withJSONObject:config,options:[.prettyPrinted,.sortedKeys]).write(to:configURL,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:configURL.path)}catch {fail("Unable to save selected calendar")}
print("Calendar selection saved.")
