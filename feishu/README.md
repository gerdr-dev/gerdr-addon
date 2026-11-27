# 飞书

把飞书里**给机器人的私信**和**群里 @ 机器人的消息**变成 Gerdr 事件，面板、会话、别的插件都能订阅。它只负责「听」和「回」：收到之后做什么（建任务、交给某个 agent、直接回一句），是订阅方自己的事。

用飞书的**长连接模式**收事件：本机往外连，不需要公网回调地址；一台电脑一条连接，所以它是插件的后台进程，不是面板函数。
需要 Node 22 以上（自带 WebSocket 和 fetch，零依赖），在 Gerdr 用的登录 shell 的 PATH 里能找到 `node`。支持国内版飞书（`feishu.cn`）和国际版 Lark（`larksuite.com`）。

## 准备（一次）

1. **建企业自建应用**：打开 [飞书开放平台](https://open.feishu.cn/app)（国际版打开 [Lark Developer Console](https://open.larksuite.com/app)）→「创建企业自建应用」。
2. **开机器人能力**：应用详情 →「添加应用能力」→ 添加**机器人**。
3. **开权限**：左侧「权限管理」→ 开通以下应用身份（tenant）权限：
   - **必需**：
     - `im:message`（获取与发送单聊、群组消息）
     - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）
     - `im:message.group_at_msg:readonly`（接收群聊中 @ 机器人消息事件）
     - `im:message:send_as_bot`（以应用的身份发消息）
   - **推荐**（不开也能收发纯文字，开了体验完整）：
     - `im:resource`（下载消息中的图片、文件附件）
     - `contact:contact.base:readonly` 或 `contact:user.base:readonly`（显示发消息人的姓名；不开则显示 `open_id`）
     - `im:chat:readonly`（读取群名，事件里的 `place` 显示为具体群名）
   - **可选**：
     - `im:message.group_msg`（打开设置里的「群里不 @ 也收」或读取群聊历史上下文时需要）
     - `im:message.reactions:write_only`（用表情回复消息时需要）
4. **先填凭证连上插件**：到「凭证与基础信息」复制 **App ID**（`cli_…`）和 **App Secret**，填进 Gerdr「设置 → 扩展 → 飞书」（国际版把「平台版本」切到 Lark），确认插件状态变为「已连上 飞书」。
   > 飞书要求先有客户端连上，后台才能保存「使用长连接接收事件」。
5. **配置事件订阅**：回到飞书开放平台 →「事件与回调」→「事件配置」：
   - 订阅方式选 **「使用长连接接收事件」** 并保存；
   - 添加事件：**`im.message.receive_v1`**（接收消息 v2.0）。
6. **发布版本**：「版本管理与发布」→ 创建版本并发布（如果企业设置了需要审批，等管理员通过；个人/测试企业一般即时生效）。
7. **限制只收自己的消息（强烈建议）**：在飞书里给机器人发一句话，在 `gerdr event list --on feishu/dm` 里看到你自己的 `actor`（`ou_…`），填进设置里的「只收这些人的消息」。

## 发出的事件

| source/kind | 什么时候 | key |
|---|---|---|
| `feishu/dm` | 有人私信机器人 | 会话 ID（`oc_…`） |
| `feishu/mention` | 群里 @ 了机器人，或者在机器人参与过的话题里接着说（不用再 @） | `chat_id/root_id`（@ 那条开启话题，就是它自己的 `message_id`） |
| `feishu/message` | 设置里打开「群里不 @ 也收」后，机器人所在群的其它消息 | 同上 |

`key` 就是「这段对话」：同一个私信、同一个话题里的后续消息 key 相同，订阅方按它接着处理（Superagent 任务看板会交给同一个任务）。
机器人参与过的话题（被 @ 过、它回复过）记在插件数据目录的 `threads.json`。

`actor` 是发消息人的 `open_id`（`ou_…`）。`title` 是「谁: 第一行」，`text` 是全文（文本里的 `@` 已还原为 `@人名`，`@机器人自己` 已去掉；图片和文件下到本机，路径以 `[附件] /path/...` 接在后面）。

`data`：`{ chat_id, chatType, message_id, root_id, thread_id, open_id, user, userName, place, text, files: [{ name, mimetype, size, path?, error? }], context, domain }`。

- `place` 是给人看的位置说明：`私聊`、`群名`、`群名 的话题`，面板显示「回复发去哪」时直接用它。
- `context` 是这段对话里它之前的几条消息（最多 8 条、两天内，含机器人自己的回复 `me: true`），有历史消息权限时自动带上。

## 回复

每个事件都带着回复地址（`reply`），订阅方不用知道它来自飞书：

```ts
ctx.events.reply(e, "收到，已建任务 t9");   // 私聊直接回会话；群里自动回到对应话题
```

等价于发一个 `feishu.send` 事件：`{ kind: "feishu.send", data: { chat_id, reply_to?, reply_in_thread?, text } }`。回复默认用飞书富文本 `md` 渲染 Markdown（失败时自动降级为纯文本）。

只想点个表情（比如 `DONE` / `OK` / `THUMBSUP`，飞书表情编码）：

```ts
ctx.events.reply(e, "已收到", { react: "OK", message_id: e.data.message_id });
```

插件在对应消息上加表情，不发文字；加不上（没开 `im:message.reactions:write_only` 或编码不对）才把文字照常发出去。

## 面板里怎么接

- **Superagent 面板**：在面板「设置 → 触发器」里直接勾选 `飞书私信`（`feishu/dm`）或 `飞书群里 @ 了机器人`（`feishu/mention`）即可。
- **在聊天里审批（remote-answer）**：在插件设置「发到哪个聊天」里选 `飞书`，再私信机器人一句，agent 等审批时就会发到飞书，回个数字继续跑。
- **会话直接订阅**：`gerdr event watch --on feishu/dm --note "帮我处理一下"`。

## 安全

消息内容会交给 agent，等于**不可信的指令**。「只收这些人的消息」尽量只填你自己的 `open_id`；订阅方别让一条消息直接落地线上写操作。
