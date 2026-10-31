# 复制 tab

`prefix+a` 把当前 tab 复制一份插到后面，`prefix+i` 插到前面（和 tmux 的 a / i 一样）。复制的是「工位」：同一个目录、同一种 agent，开一个新会话；对话本身复制不了。

![复制 tab](screenshot.png)

用到的扩展能力：`g.command` 加命令和快捷键、`g.actions.duplicateTab`。
