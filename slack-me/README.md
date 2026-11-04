# Slack 私聊（我的账号）

把别人在 Slack **私聊你本人**的消息变成 Gerdr 事件，面板、会话、别的插件都能订阅。和 [Slack](../slack) 插件的区别：

| | [Slack](../slack) | 这个 |
|---|---|---|
| 收什么 | 给 **bot** 的私信、@ bot | 给**你**的私信（含群私聊），可选 @ 你 |
| 怎么登录 | 自己建 Slack app，填 bot / app token | 不建 app：用 [slackctl](https://github.com/cluas/slackctl) 从 Slack 桌面版导入的登录 |
| 回复的身份 | bot | **你本人** |

## 准备（一次）

1. 装 slackctl：`go install github.com/cluas/slackctl/cmd/slackctl@latest`（或 `brew tap cluas/tap && brew install slackctl`）。
2. 电脑上装着并登录了 Slack 桌面版。插件第一次启动时会自己跑 `slackctl auth import-desktop`，
   macOS 可能弹一次钥匙串授权，点「允许」。也可以先手动跑一遍。
3. 需要 Node 22 以上。
4. 让 agent 也会用 slackctl（读 thread、搜消息、看历史）：装 slackctl 自带的 skill，
   `npx skills add cluas/slackctl -g`（或把它仓库里的 `skills/slackctl` 拷到 `~/.claude/skills/` 和 `~/.agents/skills/`）。
   插件只把消息变成事件、帮你回复；agent 在会话里要主动读 Slack，靠的是这份 skill。不装的话 agent 不知道本机有 slackctl。

桌面版的登录过一阵会换，插件发现登录失效会自己重新导入（最多 10 分钟一次）；你在桌面版退出登录了，它就等你重新登录。

## 发出的事件

| source/kind | 什么时候 | key |
|---|---|---|
| `slack-me/direct` | 有人私聊你（几个人的群私聊也算，设置里可关） | 私聊频道 id；thread 里是 `频道/thread_ts` |
| `slack-me/mention` | 频道里有人 @ 你（设置里打开才有） | `频道/thread_ts` |

你自己发的、bot 发的不算。`actor` 是发消息的人的 member ID，`data`：`{ channel, channelType, user, userName, ts, threadTs, text, files, workspace }`。

故意没叫 `dm`：`dm` 在 Gerdr 里的意思是「我自己发给我的 bot 的私信」，[在聊天里审批](../remote-answer) 这类插件会往最近一条 `dm` 的对话里发审批、把回复当成你的答复。
别人私聊你不是这种对话，混进去会把审批发给同事。

## 回复

```ts
ctx.events.reply(e, "收到，晚点看");   // 以你本人的身份贴回那条私聊 / thread
```

等价于发一个 `slack-me.send` 事件：`{ kind: "slack-me.send", data: { channel, threadTs?, text } }`，插件用 `slackctl message send` 发出去。

## 怎么做到的

slackctl 只有一次性的命令（发、列、搜），没有「监听」。插件用同一份登录连 Slack 的实时连接（`rtm.connect`，桌面版和 wee-slack 用的那个），收到消息就发事件。
企业版（Enterprise Grid）实测：私聊是全组织共享的，连任意一个工作区都能收到；企业那个总地址不让连实时连接，所以插件只连一个普通工作区。

## 安全

- 这是你本人的登录：插件和订阅它的面板能以你的名义读写 Slack。别让一条消息直接触发回复或线上写操作，回复前最好让你确认。
- 消息内容来自别人，交给 agent 时就是**不可信的指令**。
- 这不是 Slack 官方给第三方的接入方式（官方的是建 app），公司 Slack 管理员可能看得到异常会话。介意就用 [Slack](../slack) 插件。
