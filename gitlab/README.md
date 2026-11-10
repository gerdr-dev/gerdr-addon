# GitLab MR

报告**有人在等的** MR 现在的状态：开着还是合并了、流水线、别人留了几条意见、有没有冲突、要不要变基、能不能合。
会话用 `gerdr wait`、面板用带 `until` 的 trigger，等这个状态满足自己写的条件，满足了就被叫醒。
判断的是当时的状态，所以晚一点才开始等也不会错过：已经满足的，一等就当场叫醒。
没人在等，它就什么都不查。

## 准备

- 装 [glab](https://gitlab.com/gitlab-org/cli)，并登录要用的每个 GitLab：`glab auth login --hostname gitlab.example.com`。
  插件用的就是 glab 的登录，自己不存 token；几个 GitLab 都可以。
- Node 18+。

## 用法

在任何会话里提完 MR 以后：

```bash
gerdr wait gitlab 'gitlab.example.com/group/repo!34' \
  --until "state != 'opened' || pipeline == 'failed' || reviews > 0 || need_rebase" \
  --note "处理意见和流水线；合并后清理"
```

key 照 MR 的网址写（`https://gitlab.example.com/group/repo/-/merge_requests/34` → `gitlab.example.com/group/repo!34`）。
条件满足时会话收到一条消息，里面有 MR 现在的各个字段、最近的意见、流水线挂了时失败 job 的日志末尾，这次等待也随之结束。
要接着等，照消息里现在的值写下一个条件再等一次，比如 `reviews > 3`（现在 3 条）。

条件是一个 JS 表达式，每个字段都是变量，字符串要加引号。评论列表可以过滤，比如「别人留的、还没解决的」：
`notes.some(n => n.author != me && n.resolvable && !n.resolved)`。

回显会说插件接没接这个 key、现在的状态、条件成不成立。`gerdr wait list` 看自己在等的，`gerdr wait sources` 看所有字段。

面板写一个 trigger 文件：`{"source":"gitlab","key":"…","until":"…","fn":"…"}`。

## 字段

| 字段 | 意思 |
|---|---|
| `state` | opened / merged / closed / locked |
| `draft` | 是不是 draft |
| `pipeline` / `pipeline_id` | head 流水线的状态（none / running / success / failed …）和 id |
| `reviews` | 别人留的评论条数 |
| `unresolved` | 没解决的讨论个数 |
| `last_note` | 别人最新一条评论的 id |
| `conflict` / `need_rebase` / `mergeable` | 有冲突 / 要先变基 / GitLab 说现在可以合 |
| `approvals` | 批准的人数 |
| `head` / `target` | head 提交的 sha / 目标分支 |
| `me` | glab 登录的是谁 |
| `notes` | 最新 100 条评论，每条 `{id, author, body, resolvable, resolved, path, line, created}` |

Gerdr 每分钟问它一次每个有人在等的 MR（`addon.json` 的 `poll`），刚开始等的会马上问一次。插件只回答「这个 MR 现在什么样」，不记任何东西。
