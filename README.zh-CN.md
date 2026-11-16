# Apple2Agent

让 AI Agent 通过 MCP 使用你授权的 Apple 服务，运行在你自己的 Mac 上。

[English](README.md) · [安装指南](docs/getting-started.md) · [隐私与权限](docs/permissions-and-privacy.md) · [能力与兼容性](docs/compatibility.md)

**源码 Alpha · macOS · Node.js 24 · MIT**

Apple2Agent 将 CalDAV、CardDAV、IMAP、SMTP 与 macOS 原生 helper 结合，提供日历、邮件、提醒事项、联系人、备忘录和授权文件访问。你选择开放的账号与资源；邮件发送先冻结待审内容，再由你在 Mac 原生窗口批准。

## 适合做什么

- 查询日程和空闲时间，管理已授权日历中的事件。
- 阅读选定邮箱的邮件，准备草稿并在本人批准后发送。
- 创建提醒事项，回读到期时间与闹钟。

配置完成后可以这样问：

> 查看我明天有哪些 30 分钟空闲时间，不修改日历。
>
> 列出已选择收件箱最近三封邮件的标题。
>
> 在我选择的提醒清单中准备一个测试事项，先向我确认到期时间。

## 安装

需要 macOS、Node.js 24、Python 3 与 Xcode Command Line Tools。先克隆本仓库，再在仓库目录运行；当前安装器依赖 Git，不支持仅下载 ZIP 后直接安装。

```sh
npm ci
APPLE2AGENT_SIGN_IDENTITY=- npm run build
npm run typecheck
npm test
npm run install:local
```

**已经运行 Apple2Agent 的用户，应先阅读[升级与回滚](docs/getting-started.md#upgrade-and-rollback)。** 安装会切换当前用户的启动器和活动版本。

运行 `~/.local/bin/apple2agent setup`，在本机窗口填写账号、完成系统授权并选择资源。客户端使用 [examples](examples/) 中的模板，将路径替换为你自己的启动器绝对路径，建议先用 `readonly` profile。

## 验证范围

日历创建、回读、重复请求去重、手机同步和删除已有实机证据。QQ 邮件读取、批准发送和收取已验证。提醒事项创建和同步已验证，通知弹出仍待复测。联系人、备忘录与 Drive 有实现和测试，但未完成全部实机操作验收；Messages 为实验性功能，尚未完成真实授权与发送验收。

详见[兼容性矩阵](docs/compatibility.md)。测试通过不等于所有邮箱提供者、设备与文件格式都已验证。

## 手机接入与隐私

本地 MCP 为默认用法；[私人 Tunnel](docs/mobile-tunnel.md) 为可选进阶配置，需要使用者自己的账号、Runtime Key 和平台权限。仓库不提供共享后端，不内置微信服务，也不包含 Apple Health 功能。

手机远程调用时 Mac 需要在线。邮件最终发送批准仍需 Mac 原生窗口，目前不支持手机独立批准。

邮箱凭据保存在本应用的 Keychain 项中，Tunnel Key 另存于私有文件。工具返回内容会交给你使用的 Agent 客户端；“本机运行”不意味着数据绝不离开本机。详见[隐私说明](docs/permissions-and-privacy.md)和[进阶使用](docs/advanced-usage.zh-CN.md)。

## 许可证

项目原创代码采用 [MIT](LICENSE)，允许使用、修改、分发和商用，需保留版权及许可声明。第三方代码适用各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
