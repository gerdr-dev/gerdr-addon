# Meegle（飞书项目）

把 Meegle 上和你有关的新动静变成 Gerdr 事件，交给订阅的人处理（比如 Superagent 面板的收件箱：秘书看了决定派给哪个任务）。

| 事件 | 什么时候发 |
|---|---|
| `meegle/todo` | 新到你手里的待办：指派给你的缺陷、轮到你的需求节点 / 子任务。离开过又回来的（缺陷被重新打开、节点被打回）也算 |
| `meegle/comment` | 你的待办工作项下**别人**的新评论；工作项离开你的待办后 7 天内也还看着（比如 QA 在你刚修完的缺陷下回复） |
| `meegle/login` | meegle 命令行的登录过期了，要你在终端跑 `meegle auth login` |

- 事件的 `key` 是工作项（`myspace/12345678`），待办和它之后的评论是同一个 key，所以哪个任务接了第一条，后面的就都到那个任务。
- 评论和描述里的截图会下到本机，路径写进正文和 `data.files`，agent 能直接看。
- 回复（`meegle.comment`）以你本人的身份发成这个工作项下的评论。
- 第一次运行只记下现状，不会把积压的待办一次全发出来。

## 要求

装 meegle 命令行并登录（需要 Node 18+）：

```
npm i -g @lark-project/meegle
meegle auth login
```

插件只调 `meegle`，不存任何令牌。找不到 `meegle` 时，在设置里填它的绝对路径（`which meegle`）。

## 设置

- **多久查一次**：默认 5 分钟。每次查一次待办列表，再给每个看着的工作项查一次评论。
- **评论也收**：关掉就只发 `meegle/todo`。
- **meegle 路径**：空着会在 PATH、Homebrew 和 version-fox / nvm 装的 node 目录里找。

运行日志：`~/.gerdr/logs/addons/meegle.log`；状态（记下的待办、看过的评论）和下载的附件在插件的数据目录。
