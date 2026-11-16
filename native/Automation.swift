import Foundation
import OSAKit
let binary=URL(fileURLWithPath:CommandLine.arguments[0]).resolvingSymlinksInPath()
let sourceURL=Bundle.main.url(forResource:"automation-bridge",withExtension:"js") ?? binary.deletingLastPathComponent().appendingPathComponent("automation-bridge.js")
guard let source=try? String(contentsOf:sourceURL,encoding:.utf8),let language=OSALanguage(forName:"JavaScript") else{exit(2)}
let script=OSAScript(source:source,language:language)
var error:NSDictionary?
if let result=script.executeAndReturnError(&error),let value=result.stringValue {FileHandle.standardOutput.write(Data(value.utf8))}else{let number=error?[OSAScriptErrorNumber] as? Int ?? 0;let code=number == -1743 ? "PERMISSION_DENIED":"NATIVE_ERROR";let result:[String:Any] = ["error":["code":code,"message":"Automation could not complete. Check the signed helper's Automation permission and the selected account."]];if let data=try? JSONSerialization.data(withJSONObject:result){FileHandle.standardOutput.write(data)};exit(1)}
