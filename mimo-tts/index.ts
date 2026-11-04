/// <reference path="../gerdr.d.ts" />
// Read messages aloud with Xiaomi MiMo's TTS: a button on each message (g.messageAction) whose run plays what MiMo
// synthesizes through Gerdr's player (g.audio). MiMo speaks through its chat-completions API: the text to say is
// an assistant message, an optional user message sets the style, and the audio comes back base64 in
// choices[0].message.audio.data. That answer is JSON, so plain g.fetch carries it (no binary: true needed).
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

export default defineAddon({
  setup(g) {
    const zh = g.locale() === "zh";
    const say = async (text: string): Promise<Blob> => {
      const key = g.settings.get<string>("apiKey")?.trim();
      if (!key) throw new Error(zh ? "先在 设置 → 扩展 → MiMo 朗读 里填 API Key" : "Set the API key in Settings → Add-ons → MiMo Read Aloud");
      const style = g.settings.get<string>("style")?.trim();
      const base = (g.settings.get<string>("baseURL") || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
      const r = await g.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "api-key": key, Authorization: `Bearer ${key}` },
        body: {
          model: g.settings.get<string>("model") || "mimo-v2.5-tts",
          messages: [...(style ? [{ role: "user", content: style }] : []), { role: "assistant", content: text }],
          audio: { format: "wav", voice: g.settings.get<string>("voice") || "mimo_default" },
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

    // One piece after another; stopping (ctx.signal) ends the generator through g.audio
    async function* speech(text: string, signal: AbortSignal) {
      for (const p of pieces(text)) {
        if (signal.aborted) return;
        yield await say(p);
      }
    }

    return g.messageAction({
      id: "read",
      title: zh ? "朗读" : "Read aloud",
      icon: "Volume2",
      run: (msg, ctx) => g.audio.play(speech(msg.text, ctx.signal), { signal: ctx.signal }),
    });
  },
});
