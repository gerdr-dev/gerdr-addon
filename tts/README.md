# TTS 朗读

用云端语音合成朗读消息，支持小米 [MiMo](https://platform.xiaomimimo.com) 和 [Azure 语音](https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech)。装上以后每条消息旁边多一个喇叭：你发的话在气泡左边，agent 的回复在那一轮末尾的时间那行。点一下开始读，再点一下停。

- 长回复按句子切成几段，一段一段合成：第一句合成好就开始读，读的时候下一段已经在合成了。
- 读的是去掉 Markdown 的文字：代码块读成「（代码）」，链接只读文字。

## 设置

先选**服务商**，下面就只显示它那几项。**试听**用当前的服务商和设置读一句，改完马上能听出对不对。

### 小米 MiMo

- **API Key**：在 platform.xiaomimimo.com 申请。
- **音色**：默认茉莉；还有冰糖、苏打、白桦、mimo_default、default_zh、default_en、Mia、Chloe、Milo、Dean。
- **朗读风格**：一句话描述语气，作为风格提示发给模型。默认「自然、亲切、利落，不要播音腔，语速中等偏快」。
- **模型** / **接口地址**：默认 `mimo-v2.5-tts`、`https://api.xiaomimimo.com/v1`；走中转时改地址。

### Azure 语音

- **Key** / **区域**：Azure 门户里语音（Speech）资源的「密钥和终结点」页。区域默认 `eastasia`。
- **音色**：语音名，默认 `zh-CN-XiaoxiaoMultilingualNeural`（多语种，中英混读都自然）；其它的见 Azure 的 Voice Gallery。
- **语速**：相对正常快多少（%），默认 10。

要求 Gerdr 支持 `g.messageAction`、`g.audio` 和 `"settings"` slot（设置里只显示所选服务商的那几项；老版本 Gerdr 会把所有设置项平铺出来）。
