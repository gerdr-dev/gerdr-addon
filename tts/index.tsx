/// <reference path="../gerdr.d.ts" />
// Read messages aloud with a cloud TTS: a button on each message (g.messageAction) whose run plays what the chosen
// provider synthesizes through Gerdr's player (g.audio). Two providers, picked in settings:
//
// - Xiaomi MiMo speaks through its chat-completions API: the text to say is an assistant message, an optional user
//   message sets the style, and the audio comes back base64 in choices[0].message.audio.data. That answer is JSON, so
//   plain g.fetch carries it.
// - Azure Speech takes SSML and answers with the audio bytes themselves, so its request needs binary: true (or the
//   bytes get mangled into text).
//
// A long reply is cut into pieces and yielded one by one: g.audio plays a piece while asking for the next, so reading
// starts after the first sentence is synthesized rather than the whole reply, and no request nears g.fetch's 30s.

/** The first piece is short so the first sound comes fast; later ones are longer (fewer requests, steadier tone). */
const FIRST = 80;
const MAX = 300;

/** Cut text into pieces of whole sentences, each at most `max` characters (a longer sentence is cut at a comma / space). */
function pieces(text: string): string[] {
  const sentences = text
    .split(/(?<=[。！？!?；;…\n]|[.](?=\s))/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const limit = () => (out.length ? MAX : FIRST);
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (let s of sentences) {
    while (s.length > limit()) {
      flush();
      const at = Math.max(s.lastIndexOf("，", limit()), s.lastIndexOf(",", limit()), s.lastIndexOf(" ", limit()));
      const cut = at > limit() / 3 ? at + 1 : limit();
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (cur && cur.length + s.length + 1 > limit()) flush();
    cur = cur ? `${cur}${/[　-鿿]$/.test(cur) ? "" : " "}${s}` : s;
  }
  flush();
  return out;
}

function decode(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Each provider's own settings (addon.json keys), in the order the settings form shows them. */
const FIELDS: Record<string, string[]> = {
  mimo: ["apiKey", "voice", "style", "model", "baseURL"],
  azure: ["azureKey", "azureRegion", "azureVoice", "azureRate"],
};

/** Text goes inside SSML, so the five XML specials must be escaped or Azure rejects the request (400). */
const xml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export default defineAddon({
  setup(g) {
    const zh = g.locale() === "zh";
    const where = zh ? "设置 → 扩展 → TTS 朗读" : "Settings → Add-ons → TTS Read Aloud";

    const mimo = async (text: string): Promise<Blob> => {
      const key = g.settings.get<string>("apiKey")?.trim();
      if (!key) throw new Error(zh ? `先在 ${where} 里填 MiMo 的 API Key` : `Set the MiMo API key in ${where}`);
      const style = g.settings.get<string>("style")?.trim();
      const base = (g.settings.get<string>("baseURL") || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
      const r = await g.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "api-key": key, Authorization: `Bearer ${key}` },
        body: {
          model: g.settings.get<string>("model") || "mimo-v2.5-tts",
          messages: [...(style ? [{ role: "user", content: style }] : []), { role: "assistant", content: text }],
          audio: { format: "wav", voice: g.settings.get<string>("voice") || "茉莉" },
        },
      });
      let data: any;
      try {
        data = r.json();
      } catch {
        throw new Error(`MiMo ${r.status}: ${r.text.slice(0, 200)}`);
      }
      if (!r.ok) throw new Error(`MiMo ${r.status}: ${data?.error?.message ?? r.text.slice(0, 200)}`);
      const audio = data?.choices?.[0]?.message?.audio?.data;
      if (!audio) throw new Error(zh ? "MiMo 没有返回音频" : "MiMo returned no audio");
      return decode(audio, "audio/wav");
    };

    const azure = async (text: string): Promise<Blob> => {
      const key = g.settings.get<string>("azureKey")?.trim();
      const region = g.settings.get<string>("azureRegion")?.trim();
      if (!key || !region)
        throw new Error(zh ? `先在 ${where} 里填 Azure 的 Key 和区域` : `Set the Azure key and region in ${where}`);
      const voice = g.settings.get<string>("azureVoice")?.trim() || "zh-CN-XiaoxiaoMultilingualNeural";
      const rate = g.settings.get<number>("azureRate") ?? 0;
      // A voice name starts with its locale (zh-CN-…); xml:lang must be some locale, and the voice's own is the safe one
      const lang = voice.split("-").slice(0, 2).join("-");
      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(lang)}">` +
        `<voice name="${xml(voice)}"><prosody rate="${rate >= 0 ? "+" : ""}${rate}%">${xml(text)}</prosody></voice></speak>`;
      const r = await g.fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
          "User-Agent": "gerdr-tts",
        },
        body: ssml,
        binary: true,
      });
      if (!r.ok) {
        // binary: an error body comes as bytes too; Azure often sends none and the status alone says why (401 key, 400 SSML)
        const why = new TextDecoder().decode(r.bytes()).slice(0, 200);
        throw new Error(`Azure ${r.status}${why ? `: ${why}` : ""}`);
      }
      return new Blob([r.bytes() as Uint8Array<ArrayBuffer>], { type: "audio/mpeg" });
    };

    // Read the provider at each piece, so switching it in settings applies to the next read without a reload
    const say = (text: string) => (g.settings.get<string>("provider") === "azure" ? azure(text) : mimo(text));

    // One piece after another; stopping (ctx.signal) ends the generator through g.audio
    async function* speech(text: string, signal: AbortSignal) {
      for (const p of pieces(text)) {
        if (signal.aborted) return;
        yield await say(p);
      }
    }

    // Settings → 试听: one sentence with the values just set, so a wrong key / voice shows up right there
    const sample = zh
      ? "你好，点消息旁边的喇叭，我就把它读给你听。"
      : "Hi, tap the speaker beside a message and I'll read it to you.";
    const offPreview = g.settings.onAction("preview", ({ signal }) => g.audio.play(speech(sample, signal), { signal }));

    const offRead = g.messageAction({
      id: "read",
      title: zh ? "朗读" : "Read aloud",
      icon: "Volume2",
      run: (msg, ctx) => g.audio.play(speech(msg.text, ctx.signal), { signal: ctx.signal }),
    });
    // Settings: the provider, then only its own fields (each provider has its own key and options), then 试听.
    // Every field is still declared in addon.json; this only picks which show
    const offSettings = g.slot("settings", ({ Field, values }) => (
      <div className="space-y-2.5">
        <Field name="provider" />
        <div className="space-y-2.5 border-l-2 border-border pl-2.5">
          {(FIELDS[values.provider as string] ?? FIELDS.mimo).map((k) => (
            <Field key={k} name={k} />
          ))}
        </div>
        <Field name="preview" />
      </div>
    ));

    return () => {
      offPreview();
      offRead();
      offSettings();
    };
  },
});
