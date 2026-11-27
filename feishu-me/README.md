# 飞书私聊（我的账号）

把别人在飞书 / Lark **私聊你本人**、群里 **@ 你**、以及你参与过的话题里的消息变成 Gerdr 事件，面板、会话、别的插件都能订阅；回复以**你本人的身份**发出。和 [飞书](../feishu) 插件的区别：

| | [飞书](../feishu) | 这个 |
|---|---|---|
| 收什么 | 发给**机器人**的私信、群里 @ 机器人 | 发给**你本人**的私聊、群里 @ 你、参与过的话题 |
| 怎么连 | 飞书长连接（实时推送） | 官方 [lark-cli](https://github.com/larksuite/cli)（`--as user` 定时轮询） |
| 回复的身份 | 机器人 | **你本人** |

## 准备（一次）

1. **装官方 `lark-cli`**：
   ```bash
   npx @larksuite/cli@latest install
   ```
2. **初始化应用凭证**（没建过就按提示走一次，官方自带一键引导）：
   ```bash
   lark-cli config init
   ```
3. **用个人身份登录并授权 IM 读写权限**（`--domain im` 管读和搜索，`im:message.send_as_user` 管以你本人身份回复）：
   ```bash
   lark-cli auth login --domain im --scope "im:message.send_as_user"
   ```
   浏览器扫码确认即可。如果本机同时要用国内飞书和国际版 Lark，可以用 `lark-cli config init --new --name feishu-cn --brand feishu` 建一个独立 profile，再把插件设置里的 `lark-cli 配置名（profile）` 填成 `feishu-cn`。之后 `lark-cli` 会在访问时自动刷新 token（refresh token 过期才需要重新登录，过期时插件也会在状态栏提醒并发 `feishu-me/login` 事件）。
4. **让 agent 也会用 `lark-cli`（推荐）**：装官方 skill，方便 agent 主动搜聊天记录、看飞书文档/日历/多维表格：
   ```bash
   npx skills add larksuite/cli -y -g
   ```

> 飞书开放平台的实时 WebSocket 事件只推送机器人视角的消息，不推个人私聊；所以本插件通过官方 `lark-cli --as user` 定时轮询（默认 30 秒一次）。优先走 `im +messages-search`（每轮 1～2 次调用），如果没授权 `search:message` 会自动降级到 `im +chat-list --types p2p --sort active_time` 轮询最近活跃单聊。

## 发出的事件

| source/kind | 什么时候 | key |
|---|---|---|
| `feishu-me/direct` | 有人私聊你本人 | 会话 ID（`oc_…`） |
| `feishu-me/mention` | 群里有人 @ 你（设置「群里 @ 我也收」，默认开） | `chat_id/root_id` |
| `feishu-me/thread` | 群里你被 @ 过或回复过的话题，之后别人不 @ 你的回话（设置「参与过的话题也收」，默认开） | `chat_id/root_id`（和 @ 你那条相同） |
| `feishu-me/login` | `lark-cli` 未登录、登录过期或缺少 IM 权限 | `login` |

- 第一次启动只记录现状基线，不会把历史旧消息灌进收件箱。
- 你自己发的、机器人发的、系统消息、已撤回消息都会过滤掉。
- `actor` 是发消息人的 `open_id`（`ou_…`），`data`：`{ chat_id, chatType, message_id, root_id, thread_id, open_id, user, userName, place, text, files, context, brand }`。
- `place` 是给人看的位置说明：`私聊`、`群名`、`群名 的话题`。
- `context` 带上这段对话里它之前的最多 8 条消息（两天内，含你自己说的 `me: true`）。

> 故意没叫 `dm`：`dm` 在 Gerdr 里的意思是「我自己发给我的 bot 的私信」，[在聊天里审批](../remote-answer) 这类插件会往最近一条 `dm` 发审批。别人私聊你不是这种对话，混进去会把审批发给同事。

## 回复

```ts
ctx.events.reply(e, "收到，晚点我看下");   // 以你本人的身份回私聊或对应话题
```

等价于发一个 `feishu-me.send` 事件：`{ kind: "feishu-me.send", data: { chat_id, reply_to?, reply_in_thread?, text } }`，插件调 `lark-cli im +messages-send / +messages-reply --as user` 发出去。

只想点个表情（飞书表情编码如 `OK` / `THUMBSUP` / `DONE`）：

```ts
ctx.events.reply(e, "收到", { react: "OK", message_id: e.data.message_id });
```

## 安全

- 这是你本人的授权：插件和订阅它的面板能以你的名义读写飞书消息。强烈建议在 Superagent 面板里保持「回话先给我过目」，不要让外部消息直接自动回复或触发写操作。
- 消息内容来自别人，交给 agent 时等于**不可信的指令**。
