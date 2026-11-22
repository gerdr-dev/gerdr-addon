/// <reference path="../gerdr.d.ts" />
// Voice: talk to an agent instead of typing, and hear what it did instead of reading. Two halves, each with its
// own switch in settings (enableInput / enableOutput), so someone who only listens never sees a mic.
//
// Input: hold the mic (pinned after the attach button) to talk. The mic's PCM goes to Doubao's streaming
// recognizer (through g.socket) and the words go into the composer as they're said; each sentence, once settled, can
// be fixed up by a configured model that reads the conversation (g.llm) and replaced in place, so what's on screen is
// what gets sent (letting go leaves it in the composer and swiping right sends it, or the other way round with
// "send on release" on: a per-device switch, since on a phone sending is the point and on a computer it isn't). Azure recognition was here too and was dropped: its streaming text was rough
// enough to need a second pass on release, which replaced what you saw — Doubao re-checks each sentence itself.
// Or recognition through an OpenAI-compatible /audio/transcriptions (SiliconFlow, OpenAI, a local whisper…): it takes
// whole files, so the recording is cut at each pause and each piece sent as it ends (oaLive).
//
// Output: the speaker beside each message (g.messageAction) reads it, paragraph by paragraph, marking and jumping;
// 🔊 by the composer reads the conversation's latest reply now (tap) or turns auto read on (hold, per device): each finished
// reply's last stretch, queued when several agents finish, each turn once, one waiting on you first. The page sleeps
// with the App in the background, so listening works with Gerdr on screen.

const zh = { v: true };
const T = (cn: string, en: string) => (zh.v ? cn : en);

// ---------- a tiny store the buttons and the bar re-render from ----------

// announce: say whose reply it is first (auto read: replies of any conversation; not when you asked for this one)
type Item = { key: string; session: string; title: string; text: string; kind: "reply" | "waiting"; announce?: boolean };
type State = {
  auto: boolean; // auto read: each finished reply is read aloud (this device)
  recording: string | null; // the session being recorded for (the focused one when the press began)
  since: number; // when recording started (ms)
  busy: string | null; // released: waiting for the last sentence (and its fix-up)
  live: { done: string; hyp: string }; // what streaming recognition heard so far: settled phrases, the one in progress
  // where the finger slid: up = releasing drops the recording, right = releasing does the other of send / edit;
  // neither = releasing does what sendOnRelease says
  swipe: "" | "cancel" | "right";
  // letting go sends (swipe right: into the composer to edit) instead of the other way round. Per device (g.storage),
  // off by default: a phone wants it, a computer usually doesn't
  sendOnRelease: boolean;
  // released and being finished: whether it will be sent (the bubble says so)
  sending: boolean;
  // where the press is: "spot" (the middle of the field, under the finger: the field makes room) or the bar's mic
  from: "spot" | "mic";
  // what holds it: a finger / the mouse on the mic, or a key held on a computer's keyboard (letting go of that one
  // leaves the words in the composer instead of sending them; Esc cancels)
  via: "touch" | "key";
  // the composer box being talked into (its window position), so the bubble sits right above it; null = centered
  anchorEl: HTMLElement | null;
  // a short word about the last recording, shown in the bubble for a moment ("didn't catch that", an error)
  note: { text: string; bad: boolean } | null;
  queue: Item[];
  playing: Item | null;
  last: Item | null;
  // auto read came back on with the page (a reload) and no tap has unlocked sound yet: the WebView would refuse it
  needTap: boolean;
  // conversations whose 🔊 was tapped while the agent was still answering: their reply is read when the turn ends
  armed: string[];
};
let st: State = { auto: false, recording: null, since: 0, busy: null, live: { done: "", hyp: "" }, swipe: "", sendOnRelease: false, sending: false, from: "mic", via: "touch", anchorEl: null, note: null, queue: [], playing: null, last: null, needTap: false, armed: [] };
const subs = new Set<() => void>();
const put = (p: Partial<State>) => {
  st = { ...st, ...p };
  subs.forEach((f) => f());
};

// ---------- text for speech ----------

/** Each piece's limit in characters: the first short so the first sound comes fast, then doubling to the last. */
const LIMITS = [60, 120, 240, 300];
/** Speech requests in flight at once while reading (see `speech` in `read`). */
const PARALLEL = 3;
/**
 * A heading goes with the paragraph after it: a line shorter than SHORT with no stop at its end (a heading, a label),
 * or any line shorter than TINY. Alone it costs a request (~1s, plus ~0.2s of silence at each end of its clip) for a
 * word or two, and a heading read on its own sounds odd. The two are marked together: they sit next to each other on
 * screen. A short sentence that ends with a stop stays its own piece, so a mark never runs across a section.
 */
const SHORT = 20;
const TINY = 6;
const SENT_END = /[。！？!?；;…:：.,，]$/;
const leadsOn = (line: string) => line.length < TINY || (line.length < SHORT && !SENT_END.test(line));

/**
 * A piece to synthesize, and the paragraph it belongs to (what is marked while it plays; n: its index; last: the
 * paragraph's last line in the text, counting non-empty lines).
 */
type Piece = { say: string; para: string; n: number; last: number };

/**
 * Paragraph by paragraph; a paragraph longer than the current limit cut into whole sentences (a longer sentence at a
 * comma / space).
 */
function paraPieces(text: string): Piece[] {
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
      .map((l) => (SENT_END.test(l) ? l : `${l}。`))
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

/** Text goes inside SSML, so the five XML specials must be escaped or Azure rejects the request (400). */
const xml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);


/** Markdown → something to say: code and tables are on screen, not read; links read as their text. */
export function forSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, T("（代码见屏幕）", "(code on screen)"))
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, T("（链接）", "(link)"))
    .replace(/`([^`]+)`/g, (_, c: string) => (/[/\\]/.test(c) && c.length > 20 ? c.split(/[/\\]/).pop()! : c))
    .replace(/(?:^|\s)(?:~|\.{0,2})?\/(?:[\w.@-]+\/)+([\w.@-]+)/g, " $1") // a long path: its last part
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ---------- hints ----------

const STOP = new Set(
  "the and for you are not but with this that from have was were will would can could should into then than when what which where who how why yes all any its our out use get got let set new old one two may might must also just only some more most very".split(
    " ",
  ),
);

/** English words and identifiers in text, newest kept when there are too many (a long phrase list costs accuracy). */
function terms(texts: string[], max = 80): string[] {
  const seen = new Map<string, string>();
  for (const t of texts) {
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g)) {
      const w = m[0];
      if (w.length < 3 || STOP.has(w.toLowerCase()) || w.length > 40) continue;
      seen.delete(w.toLowerCase());
      seen.set(w.toLowerCase(), w);
    }
  }
  return [...seen.values()].slice(-max);
}

// ---------- audio bits ----------

/** A short two-note chime (WebAudio, so it doesn't take g.audio's one player from a reply). */
let ac: AudioContext | null = null;
function chime() {
  if (!ac) return;
  const t0 = ac.currentTime;
  for (const [i, f] of [880, 1320].entries()) {
    const o = ac.createOscillator();
    const v = ac.createGain();
    o.frequency.value = f;
    v.gain.setValueAtTime(0.0001, t0 + i * 0.12);
    v.gain.exponentialRampToValueAtTime(0.15, t0 + i * 0.12 + 0.02);
    v.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.25);
    o.connect(v).connect(ac.destination);
    o.start(t0 + i * 0.12);
    o.stop(t0 + i * 0.12 + 0.3);
  }
}

/** 16 kHz mono 16-bit PCM as a WAV file: what every /audio/transcriptions takes. */
function wav(pcm: Int16Array) {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true); // the fmt chunk's size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 16000, true); // samples per second
  v.setUint32(28, 32000, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per sample
  v.setUint16(34, 16, true); // bits per sample
  tag(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return out;
}

/** A chunk's loudness in dBFS (RMS): about -120 for silence, 0 at full scale. */
function dbfs(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return 20 * Math.log10(Math.sqrt(sum / Math.max(1, pcm.length)) / 32768 || 1e-6);
}

/** Two pieces of recognized text, in order: a space between Latin words, none between Chinese sentences. */
const glue = (a: string, b: string) => (a && b && /[A-Za-z0-9,.;:!?)]$/.test(a) && /^[A-Za-z0-9(]/.test(b) ? `${a} ${b}` : a + b);

export default defineAddon({
  setup(g) {
    zh.v = g.locale() === "zh";
    const where = T("设置 → 扩展 → 语音", "Settings → Add-ons → Voice");
    const fail = (e: unknown) => g.notify(e instanceof Error ? e.message : String(e), { level: "error" });
    // What happens to a recording is said in its bubble, where you're looking, not as a toast at the window's top
    let noteTimer: ReturnType<typeof setTimeout> | undefined;
    const note = (text: string, bad = false) => {
      clearTimeout(noteTimer);
      put({ note: { text, bad } });
      noteTimer = setTimeout(() => put({ note: null }), bad ? 4000 : 2500);
    };
    const noteFail = (e: unknown) => note(e instanceof Error ? e.message : String(e), true);
    const titleOf = (sid: string) => g.state().sessions.find((s) => s.id === sid)?.title || T("一个会话", "a conversation");

    const isZh = zh.v;
    const inputOn = () => g.settings.get<boolean>("enableInput") !== false;
    const outputOn = () => g.settings.get<boolean>("enableOutput") !== false;
    put({ auto: !!g.storage.get<boolean>("auto"), sendOnRelease: !!g.storage.get<boolean>("sendOnRelease") });

    // Sound needs a tap to start it (Android's WebView: for each element it hasn't played). Turning auto read on is
    // one; after a reload it comes back on without one, so the first touch anywhere unlocks, and until then replies
    // wait in the queue instead of failing.
    let unlocked = false;
    const unlock = () => {
      g.audio.unlock();
      ac ??= new AudioContext();
      ac.resume().catch(() => {});
      unlocked = true;
      if (st.needTap) put({ needTap: false });
    };
    const onTouch = () => {
      if (!unlocked) unlock();
      if (st.auto) setTimeout(pump, 0);
    };
    document.addEventListener("pointerdown", onTouch, true);

    // ---------- transcription ----------

    /** The words of this conversation, as hints. */
    async function hintsFor(sid: string, typed: string): Promise<string[]> {
      const s = g.state().sessions.find((x) => x.id === sid);
      const texts = [s?.title ?? "", s?.cwd?.split("/").pop() ?? "", typed];
      try {
        texts.unshift((await g.sessions.reply(sid)).text);
      } catch {
        // an older Gerdr, or no reply yet
      }
      return terms(texts);
    }

    // ---------- OpenAI-compatible speech: SiliconFlow, OpenAI, and any service with the same API ----------
    // /audio/transcriptions (multipart: file + model) and /audio/speech (JSON: model, input, voice) are the shape most
    // vendors and local servers speak. A preset fills in the address and models, so picking SiliconFlow and pasting the
    // key is enough; each can be overridden (a proxy, SiliconFlow's international site, another model).
    type Preset = { name: string; base: string; asr: string; tts: string; voice: string; prompt: boolean };
    const PRESETS: Record<string, Preset> = {
      // SenseVoice documents only file + model: no prompt is sent there
      siliconflow: { name: T("硅基流动", "SiliconFlow"), base: "https://api.siliconflow.cn/v1", asr: "FunAudioLLM/SenseVoiceSmall", tts: "FunAudioLLM/CosyVoice2-0.5B", voice: "anna", prompt: false },
      openai: { name: "OpenAI", base: "https://api.openai.com/v1", asr: "gpt-4o-mini-transcribe", tts: "gpt-4o-mini-tts", voice: "coral", prompt: true },
      // The names most compatible servers know (Groq, a local whisper / Kokoro server…); prompt is part of the API
      custom: { name: T("语音服务", "Speech service"), base: "", asr: "whisper-1", tts: "tts-1", voice: "alloy", prompt: true },
    };
    const asrOa = () => g.settings.get<string>("asrProvider") === "openai";
    /** The picked preset with what's set over it; throws, saying what to fill in, when it can't be used yet. */
    const oaConf = () => {
      const id = g.settings.get<string>("oaPreset") || "siliconflow";
      const p = PRESETS[id] ?? PRESETS.siliconflow;
      const base = (g.settings.get<string>("oaBaseURL")?.trim() || p.base).replace(/\/+$/, "");
      const key = g.settings.get<string>("oaKey")?.trim() ?? "";
      if (!base) throw new Error(T(`先在 ${where} 里填语音服务的接口地址`, `Set the speech service's address in ${where}`));
      // A local server may want no key; a vendor always does
      if (!key && id !== "custom") throw new Error(T(`先在 ${where} 里填${p.name}的 API Key`, `Set the ${p.name} API key in ${where}`));
      return {
        ...p,
        id,
        base,
        auth: (key ? { Authorization: `Bearer ${key}` } : {}) as Record<string, string>,
        asr: g.settings.get<string>("oaAsrModel")?.trim() || p.asr,
        tts: g.settings.get<string>("oaTtsModel")?.trim() || p.tts,
      };
    };
    /** An error answer's message: {error: {message}}, {message}, or the text itself. */
    const why = (text: string) => {
      try {
        const o = JSON.parse(text);
        return String(o?.error?.message ?? o?.message ?? o?.error ?? text).slice(0, 200);
      } catch {
        return text.slice(0, 200);
      }
    };

    // ---------- recording ----------
    // Hold the mic to talk, let go to send (slide up to cancel, right to edit it in the composer first). While held, the mic's PCM goes to
    // streaming recognition through g.socket, so the words go into the composer as they're said.

    /** A streaming recognizer: takes the PCM as it's recorded, reports what it heard through setLive. */
    type Live = { push(pcm: Int16Array): void; end(): void; close(): void };
    type Rec = {
      stream: MediaStream;
      ctx: AudioContext;
      node: ScriptProcessorNode;
      level: AnalyserNode; // the mic's loudness, read by the bubble's waveform
      samples: number; // how much was recorded (16 kHz)
      live: Live | null; // null until the recognizer's socket is set up
      buf: Int16Array[]; // recorded before that, handed over then
      ending: boolean; // released before the recognizer was ready: end it once it is
      ended: Promise<void>; // the recognizer gave its last words (or gave up)
      finish: () => void;
      cutoff: ReturnType<typeof setTimeout>;
    };
    let rec: Rec | null = null;
    // Why recognition failed in this recording, said again when it ends: a note shown while you talk is gone by the
    // time you let go, and "didn't catch that" hid a wrong key
    let asrErr = "";
    const asrFail = (e: unknown) => {
      asrErr ||= e instanceof Error ? e.message : String(e);
      note(asrErr, true);
    };
    /** The composer that gets the text: set when the mic is pressed (its composer's ctx). */
    let target: ComposerContext | null = null;
    // What the composer held before the caret when the press began: the words go in live after it, as said (like a
    // keyboard's voice input), and are replaced by the fixed-up text on release; cancelling puts it back. null: no
    // press going on. liveTail: what was after the caret (a selection is talked over), kept after the words
    let liveBase: string | null = null;
    let liveTail = "";
    // What we last wrote into the composer. The person may send (or edit) the live text before the fix-up comes
    // back: then the composer no longer holds it, and nothing more is written — late words or the fixed-up copy
    // would put back a message already sent
    let lastShown: string | null = null;
    const joinText = (base: string, t: string) => (base && t ? base + (/\s$/.test(base) ? "" : " ") + t : base + t);
    // The composer's text with t said at the caret, and where the caret goes (right after t)
    const around = (base: string, t: string) => {
      const head = joinText(base, t);
      const tail = t && liveTail && !/\s$/.test(head) && !/^\s/.test(liveTail) ? " " + liveTail : liveTail;
      return { text: head + tail, caret: head.length };
    };
    const touched = () => !!target && lastShown !== null && target.text !== lastShown;
    // hyp: the end of t the recognizer may still change. It goes in as the composer's pending stretch, drawn in grey
    // until the recognizer settles it (an older Gerdr ignores the third argument and draws it all alike). With the
    // finger on "cancel" all the words said are struck through instead: letting go now drops them
    let caretOff = 0; // caret traces this recording (showLive)
    const showLive = (t: string, hyp = "") => {
      if (!target || liveBase === null) return;
      if (touched()) {
        mark(`touched(${target.text.length}/${lastShown?.length})`);
        return void (liveBase = lastShown = null);
      }
      const o = around(liveBase, t);
      lastShown = o.text;
      const n = st.swipe === "cancel" ? t.length : t.endsWith(hyp) ? hyp.length : 0;
      target.setText(o.text, o.caret, n ? { start: o.caret - n, end: o.caret, look: st.swipe === "cancel" ? "cancel" : "pending" } : undefined);
      // Traced: the caret not where the words end a moment later (seen once on the Android App: the caret sat inside
      // the settled words, never reproduced). Only while the box still holds this text, so newer words don't count;
      // at most three per recording
      const tg = target;
      setTimeout(() => {
        const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]:focus");
        const at = tg.selection.start;
        if (ta?.value === o.text && at !== o.caret && caretOff++ < 3) mark(`caret(${at}/${o.caret}/${o.text.length} n=${n})`);
      }, 100);
    };
    const dropLive = () => {
      if (target && liveBase !== null && !touched()) target.setText(liveBase + liveTail, liveBase.length);
      liveBase = lastShown = null;
    };

    // Each sentence the recognizer settles is fixed up right away by the fix-up model (fixModel, optional), while you
    // go on talking, and the fixed copy replaces it in the composer: what you see while holding is what gets sent, not
    // a draft that changes after you let go (that made sending on release a blind send). Only the sentence still
    // being said is raw. The model reads the conversation and fixes homophones a recognizer can't tell apart
    // ("对不起" → "对不齐" while talking layout).
    type Seg = { raw: string; fixed: string | null; failed: boolean; job: Promise<void> };
    let segs: Seg[] = [];
    let segSession = "";
    const shown = (hyp: string) => segs.map((x) => x.fixed ?? x.raw).join("") + hyp;
    function addSeg(raw: string) {
      const model = g.settings.get<string>("fixModel")?.trim();
      const seg: Seg = { raw, fixed: null, failed: false, job: Promise.resolve() };
      const before = (liveBase ?? "") + shown("");
      segs.push(seg);
      if (!raw.trim() || !model) return;
      seg.job = fixText(raw, model, segSession, before)
        .then((t) => {
          if (!t || !segs.includes(seg)) return;
          seg.fixed = t;
          showLive(shown(st.live.hyp), st.live.hyp);
        })
        .catch((e) => {
          seg.failed = true;
          console.warn("voice: fix-up failed", e);
        });
    }
    /** What a recognizer heard so far: settled sentences, and the one still changing. */
    const setLive = (r: Rec, done: string, hyp: string) => {
      if (rec !== r && !st.busy) return;
      let have = segs.map((x) => x.raw).join("");
      if (!done.startsWith(have)) [segs, have] = [[], ""]; // the recognizer took settled words back
      if (done.length > have.length) addSeg(done.slice(have.length));
      put({ live: { done, hyp } });
      showLive(shown(hyp), hyp); // straight into the composer, as said: the settled words solid, the rest grey
    };

    /** A socket that queues what's sent before it opens. */
    function queued(sock: WebSocket, first: () => void) {
      const q: (string | Uint8Array)[] = [];
      sock.addEventListener("open", () => {
        first();
        for (const m of q) sock.send(m);
        q.length = 0;
      });
      return (m: string | Uint8Array) => (sock.readyState === WebSocket.OPEN ? sock.send(m) : q.push(m));
    }

    /**
     * Doubao (Volcengine) streaming recognition, model 2.0. Its binary protocol: a 4-byte header (version | header
     * size, message type | flags, serialization | compression, 0), a 4-byte big-endian size, the payload. One full
     * client request (JSON) opens, audio-only frames follow (raw 16 kHz PCM, ~200ms each), the last flagged 0b0010.
     * It takes the conversation itself as context (dialog_ctx), not only a word list, and re-checks each
     * finished sentence with its non-streaming model (enable_nonstream), so what it settles on is the better text.
     */
    async function doubaoLive(r: Rec, hints: string[], dialog: string[]): Promise<Live> {
      const appId = g.settings.get<string>("doubaoAppId")?.trim();
      const key = g.settings.get<string>("doubaoKey")?.trim();
      if (!key) throw new Error(T(`先在 ${where} 里填豆包的 Key`, `Set the Doubao key in ${where}`));
      const headers: Record<string, string> = {
        "X-Api-Resource-Id": "volc.seedasr.sauc.duration",
        "X-Api-Connect-Id": crypto.randomUUID(),
        "X-Api-Request-Id": crypto.randomUUID(),
      };
      // The new console gives one API key; the old one an App ID and an Access Token
      if (appId) Object.assign(headers, { "X-Api-App-Key": appId, "X-Api-Access-Key": key });
      else headers["X-Api-Key"] = key;
      const sock = await g.socket("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async", { headers });
      sock.binaryType = "arraybuffer";
      mark("sock");
      let got = 0;
      let mism = 0; // responses whose text didn't start with the settled sentences (one is traced)
      const frame = (type: number, flags: number, json: boolean, payload: Uint8Array) => {
        const out = new Uint8Array(8 + payload.length);
        out.set([0x11, (type << 4) | flags, json ? 0x10 : 0x00, 0]);
        new DataView(out.buffer).setUint32(4, payload.length);
        out.set(payload, 8);
        return out;
      };
      const context: Record<string, unknown> = {};
      if (hints.length) context.hotwords = hints.slice(0, 30).map((word) => ({ word }));
      if (dialog.length) Object.assign(context, { context_type: "dialog_ctx", context_data: dialog.map((text) => ({ text })) });
      const body = {
        user: { uid: "gerdr" },
        audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          enable_nonstream: true,
          result_type: "full",
          show_utterances: true,
          ...(Object.keys(context).length ? { corpus: { context: JSON.stringify(context) } } : {}),
        },
      };
      const send = queued(sock, () => sock.send(frame(1, 0, true, new TextEncoder().encode(JSON.stringify(body)))));
      // ~200ms per audio frame, as the API prefers: the mic's chunks are ~85ms
      let held: Int16Array[] = [];
      let heldLen = 0;
      const flush = (last: boolean) => {
        const all = new Int16Array(heldLen);
        let at = 0;
        for (const c of held) {
          all.set(c, at);
          at += c.length;
        }
        held = [];
        heldLen = 0;
        send(frame(2, last ? 2 : 0, false, new Uint8Array(all.buffer)));
      };
      sock.onmessage = async (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const v = new DataView(e.data);
        const type = v.getUint8(1) >> 4;
        const flags = v.getUint8(1) & 15;
        if (got++ === 0) mark("first");
        if (type === 0b1111) {
          const code = v.getUint32(4);
          const msg = new TextDecoder().decode(new Uint8Array(e.data, 12, v.getUint32(8)));
          mark(`err(${code} ${msg.slice(0, 80)})`);
          asrFail(`${T("豆包", "Doubao")} ${code}: ${msg}`);
          return r.finish();
        }
        if (type !== 0b1001) return;
        let at = 4;
        if (flags & 1) at += 4; // a sequence number
        const size = v.getUint32(at);
        let bytes = new Uint8Array(e.data, at + 4, size);
        if ((v.getUint8(2) & 15) === 1) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
        let res: any = {};
        try {
          res = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return;
        }
        // A response without a result (or with empty text once words are in) is not the recognizer taking them back:
        // in "full" mode every result holds everything heard. Taking it as one wiped the words from the composer
        if (!res?.result) return flags & 2 ? r.finish() : undefined;
        const text: string = res.result.text ?? "";
        if (!text && segs.length + st.live.hyp.length > 0) return flags & 2 ? r.finish() : undefined;
        const utts = (res?.result?.utterances ?? []) as any[];
        const settled = utts.filter((u) => u.definite).map((u) => u.text ?? "").join("");
        if (settled && text.startsWith(settled)) setLive(r, settled, text.slice(settled.length));
        else if (settled) {
          // The text doesn't start with the settled sentences as they read joined (a space between them, or the
          // second pass rewrote one): take the sentences as Doubao marks them. Taking it all as unsettled drew the
          // whole composer grey and dropped the fixed-up sentences (reported)
          if (!mism++) mark(`mismatch(${JSON.stringify(settled.slice(-12))}|${JSON.stringify(text.slice(settled.length - 12, settled.length + 4))})`);
          setLive(r, settled, utts.filter((u) => !u.definite).map((u) => u.text ?? "").join(""));
        } else setLive(r, "", text);
        if (flags & 2) {
          mark(`last(n=${got} len=${text.length})`);
          r.finish(); // the last response
        }
      };
      sock.onclose = (e) => {
        mark(`close(${e.code}${e.reason ? " " + e.reason.slice(0, 60) : ""} n=${got})`);
        r.finish();
      };
      sock.onerror = () => {
        mark("sockerr");
        r.finish();
      };
      return {
        push: (pcm) => {
          held.push(pcm);
          heldLen += pcm.length;
          if (heldLen >= 3200) flush(false);
        },
        end: () => flush(true),
        close: () => sock.close(),
      };
    }

    /** One piece of a recording to text, through /audio/transcriptions. */
    async function oaTranscribe(pcm: Int16Array, hints: string[]): Promise<string> {
      const c = oaConf();
      const form = new FormData();
      form.append("model", c.asr);
      // A prompt steers whisper-like models to these spellings, and for Chinese to simplified characters with punctuation
      if (c.prompt && hints.length) form.append("prompt", T("以下是普通话，会说到：", "Vocabulary: ") + hints.join(", "));
      form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "speech.wav");
      // The browser writes the multipart body and its boundary; g.fetch sends those bytes as they are
      const req = new Response(form);
      const r = await g.fetch(`${c.base}/audio/transcriptions`, {
        method: "POST",
        headers: { ...c.auth, "Content-Type": req.headers.get("content-type") ?? "multipart/form-data" },
        body: new Uint8Array(await req.arrayBuffer()),
      });
      if (!r.ok) throw new Error(`${c.name} ${r.status}: ${why(r.text)}`);
      let text = r.text;
      try {
        text = r.json()?.text ?? "";
      } catch {
        // a server answering in plain text
      }
      return text.replace(/<\|[^|]*\|>/g, "").trim(); // SenseVoice's language / emotion tags, should any come through
    }

    /**
     * Recognition through /audio/transcriptions. It takes a file, not a stream, so the recording is cut at each pause
     * and each piece is sent as it ends: the words still come in while you talk, a pause behind, and every request
     * stays small and quick. Pieces are out at the same time and are put back in order.
     */
    const RATE = 16000;
    const SPEECH_DB = -50; // louder than this is speech (the mic has noise suppression and gain control on)
    function oaLive(r: Rec, hints: string[]): Live {
      const words = (g.settings.get<string>("words") ?? "").split("\n").map((w) => w.trim()).filter(Boolean);
      const prompt = [...new Set([...words, ...hints])].slice(0, 40);
      let cur: Int16Array[] = [];
      let len = 0; // samples in the piece being recorded
      let voiced = 0; // of those, loud enough to be speech
      let quiet = 0; // silence since the last speech
      let closed = false;
      const texts: (string | null)[] = []; // each piece's text, in order; null while it's out
      const jobs: Promise<void>[] = [];
      const show = () => {
        if (closed) return;
        let done = "";
        for (const t of texts) {
          if (t === null) break; // what comes after waits for it
          done = glue(done, t);
        }
        setLive(r, done, "");
      };
      const send = () => {
        const all = new Int16Array(len);
        let at = 0;
        for (const c of cur) {
          all.set(c, at);
          at += c.length;
        }
        [cur, len, voiced, quiet] = [[], 0, 0, 0];
        const i = texts.push(null) - 1;
        mark(`piece${i}(${(all.length / RATE).toFixed(1)}s)`);
        const job = oaTranscribe(all, prompt).then(
          (t) => void (texts[i] = t),
          (e) => {
            texts[i] = "";
            mark(`fail${i}`);
            asrFail(e);
          },
        );
        jobs.push(job.then(show));
      };
      return {
        push: (pcm) => {
          cur.push(pcm);
          len += pcm.length;
          if (dbfs(pcm) > SPEECH_DB) [voiced, quiet] = [voiced + pcm.length, 0];
          else quiet += pcm.length;
          // A pause after some speech ends a piece; one that goes on and on is cut anyway. Long silence is dropped
          // once a piece has shown the mic is loud enough to tell (whisper-like models make words up from silence)
          if (voiced > 0.3 * RATE && quiet > 0.6 * RATE) send();
          else if (len > 25 * RATE) {
            if (voiced || !texts.length) send();
            else [cur, len, quiet] = [[], 0, 0];
          }
        },
        end: () => {
          // What's left, unless it's only the silence after the last piece (a recording never loud enough is sent whole)
          if (len && (voiced > 0 || !texts.length)) send();
          Promise.all(jobs).then(() => r.finish());
        },
        close: () => void (closed = true),
      };
    }

    /** 16-bit mono PCM at 16 kHz from the mic's float samples (whatever rate the device runs at). */
    function to16k(f: Float32Array, rate: number): Int16Array {
      const step = rate / 16000;
      const out = new Int16Array(Math.floor(f.length / step));
      for (let i = 0; i < out.length; i++) {
        // average the samples this one stands for: a cheap low-pass, so dropping rate doesn't alias
        const a = Math.floor(i * step);
        const b = Math.min(f.length, Math.floor((i + 1) * step));
        let sum = 0;
        for (let k = a; k < b; k++) sum += f[k];
        const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      return out;
    }

    const activeSession = () => g.state().activePane?.sessionId ?? "";

    // One line per recording in Gerdr's log (gerdr.log, "ui client error" build=voice-trace): what happened when, and
    // how it ended. Recordings that ended with no words and no note couldn't be told apart from the outside: the log
    // only showed the socket opening. Sent the way the perf-probe add-on sends its lines (a fake build id keeps them
    // out of the rescue panel). Temporary, until the silent failures are understood.
    let tr: { t0: number; ev: string[] } | null = null;
    const mark = (what: string) => tr && tr.ev.push(`${what}@${Math.round(performance.now() - tr.t0)}`);
    const sendTrace = (end: string) => {
      if (!tr) return;
      mark(end);
      const line = tr.ev.join(" ");
      tr = null;
      const base = ((window as any).__GERDR_UI__ || {}).base || "";
      fetch(base + "/api/ui/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gerdr": "1" },
        body: JSON.stringify({ build: "voice-trace", items: [{ source: "voice", message: line }] }),
      }).catch(() => {});
    };

    async function startRecording() {
      if (rec || st.busy) return;
      // You're talking: the reading stops, all of it. g.audio.stop() alone ended only the clip sounding: play() went on
      // to the reply after its name, ~2s later (synthesis), and on Android that sound took a Bluetooth headset back
      // from its mic, so the rest of the recording heard nothing
      stopPlaying();
      const sid = target?.sessionId || activeSession();
      clearTimeout(noteTimer);
      caretOff = 0;
      put({ recording: sid || "?", since: Date.now(), live: { done: "", hyp: "" }, swipe: "", note: null });
      segs = [];
      segSession = sid;
      asrErr = "";
      tr = { t0: performance.now(), ev: ["press@0"] };
      // What the recognizer is told about the conversation needs a round trip or two (slow over the remote link):
      // started now, alongside the mic, not after it. The socket used to open only once both were done, and a short
      // recording could end before it was even up
      const context = recognizerContext(sid);
      context.catch(() => {});
      try {
        // a missing key says so now, not after you've talked
        if (asrOa()) oaConf();
        else if (!g.settings.get<string>("doubaoKey")?.trim()) throw new Error(T(`先在 ${where} 里填豆包的 Key`, `Set the Doubao key in ${where}`));
        // A page that isn't a secure context has no navigator.mediaDevices at all (the desktop App before it treated
        // http://gerdr as secure, Gerdr opened over plain http on the LAN): say why, not "Cannot read properties…"
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(
            T(
              "这个页面用不了麦克风（不是安全页面）：桌面 App 升级到新版，或用 https 地址 / 手机打开 Gerdr",
              "No microphone on this page (not a secure context): update the desktop App, or open Gerdr over https / on a phone",
            ),
          );
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        mark("mic");
        if (!st.recording) return stream.getTracks().forEach((t) => t.stop()); // let go while the mic was starting
        const ctx = new AudioContext();
        const node = ctx.createScriptProcessor(4096, 1, 1);
        let finish!: () => void;
        const ended = new Promise<void>((ok) => (finish = ok));
        const level = ctx.createAnalyser();
        level.fftSize = 1024;
        const r: Rec = { stream, ctx, node, level, samples: 0, live: null, buf: [], ending: false, ended, finish, cutoff: setTimeout(() => finishRecording(), 3 * 60_000) };
        rec = r;
        node.onaudioprocess = (e) => {
          const pcm = to16k(e.inputBuffer.getChannelData(0), ctx.sampleRate);
          r.samples += pcm.length;
          if (r.live) r.live.push(pcm);
          else r.buf.push(pcm);
        };
        const src = ctx.createMediaStreamSource(stream);
        src.connect(node);
        src.connect(level);
        node.connect(ctx.destination); // a ScriptProcessor only runs while connected; it outputs silence
        openLive(r, context).catch((e) => {
          mark(`fail(${e instanceof Error ? e.message : String(e)})`);
          asrFail(e);
          r.finish();
        });
      } catch (e) {
        put({ recording: null });
        sendTrace(`micfail(${(e as any)?.name ?? e})`);
        noteFail(
          (e as any)?.name === "NotAllowedError"
            ? T("没有麦克风权限：在系统设置里允许 Gerdr 用麦克风", "No microphone permission: allow it for Gerdr in the system settings")
            : e,
        );
      }
    }

    /** Start the chosen recognizer for a recording: hand it what was recorded meanwhile, and the end if it came. */
    async function recognizerContext(sid: string) {
      const [hints, reply] = await Promise.all([
        hintsFor(sid, ""),
        g.sessions.reply(sid).then(
          (x) => x.text,
          () => "", // no reply yet
        ),
      ]);
      // The conversation as context, newest first: the agent's last reply, then the conversation's title
      const title = g.state().sessions.find((x) => x.id === sid)?.title ?? "";
      return { hints, dialog: [reply.slice(-600), title].filter(Boolean) };
    }
    async function openLive(r: Rec, context: Promise<{ hints: string[]; dialog: string[] }>) {
      const { hints, dialog } = await context;
      mark("ctx");
      const live = asrOa() ? oaLive(r, hints) : await doubaoLive(r, hints, dialog);
      if (rec !== r && !r.ending) return live.close(); // cancelled meanwhile
      r.live = live;
      for (const c of r.buf) live.push(c);
      r.buf = [];
      if (r.ending) live.end();
    }

    async function finishRecording() {
      const sid = st.recording;
      const r = rec;
      const cancel = st.swipe === "cancel";
      // A held key never sends: the hands are on the keyboard, so reading it over and pressing Enter costs nothing
      const edit = st.via === "key" || st.sendOnRelease === (st.swipe === "right");
      rec = null;
      put({ recording: null, swipe: "", sending: !cancel && !edit }); // the bubble says whether it will send
      if (!r) return;
      clearTimeout(r.cutoff);
      r.node.disconnect();
      r.stream.getTracks().forEach((t) => t.stop());
      r.ctx.close().catch(() => {});
      const secs = r.samples / 16000;
      mark(`up(${secs.toFixed(1)}s live=${!!r.live})`);
      if (cancel || secs < 0.5) {
        sendTrace(cancel ? "cancel" : "short");
        r.live?.close();
        dropLive();
        if (!cancel) note(T("按住说话，说完松手", "Hold to talk, let go when done"));
        return;
      }
      if (r.live) r.live.end();
      else r.ending = true;
      put({ busy: sid || "?" });
      const t0 = performance.now();
      const secsSince = (t: number) => `${((performance.now() - t) / 1000).toFixed(1)}s`;
      // The click that ends the press says which composer (run below); wait a moment for it
      await new Promise((ok) => setTimeout(ok, 50));
      const to = target;
      const session = to?.sessionId ?? (sid && sid !== "?" ? sid : activeSession());
      const fixModel = g.settings.get<string>("fixModel")?.trim();
      // The last sentence settles shortly after the audio ends; with a fix-up model it is then fixed like the ones
      // before (those were fixed while you talked), so this waits only for that one. Up to 10s: it used to be 2.5s,
      // and over the remote link a short recording's socket could still be opening then, so everything said was
      // dropped as "didn't catch that". The bubble says it's still recognizing meanwhile
      await Promise.race([r.ended, new Promise((ok) => setTimeout(ok, 10_000))]);
      const heardIn = secsSince(t0);
      const tHeard = performance.now();
      if (fixModel) await Promise.race([Promise.all(segs.map((x) => x.job)), new Promise((ok) => setTimeout(ok, 5000))]);
      const text = shown(st.live.hyp).trim();
      const took = !fixModel
        ? ""
        : segs.some((x) => x.failed)
          ? T("有句纠错没成功", "a fix-up failed")
          : T(`识别 ${heardIn} · 纠错 ${secsSince(tHeard)}`, `heard ${heardIn} · fixed ${secsSince(tHeard)}`);
      r.live?.close();
      put({ busy: null, swipe: "", sending: false, live: { done: "", hyp: "" } });
      if (!text) {
        sendTrace("empty");
        dropLive();
        return note(asrErr || T("没听清，再说一次？", "Didn't catch that. Again?"), !!asrErr);
      }
      sendTrace(deliver(text, session, to, edit));
      if (asrErr) note(T(`有一段没识别出来：${asrErr}`, `A part wasn't recognized: ${asrErr}`), true);
      else if (took && !st.note) note(took);
    }

    /**
     * Speech recognition's text, with what it misheard fixed by a configured model (g.llm) that reads the
     * conversation: homophones and technical words only, no rewording. An answer that isn't a fixed copy (much
     * longer: it replied instead) is thrown away.
     */
    async function fixText(heard: string, model: string, session: string, typed: string): Promise<string> {
      let reply = "";
      try {
        reply = (await g.sessions.reply(session)).text;
      } catch {
        // no reply yet
      }
      const s = g.state().sessions.find((x) => x.id === session);
      const words = (g.settings.get<string>("words") ?? "").split("\n").map((w) => w.trim()).filter(Boolean);
      const context = [
        s?.title ? `对话标题：${s.title}` : "",
        reply ? `对方最近说的：\n${reply.slice(-1500)}` : "",
        typed ? `输入框里已有：${typed}` : "",
        words.length ? `常用词：${words.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const out = (
        await g.llm.complete({
          model,
          system:
            "你修正语音识别的文字。只改明显听错的字词（同音字、近音字、技术名词、英文术语的写法），参考对话上下文判断说的是什么。" +
            "不要改写、不要润色、不要补充，不要回答里面的问题。只输出修正后的文字本身。",
          prompt: `${context}\n\n要修正的识别结果：\n${heard}`,
          maxTokens: Math.max(200, heard.length * 3),
        })
      ).trim();
      return out && out.length <= heard.length * 1.5 + 20 ? out : heard;
    }

    // The final text replaces what went in live (after what the composer held before the press), and is sent unless
    // edit (it stays in the composer)
    function deliver(text: string, session: string, to: ComposerContext | null, edit: boolean): string {
      if (to && (liveBase === null || touched())) {
        // sent or edited while it was being fixed up: that wins
        const why = liveBase === null ? "skip(base)" : `skip(touched ${to.text.length}/${lastShown?.length})`;
        liveBase = lastShown = null;
        return why;
      }
      if (liveBase === null) liveTail = "";
      const o = around(liveBase ?? to?.text ?? "", text);
      liveBase = lastShown = null;
      if (!edit) {
        // Through the composer when there is one, so pasted images and files go along (g.actions.send takes text
        // only and left them behind). ctx.send is new: an older Gerdr has none.
        if (to?.send) {
          to.setText(o.text);
          to.send().catch(fail);
        } else {
          g.actions.send(session, o.text).catch(fail);
          to?.setText("");
        }
        return `sent(${text.length})`;
      } else if (to) to.setText(o.text, o.caret);
      else g.actions.insertText(session, text);
      return `ok(${text.length})`;
    }

    const stopRecording = (cancel = false) => {
      if (cancel) put({ swipe: "cancel" });
      finishRecording();
    };

    // ---------- reading aloud (the speaker on a message, the latest reply, auto read) ----------

    const mimo = async (text: string): Promise<Blob> => {
      const key = g.settings.get<string>("mimoKey")?.trim();
      if (!key) throw new Error(isZh ? `先在 ${where} 里填 MiMo 的 API Key` : `Set the MiMo API key in ${where}`);
      const style = g.settings.get<string>("mimoStyle")?.trim();
      const base = (g.settings.get<string>("mimoBaseURL") || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
      const r = await g.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "api-key": key, Authorization: `Bearer ${key}` },
        body: {
          model: g.settings.get<string>("mimoModel") || "mimo-v2.5-tts",
          messages: [...(style ? [{ role: "user", content: style }] : []), { role: "assistant", content: text }],
          audio: { format: "wav", voice: g.settings.get<string>("mimoVoice") || "茉莉" },
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
      if (!audio) throw new Error(isZh ? "MiMo 没有返回音频" : "MiMo returned no audio");
      return decode(audio, "audio/wav");
    };

    /**
     * Doubao (Volcengine) speech synthesis 2.0, HTTP one-way streaming: one POST, the answer a run of JSON objects
     * ({code: 0, data: base64 MP3 bytes}…, then {code: 20000000}), read whole here — a piece is a paragraph, ~2s for
     * ~8s of speech. Same key as recognition (both are 豆包语音 in the console; each service is opened on its own).
     */
    const doubao = async (text: string): Promise<Blob> => {
      const key = g.settings.get<string>("doubaoKey")?.trim();
      const appId = g.settings.get<string>("doubaoAppId")?.trim();
      if (!key) throw new Error(T(`先在 ${where} 里填豆包的 Key`, `Set the Doubao key in ${where}`));
      const headers: Record<string, string> = { "X-Api-Resource-Id": "seed-tts-2.0", "X-Api-Request-Id": crypto.randomUUID() };
      if (appId) Object.assign(headers, { "X-Api-App-Id": appId, "X-Api-Access-Key": key });
      else headers["X-Api-Key"] = key;
      const r = await g.fetch("https://openspeech.bytedance.com/api/v3/tts/unidirectional", {
        method: "POST",
        headers,
        body: {
          user: { uid: "gerdr" },
          req_params: {
            text,
            speaker: g.settings.get<string>("doubaoVoice") || "zh_female_xiaohe_uranus_bigtts",
            audio_params: { format: "mp3", sample_rate: 24000, speech_rate: g.settings.get<number>("doubaoRate") ?? 0 },
          },
        },
      });
      const parts: Uint8Array[] = [];
      let err = "";
      let at = 0;
      const t = r.text;
      // Concatenated JSON objects: cut at each top-level brace (base64 and messages hold no braces)
      while (at < t.length) {
        const start = t.indexOf("{", at);
        if (start < 0) break;
        let depth = 0;
        let end = start;
        for (; end < t.length; end++) {
          if (t[end] === "{") depth++;
          else if (t[end] === "}" && --depth === 0) break;
        }
        at = end + 1;
        let o: any;
        try {
          o = JSON.parse(t.slice(start, end + 1));
        } catch {
          continue;
        }
        const code = o.code ?? o.header?.code;
        if (o.data) parts.push(Uint8Array.from(atob(o.data), (c) => c.charCodeAt(0)));
        else if (code !== 0 && code !== 20000000) err = `${code}: ${o.message ?? o.header?.message ?? ""}`;
      }
      if (!parts.length) {
        if (/not granted/.test(err))
          throw new Error(T("豆包语音合成还没开通：控制台 → 豆包语音 → 语音合成，开通 2.0", "Doubao TTS isn't enabled: console → 豆包语音 → speech synthesis, enable 2.0"));
        throw new Error(`${T("豆包", "Doubao")} ${r.status} ${err || t.slice(0, 200)}`);
      }
      return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: "audio/mpeg" });
    };

    const azure = async (text: string): Promise<Blob> => {
      const key = g.settings.get<string>("azureKey")?.trim();
      const region = g.settings.get<string>("azureRegion")?.trim();
      if (!key || !region)
        throw new Error(isZh ? `先在 ${where} 里填 Azure 的 Key 和区域` : `Set the Azure key and region in ${where}`);
      const picked = g.settings.get<string>("azureVoice")?.trim();
      const voice = (picked === "custom" ? g.settings.get<string>("azureVoiceName")?.trim() : picked) || "zh-CN-XiaoxiaoMultilingualNeural";
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
          "User-Agent": "gerdr-voice",
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

    /** /audio/speech: SiliconFlow's CosyVoice, OpenAI's voices, or any compatible server. */
    const oaSpeech = async (text: string): Promise<Blob> => {
      const c = oaConf();
      const own = g.settings.get<string>("oaVoice")?.trim();
      const picked = g.settings.get<string>("sfVoice") || c.voice;
      // SiliconFlow names a preset voice after its model ("FunAudioLLM/CosyVoice2-0.5B:anna"), so the pick follows a
      // model change; "custom" is a whole name of your own (an uploaded voice's speech:…)
      const voice = c.id === "siliconflow" ? (picked === "custom" ? own : `${c.tts}:${picked}`) : own || c.voice;
      if (!voice) throw new Error(T(`先在 ${where} 里填音色名`, `Set the voice name in ${where}`));
      const rate = g.settings.get<number>("oaRate") ?? 0;
      const r = await g.fetch(`${c.base}/audio/speech`, {
        method: "POST",
        headers: c.auth,
        // Only fields every compatible API takes: some (OpenAI) refuse one they don't know
        body: { model: c.tts, input: text, voice, response_format: "mp3", ...(rate ? { speed: Math.min(4, Math.max(0.25, 1 + rate / 100)) } : {}) },
        binary: true,
      });
      const bytes = r.bytes();
      // An error is JSON, not audio — also from a proxy that answers it with 200
      if (!r.ok || bytes[0] === 0x7b) throw new Error(`${c.name} ${r.status}: ${why(new TextDecoder().decode(bytes))}`);
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/mpeg" });
    };

    // Read the provider at each piece, so switching it in settings applies to the next read without a reload
    const say = (text: string) => {
      const p = g.settings.get<string>("ttsProvider") || "doubao";
      return p === "mimo" ? mimo(text) : p === "azure" ? azure(text) : p === "openai" ? oaSpeech(text) : doubao(text);
    };

    // Synthesis runs ahead of playback without waiting for g.audio to ask, PARALLEL pieces at a time; stopping
    // (ctx.signal) ends the generator through g.audio and starts nothing more
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
      const ps = paraPieces(text);
      // By piece index: synthesized in this run, or on the way in the chain of `stop`. A jump cancels its chain, and a
      // piece of that chain still queued then fails with the cancel when its turn comes: only a piece already
      // synthesized, or one of a chain still going, is reused, else the next chain would play that failure
      const done = new Map<number, { job: Promise<Blob>; stop: AbortSignal; ok?: boolean }>();

      // From piece `start` on, PARALLEL at a time: each starts as soon as the one PARALLEL places before it is done (not
      // when g.audio asks: it asks once a piece starts playing, too late for a long one). Not one after another: a
      // request is mostly waiting (Azure's eastus from China: 2-4s from a computer for a 4-10s clip, and the phone App
      // calls it over the phone's own network), so in a row a short paragraph (a bullet point) ended before the next
      // one's request did, and the reading stopped for seconds after every sentence. A failure is seen when its piece's turn comes, not as an unhandled
      // rejection; once `stop` aborts, nothing more starts.
      async function* speech(start: number, stop: AbortSignal) {
        const jobs: Promise<Blob>[] = [];
        for (let i = start; i < ps.length; i++) {
          const gate = jobs[jobs.length - PARALLEL];
          const before = gate ? gate.catch(() => {}) : Promise.resolve();
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
    const sample = isZh
      ? "你好，点消息旁边的喇叭，或者输入框旁的喇叭，我就念给你听。"
      : "Hi, tap the speaker beside a message and I'll read it to you.";
    const offPreview = g.settings.onAction("preview", ({ signal }) => read(sample, signal));

    const offRead = g.messageAction({
      id: "read",
      when: (msg) => outputOn() && !!msg.text,
      title: isZh ? "朗读" : "Read aloud",
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

    const played = new Set<string>(g.storage.get<string[]>("played") ?? []);
    const markPlayed = (key: string) => {
      played.add(key);
      g.storage.set("played", [...played].slice(-300));
    };
    let current: AbortController | null = null;

    async function play(item: Item) {
      current?.abort();
      const c = new AbortController();
      current = c;
      put({ playing: item, last: item, queue: st.queue.filter((q) => q.key !== item.key) });
      markPlayed(item.key);
      setMedia(item);
      try {
        const head = item.kind === "reply" && item.announce ? T(`「${item.title}」：`, `${item.title}: `) : "";
        let done = false;
        if (item.kind === "reply" && g.runMessageAction) {
          // Through the message's own speaker when the reply is on screen: the paragraph being read is marked and a
          // tap on another jumps there, as when you tap it yourself. The name first, on its own
          if (head) await read(head, c.signal);
          if (!c.signal.aborted) done = await g.runMessageAction("read", item.session);
          if (done || c.signal.aborted) return;
          if (head) {
            await read(forSpeech(item.text), c.signal);
            return;
          }
        }
        await read(head + forSpeech(item.text), c.signal);
      } catch (e) {
        if ((e as any)?.name === "NotAllowedError") {
          // The WebView refused: keep it for after the next tap rather than lose it
          unlocked = false;
          played.delete(item.key);
          put({ queue: [item, ...st.queue], needTap: true });
        } else if (!c.signal.aborted) fail(e);
      } finally {
        if (current === c) {
          current = null;
          put({ playing: null });
          if (st.auto && g.settings.get<string>("playMode") !== "manual") pump();
        }
      }
    }

    /** Play the next one if nothing plays (and you're not talking). */
    function pump() {
      if (st.playing || st.recording || st.busy || !st.queue.length) return;
      if (!unlocked) return put({ needTap: true });
      play(st.queue[0]);
    }

    function enqueue(item: Item) {
      if (played.has(item.key) || st.queue.some((q) => q.key === item.key)) return;
      // A newer reply of the same conversation replaces one still waiting; a "waiting on you" goes to the front
      const rest = st.queue.filter((q) => !(q.session === item.session && q.kind === item.kind));
      put({ queue: item.kind === "waiting" ? [item, ...rest] : [...rest, item] });
      if (g.settings.get<string>("playMode") === "manual") {
        if (!st.playing) chime();
      } else pump();
    }

    const next = () => {
      if (st.playing) {
        current?.abort();
        g.audio.stop();
      }
      setTimeout(() => !st.playing && st.queue.length && play(st.queue[0]), 0);
    };
    const stopPlaying = () => {
      current?.abort();
      current = null;
      g.audio.stop();
      put({ playing: null });
    };

    /** A conversation's latest reply, now: whether or not auto read was on when it came. */
    async function readLatest(sid: string) {
      if (!sid) return;
      unlock(); // inside the tap
      // Still answering (you just asked): the reply you want is the one coming, not the one before your question
      if (st.armed.includes(sid)) return put({ armed: st.armed.filter((x) => x !== sid) });
      const status = g.state().sessions.find((x) => x.id === sid)?.status;
      if (status === "running" || status === "starting" || status === "waiting") {
        put({ armed: [...st.armed, sid] });
        return g.notify(T("它答完就念给你听", "It will be read once the agent is done"));
      }
      const r = await g.sessions.reply(sid);
      const text = (g.settings.get<string>("scope") === "all" ? r.text : r.final || r.text).trim();
      if (!text) return g.notify(T("这个对话还没有回复", "No reply in this conversation yet"));
      play({ key: `${sid}:latest:${Date.now()}`, session: sid, title: titleOf(sid), text, kind: "reply", announce: false });
    }

    // A car's steering-wheel buttons / a headset: next = the next reply, play = start, pause = stop
    function setMedia(item: Item | null) {
      const ms = (navigator as any).mediaSession;
      if (!ms) return;
      try {
        if (item && (window as any).MediaMetadata) ms.metadata = new (window as any).MediaMetadata({ title: item.title, artist: "Gerdr" });
        ms.setActionHandler("nexttrack", next);
        ms.setActionHandler("play", () => (st.playing ? null : next()));
        ms.setActionHandler("pause", stopPlaying);
      } catch {
        // an action this browser doesn't know
      }
    }

    function setAuto(on: boolean) {
      if (on) unlock(); // inside the tap: replies arrive long after it
      g.storage.set("auto", on);
      put({ auto: on, queue: on ? st.queue : [] });
      g.notify(
        on
          ? T("自动朗读开了：agent 做完会念给你听（这台设备）", "Auto read on: finished replies are read to you on this device")
          : T("自动朗读关了", "Auto read off"),
      );
    }

    const offTurn = g.on("turn", async (t) => {
      if (st.armed.includes(t.sessionId)) {
        put({ armed: st.armed.filter((x) => x !== t.sessionId) });
        if (t.stopReason === "cancelled" || !outputOn()) return;
        const key = `${t.sessionId}:${t.ts}`;
        played.add(key); // auto read (below) leaves it to this
        try {
          const r = await g.sessions.reply(t.sessionId);
          const text = (g.settings.get<string>("scope") === "all" ? r.text : r.final || r.text).trim();
          if (text) play({ key, session: t.sessionId, title: titleOf(t.sessionId), text, kind: "reply", announce: false });
        } catch (e) {
          fail(e);
        }
        return;
      }
      if (!st.auto || !outputOn() || t.stopReason === "cancelled") return;
      if (t.auto && !g.settings.get<boolean>("includeAuto")) return;
      const key = `${t.sessionId}:${t.ts}`;
      if (played.has(key)) return;
      try {
        const r = await g.sessions.reply(t.sessionId);
        const text = g.settings.get<string>("scope") === "all" ? r.text : r.final || r.text;
        if (text) enqueue({ key, session: t.sessionId, title: titleOf(t.sessionId), text, kind: "reply", announce: true });
      } catch (e) {
        fail(e);
      }
    });

    const offWait = g.on("needsInput", (e) => {
      if (!st.auto || !outputOn()) return;
      const title = e.session.title || titleOf(e.session.id);
      enqueue({
        key: `${e.session.id}:wait:${Date.now()}`,
        session: e.session.id,
        title,
        text: T(`「${title}」在等你批准或者回答，回到屏幕上处理一下。`, `${title} is waiting for your approval or answer, on screen.`),
        kind: "waiting",
      });
    });

    // ---------- UI ----------

    const { useState, useEffect } = g.React;
    const useSt = () => {
      const [, bump] = useState(0);
      useEffect(() => {
        const f = () => bump((n) => n + 1);
        subs.add(f);
        return () => void subs.delete(f);
      }, []);
      return st;
    };
    const I = g.icons as any;

    // Hold to talk. A composer action is a click, so the icon itself takes the press: it covers the button (negative
    // margins over its padding) and captures the pointer, so letting go anywhere ends it.
    // A press on the mic: where it started (for the swipes), and the composer box the bubble follows
    let pressAt = { x: 0, y: 0 };
    // The composer box (text field, attachments, bottom bar): the nearest ancestor holding both the text field and
    // the bar's buttons — not the field's own wrapper, or the bubble would sit over the attachments
    const boxOf = (el: HTMLElement | null) => {
      while (el && !(el.querySelector("textarea") && el.querySelector("button"))) el = el.parentElement;
      return el;
    };
    function beginPress(from: HTMLElement, ctx: ComposerContext | undefined, x: number, y: number, where: "spot" | "mic" = "mic", via: "touch" | "key" = "touch") {
      pressAt = { x, y };
      put({ from: where, via });
      if (ctx) target = ctx; // this composer gets the text (a phone's long press is followed by no click)
      // The words go in where the caret is (over what's selected), like typing. A Gerdr from before ctx.selection: the end
      const t = target?.text ?? "";
      const sel = target?.selection ?? { start: t.length, end: t.length };
      liveBase = t.slice(0, sel.start);
      liveTail = t.slice(sel.end);
      lastShown = target ? t : null;
      // The keyboard stays as it is: talking with it up puts the words at the caret, and typing goes on after
      put({ anchorEl: boxOf(from) });
      startRecording();
    }
    function movePress(x: number, y: number) {
      if (!st.recording) return;
      const dx = x - pressAt.x;
      const dy = pressAt.y - y;
      const swipe = dy > 60 && dy >= dx ? "cancel" : dx > 60 ? "right" : "";
      if (swipe !== st.swipe) {
        const was = st.swipe;
        put({ swipe });
        // Into or out of "cancel": the words in the composer are struck through, or back
        if (was === "cancel" || swipe === "cancel") showLive(shown(st.live.hyp), st.live.hyp);
      }
    }

    // The props that make an element a hold-to-talk surface: no scrolling, no text selection or callout, the
    // pointer kept until it lets go (wherever it went)
    const holdProps = (ctx: ComposerContext | undefined) => ({
      // the phone's pager turns pages on a sideways swipe; this one is ours (swipe right = send / edit)
      "data-no-swipe": "",
      style: { touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" } as any,
      onContextMenu: (e: any) => e.preventDefault(),
      onPointerDown: (e: any) => {
        if (e.button !== 0 || st.busy) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        g.haptic ? g.haptic() : navigator.vibrate?.(30);
        beginPress(e.currentTarget, ctx, e.clientX, e.clientY);
      },
      onPointerMove: (e: any) => movePress(e.clientX, e.clientY),
      onPointerUp: () => st.recording && finishRecording(),
      onPointerCancel: (e: any) => lostPress(`mic ${e.currentTarget?.isConnected ? "in" : "gone"}`),
    });

    // The mic: right after the attach button, pinned there (place "start") so it never moves; hold it to talk
    // Cancel a touch's default gestures on an element (natively: React's touchstart is passive): no long-press menu,
    // no system long-press buzz (the press buzzes itself on starting), and Android can't hand the long press to a
    // bigger input nearby. Pointer events still come
    // The browser took the pointer away mid-press (pointercancel) though the finger is still down and didn't move:
    // seen on the Android App, 1.5–2.5s into a still press, every time for a while. That used to count as "cancel"
    // and dropped everything said, with no word about it. Now the recording goes on, and ends as a normal release
    // when the finger really lifts: touch events still come after the pointer is cancelled (touchend), and a touch
    // that's cancelled too, or the next tap anywhere, ends it the same way. The swipes can't be read meanwhile.
    function lostPress(why: string) {
      if (!st.recording) return;
      mark(`lost(${why})`);
      const end = (e: Event) => {
        off();
        mark(e.type);
        if (st.recording) finishRecording();
      };
      const kinds = ["touchend", "touchcancel", "pointerup"];
      const off = () => kinds.forEach((k) => document.removeEventListener(k, end, true));
      kinds.forEach((k) => document.addEventListener(k, end, true));
    }

    function useNoTouchDefaults(el: () => HTMLElement | null | undefined, deps: unknown[]) {
      useEffect(() => {
        const e = el();
        if (!e) return;
        const stop = (t: TouchEvent) => t.cancelable && t.preventDefault();
        e.addEventListener("touchstart", stop, { passive: false });
        return () => e.removeEventListener("touchstart", stop);
      }, deps);
    }

    function Mic({ ctx }: { ctx?: ComposerContext }) {
      const s = useSt();
      const self = g.React.useRef<HTMLSpanElement | null>(null);
      useNoTouchDefaults(() => self.current, []);
      // Known by its session, for the held key (which has no element to press, so no ctx of its own)
      useEffect(() => {
        if (!ctx || !self.current) return;
        const me = { ctx, el: self.current };
        composers.set(ctx.sessionId, me);
        return () => void (composers.get(ctx.sessionId) === me && composers.delete(ctx.sessionId));
      }, [ctx, ctx?.sessionId]);
      const icon = s.busy ? (
        <I.LoaderCircle className="size-4 animate-spin" />
      ) : (
        <I.Mic className={g.ui.cn("size-4", s.recording && "text-bad")} />
      );
      // The button's padding is part of the hold area (negative margins), so the whole button takes the press. On a
      // touch screen the press area reaches further than the button looks (a ::before is hit-tested as the span):
      // up into the field's bottom padding and down past the composer's edge, where a thumb lands short of a 16px
      // icon; sideways only into the 4px gaps, so 📎 and the rest keep their own presses
      return (
        <span
          ref={self}
          {...holdProps(ctx)}
          className="relative -mx-1.5 -my-1 flex items-center px-1.5 py-1 pointer-coarse:before:absolute pointer-coarse:before:-inset-x-0.5 pointer-coarse:before:-top-2 pointer-coarse:before:-bottom-4"
        >
          {icon}
        </span>
      );
    }
    /**
     * The middle of an empty composer is a "hold to talk" spot (g.slot("composerInput"), drawn over the field): hold it
     * to talk, tap it to type (focus()). Only the middle: the field's sides are still the field, with the system's
     * long-press menu (paste) — which no page can stop on the field itself, so the spot is our own element on top.
     * Stays while talking, though the live words fill the field, so the press isn't lost.
     */
    const HOLD_MS = 200;
    // While the spot shows, the field's own placeholder is hidden (the spot says what to do instead of overlapping it)
    const spotCss = document.createElement("style");
    spotCss.textContent = "textarea[data-voice-spot]::placeholder{color:transparent}";
    document.head.appendChild(spotCss);

    function TalkSpot({ ctx, focus }: { ctx: ComposerContext; focus(): void }) {
      const s = useSt();
      const self = g.React.useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean; el?: HTMLDivElement | null }>({ held: false });
      const talking = !!(s.recording || s.busy);
      const shown = !ctx.text || talking;
      // Mark the field next to the spot while the hint shows (it's in the same relative box). While talking, pad the
      // field's bottom by about a finger: the composer sits on the screen's bottom edge, so the field grows upwards,
      // the finger ends up in the padding, and the words (top down, newest line last) stay above it instead of under it
      const field = () => self.current.el?.parentElement?.querySelector("textarea") ?? null;
      useEffect(() => {
        const ta = field();
        if (!ta) return;
        if (shown && !talking) ta.setAttribute("data-voice-spot", "");
        else ta.removeAttribute("data-voice-spot");
        return () => ta.removeAttribute("data-voice-spot");
      }, [shown, talking]);
      // Room under the words only when the finger is on the field itself (the bar's mic is below the words already)
      const pad = !!s.recording && s.from === "spot";
      useEffect(() => {
        const ta = field();
        if (!ta || !pad) return;
        // The composer sizes the field from its content only when the text changes: size it now, as it would
        const fit = () => {
          ta.style.height = "auto";
          ta.style.height = Math.min(ta.scrollHeight, Math.max(160, window.innerHeight * 0.4)) + "px";
          ta.scrollTop = ta.scrollHeight;
        };
        ta.style.paddingBottom = "72px";
        fit();
        return () => {
          ta.style.paddingBottom = "";
          fit();
        };
      }, [pad]);
      // Android hands a long press near a small target to the bigger input next to it (touch adjustment), which then
      // shows its paste menu
      useNoTouchDefaults(() => self.current.el, [shown]);
      // Newest words in sight as they come
      useEffect(() => {
        const ta = field();
        if (ta && pad) ta.scrollTop = ta.scrollHeight;
      });
      if (!shown) return null;
      const hold = holdProps(ctx);
      return (
        <div
          ref={(el: HTMLDivElement | null) => void (self.current.el = el)}
          data-no-swipe=""
          style={hold.style}
          onContextMenu={hold.onContextMenu}
          className={g.ui.cn(
            "absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[14px]",
            // While talking it's invisible (the words fill the field under it), but stays to keep the finger's press
            talking ? "opacity-0" : "text-muted-foreground/80",
          )}
          onPointerDown={(e: any) => {
            if (e.button !== 0 || st.busy) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            const el = e.currentTarget;
            const [x, y] = [e.clientX, e.clientY];
            self.current.held = false;
            self.current.timer = setTimeout(() => {
              self.current.held = true;
              g.haptic ? g.haptic() : navigator.vibrate?.(30);
              beginPress(el, ctx, x, y, "spot");
            }, HOLD_MS);
          }}
          onPointerMove={hold.onPointerMove}
          onPointerUp={() => {
            clearTimeout(self.current.timer);
            if (self.current.held) finishRecording();
            else focus(); // a tap: type
          }}
          onPointerCancel={() => {
            clearTimeout(self.current.timer);
            if (self.current.held) lostPress(`spot ${self.current.el?.isConnected ? "in" : "gone"}`);
          }}
        >
          <I.Mic className="size-4" />
          {T("按住说话", "Hold to talk")}
        </div>
      );
    }

    // ---------- hold a key to talk (a computer's keyboard) ----------
    // A held command (g.command with release): its key, right Option / right Alt by default (under the right thumb,
    // and never held alone otherwise), is a row of Settings → Shortcuts like any other, and of this add-on's settings
    // (g.ui.Shortcut), one value for both. Gerdr starts a lone modifier only once it's been held by itself for a
    // moment, so ⌥← and the rest still work. Talks into the composer you're in; letting go leaves the words there,
    // not sent; Esc while holding drops them. A Gerdr without held commands never calls release: then the key is
    // never bound either ("altright" isn't a key it knows), so nothing happens.
    const composers = new Map<string, { ctx: ComposerContext; el: HTMLElement }>();
    let keyTalk = false;
    /** The composer the key talks into: the one holding focus, else the focused pane's. */
    function keyComposer() {
      const a = document.activeElement;
      for (const c of composers.values()) if (c.el.isConnected && a && boxOf(c.el)?.contains(a)) return c;
      const c = composers.get(activeSession());
      return c?.el.isConnected ? c : null;
    }
    // Esc would also reach the composer, which stops a running agent with it
    const onEsc = (e: KeyboardEvent) => {
      if (!keyTalk || e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (st.recording) stopRecording(true);
    };
    window.addEventListener("keydown", onEsc, true);
    const offTalkKey = g.command({
      id: "voice.talk",
      title: T("按住说话（松开留在输入框）", "Hold to talk (let go: into the composer)"),
      key: "altright",
      run: () => {
        if (!inputOn() || rec || st.recording || st.busy) return;
        const c = keyComposer();
        if (!c) return; // not in a conversation (a terminal, settings)
        keyTalk = true;
        target = c.ctx;
        beginPress(c.el, c.ctx, 0, 0, "mic", "key");
      },
      release: async () => {
        if (!keyTalk) return;
        keyTalk = false;
        if (!st.recording) return; // cancelled with Esc
        const box = st.anchorEl;
        await finishRecording();
        // Back to typing: the words are at the caret, Enter sends them
        box?.querySelector("textarea")?.focus();
      },
    });

    const micAction = () => g.composerAction({
      id: "mic",
      title: st.sendOnRelease
        ? T("按住说话：松手发送，上滑取消，右滑放进输入框编辑", "Hold to talk: let go to send, slide up to cancel, right to edit it first")
        : T("按住说话：松手放进输入框，上滑取消，右滑直接发送", "Hold to talk: let go to put it in the composer, slide up to cancel, right to send"),
      place: "start",
      // render gives each composer its own ctx; icon is for a Gerdr without render, where the click's run says
      render: (ctx) => <Mic ctx={ctx} />,
      icon: <Mic />,
      run: (ctx) => {
        target = ctx;
      },
    });


    // 🔊, one button for listening: tap = this conversation's latest reply now (tap again: stop); hold = auto read on /
    // off (this device). Brand-coloured while auto read is on, with how many replies wait
    const LONG_MS = 500;
    function Listen({ ctx }: { ctx?: ComposerContext }) {
      const s = useSt();
      const self = g.React.useRef<{ el?: HTMLSpanElement | null; timer?: ReturnType<typeof setTimeout>; long: boolean }>({ long: false });
      useNoTouchDefaults(() => self.current.el, []);
      const mine = !!(ctx && s.playing && s.playing.session === ctx.sessionId);
      return (
        <span
          ref={(el: HTMLSpanElement | null) => void (self.current.el = el)}
          className="relative -mx-1.5 -my-1 flex items-center px-1.5 py-1"
          style={{ WebkitTouchCallout: "none", userSelect: "none" } as any}
          onContextMenu={(e: any) => e.preventDefault()}
          onPointerDown={(e: any) => {
            if (e.button !== 0) return;
            e.preventDefault();
            self.current.long = false;
            self.current.timer = setTimeout(() => {
              self.current.long = true;
              g.haptic ? g.haptic() : navigator.vibrate?.(30);
              setAuto(!st.auto);
            }, LONG_MS);
          }}
          onPointerUp={() => {
            clearTimeout(self.current.timer);
            if (self.current.long || !ctx) return;
            if (mine) stopPlaying();
            else readLatest(ctx.sessionId).catch(fail);
          }}
          onPointerCancel={() => clearTimeout(self.current.timer)}
        >
          {mine ? <I.Square className="size-3.5 fill-current" /> : <I.Volume2
              className={g.ui.cn("size-4", s.auto && "text-brand", ctx && s.armed.includes(ctx.sessionId) && "animate-pulse text-brand")}
            />}
          {s.auto && s.queue.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-brand px-0.5 text-center text-[9px] leading-3.5 text-brand-foreground">
              {s.queue.length}
            </span>
          )}
        </span>
      );
    }
    const listenAction = () =>
      g.composerAction({
        id: "listen",
        title: T("点：念最新回复（还在答就等答完再念；再点停） · 长按：开关自动朗读", "Tap: read the latest reply (still answering: once it's done; again: stop) · hold: auto read on / off"),
        render: (ctx) => <Listen ctx={ctx} />,
        icon: <Listen />,
        // The press is handled by Listen itself (tap / hold); a click after it has nothing left to do
        run: () => {},
      });

    // Each half's buttons exist while its switch is on. A settings change doesn't re-run setup, so look again every
    // second (cheap: two reads) and add or take away the buttons
    const halves = [
      // "Hold to talk" over the field is for a phone, where the bar's mic is a small target under a thumb; with a
      // mouse the mic is easy to hit and the hint in the middle of an empty field is only in the way
      {
        on: inputOn,
        make: () => (matchMedia("(pointer: coarse)").matches ? [micAction(), g.slot("composerInput", TalkSpot)] : [micAction()]),
      },
      { on: outputOn, make: () => [listenAction()] },
    ].map((h) => ({ ...h, offs: [] as Dispose[] }));
    const syncHalves = () => {
      for (const h of halves) {
        if (h.on() && !h.offs.length) h.offs = h.make();
        else if (!h.on() && h.offs.length) {
          h.offs.forEach((f) => f());
          h.offs = [];
          if (h.on === outputOn) {
            stopPlaying();
            put({ queue: [] });
          }
        }
      }
    };
    syncHalves();
    const halvesTimer = setInterval(syncHalves, 1000);

    // The player: while something plays, or auto read has replies waiting. Big buttons, for a phone in a car mount
    /** The composer box's place on screen, measured every frame while shown: it grows with its text, moves with the keyboard. */
    function useBoxRect(el: HTMLElement | null, on: boolean) {
      const [r, setR] = useState<{ left: number; width: number; bottom: number } | null>(null);
      // Measured in a layout effect, before the browser paints: with useEffect the bubble's first frame used the rect
      // from the last time it showed (the composer was three lines taller then), and it dropped into place a frame
      // later. Forgotten when hidden, so nothing stale is around for the next time
      g.React.useLayoutEffect(() => {
        if (!el || !on) return setR(null);
        let raf = 0;
        const tick = () => {
          const b = el.getBoundingClientRect();
          const next = { left: b.left, width: b.width, bottom: window.innerHeight - b.top + 8 };
          setR((p) => (p && p.left === next.left && p.width === next.width && p.bottom === next.bottom ? p : next));
          raf = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(raf);
      }, [el, on]);
      return el && el.isConnected ? r : null;
    }

    // The bubble's waveform: the mic's loudness over the last couple of seconds, newest on the right, so you can see
    // it hears you (and how loud) before any words show up. Drawn on a canvas from requestAnimationFrame, outside
    // React: the bubble itself only re-renders twice a second for the timer
    const BAR = 2, GAP = 2, STEP_MS = 50; // a new bar every 50 ms: scrolls at the same speed at any frame rate
    function Wave({ muted }: { muted: boolean }) {
      const cv = g.React.useRef<HTMLCanvasElement | null>(null);
      useEffect(() => {
        const c = cv.current;
        if (!c) return;
        const g2 = c.getContext("2d")!;
        const buf = new Float32Array(1024);
        let hist: number[] = [];
        let raf = 0;
        let last = 0;
        let peak = 0; // loudest frame since the last bar: a short syllable between two bars still shows
        const draw = (now: number) => {
          raf = requestAnimationFrame(draw);
          const an = rec?.level;
          if (an) {
            an.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
            peak = Math.max(peak, Math.min(1, Math.max(0, (db + 55) / 40))); // -55 dB (room) .. -15 dB (loud) → 0..1
          }
          if (now - last < STEP_MS) return;
          last = now;
          const dpr = window.devicePixelRatio || 1;
          const w = c.clientWidth, h = c.clientHeight;
          if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
            c.width = Math.round(w * dpr);
            c.height = Math.round(h * dpr);
          }
          const n = Math.max(1, Math.floor((w + GAP) / (BAR + GAP)));
          hist.push(peak);
          peak = 0;
          if (hist.length > n) hist = hist.slice(hist.length - n);
          g2.setTransform(dpr, 0, 0, dpr, 0, 0);
          g2.clearRect(0, 0, w, h);
          g2.fillStyle = getComputedStyle(c).color; // the theme's token via the text-* class, not a fixed colour
          const x0 = w - hist.length * (BAR + GAP) + GAP;
          hist.forEach((v, i) => {
            const bh = Math.max(2, v * h);
            g2.beginPath();
            g2.roundRect(x0 + i * (BAR + GAP), (h - bh) / 2, BAR, bh, BAR / 2);
            g2.fill();
          });
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
      }, []);
      return <canvas ref={cv} className={g.ui.cn("block h-4 min-w-0 flex-1", muted ? "text-muted-foreground/50" : "text-bad")} />;
    }

    // The recording bubble's border, breathing red. animate-pulse only dims to 50%, which over a thin red line barely
    // read; this goes nearly out and back. Web Animations, started once on mount: no keyframes to
    // register with the in-browser Tailwind, and the bubble re-rendering every second doesn't restart it
    function RecBorder() {
      const el = g.React.useRef<HTMLSpanElement | null>(null);
      g.React.useEffect(() => {
        const a = el.current?.animate(
          [
            { opacity: 1 },
            { opacity: 0.24 },
          ],
          { duration: 900, direction: "alternate", iterations: Infinity, easing: "ease-in-out" },
        );
        return () => a?.cancel();
      }, []);
      return <span ref={el} className="pointer-events-none absolute -inset-px rounded-2xl border border-bad" />;
    }

    function Bar() {
      const s = useSt();
      const anchor = useBoxRect(s.anchorEl, !!(s.recording || s.busy || s.note));
      const [, tick] = useState(0);
      useEffect(() => {
        if (!s.recording) return;
        const t = setInterval(() => tick((n) => n + 1), 500);
        return () => clearInterval(t);
      }, [s.recording]);
      if (s.note && !s.recording && !s.busy) {
        return (
          <div
            className={g.ui.cn(
              // Same box as the recording bubble (px-3 py-2): this one takes its place, and a taller one read as a jump
              "pointer-events-none fixed z-50 rounded-2xl border border-border/60 bg-background px-3 py-2 text-sm shadow-xl",
              !anchor && "bottom-32 left-1/2 w-[min(92vw,28rem)] -translate-x-1/2",
              s.note.bad ? "text-bad" : "text-muted-foreground",
            )}
            style={anchor ? { left: anchor.left, width: anchor.width, bottom: anchor.bottom } : undefined}
          >
            {s.note.text}
          </div>
        );
      }
      // After letting go: the recognizer's last words (and, with a fix-up model, the last sentence's fix). Usually
      // quick, but over a slow link it can take seconds, and a bubble that just went away read as "nothing happened"
      const fixing = !!s.busy && !!g.settings.get<string>("fixModel")?.trim();
      if (s.recording || s.busy) {
        const sec = s.recording ? Math.floor((Date.now() - s.since) / 1000) : 0;
        // The words go into the composer only (its draft is kept by the server, so they survive a dropped connection or
        // a reload); a second copy here read as doubled text. The bubble says how long and what letting go does
        return (
          <div
            className={g.ui.cn(
              "pointer-events-none fixed z-50 rounded-2xl border border-border/60 bg-background px-3 py-2 shadow-xl",
              !anchor && "bottom-32 left-1/2 w-[min(92vw,28rem)] -translate-x-1/2",
            )}
            style={anchor ? { left: anchor.left, width: anchor.width, bottom: anchor.bottom } : undefined}
          >
            {/* While recording the border breathes red over the grey one (a layer of its own, so only the border
                pulses, not the words); it goes grey again while the finger is on "cancel" */}
            {s.recording && s.swipe !== "cancel" && (
              <RecBorder />
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {s.recording ? (
                <>
                  <span className={g.ui.cn("size-2 rounded-full", s.swipe === "cancel" ? "bg-muted-foreground" : "bg-bad")} />
                  <span className="tabular-nums">
                    {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}
                  </span>
                  <Wave muted={s.swipe === "cancel"} />
                  {s.via === "key" ? (
                    <span className="shrink-0">{T("松开放进输入框 · Esc 取消", "Let go: into the composer · Esc: cancel")}</span>
                  ) : (
                  /* Both hints stay put (same words, same weight: nothing shifts as the finger moves); the one the
                      finger is on lights up and the other fades */
                  <span className="flex shrink-0 items-center gap-2">
                    <span
                      className={g.ui.cn(
                        "transition-[color,opacity] duration-150",
                        s.swipe === "cancel" && "text-bad",
                        s.swipe === "right" && "opacity-30",
                      )}
                    >
                      {T("上滑取消", "Up: cancel")}
                    </span>
                    <span
                      className={g.ui.cn(
                        "transition-[color,opacity] duration-150",
                        s.swipe === "right" && "text-brand",
                        s.swipe === "cancel" && "opacity-30",
                      )}
                    >
                      {s.sendOnRelease ? T("右滑编辑", "Right: edit") : T("右滑发送", "Right: send")}
                    </span>
                  </span>
                  )}
                </>
              ) : (
                <>
                  <I.LoaderCircle className="size-3 animate-spin" />
                  {fixing
                    ? !s.sending
                      ? T("最后一句纠错中…", "Fixing the last sentence…")
                      : T("最后一句纠错后发送…", "Fixing the last sentence, then sending…")
                    : !s.sending
                      ? T("识别中…", "Recognizing…")
                      : T("识别完就发送…", "Recognizing, then sending…")}
                </>
              )}
            </div>
          </div>
        );
      }
      if (!s.playing && !(s.auto && (s.queue.length || s.needTap))) return null;
      const label = s.needTap
          ? T("点一下屏幕就能念", "Tap anywhere to hear them")
        : s.playing
          ? s.playing.title
          : T(`${s.queue.length} 条没听`, `${s.queue.length} waiting`);
      return (
        <div className="fixed left-1/2 top-2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-1 rounded-full border bg-background py-1 pl-3 pr-1 text-sm shadow-lg">
          <I.Volume2 className="size-4 shrink-0 text-brand" />
          <span className="min-w-0 truncate px-1">{label}</span>
          {s.playing && s.queue.length > 0 && <span className="shrink-0 text-xs text-muted-foreground">+{s.queue.length}</span>}
          {s.playing ? (
            <g.ui.Button size="icon" variant="ghost" title={T("停", "Stop")} onClick={stopPlaying}>
              <I.Square className="size-4" />
            </g.ui.Button>
          ) : (
            s.queue.length > 0 && (
              <g.ui.Button size="icon" variant="ghost" title={T("念下一条", "Play next")} onClick={next}>
                <I.Play className="size-4" />
              </g.ui.Button>
            )
          )}
          {s.playing && s.queue.length > 0 && (
            <g.ui.Button size="icon" variant="ghost" title={T("下一条", "Next")} onClick={next}>
              <I.SkipForward className="size-4" />
            </g.ui.Button>
          )}
          {!s.playing && s.last && (
            <g.ui.Button size="icon" variant="ghost" title={T("再念一遍", "Again")} onClick={() => play(s.last!)}>
              <I.RotateCcw className="size-4" />
            </g.ui.Button>
          )}
          {!s.playing && s.queue.length > 0 && (
            <g.ui.Button size="icon" variant="ghost" title={T("清空", "Clear")} onClick={() => put({ queue: [] })}>
              <I.X className="size-4" />
            </g.ui.Button>
          )}
        </div>
      );
    }
    const offBar = g.slot("overlay", Bar);

    // Settings: what to set first (the key), then input, then reading
    // The fix-up model, as a dropdown of the models configured in Gerdr (g.llm.models(), known only at run time, so
    // not a select in addon.json): it was a text field with a row of chips under it, one per model, which took a lot
    // of room. Built from g.ui.Popover and styled like gerdr's own select. "None" first: it's the default, and most
    // people never need a fix-up. A value typed in before (not among the models) stays listed.
    function ModelPick({ value, set }: { value: string; set: (v: string | null) => void }) {
      const [models, setModels] = useState<string[]>([]);
      const [open, setOpen] = useState(false);
      useEffect(() => {
        g.llm.models().then(setModels, () => {});
      }, []);
      const list = ["", ...(value && !models.includes(value) ? [value] : []), ...models];
      const name = (m: string) => m || T("不纠错（默认）", "None (default)");
      return (
        <div className="text-[12px]">
          <div className="flex gap-2 max-md:flex-col max-md:items-stretch max-md:gap-1 md:items-center">
            <span className="min-w-0 md:flex-1">{T("纠错模型", "Fix-up model")}</span>
            <g.ui.Popover open={open} onOpenChange={setOpen}>
              <g.ui.PopoverTrigger asChild>
                <button className="flex h-7 items-center justify-between gap-2 whitespace-nowrap rounded-md border bg-transparent px-2.5 text-[12px] max-md:w-full md:min-w-44">
                  <span className={g.ui.cn("truncate", !value && "text-muted-foreground")}>{name(value)}</span>
                  <I.ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </g.ui.PopoverTrigger>
              <g.ui.PopoverContent align="end" className="max-h-72 w-64 overflow-y-auto p-1">
                {list.map((m) => (
                  <button
                    key={m || "none"}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-muted"
                    onClick={() => {
                      set(m || null);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{name(m)}</span>
                    {m === value && <I.Check className="size-3.5 shrink-0" />}
                  </button>
                ))}
              </g.ui.PopoverContent>
            </g.ui.Popover>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {T(
              "一般不用：每说完一句就交给这个模型，结合对话改同音字和术语。列的是 Gerdr 设置 → 模型里配好的；开着时松手后要等最后一句纠完。",
              "Rarely needed: each finished sentence goes to this model, which fixes misheard words using the conversation. Lists the models set up in Gerdr (Settings → Models); with one on, letting go waits for the last fix.",
            )}
          </div>
        </div>
      );
    }

    // Send on release: this device's own choice (g.storage), not an addon.json setting, which is the same on every
    // device. A phone wants it on (one hand, no keyboard to press Enter on), a computer off.
    function SendOnRelease() {
      const s = useSt();
      return (
        <div className="text-[12px]">
          <label className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{T("松手就发送（这台设备）", "Send on release (this device)")}</span>
            <g.ui.Switch
              checked={s.sendOnRelease}
              onCheckedChange={(v) => {
                g.storage.set("sendOnRelease", v);
                put({ sendOnRelease: v });
                // the mic's tooltip says what letting go does: put it back with the new words
                const h = halves[0];
                if (h.offs.length && !st.recording && !st.busy) {
                  h.offs.forEach((f) => f());
                  h.offs = [];
                  syncHalves();
                }
              }}
            />
          </label>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {T(
              "开：松手直接发出去，右滑放进输入框编辑。关（默认）：松手放进输入框，右滑直接发送。只管这台设备，手机上开、电脑上关互不影响。键盘按住说话总是放进输入框。",
              "On: letting go sends it, swipe right puts it in the composer to edit. Off (default): letting go puts it in the composer, swipe right sends. Only this device, so the phone and the computer can differ. Holding a key always puts it in the composer.",
            )}
          </div>
        </div>
      );
    }

    // azureVoice used to be a text field: a name typed there that isn't one of the select's options now goes to the
    // "custom" name field, so it keeps being used and the select shows "Custom…" instead of nothing
    {
      const old = g.settings.get<string>("azureVoice")?.trim();
      const listed = ["zh-CN-XiaoxiaoMultilingualNeural", "zh-CN-XiaoxiaoNeural", "zh-CN-XiaochenMultilingualNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunxiNeural", "zh-CN-YunjianNeural", "zh-CN-YunyangNeural", "zh-CN-YunxiaNeural", "en-US-AvaMultilingualNeural", "en-US-EmmaMultilingualNeural", "en-US-AndrewMultilingualNeural", "en-US-BrianMultilingualNeural"] // addon.json's options, but "custom"
      if (old && old !== "custom" && !listed.includes(old)) g.settings.set({ azureVoice: "custom", azureVoiceName: old }).catch(() => {});
    }

    // Settings: two halves, each behind its switch; a provider's own fields only once it's picked
    const offSettings = g.slot("settings", ({ Field, values, set }) => {
      // A key used by both halves is shown once: in the input half when recognition uses it, else in the reading half
      const listening = values.enableInput !== false;
      const oaInInput = listening && values.asrProvider === "openai";
      const doubaoInInput = listening && values.asrProvider !== "openai";
      const oaConn = ["oaPreset", "oaKey", "oaBaseURL"];
      const oaVoiceFields =
        values.oaPreset === "openai" || values.oaPreset === "custom" ? ["oaVoice"] : ["sfVoice", ...(values.sfVoice === "custom" ? ["oaVoice"] : [])];
      return (
        <div className="space-y-2.5">
          <Field name="enableInput" />
          {listening && (
            <div className="space-y-2.5 border-l-2 border-border pl-2.5">
              <Field name="asrProvider" />
              {(oaInInput ? [...oaConn, "oaAsrModel"] : ["doubaoKey", "doubaoAppId"]).map((k) => (
                <Field key={k} name={k} />
              ))}
              <SendOnRelease />
              <ModelPick value={(values.fixModel as string) ?? ""} set={(v) => set("fixModel", v)} />
              <Field name="words" />
              {g.ui.Shortcut && (
                <g.ui.Shortcut
                  command="voice.talk"
                  title={T("键盘按住说话", "Hold a key to talk")}
                  description={T(
                    "电脑上按住说话，松开后文字留在输入框里不发送，按 Esc 取消；说进光标所在的输入框，没有就是当前会话的。单个修饰键要单独按住一小会儿才开始，组合键照常用。和设置 → 快捷键里的是同一个。",
                    "On a computer: hold to talk, let go and the words stay in the composer, not sent; Esc cancels. Into the composer with the caret, else the focused conversation's. A modifier alone starts once held by itself for a moment; combinations still work. The same key as in Settings → Shortcuts.",
                  )}
                />
              )}
            </div>
          )}
          <Field name="enableOutput" />
          {values.enableOutput !== false && (
            <div className="space-y-2.5 border-l-2 border-border pl-2.5">
              <Field name="ttsProvider" />
              {(values.ttsProvider === "mimo"
                ? ["mimoKey", "mimoVoice", "mimoStyle", "mimoModel", "mimoBaseURL"]
                : values.ttsProvider === "azure"
                  ? ["azureKey", "azureRegion", "azureVoice", ...(values.azureVoice === "custom" ? ["azureVoiceName"] : []), "azureRate"]
                  : values.ttsProvider === "openai"
                    ? [...(oaInInput ? [] : oaConn), "oaTtsModel", ...oaVoiceFields, "oaRate"]
                    : // the key is shared with recognition: shown here only when recognition doesn't show it
                      [...(doubaoInInput ? [] : ["doubaoKey", "doubaoAppId"]), "doubaoVoice", "doubaoRate"]
              ).map((k) => (
                <Field key={k} name={k} />
              ))}
              <Field name="scope" />
              <Field name="playMode" />
              <Field name="includeAuto" />
              <Field name="preview" />
            </div>
          )}
        </div>
      );
    });

    return () => {
      stopRecording(true);
      stopPlaying();
      document.removeEventListener("pointerdown", onTouch, true);
      window.removeEventListener("keydown", onEsc, true);
      offTalkKey();
      spotCss.remove();
      clearInterval(halvesTimer);
      for (const h of halves) h.offs.forEach((f) => f());
      [offTurn, offWait, offPreview, offRead, offBar, offSettings].forEach((f) => f());
      subs.clear();
    };
  },
});
