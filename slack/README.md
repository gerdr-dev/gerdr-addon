# Slack

把 Slack 里**给 bot 的私信**和 **@ 它的消息**变成 Gerdr 事件，面板、会话、别的插件都能订阅。它只负责「听」和「回」：
收到之后做什么（建任务、交给某个 agent、直接回一句），是订阅方自己的事。

用 Slack 的 Socket Mode：本机往外连，不需要公网地址；一台电脑一条连接，所以它是插件的后台进程，不是面板函数。
需要 Node 22 以上（自带 WebSocket，零依赖），在 Gerdr 用的登录 shell 的 PATH 里能找到 `node`。版本不够时插件状态会直接写明需要升级。

## 发出的事件

| source/kind | 什么时候 | key |
|---|---|---|
| `slack/dm` | 有人私信 bot | 私信频道 id（`D…`） |
| `slack/mention` | 频道里 @ 了 bot，或者在 bot 参与过的 thread 里接着说（不用再 @） | `频道/thread_ts`（@ 那条开了 thread，就是它自己的 ts） |
| `slack/message` | 设置里打开「频道里不 @ 也收」后，bot 所在频道的其它消息 | 同上 |

`key` 就是「这段对话」：同一个私信、同一个 thread 里的后续消息 key 相同，订阅方按它接着处理（任务看板会交给同一个任务）。
bot 参与过的 thread（被 @ 过、它回复过）记在插件数据目录的 `threads.json`。

`actor` 是发消息的人的 member ID（订阅方按它决定谁能派活）。`title` 是「谁: 第一行」，`text` 是全文（附件下到本机的路径接在后面），`url` 是消息链接。
`data`：`{ channel, channelType, user, userName, ts, threadTs, text, files: [{ name, path?, error? }], team }`。
`threadTs` 是回复该贴进的 thread（私信顶层为空）。

## 回复

每个事件都带着回复地址（`reply`），订阅方不用知道它来自 Slack：

```ts
ctx.events.reply(e, "收到，已建任务 t9");   // 贴回那条私信 / 那个 thread
```

等价于自己发一个 `slack.send` 事件：`{ kind: "slack.send", data: { channel, threadTs?, text } }`。

## 面板里怎么接

`triggers/slack.json`：

```json
{ "on": "slack/dm", "fn": "inbox.onSlack", "name": "Slack 私信" }
```

`local/inbox.ts`：

```ts
export async function onSlack(input: { event: GerdrEvent }, ctx: Ctx) {
  const e = input.event;
  // 听不听、怎么处理由面板自己定：读自己的设置 / skill，再决定
  const t = await ctx.sessions.start({ cwd: "~/dev/proj", prompt: e.text ?? "", title: e.title });
  ctx.events.reply(e, `收到，在处理（${t.id}）`);
}
```

会话也能直接订阅：`gerdr event watch --on slack/dm --note "帮我回一下"`。

## 建 Slack app（一次）

<https://api.slack.com/apps> → Create New App → **From a manifest**：

```yaml
display_information:
  name: gerdr
features:
  bot_user: { display_name: gerdr, always_online: true }
oauth_config:
  scopes:
    bot: [chat:write, im:history, im:read, im:write, app_mentions:read, channels:history, groups:history, files:read, users:read]
settings:
  event_subscriptions:
    bot_events: [message.im, app_mention, message.channels, message.groups]
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

然后：Basic Information → App-Level Tokens 生成 `xapp-…`（scope `connections:write`）；Install to Workspace 拿 `xoxb-…`；
两个都填进 Gerdr 设置 → 插件 → Slack。你自己的 member ID（个人资料 → More → Copy member ID）填进「只收这些人的消息」。

- `channels:history` / `groups:history` 和对应的事件只在打开「频道里不 @ 也收」时有用，不要可以去掉。
- `files:read` 是收附件用的；`users:read` 让事件里显示名字而不是 ID。
- 改了 scope 要 Reinstall to Workspace。

## 安全

消息内容会交给 agent，等于**不可信的指令**。「只收这些人的消息」尽量只填自己；订阅方别让一条消息直接落地线上写操作。
