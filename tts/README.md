# TTS 朗读

用云端语音合成朗读消息，支持小米 [MiMo](https://platform.xiaomimimo.com) 和 [Azure 语音](https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech)。装上以后每条消息旁边多一个喇叭：你发的话在气泡左边，agent 的回复在那一轮末尾的时间那行。点一下开始读，再点一下停。

- 一段一段地读，正在读的那段在消息里高亮；读的时候点某一段，就从那段接着读。每段单独合成，前一段合成完马上合成下一段，段与段之间不停顿；太长的段按句子切开，开头那块短，第一句很快就出声。
- agent 的回复默认只读最后一段（干完活的总结），过程中说的话跳过；设置里「读哪些」可以改成整条回复。
- 读的是去掉 Markdown 的文字：代码块读成「（代码）」，链接只读文字。

## 设置

先选**服务商**，下面就只显示它那几项。**试听**用当前的服务商和设置读一句，改完马上能听出对不对。

### 小米 MiMo

- **API Key**：在 platform.xiaomimimo.com 申请。
- **音色**：默认茉莉；还有冰糖、苏打、白桦、mimo_default、default_zh、default_en、Mia、Chloe、Milo、Dean。
- **朗读风格**：一句话描述语气，作为风格提示发给模型。默认「自然、亲切、利落，不要播音腔，语速中等偏快，句与句之间停顿短一点」。
- **模型** / **接口地址**：默认 `mimo-v2.5-tts`、`https://api.xiaomimimo.com/v1`；走中转时改地址。

### Azure 语音

- **Key** / **区域**：Azure 门户里语音（Speech）资源的「密钥和终结点」页。区域默认 `eastasia`。
- **音色**：语音名，默认 `zh-CN-XiaoxiaoMultilingualNeural`（多语种，中英混读都自然）；其它的见 Azure 的 Voice Gallery。
- **语速**：相对正常快多少（%），默认 10。

要求 Gerdr 支持 `g.messageAction`、`g.audio` 和 `"settings"` slot（设置里只显示所选服务商的那几项；老版本 Gerdr 会把所有设置项平铺出来）。
