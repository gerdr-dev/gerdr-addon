# Slack

把 Slack 里**给 bot 的私信**和 **@ 它的消息**变成 Gerdr 事件，面板、会话、别的插件都能订阅。它只负责「听」和「回」：
收到之后做什么（建任务、交给某个 agent、直接回一句），是订阅方自己的事。

用 Slack 的 Socket Mode：本机往外连，不需要公网地址；一台电脑一条连接，所以它是插件的后台进程，不是面板函数。
需要 Node 22 以上（自带 WebSocket，零依赖）。

## 发出的事件

| source/kind | 什么时候 | key |
|---|---|---|
| `slack/dm` | 有人私信 bot | 私信频道 id（`D…`） |
| `slack/mention` | 频道里 @ 了 bot | 频道 id；在 thread 里是 `频道/thread_ts` |
| `slack/message` | 设置里打开「频道里不 @ 也收」后，bot 所在频道的其它消息 | 同上 |

`title` 是「谁: 第一行」，`text` 是全文（附件下到本机的路径接在后面），`url` 是消息链接。
`data`：`{ channel, channelType, user, userName, ts, threadTs, text, files: [{ name, path?, error? }], team }`。
`threadTs` 是回复该贴进的 thread（私信顶层为空）。

## 回复

发一个 `slack.send` 事件，`data` 写清楚贴到哪：

```ts
ctx.events.emit({ source: "board", kind: "slack.send", data: { channel: e.data.channel, threadTs: e.data.threadTs, text: "收到，已建任务 t9" } });
```

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
  ctx.events.emit({ source: "board", kind: "slack.send", data: { channel: e.data.channel, threadTs: e.data.threadTs, text: `收到，在处理（${t.id}）` } });
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
