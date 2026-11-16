# 进阶使用

本文描述已有实现，不代表每个提供者或设备已验收。能力边界见 [兼容性](compatibility.md)。

## Mail 已登录账户与完整协议能力

Mac Mail 适配器通过正常 Apple Events 列账户、目录、搜索、读取正文 / 本地 MIME、保存普通草稿以及有条件的标记 / 移动；不读取 Mail 私有数据库、密码或 OAuth token。读取前后检查未读状态，异常时明确返回失败。

原生 Mail 自动化缺少可靠的完整富文本草稿 / 发送证明。需要这些能力时，可把该账户独立连接到自己的 IMAP / SMTP：

```sh
node dist/cli.js link-mail-provider
```

窗口让本人选择 Mail 账户、该账户的发件地址、TLS 端点和专用密码。每个协议连接有独立引用、UIDVALIDITY、操作与审批命名空间；不会把 Mail ID 当作 UID。IMAP 使用 TLS 993，SMTP 使用 TLS 465 或 STARTTLS 587；用户名或密码不进入命令参数 / 日志。

提供者不支持 App 专用密码、必须 OAuth，或需要其他认证时，连接保持待配置；目前没有 OAuth adapter。Mac Mail / 协议连接不会自动重复聚合。无法执行的操作明确返回 `PROVIDER_UNSUPPORTED`，不会默默丢 HTML、附件或线程信息。多发件别名必须明确指定该账户已验证的地址。

## 写操作与审核

新增 / 修改 / 删除使用稳定 UUID `request_id`；重试复用原 id。改输入会冲突。日历与联系人修改使用强 ETag，原生 API 使用写前快照和本项目锁，不能宣称原子服务器 CAS。

- `verified`：按标明的 `server / local` 层级回读；历史回执可能标为 `current_state_unchecked`。
- `accepted_unverified`：上游接受，但证明不足；只恢复核验。
- `OUTCOME_UNKNOWN`：可能发生，禁止自动重新提交或换 id 规避。
- `partial`：逐项回执；不为修复 Sent 副本再次发信。
- `queued_for_approval`：只排队，尚未发出。

发送流程：MCP 生成冻结的待审内容 → 本人运行下列命令、核对原生窗口 → 通过相应 execute 工具执行同一 action。MCP 没有批准工具，`approved:true` 不是授权。

```sh
node dist/cli.js review ACTION_ID
```

手机可以查询 / 创建日历，并提交发送待审请求。当前发送确认仍在本机完成；未实现可验证的手机本人确认事件，不能标记手机发送链路验收通过。SMTP 接受不等于收件人送达；Messages 当前只返回可证明的提交状态。

## 协议行为

邮件线程使用 Message-ID / In-Reply-To / References 连接同一范围内的整条回复链，不按相同主题拼接；默认包含目标文件夹、INBOX 和可发现的 Sent。待回复及往来人分析包含已发送邮件，往来人候选覆盖 From / To / Cc。

`mail_list_changes` 使用冻结分页快照。继续读取时传入返回的 `next_cursor` 作为 `cursor`，保持原 `change_token`；首次返回 null 时省略 token。完整快照的最后一页才返回新检查点。不完整扫描不推进检查点，也不把缺失数据当成已确认移除。UIDVALIDITY 改变或快照过期需要重新建立基线。

联系人搜索支持重音字符归一化，生日查询拒绝无效日期，未到出生年份不产生负年龄；无年份生日保持年龄未知。2 月 29 日在非闰年按明确的 2 月 28 日策略展示。

大结果保留在 MCP `structuredContent`，文本部分提供简短提示，避免重复编码导致 4 MiB 文件超出传输预算；序列化结果上限为 8 MiB。CLI 仍直接输出结构化结果。

## 日历写入范围

默认新建位置与可写范围分别保存。旧配置保持 `selected`：只操作已选日历；本人明确授权整个账户后，可运行：

```sh
apple2agent calendar-access all-writable
```

这使当前 iCloud 账户中由苹果确认可写的所有日历可创建、修改和删除，包括以后发现的可写日历。`apple2agent calendar-access selected` 恢复所选范围。`select-calendar` 只选择默认创建位置并保留已有授权。配置改变后须重连 MCP；只读 profile、上游只读 / 未确认权限以及强修订校验继续生效。

`calendar_list` 的 `writable` 表示苹果端权限；`write_authorized / write_access_reason / write_scope` 表示本次调用的应用授权。详情补充 `editable_fields / deletable / scheduling_role / edit_restriction`，避免将默认新建位置误认为全部写权限。

普通自有日程可以修改标题、时间、地点、备注、重复与报警。受邀日程或外部邀请副本可修改协议允许的个人忙闲 / DISPLAY 报警；组织者控制的内容仍受苹果权限约束。需要通知已有参与者的组织者操作返回明确限制，不隐式发送通知或新增参与者。

明确删除整个外部邀请或重复系列时，依据服务端 principal 地址判断身份，使用 `If-Match` 与 `Schedule-Reply:F` 抑制拒绝回复。身份无法确认、后端不能抑制调度回复、包含其他 UID 的对象和会通知他人的组织者操作在写前拒绝。单次受邀实例删除暂不自动生成拒绝回复。

日历改删前保存原始 ICS 到应用私有 `backups/calendar`（目录 0700 / 文件 0600），常规响应不包含原始 ICS。显式 `maintenance` 按现有备份保留策略处理本项目生成的 64 位哈希命名日历备份。
