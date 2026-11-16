#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin
SIGN_IDENTITY="${APPLE2AGENT_SIGN_IDENTITY:-}"
if [ -z "$SIGN_IDENTITY" ] && [ -f bin/.sign-identity ]; then
    SIGN_IDENTITY="$(cat bin/.sign-identity)"
fi
if [ -z "$SIGN_IDENTITY" ]; then
    SIGN_IDENTITY="$(security find-identity -v -p codesigning | awk '/\) [0-9A-F]+ "/ { print $2; exit }')"
fi
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SIGN_CHANGED=0
if [ ! -f bin/.sign-identity ] || [ "$(cat bin/.sign-identity)" != "$SIGN_IDENTITY" ]; then
    SIGN_CHANGED=1
fi
if [ ! -f bin/keychain-helper ] || [ native/KeychainHelper.swift -nt bin/keychain-helper ]; then
    xcrun swiftc -O native/KeychainHelper.swift -o bin/keychain-helper -framework AppKit -framework Security
    SIGN_CHANGED=1
fi
if [ "$SIGN_CHANGED" = 1 ]; then
    codesign --force --sign "$SIGN_IDENTITY" --identifier com.apple2agent.credentials bin/keychain-helper
fi
if [ ! -f bin/calendar-picker ] || [ native/CalendarPicker.swift -nt bin/calendar-picker ]; then
    xcrun swiftc -O native/CalendarPicker.swift -o bin/calendar-picker -framework AppKit
    codesign --force --sign - --identifier com.apple2agent.calendar-picker bin/calendar-picker
fi
printf '%s' "$SIGN_IDENTITY" > bin/.sign-identity
if [ ! -f bin/action-approval ] || [ native/ActionApproval.swift -nt bin/action-approval ]; then
    xcrun swiftc -O native/ActionApproval.swift -o bin/action-approval -framework AppKit
    codesign --force --sign "$SIGN_IDENTITY" --identifier com.apple2agent.approval bin/action-approval
fi
if [ ! -f bin/reminders ] || [ native/Reminders.swift -nt bin/reminders ] || [ native/Reminders-Info.plist -nt bin/reminders ]; then
    xcrun swiftc -O native/Reminders.swift -o bin/reminders -framework EventKit -framework CryptoKit -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/Reminders-Info.plist
    codesign --force --sign "$SIGN_IDENTITY" --identifier com.apple2agent.reminders bin/reminders
fi
if [ ! -f bin/drive ] || [ native/Drive.swift -nt bin/drive ]; then
    xcrun swiftc -O native/Drive.swift -o bin/drive -framework Foundation -framework CryptoKit
    codesign --force --sign "$SIGN_IDENTITY" --identifier com.apple2agent.drive bin/drive
fi
if [ ! -f bin/automation ] || [ native/Automation.swift -nt bin/automation ] || [ native/Automation-Info.plist -nt bin/automation ]; then
    xcrun swiftc -O native/Automation.swift -o bin/automation -framework OSAKit -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/Automation-Info.plist
    codesign --force --sign "$SIGN_IDENTITY" --identifier com.apple2agent.automation bin/automation
fi
for PICKER in ResourcePicker TunnelPicker; do
    if [ ! -f "bin/$PICKER" ] || [ "native/$PICKER.swift" -nt "bin/$PICKER" ]; then
        xcrun swiftc -O "native/$PICKER.swift" -o "bin/$PICKER" -framework AppKit
        codesign --force --sign "$SIGN_IDENTITY" --identifier "com.apple2agent.$PICKER" "bin/$PICKER"
    fi
done
if [ ! -f bin/MailProviderPicker ] || [ native/MailProviderPicker.swift -nt bin/MailProviderPicker ]; then
    xcrun swiftc -O native/MailProviderPicker.swift -o bin/MailProviderPicker -framework AppKit -framework Security
    codesign --force --sign "$SIGN_IDENTITY" --identifier com.apple2agent.mail-provider bin/MailProviderPicker
fi
# UI and permission helpers have real app identities so macOS can display their
# windows and attribute privacy permissions to stable Apple2Agent bundles.
cp native/automation/bridge.js bin/automation-bridge.js
for APP_HELPER in ResourcePicker TunnelPicker MailProviderPicker action-approval reminders automation; do
    APP_ROOT="bin/$APP_HELPER.app"
    APP_ID="com.apple2agent.$APP_HELPER"
    case "$APP_HELPER" in
        action-approval) APP_ID="com.apple2agent.approval" ;;
        MailProviderPicker) APP_ID="com.apple2agent.mail-provider" ;;
    esac
    mkdir -p "$APP_ROOT/Contents/MacOS"
    cp "bin/$APP_HELPER" "$APP_ROOT/Contents/MacOS/$APP_HELPER"
    if [ "$APP_HELPER" = automation ]; then
        mkdir -p "$APP_ROOT/Contents/Resources"
        cp native/automation/bridge.js "$APP_ROOT/Contents/Resources/automation-bridge.js"
    fi
    /usr/bin/python3 - "$APP_HELPER" "$APP_ROOT" "$APP_ID" <<'PY'
import pathlib,plistlib,sys
helper,root,identifier=sys.argv[1:]
titles={'ResourcePicker':'Apple2Agent 授权','TunnelPicker':'Apple2Agent 手机连接','MailProviderPicker':'Apple2Agent 邮件连接','action-approval':'Apple2Agent 操作审核','reminders':'Apple2Agent Reminders','automation':'Apple2Agent Automation'}
p=pathlib.Path(root)/'Contents/Info.plist'
info={'CFBundleIdentifier':identifier,'CFBundleName':titles[helper],'CFBundleDisplayName':titles[helper],'CFBundleExecutable':helper,'CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.5','NSHighResolutionCapable':True}
source={'reminders':'Reminders-Info.plist','automation':'Automation-Info.plist'}.get(helper)
if source:info.update(plistlib.loads((pathlib.Path('native')/source).read_bytes()))
p.write_bytes(plistlib.dumps(info))
PY
    codesign --force --sign "$SIGN_IDENTITY" --identifier "$APP_ID" "$APP_ROOT"
done
