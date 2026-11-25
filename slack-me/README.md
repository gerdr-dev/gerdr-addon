# Slack 私聊（我的账号）

把别人在 Slack **私聊你本人**的消息变成 Gerdr 事件，面板、会话、别的插件都能订阅。和 [Slack](../slack) 插件的区别：

| | [Slack](../slack) | 这个 |
|---|---|---|
| 收什么 | 给 **bot** 的私信、@ bot | 给**你**的私信（含群私聊），可选 @ 你 |
| 怎么登录 | 自己建 Slack app，填 bot / app token | 不建 app：用 [slackctl](https://github.com/cluas/slackctl) 从 Slack 桌面版导入的登录 |
| 回复的身份 | bot | **你本人** |

## 准备（一次）

1. 装 slackctl **v0.3.0 以上**（收消息靠它的 `listen`）：`go install github.com/cluas/slackctl/cmd/slackctl@latest`（或 `brew tap cluas/tap && brew install slackctl`）。
   版本太旧时插件状态会写明要升级。
2. 电脑上装着并登录了 Slack 桌面版。插件第一次启动时会自己跑 `slackctl auth import-desktop`，
   macOS 可能弹一次钥匙串授权，点「允许」。也可以先手动跑一遍。
3. 需要 Node 18 以上。
4. 让 agent 也会用 slackctl（读 thread、搜消息、看历史）：装 slackctl 自带的 skill，
   `npx skills add cluas/slackctl -g`（或把它仓库里的 `skills/slackctl` 拷到 `~/.claude/skills/` 和 `~/.agents/skills/`）。
   插件只把消息变成事件、帮你回复；agent 在会话里要主动读 Slack，靠的是这份 skill。不装的话 agent 不知道本机有 slackctl。

桌面版的登录过一阵会换，插件发现登录失效会自己重新导入（最多 10 分钟一次）；你在桌面版退出登录了，它就等你重新登录。

## 发出的事件

| source/kind | 什么时候 | key |
|---|---|---|
| `slack-me/direct` | 有人私聊你（几个人的群私聊也算，设置里可关） | 私聊频道 id；thread 里是 `频道/thread_ts` |
| `slack-me/mention` | 频道里有人 @ 你（设置里打开才有） | `频道/thread_ts`；小频道里同下 |
| `slack-me/thread` | 频道里你说过话、或被 @ 过的消息列（thread），之后别人不 @ 你的回话（设置「参与过的消息列也收」，默认开） | `频道/thread_ts`，和 @ 你那条一样 |
| `slack-me/channel` | 小频道里有人说话（设置「小频道全收」填了人数才有）；或者大频道里你刚在顶层说过话，之后「说话后接着收」那么多分钟里别人在顶层说的（默认 60 分钟）。都不用 @ 你 | 频道 id；小频道的 thread 里是 `频道/thread_ts` |

小频道：人数（含你）不超过「小频道全收」那个数的频道。几个人的频道多半就是在跟你说话，只是不 @ 你、也不开 thread ——
只收 @ 的话，同事接着回的那句永远进不来，等他回话的 agent 也就永远等不到。所以它的顶层像群私聊一样是一个对话（key 是频道 id），
里面 @ 你的那条也一样，这样跟着那条 @ 的任务能听到同事在底下没 @ 的回话。单独一个 kind，是因为面板通常对每条私聊开工作，
小频道里每句话都开就太吵了；不在触发器里开它，面板的「等回复」照样能跟住某个小频道。

参与过的消息列、说话后接着收：大频道里同事接你的话多半不 @ 你 —— 你在 thread 里问「什么环境」，他回一个链接；
你在频道里说了几句，后面的人接着讨论。Slack 自己会把「你回过或被 @ 过的 thread」里的新回复提醒给你，这里照着做：
插件记住你在哪个 thread 说过话 / 被 @ 过、在哪个频道顶层刚说过话（存在插件数据目录的 `involved.json`，重启不丢，
30 天没动静的忘掉）。插件开始收之前就有的 thread，第一次有新回复时用 `conversations.replies` 问一次里面有没有你，答案记一小时。
thread 的 key 和 @ 你那条一样，所以跟着那条 @ 的任务也能听到后面的回话。

你自己发的、bot 发的不算。`actor` 是发消息的人的 member ID，`data`：`{ channel, channelType, place, user, userName, ts, threadTs, text, files, workspace }`。
`place` 是这段对话在哪、给人看的：`私聊`、`群私聊`、`#频道名 的消息列`、`#频道名`（小频道顶层），显示回复发去哪时用它，别只写对方名字 —— 「回给 某人」会被当成私聊。
事件的 `text` / `title` 和 `data.context` 里，`<@U…>` 换成了 `@人名`；`data.text` 是 Slack 的原文，ID 还在。

故意没叫 `dm`：`dm` 在 Gerdr 里的意思是「我自己发给我的 bot 的私信」，[在聊天里审批](../remote-answer) 这类插件会往最近一条 `dm` 的对话里发审批、把回复当成你的答复。
别人私聊你不是这种对话，混进去会把审批发给同事。

## 回复

```ts
ctx.events.reply(e, "收到，晚点看");   // 以你本人的身份贴回那条私聊 / thread
```

等价于发一个 `slack-me.send` 事件：`{ kind: "slack-me.send", data: { channel, threadTs?, text } }`，插件用 `slackctl message send` 发出去。

只想点个表情：`ctx.events.reply(e, "已批", { react: "white_check_mark", ts: e.data.ts })`，插件用 `slackctl message react add` 以你的身份在 `ts` 那条消息上加表情，不发文字；加不上才把文字照常发出去。

## 怎么做到的

收消息是 `slackctl listen --mentions-or-dms --include-bots=false`（开了「小频道全收」「参与过的消息列也收」或「说话后接着收」
就去掉 `--mentions-or-dms`，所有频道消息（包括你自己发的）都过来，插件自己筛；实时连接本来就推你所在的所有频道，slackctl 是在本地筛的，所以不多调 Slack 接口。
频道人数用 `conversations.info` 查，每个频道一小时查一次）：slackctl 用同一份登录连 Slack 的实时连接（`rtm.connect`，桌面版用的那个），
保活、断线重连都是它做的，插件只读它输出的 JSON 行、再按设置筛（群私聊、@ 我、只收谁）。
listen 的输出不带附件、正文最多 2000 字，也看不出消息带没带附件，所以每条消息插件都会用同一份登录再取一次完整的。
listen 因为登录失效退出时，插件重新从桌面版导入登录再拉起来。
企业版（Enterprise Grid）实测：私聊是全组织共享的，连任意一个工作区都能收到；企业那个总地址不让连实时连接，所以插件只连一个普通工作区。

## 安全

- 这是你本人的登录：插件和订阅它的面板能以你的名义读写 Slack。别让一条消息直接触发回复或线上写操作，回复前最好让你确认。
- 消息内容来自别人，交给 agent 时就是**不可信的指令**。
- 这不是 Slack 官方给第三方的接入方式（官方的是建 app），公司 Slack 管理员可能看得到异常会话。介意就用 [Slack](../slack) 插件。

## 上下文

每条事件的 `data.context` 带上这段对话里它之前的几条消息（最多 8 条、两天以内），包括你自己说的（`me: true`）：
只有别人的消息会变成事件，光一句回复，接收的一方（比如 Superagent 的秘书）看不出它在回什么。
