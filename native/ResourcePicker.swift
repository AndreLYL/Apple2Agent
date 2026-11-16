import AppKit
import Foundation
final class ScopeSelection: NSObject {
    var buttons = [NSButton]()
    @objc func selectAll(_ sender: Any?) { buttons.forEach { $0.state = .on } }
    @objc func clearAll(_ sender: Any?) { buttons.forEach { $0.state = .off } }
}
let data=FileHandle.standardInput.readDataToEndOfFile()
guard data.count<4*1024*1024,let input=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let path=input["config_path"] as? String,let module=input["module"] as? String,let choices=input["choices"] as? [[String:Any]],let configData=try? Data(contentsOf:URL(fileURLWithPath:path)),var config=(try? JSONSerialization.jsonObject(with:configData)) as? [String:Any] else{exit(2)}
var hub=config["hub"] as? [String:Any] ?? ["enabled_modules":["calendar","mail"]]
let app=NSApplication.shared;app.setActivationPolicy(.regular)
let alert=NSAlert();alert.messageText="Apple2Agent：选择授权范围";alert.informativeText="模块：\(module)。只选你希望 Agent 访问的资源。未勾选的资源不会授权。";alert.addButton(withTitle:"保存授权");alert.addButton(withTitle:"取消")
let scroll=NSScrollView(frame:NSRect(x:0,y:0,width:650,height:380));scroll.hasVerticalScroller=true
let view=NSView(frame:NSRect(x:0,y:0,width:630,height:max(380,choices.count*32)));var buttons=[NSButton]()
for (i,choice) in choices.enumerated(){let kind=choice["kind"] as? String ?? "",id=choice["id"] as? String ?? "",label=choice["label"] as? String ?? id;let button=NSButton(checkboxWithTitle:label,target:nil,action:nil);button.frame=NSRect(x:8,y:view.frame.height-CGFloat((i+1)*32),width:610,height:28);button.state=(hub[kind] as? [String] ?? []).contains(id) ? .on:.off;view.addSubview(button);buttons.append(button)}
scroll.documentView=view
let selection=ScopeSelection();selection.buttons=buttons
let accessory=NSView(frame:NSRect(x:0,y:0,width:650,height:420))
accessory.addSubview(scroll)
let selectAll=NSButton(title:"全部勾选",target:selection,action:#selector(ScopeSelection.selectAll(_:)))
selectAll.frame=NSRect(x:420,y:387,width:105,height:28);accessory.addSubview(selectAll)
let clearAll=NSButton(title:"全部取消",target:selection,action:#selector(ScopeSelection.clearAll(_:)))
clearAll.frame=NSRect(x:535,y:387,width:105,height:28);accessory.addSubview(clearAll)
alert.accessoryView=accessory
alert.window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
app.activate(ignoringOtherApps:true);alert.window.makeKeyAndOrderFront(nil)
if alert.runModal() != .alertFirstButtonReturn{exit(20)}
for kind in Set(choices.compactMap{$0["kind"] as? String}){hub[kind]=choices.enumerated().filter{ $0.element["kind"] as? String==kind && buttons[$0.offset].state == .on }.compactMap{$0.element["id"] as? String}}
for (kind,deny) in [("reminder_lists","denied_reminder_lists"),("notes_folders","denied_notes_folders")] {
 if choices.contains(where:{$0["kind"] as? String==kind}) {hub[deny]=choices.enumerated().filter{$0.element["kind"] as? String==kind && buttons[$0.offset].state == .off}.compactMap{$0.element["id"] as? String}}
}
var enabled=hub["enabled_modules"] as? [String] ?? [];if !enabled.contains(module){enabled.append(module)};hub["enabled_modules"]=enabled;config["hub"]=hub
guard let current=try? Data(contentsOf:URL(fileURLWithPath:path)),current==configData else{exit(3)}
let url=URL(fileURLWithPath:path);let temp=url.deletingLastPathComponent().appendingPathComponent("config-\(UUID().uuidString).tmp")
guard let out=try? JSONSerialization.data(withJSONObject:config,options:[.prettyPrinted,.sortedKeys]) else{exit(2)}
do{try out.write(to:temp,options:.withoutOverwriting);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:temp.path);_ = try FileManager.default.replaceItemAt(url,withItemAt:temp)}catch{exit(2)}
FileHandle.standardOutput.write(Data("{\"saved\":true}".utf8))
