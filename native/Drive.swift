import Foundation
import Darwin
import CryptoKit
import PDFKit
var writeStarted=false
func fail(_ code:String,_ message:String)->Never { output(["error":["code":code,"message":message,"write_state":writeStarted ? "outcome_unknown":"failed_before_write"]]);exit(1) }
func output(_ v:Any){if let d=try? JSONSerialization.data(withJSONObject:v,options:[.sortedKeys]){FileHandle.standardOutput.write(d)}else{exit(2)}}
let raw=FileHandle.standardInput.readDataToEndOfFile()
guard raw.count<=8*1024*1024,let env=(try? JSONSerialization.jsonObject(with:raw)) as? [String:Any],let op=env["operation"] as? String,let a=env["args"] as? [String:Any],let root=a["root"] as? String else {fail("INVALID_INPUT","Structured Drive input required.")}
let rootfd=open(root,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
guard rootfd>=0 else{fail("PERMISSION_DENIED","Authorized Drive root is unavailable or a link.")}
defer{close(rootfd)}
func parts(_ path:String)->[String]{if path.hasPrefix("/") || path.utf8.contains(0){fail("PERMISSION_DENIED","Relative paths only.")};if path=="" || path=="."{return []};let p=path.split(separator:"/",omittingEmptySubsequences:false).map(String.init);if p.contains(where:{$0.isEmpty || $0==".." || $0=="." || $0==".Trash" || $0==".Trashes"}){fail("PERMISSION_DENIED","Unsafe Drive path.")};return p}
func parent(_ path:String)->(Int32,String){var p=parts(path);guard let last=p.popLast() else{fail("PERMISSION_DENIED","Root mutation is forbidden.")};var fd=dup(rootfd);for c in p{let next=openat(fd,c,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);close(fd);if next<0{fail("PERMISSION_DENIED","Directory is unavailable or contains a link.")};fd=next};return(fd,last)}
func info(_ fd:Int32,_ name:String)->[String:Any]{var s=stat();var legacyPlaceholder=false
if fstatat(fd,name,&s,AT_SYMLINK_NOFOLLOW) != 0 {
 let marker="."+name+".icloud";guard fstatat(fd,marker,&s,AT_SYMLINK_NOFOLLOW)==0 else{fail("NOT_FOUND","File is not available.")};legacyPlaceholder=true
};if s.st_mode & S_IFMT == S_IFLNK{fail("PERMISSION_DENIED","Symbolic links are not accessible.")};let revision="\(s.st_dev):\(s.st_ino):\(s.st_size):\(s.st_mtimespec.tv_sec):\(s.st_mtimespec.tv_nsec):\(s.st_ctimespec.tv_sec):\(s.st_ctimespec.tv_nsec)";return ["name":name,"size":s.st_size,"directory":s.st_mode & S_IFMT == S_IFDIR,"revision":revision,"sync_state":legacyPlaceholder || s.st_flags & 0x40000000 != 0 ? "cloud_only":"local","modified_at":ISO8601DateFormatter().string(from:Date(timeIntervalSince1970:Double(s.st_mtimespec.tv_sec)))]}
let path=a["path"] as? String ?? ""
if op=="list"{var fd=dup(rootfd);for c in parts(path){let n=openat(fd,c,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);close(fd);guard n>=0 else{fail("PERMISSION_DENIED","Directory is unavailable or a link.")};fd=n};guard let dir=fdopendir(fd) else{close(fd);fail("NOT_FOUND","Directory unavailable.")};defer{closedir(dir)};var items=[[String:Any]]();var count=0;let limit=min(a["limit"] as? Int ?? 1000,2000);while let e=readdir(dir){let name=withUnsafePointer(to:&e.pointee.d_name){$0.withMemoryRebound(to:CChar.self,capacity:1024){String(cString:$0)}};if name=="." || name==".." || name.hasPrefix(".a2a-") || name==".Trash" || name==".Trashes"{continue};count+=1;if items.count<limit{var s=stat();if fstatat(fd,name,&s,AT_SYMLINK_NOFOLLOW)==0 && s.st_mode & S_IFMT != S_IFLNK{let logical=name.hasPrefix(".") && name.hasSuffix(".icloud") ? String(name.dropFirst().dropLast(7)):name;items.append(info(fd,logical))}};if count>2000{break}};output(["items":items,"complete":count<=limit && items.count==count,"scanned":count]);exit(0)}
let (fd,name)=parent(path);defer{close(fd)}
func expected(){guard let revision=a["expected_revision"] as? String,info(fd,name)["revision"] as? String==revision else{fail("STALE_REVISION","File changed; read its current revision.")}}
switch op{
case "info":output(info(fd,name))
case "read", "pdf":
 let metadata=info(fd,name);if metadata["sync_state"] as? String != "local"{
 if a["download"] as? Bool == true {
  let f=openat(fd,name,O_EVTONLY|O_NOFOLLOW|O_CLOEXEC);guard f>=0 else{output(["sync_state":"cloud_only","download_state":"unavailable","complete":false]);exit(0)};defer{close(f)}
  var opened=stat();guard fstat(f,&opened)==0,let reference=(URL(fileURLWithPath:root).appendingPathComponent(path) as NSURL).fileReferenceURL() else{fail("DOWNLOAD_UNAVAILABLE","Cannot create a stable file reference for download.")}
  var bound=stat();guard stat(reference.path,&bound)==0,bound.st_dev==opened.st_dev,bound.st_ino==opened.st_ino else{fail("PERMISSION_DENIED","File identity changed before download.")}
  do{try FileManager.default.startDownloadingUbiquitousItem(at:reference);output(["sync_state":"downloading","complete":false])}catch{output(["sync_state":"cloud_only","download_state":"unavailable","complete":false])}
 }else{output(metadata)};exit(0)
 }

 guard metadata["directory"] as? Bool == false else{fail("INVALID_INPUT","Cannot read a folder as a file.")}
 let f=openat(fd,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);guard f>=0 else{fail("PERMISSION_DENIED","File could not be opened safely.")};defer{close(f)};var s=stat();guard fstat(f,&s)==0,s.st_mode & S_IFMT == S_IFREG else{fail("PERMISSION_DENIED","Only regular files can be read.")};let limit=min(a["max_bytes"] as? Int ?? 4194304,4194304);if s.st_size>limit{fail("CONTENT_TOO_LARGE","File exceeds 4 MiB.")};var data=Data();var buffer=[UInt8](repeating:0,count:65536);while true{let n=Darwin.read(f,&buffer,buffer.count);if n<0{fail("READ_FAILED","File could not be read.")};if n==0{break};data.append(buffer,count:n);if data.count>limit{fail("CONTENT_TOO_LARGE","File grew beyond the limit.")}};guard info(fd,name)["revision"] as? String==metadata["revision"] as? String else{fail("STALE_REVISION","File changed during read.")};var out=metadata;if op=="pdf"{guard let document=PDFDocument(data:data),!document.isEncrypted,document.pageCount<=1000 else{fail("FORMAT_UNSUPPORTED","PDF is locked or exceeds the page limit.")};let text=document.string ?? "";out["text"]=String(text.prefix(262144));out["truncated"]=text.count>262144;output(out);exit(0)};out["base64"]=data.base64EncodedString();out["sha256"]=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined();output(out)
case "write":
 guard let content=a["text"] as? String,let bytes=content.data(using:.utf8),bytes.count<=4194304 else{fail("INVALID_INPUT","Text up to 4 MiB required.")}
 let overwrite=a["overwrite"] as? Bool == true;if overwrite{expected()}
 let temp=".a2a-\(UUID().uuidString)";let f=openat(fd,temp,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600);guard f>=0 else{fail("WRITE_FAILED","Could not stage the file.")};defer{close(f);unlinkat(fd,temp,0)}
 var written=0;bytes.withUnsafeBytes{p in while written<bytes.count{let n=Darwin.write(f,p.baseAddress!.advanced(by:written),bytes.count-written);if n<=0{fail("WRITE_FAILED","Staged file write failed.")};written+=n}};guard fsync(f)==0 else{fail("WRITE_FAILED","Staged file flush failed.")};if overwrite{expected()};let flags:UInt32=overwrite ? 0:UInt32(RENAME_EXCL);guard renameatx_np(fd,temp,fd,name,flags)==0 else{fail(errno==EEXIST ? "ALREADY_EXISTS":"WRITE_FAILED","Atomic file replacement was rejected.")};writeStarted=true;fsync(fd);output(info(fd,name))
case "mkdir":guard mkdirat(fd,name,0o700)==0 else{fail(errno==EEXIST ? "ALREADY_EXISTS":"WRITE_FAILED","Folder could not be created exclusively.")};writeStarted=true;output(info(fd,name))
case "move":expected();guard let target=a["target"] as? String else{fail("INVALID_INPUT","Target required.")};let (to,dest)=parent(target);defer{close(to)};guard renameatx_np(fd,name,to,dest,UInt32(RENAME_EXCL))==0 else{fail(errno==EEXIST ? "ALREADY_EXISTS":"WRITE_FAILED","Move failed without replacing the destination.")};writeStarted=true;output(info(to,dest))
case "trash":expected();let trash=NSHomeDirectory()+"/.Trash";let to=open(trash,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);guard to>=0 else{fail("PERMISSION_DENIED","User Trash is not accessible.")};defer{close(to)};let dest="\(name)-\(UUID().uuidString)";guard renameatx_np(fd,name,to,dest,UInt32(RENAME_EXCL))==0 else{fail("WRITE_FAILED","Could not move the item to the user Trash.")};writeStarted=true;output(["trashed":true,"trash_name":dest])
default:fail("INVALID_INPUT","Unknown Drive operation.")
}
