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
// A long reply is read paragraph by paragraph: each paragraph (a line of msg.text: a paragraph, a list item, a
// heading) is synthesized on its own and marked on screen while it plays (ctx.highlight, g.audio's onClip). Paragraphs
// are never merged, so the mark is exactly the one being read. No gap between pieces takes two things (measured with
// MiMo: it synthesizes ~18 characters a second plus ~1s per request, and reads ~6.5 a second):
// - synthesis runs on by itself, the next piece as soon as the last is done, rather than when g.audio asks for it (it
//   asks once a piece starts playing: a 224-character piece then took 12.5s to come while the 49-character one before
//   it played for 7.7s, a 5s silence). Stopping starts nothing more; the one being synthesized is wasted;
// - a paragraph longer than the piece's limit is cut at sentences, and the limits grow step by step (LIMITS), so the
//   first sound comes fast and each piece is synthesized while the one before plays. Every piece stays under g.fetch's
//   30s.

/** Each piece's limit in characters: the first short so the first sound comes fast, then doubling to the last. */
const LIMITS = [60, 120, 240, 300];
/**
 * A heading goes with the paragraph after it: a line shorter than SHORT with no stop at its end (a heading, a label),
 * or any line shorter than TINY. Alone it costs a request (~1s, plus ~0.2s of silence at each end of its clip) for a
 * word or two, and a heading read on its own sounds odd. The two are marked together: they sit next to each other on
 * screen. A short sentence that ends with a stop stays its own piece, so a mark never runs across a section.
 */
const SHORT = 20;
const TINY = 6;
const STOP = /[。！？!?；;…:：.,，]$/;
const leadsOn = (line: string) => line.length < TINY || (line.length < SHORT && !STOP.test(line));

/**
 * A piece to synthesize, and the paragraph it belongs to (what is marked while it plays; n: its index; last: the
 * paragraph's last line in the text, counting non-empty lines).
 */
type Piece = { say: string; para: string; n: number; last: number };

/**
 * Paragraph by paragraph; a paragraph longer than the current limit cut into whole sentences (a longer sentence at a
 * comma / space).
 */
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  const limit = () => LIMITS[Math.min(out.length, LIMITS.length - 1)];
  const paras: { para: string; last: number }[] = [];
  let carry = "";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  lines.forEach((line, i) => {
    const para = carry ? `${carry}\n${line}` : line;
    carry = leadsOn(line) ? para : "";
    if (!carry) paras.push({ para, last: i });
  });
  if (carry) paras.push({ para: carry, last: lines.length - 1 });
  for (const [n, { para, last }] of paras.entries()) {
    // A line ending without a stop (a heading run into the paragraph after it) gets one, so it is said as its own sentence
    const said = para
      .split("\n")
      .map((l) => (STOP.test(l) ? l : `${l}。`))
      .join("\n");
    const sentences = said.split(/(?<=[。！？!?；;…\n]|[.](?=\s))/).map((s) => s.trim()).filter(Boolean);
    let cur = "";
    const flush = () => {
      if (cur) out.push({ say: cur, para, n, last });
      cur = "";
    };
    for (let s of sentences) {
      while (s.length > limit()) {
        flush();
        const at = Math.max(s.lastIndexOf("，", limit()), s.lastIndexOf(",", limit()), s.lastIndexOf(" ", limit()));
        const cut = at > limit() / 3 ? at + 1 : limit();
        out.push({ say: s.slice(0, cut).trim(), para, n, last });
        s = s.slice(cut).trim();
      }
      if (cur && cur.length + s.length + 1 > limit()) flush();
      cur = cur ? `${cur}${/[　-鿿]$/.test(cur) ? "" : " "}${s}` : s;
    }
    flush();
  }
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

    // Synthesis runs one piece after another, up to AHEAD pieces past the one playing, without waiting for g.audio to
    // ask; stopping (ctx.signal) ends the generator through g.audio and starts nothing more
    /**
     * Read `text` aloud. With a message action's ctx, each paragraph is marked on screen as it starts, and a click on
     * one jumps the reading there: what plays stops, and it goes on from that paragraph. Pieces already synthesized
     * are kept for the run, so jumping back costs no request.
     */
    const read = async (
      text: string,
      signal: AbortSignal,
      ctx?: { highlight?(t: string | null): void; onPick?(s: string[] | null, pick: (i: number) => void): void },
      startLine = 0,
    ) => {
      const ps = pieces(text);
      // By piece index: synthesized in this run, or on the way in the chain of `stop`. A jump cancels its chain, and a
      // piece of that chain still queued then fails with the cancel when its turn comes: only a piece already
      // synthesized, or one of a chain still going, is reused, else the next chain would play that failure
      const done = new Map<number, { job: Promise<Blob>; stop: AbortSignal; ok?: boolean }>();

      // From piece `start` on, one after another, each as soon as the one before is done (not when g.audio asks: it
      // asks once a piece starts playing, too late for a long one). A failure is seen when its piece's turn comes, not
      // as an unhandled rejection; once `stop` aborts, nothing more starts.
      async function* speech(start: number, stop: AbortSignal) {
        const jobs: Promise<Blob>[] = [];
        for (let i = start; i < ps.length; i++) {
          const before = jobs.length ? jobs[jobs.length - 1].catch(() => {}) : Promise.resolve();
          const had = done.get(i);
          if (had && (had.ok || !had.stop.aborted)) {
            jobs.push(had.job);
            continue;
          }
          const job = before.then(() => (stop.aborted ? Promise.reject(stop.reason) : say(ps[i].say)));
          const entry: { job: Promise<Blob>; stop: AbortSignal; ok?: boolean } = { job, stop };
          done.set(i, entry);
          job.then(
            () => (entry.ok = true),
            () => done.get(i) === entry && done.delete(i), // a failed piece is asked again next time
          );
          jobs.push(job);
        }
        for (const job of jobs) {
          if (stop.aborted) return;
          yield await job;
        }
      }

      // Reading starts at the paragraph holding line `startLine` (the reply's last part); every paragraph takes clicks
      let from = Math.max(
        0,
        ps.findIndex((p) => p.last >= startLine),
      );
      let jumped = false;
      let cur = new AbortController();
      const paras = [...new Map(ps.map((p) => [p.n, p.para])).values()];
      ctx?.onPick?.(paras, (n) => {
        from = ps.findIndex((p) => p.n === n);
        jumped = true;
        cur.abort();
        g.audio.stop(); // ends the play below at once, rather than after the piece now sounding
      });
      for (;;) {
        cur = new AbortController();
        const stop = AbortSignal.any([signal, cur.signal]);
        const start = from;
        jumped = false;
        try {
          await g.audio.play(speech(start, stop), { signal, onClip: (i) => ctx?.highlight?.(ps[start + i]?.para ?? null) });
        } catch (e) {
          // A jump cancels the pieces on the way: what that throws is the jump, not a failure
          if (!jumped) throw e;
        }
        if (!jumped || signal.aborted) return;
      }
    };

    // Settings → 试听: one sentence with the values just set, so a wrong key / voice shows up right there
    const sample = zh
      ? "你好，点消息旁边的喇叭，我就把它读给你听。"
      : "Hi, tap the speaker beside a message and I'll read it to you.";
    const offPreview = g.settings.onAction("preview", ({ signal }) => read(sample, signal));

    const offRead = g.messageAction({
      id: "read",
      title: zh ? "朗读" : "Read aloud",
      icon: "Volume2",
      // A reply's last part by default: what it said along the way ("let me check…") is noise when listening.
      // msg.final is missing on a Gerdr older than it: read the whole then
      run: (msg, ctx) => {
        // The whole reply is laid out, so a click on what was said along the way jumps there too; with "final" reading
        // starts at the last part, which is the reply's last lines. msg.final / ctx.highlight / onPick are missing on a
        // Gerdr older than them: the whole reply, no mark, no jumping then
        const count = (t: string) => t.split("\n").filter((l) => l.trim()).length;
        const start = g.settings.get<string>("scope") !== "all" && msg.final ? count(msg.text) - count(msg.final.text) : 0;
        return read(msg.text, ctx.signal, ctx, start);
      },
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
        <Field name="scope" />
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
