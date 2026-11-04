# MiMo 朗读

用小米 [MiMo](https://platform.xiaomimimo.com) 的语音合成朗读消息。装上以后每条消息旁边多一个喇叭：你发的话在气泡左边，agent 的回复在那一轮末尾的时间那行。点一下开始读，再点一下停。

- 长回复按句子切成几段，一段一段合成：第一句合成好就开始读，读的时候下一段已经在合成了。
- 读的是去掉 Markdown 的文字：代码块读成「（代码）」，链接只读文字。

## 设置

- **API Key**：在 platform.xiaomimimo.com 申请。
- **音色**：mimo_default、default_zh、default_en、Mia、Chloe、Milo、Dean。
- **朗读风格**：可选，一句话描述语气（「语速稍快，平静自然」），作为风格提示发给模型。
- **模型** / **接口地址**：默认 `mimo-v2.5-tts`、`https://api.xiaomimimo.com/v1`；走中转时改地址。

要求 Gerdr 支持 `g.messageAction` 和 `g.audio`。
