// Messages people send *you* on Slack (direct messages, optionally @-mentions and everything said in small channels)
// → Gerdr events, and replies → Slack, as
// you. No Slack app: it uses the session the Slack desktop app is signed in with, which slackctl imports
// (`slackctl auth import-desktop` → ~/.config/agent-slack/credentials.json: an xoxc token plus the d cookie).
//
// Receiving is `slackctl listen` (v0.3.0+): Slack's real-time socket (rtm.connect, what the desktop client uses) as
// JSON lines, kept alive and reconnected by slackctl. Measured on an Enterprise Grid: a DM arrives on the connection of
// any of its workspaces (DMs are org-wide), and the enterprise address itself refuses rtm.connect
// (enterprise_is_restricted) — so one listener, on one workspace, is enough and the right one.
// Sending goes through `slackctl message send`, so what the add-on posts is exactly what an agent with slackctl would.
// The same credentials are still read here for the few Web API calls listen doesn't cover (names, files, long text).
//
// Talks to Gerdr in JSON lines: stdin gets hello / settings / event, stdout sends status / event.

import { createInterface } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = process.env.GERDR_ADDON_DATA || process.cwd();
const CREDS = path.join(os.homedir(), ".config", "agent-slack", "credentials.json");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const status = (text) => out({ type: "status", text });
const log = (...a) => console.error(new Date().toISOString(), ...a);
let zh = true;
const T = (z, e) => (zh ? z : e);

// Node 18 is the first with a global fetch. An older one says so in Settings → Add-ons rather than crash-looping.
const NEED_NODE = 18;
const tooOld = () =>
  Number(process.versions.node.split(".")[0]) < NEED_NODE || typeof fetch !== "function"
    ? T(
        `需要 Node ${NEED_NODE} 以上，现在是 v${process.versions.node}（${process.execPath}）`,
        `Needs Node ${NEED_NODE}+; this is v${process.versions.node} (${process.execPath})`,
      )
    : "";

let settings = {};
let proc = null; // the running `slackctl listen`
let ws_ = null; // { url, name, token, cookie }: the workspace we listen on
let me = "";
let stopping = false;
let backoff = 1000;
let reconnectTimer = null;
let lastImport = 0;
const names = new Map(); // user id → display name
const kinds = new Map(); // channel id → { kind: "im" | "mpim" | "channel", members?, name?, at }
const KIND_TTL = 3600_000; // people join and leave channels: a channel's size is asked again after this
let connectedAt = 0; // when this process first heard Slack: a thread started after it has been seen whole, live

// ---- slackctl ----

// The login shell's PATH usually has it, but `go install` puts it in ~/go/bin, which not every PATH lists
async function slackctlPath() {
  const want = (settings.slackctl || "slackctl").replace(/^~(?=\/)/, os.homedir());
  if (want.includes("/")) return want;
  const dirs = [...(process.env.PATH ?? "").split(":"), path.join(os.homedir(), "go", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    const p = path.join(d, want);
    if (await access(p, constants.X_OK).then(() => true, () => false)) return p;
  }
  return "";
}

async function slackctl(args) {
  const bin = await slackctlPath();
  if (!bin) throw new Error(T("找不到 slackctl", "slackctl not found"));
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 60_000, maxBuffer: 10 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split("\n").pop())) : resolve(stdout),
    ),
  );
}

// The desktop app rotates its session now and then; importing again picks up the current one. At most every 10
// minutes, so a session that is really gone (signed out) doesn't turn into a loop of keychain reads.
async function importDesktop() {
  if (Date.now() - lastImport < 10 * 60_000) return false;
  lastImport = Date.now();
  log("slackctl auth import-desktop");
  await slackctl(["auth", "import-desktop"]);
  return true;
}

// The workspace to listen on: the one the setting names (a substring of its address or name), else slackctl's
// default, else the first. Never the enterprise address: it refuses the real-time socket.
async function pickWorkspace() {
  const c = JSON.parse(await readFile(CREDS, "utf8"));
  const usable = (c.workspaces ?? []).filter((w) => w.auth?.xoxc_token && !/\.enterprise\.slack\.com/.test(w.workspace_url));
  const q = (settings.workspace ?? "").trim().toLowerCase();
  const w = q
    ? usable.find((w) => w.workspace_url.toLowerCase().includes(q) || (w.workspace_name ?? "").toLowerCase().includes(q))
    : usable.find((w) => w.workspace_url === c.default) || usable[0];
  if (!w) throw new Error(q ? T(`slackctl 里没有「${q}」这个工作区`, `No workspace "${q}" in slackctl`) : T("slackctl 里没有可用的工作区", "No usable workspace in slackctl"));
  const d = w.auth.xoxd_cookie ?? "";
  return {
    url: w.workspace_url.replace(/\/$/, ""),
    name: w.workspace_name || w.workspace_url,
    token: w.auth.xoxc_token,
    // Stored either way depending on where it was imported from: send it encoded, once
    cookie: `d=${encodeURIComponent(safeDecode(d))}`,
  };
}
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// ---- Slack Web API, as the signed-in person ----

class AuthError extends Error {}

async function api(method, params = {}) {
  const r = await fetch(`${ws_.url}/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ws_.token}`, Cookie: ws_.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) {
    const E = /invalid_auth|not_authed|token_revoked|token_expired|account_inactive/.test(j.error) ? AuthError : Error;
    throw new E(`${method}: ${j.error}`);
  }
  return j;
}

async function nameOf(user) {
  if (!user) return "";
  if (names.has(user)) return names.get(user);
  let n = user;
  try {
    const j = await api("users.info", { user });
    n = j.user?.profile?.display_name || j.user?.real_name || j.user?.name || user;
  } catch {}
  names.set(user, n);
  return n;
}

// Slack writes a mention as <@U123> (or <@U123|name>): whoever reads the event, a person or an agent, needs the name.
async function readable(text) {
  const ids = [...new Set([...(text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  const got = new Map(await Promise.all(ids.map(async (id) => [id, await nameOf(id)])));
  return (text ?? "").replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${got.get(id) ?? id}`);
}

// listen only flags D… DMs; a group DM it lets through (or a channel message) is told apart here, with the channel's
// member count (you included) for smallChannel. Asked once per channel an hour.
async function kindOf(channel) {
  if (channel.startsWith("D")) return { kind: "im" };
  const had = kinds.get(channel);
  if (had && Date.now() - had.at < KIND_TTL) return had;
  let k = { kind: "channel", at: Date.now() };
  try {
    const j = await api("conversations.info", { channel, include_num_members: "true" });
    k = { kind: j.channel?.is_im ? "im" : j.channel?.is_mpim ? "mpim" : "channel", members: j.channel?.num_members, name: j.channel?.name, at: Date.now() };
  } catch (e) {
    // Not cached for long: a failed lookup must not make a small channel's messages vanish for an hour
    log("conversations.info failed", channel, e.message);
    k.at = Date.now() - KIND_TTL + 60_000;
  }
  kinds.set(channel, k);
  return k;
}

/** smallChannel: a channel with at most this many members (you included) is heard in full; 0 = off. */
const smallMax = (st = settings) => Math.max(0, Math.floor(Number(st.smallChannel) || 0));
/** threads: a channel thread you said something in or were @-mentioned in is heard in full. On unless turned off. */
const threadsOn = (st = settings) => st.threads !== false;
/** afterMe: for this many minutes after you speak at a channel's top level, what others say there is heard; 0 = off. */
const afterMin = (st = settings) => Math.max(0, Math.floor(Number(st.afterMe ?? 60) || 0));
/** Whether listen has to pass every channel message (each of these is decided here, not by slackctl's filter). */
const needAll = (st = settings) => smallMax(st) > 0 || threadsOn(st) || afterMin(st) > 0;

// ---- conversations you're in ----
//
// Slack notifies you of replies in a thread you posted in or were @-mentioned in, and in a busy channel the talk right
// after you said something is usually to you. Neither comes with an @ (2026-11-25: a colleague answered the user's
// "什么环境" in the thread with just a link, and a channel discussion kept going under the user's messages; neither
// reached the secretary). So what you say, and where you're @-mentioned, is remembered here, on disk so a restart
// doesn't forget it: threads by "<channel>/<thread ts>" → last activity (ms), channels → when you last spoke at the
// top level (ms).

const INVOLVED = path.join(DATA, "involved.json");
const THREAD_DAYS = 30; // a thread quiet for longer is forgotten
let involved = { threads: {}, spoke: {} };
let saveTimer = null;

async function loadInvolved() {
  try {
    const j = JSON.parse(await readFile(INVOLVED, "utf8"));
    involved = { threads: j.threads ?? {}, spoke: j.spoke ?? {} };
  } catch {}
}

function saveInvolved() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const old = Date.now() - THREAD_DAYS * 86400_000;
    for (const [k, at] of Object.entries(involved.threads)) if (at < old) delete involved.threads[k];
    for (const [k, at] of Object.entries(involved.spoke)) if (at < old) delete involved.spoke[k];
    await mkdir(DATA, { recursive: true }).catch(() => {});
    await writeFile(INVOLVED, JSON.stringify(involved)).catch((e) => log("save involved failed", e.message));
  }, 2000);
}

function joinThread(channel, threadTs) {
  involved.threads[`${channel}/${threadTs}`] = Date.now();
  saveInvolved();
}

// A thread that started before this process was listening may hold something of yours it never saw (said before the
// add-on was updated, or while Gerdr was off): asked of Slack once, the answer kept. Later threads were seen whole, so
// they are never asked about, which keeps this to a handful of calls in a channel-heavy workspace.
const asked = new Map(); // thread key → when Slack said you're not in it
let askedThisMinute = { at: 0, n: 0 };
async function inThread(channel, threadTs) {
  const key = `${channel}/${threadTs}`;
  if (involved.threads[key]) return true;
  if (Number(threadTs) * 1000 >= connectedAt) return false;
  if (Date.now() - (asked.get(key) ?? 0) < 3600_000) return false;
  // conversations.replies is rate limited (tier 3, ~50 a minute): a burst of old threads waking up mustn't use it all
  if (Date.now() - askedThisMinute.at > 60_000) askedThisMinute = { at: Date.now(), n: 0 };
  if (++askedThisMinute.n > 20) return false;
  asked.set(key, Date.now());
  try {
    const j = await api("conversations.replies", { channel, ts: threadTs, limit: "200" });
    const mine = (j.messages ?? []).some((m) => m.user === me || (m.text ?? "").includes(`<@${me}>`) || (m.text ?? "").includes(`<@${me}|`));
    if (mine) joinThread(channel, threadTs);
    return mine;
  } catch (e) {
    log("conversations.replies failed", key, e.message);
    return false;
  }
}

// What you say in a channel: its thread is yours from then on (your top-level message starts one), and the top level
// is heard for a while
function onMine(ev, ck) {
  if (ck !== "channel") return;
  joinThread(ev.channel, ev.thread_ts || ev.ts);
  if (!ev.thread_ts || ev.subtype === "thread_broadcast") {
    involved.spoke[ev.channel] = Date.now();
    saveInvolved();
  }
}

// ---- the connection: `slackctl listen` ----

// `listen` came in slackctl v0.3.0; an older one says so instead of failing on every start
const listenOK = new Map(); // slackctl path → has listen
async function hasListen(bin) {
  if (!listenOK.has(bin)) listenOK.set(bin, await slackctl(["listen", "--help"]).then(() => true, () => false));
  return listenOK.get(bin);
}

const INSTALL = "go install github.com/cluas/slackctl/cmd/slackctl@latest";

async function connect() {
  clearTimeout(reconnectTimer);
  if (stopping) return;
  const old = tooOld();
  if (old) return status(old);
  const bin = await slackctlPath();
  if (!bin) {
    return status(
      T(
        `找不到 slackctl：先装（${INSTALL}，或 brew tap cluas/tap && brew install slackctl），或在设置里填它的路径`,
        `slackctl not found: install it (${INSTALL}, or brew tap cluas/tap && brew install slackctl), or set its path`,
      ),
    );
  }
  if (!(await hasListen(bin))) {
    return status(T(`slackctl 太旧，没有 listen（要 v0.3.0 以上）：${INSTALL}`, `slackctl is too old to listen (needs v0.3.0+): ${INSTALL}`));
  }
  try {
    try {
      ws_ = await pickWorkspace();
    } catch (e) {
      // No credentials yet (or not for that workspace): import them from the desktop app, which is the whole point
      status(T("从 Slack 桌面版导入登录…", "Importing the sign-in from Slack desktop…"));
      if (!(await importDesktop())) throw e;
      ws_ = await pickWorkspace();
    }
  } catch (e) {
    log("connect failed", e.message);
    return later(T(`连不上：${e.message}`, `Can't connect: ${e.message}`));
  }

  // DMs, group DMs and @-mentions only, no bots: listen drops the rest of the workspace's traffic itself. It keeps the
  // socket alive and reconnects on its own; it exits only when it can't go on (sign-in rejected, Slack refusing).
  // With smallChannel, threads or afterMe on, every channel message has to come through (yours too, to know where you
  // are) and onMessage sorts them. That costs nothing on Slack's side: the socket carries all of your channels either
  // way and slackctl filters locally (internal/listen/event.go), so only this process parses more lines.
  const args = ["listen", "--workspace", ws_.url, "--include-bots=false"];
  if (!needAll()) args.push("--mentions-or-dms");
  const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc = p;
  let ended = ""; // "auth" | "refused": the last control line before it exits
  let lastErr = "";
  createInterface({ input: p.stdout }).on("line", (line) => {
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      return;
    }
    if (f.type === "_connected" || f.type === "_reconnected") {
      backoff = 1000;
      me = f.self?.id ?? me;
      connectedAt ||= Date.now();
      status(T(`已连上 ${ws_.name}（${f.self?.name ?? me}）`, `Connected to ${ws_.name} (${f.self?.name ?? me})`));
      log(f.type, ws_.url, me);
    } else if (f.type === "_auth_error") ended = "auth";
    else if (f.type === "_connect_error") ended = "refused";
    if (f.type?.startsWith("_")) {
      if (f.error) lastErr = f.error;
      return;
    }
    if (f.type === "message" && p === proc) onMessage(f).catch((e) => log("message failed", e.message));
  });
  createInterface({ input: p.stderr }).on("line", (line) => {
    log("slackctl:", line);
    if (line.trim()) lastErr = line.trim();
  });
  p.on("error", (e) => (lastErr = e.message));
  p.on("close", async (code) => {
    // A listener replaced on purpose (settings changed, shutting down) isn't a disconnection
    if (proc !== p || stopping) return;
    proc = null;
    log("slackctl listen exited", code, ended, lastErr);
    if (ended === "auth") {
      const again = await importDesktop().catch((err) => (log("import failed", err.message), false));
      if (again) return later(T("登录过期，已从 Slack 桌面版重新导入，重连中…", "Sign-in expired; imported again from Slack desktop, reconnecting…"), 1000);
      return later(
        T(`登录失效（${lastErr}）：打开 Slack 桌面版登录后会自动重试`, `Sign-in no longer valid (${lastErr}): sign in to Slack desktop, it retries by itself`),
        10 * 60_000,
      );
    }
    if (ended === "refused") {
      return later(T(`Slack 不让这个工作区实时连接（${lastErr}）：在设置里换一个工作区`, `Slack refuses a real-time connection here (${lastErr}): pick another workspace in settings`), 10 * 60_000);
    }
    later(T(`连接断了（${lastErr || code}），重连中…`, `Disconnected (${lastErr || code}), reconnecting…`));
  });
}

function stopListen() {
  const p = proc;
  proc = null;
  p?.kill();
}

function later(text, wait) {
  status(text);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, wait ?? backoff);
  if (wait === undefined) backoff = Math.min(backoff * 2, 60_000);
}

// ---- Slack → events ----

const allowList = () =>
  (settings.allow ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

// A listen line: { type: "message", subtype?, channel, ts, thread_ts?, user, bot_id?, text, from_self, is_mention, is_dm }.
// It has no files and cuts text at 2000 characters, so every message is read again in full. Nothing in the line says
// whether files came with it: Slack's current uploads carry no file_share subtype, so "@a @b + a screenshot" arrived as
// just "@a @b" while only image-only messages (empty text) got their files. Only DMs, @-mentions, small channels and
// conversations you're in get this far, so one conversations.history call each is nothing next to the rate limit.

async function onMessage(ev) {
  // listen already drops edits, deletions, joins…; files, thread broadcasts and /me are someone saying something
  if (ev.subtype && !["file_share", "thread_broadcast", "me_message"].includes(ev.subtype)) return;
  if (ev.bot_id || !ev.user || !ev.channel || !ev.ts) return;
  // What you say yourself isn't a message *to* you, but it tells where you are in the conversation
  if (ev.from_self || ev.user === me) {
    if (!ev.is_dm && (threadsOn() || afterMin())) onMine(ev, (await kindOf(ev.channel)).kind);
    return;
  }
  const allow = allowList();
  if (allow.length && !allow.includes(ev.user)) return;

  const info = ev.is_dm ? { kind: "im" } : await kindOf(ev.channel);
  const ck = info.kind;
  const small = ck === "channel" && smallMax() > 0 && info.members > 0 && info.members <= smallMax();
  // A thread that's partly yours, or the top level right after you spoke there: the conversation is with you though
  // the message doesn't @ you
  let followed = false;
  let kind;
  if (ck === "im") kind = "direct";
  else if (ck === "mpim") {
    if (settings.groupDMs === false) return;
    kind = "direct";
  } else if (settings.mentions && ev.is_mention) {
    kind = "mention";
    // Being @-mentioned puts you in the thread (a top-level @ starts one): the answers under it come in too
    if (threadsOn()) joinThread(ev.channel, ev.thread_ts || ev.ts);
  }
  // A channel of a few people is talk among them, you included, like a group DM: a colleague's answer there comes
  // without a thread or an @ (2026-11-23: an agent waiting for one couldn't, as nothing but @-mentions came in). Its
  // own kind, so a panel that starts work on every DM doesn't on every word said here; following one still works.
  else if (small) kind = "channel";
  else if (ev.thread_ts && ev.thread_ts !== ev.ts && threadsOn() && (await inThread(ev.channel, ev.thread_ts))) {
    // Same key as the @-mention that brought you in, so whatever follows that conversation hears this
    kind = "thread";
    joinThread(ev.channel, ev.thread_ts);
  } else if (!ev.thread_ts && afterMin() && Date.now() - (involved.spoke[ev.channel] ?? 0) <= afterMin() * 60_000) {
    // The top level, keyed by the channel like a small channel's
    kind = "channel";
    followed = true;
  } else return;

  const full = await fullMessage(ev.channel, ev.ts, ev.thread_ts).catch((e) => (log("fetch message failed", e.message), null));
  if (full) ev = { ...ev, text: full.text ?? ev.text, files: full.files };
  const raw = ev.text ?? "";
  const text = await readable(raw);

  // Replies go in the message's thread, except a DM's or a small channel's top level, which is a conversation already.
  // An @-mention in a small channel too: keyed apart, a colleague's un-@'d answer right under it would be another
  // conversation, and a task following the mention would never hear it.
  const whole = kind === "direct" || small || followed;
  const threadTs = ev.thread_ts || (whole ? undefined : ev.ts);
  const who = await nameOf(ev.user);
  const files = await download(ev);
  // What was said just before, yours included (only others' messages become events): a reply like "新版没用" means
  // nothing to whoever reads it without the question it answers
  // Where it was said, in words, for whoever shows an answer going back: "回给 乔巴" read as a DM when it went to a
  // channel's thread (2026-11-23)
  const chan = info.name ? `#${info.name}` : "频道";
  const place = ck === "im" ? "私聊" : ck === "mpim" ? "群私聊" : threadTs ? `${chan} 的消息列` : chan;
  const context = await before(ev.channel, ev.ts, ev.thread_ts).catch((e) => (log("fetch context failed", e.message), []));
  out({
    type: "event",
    event: {
      id: `slack-me:${ev.channel}:${ev.ts}`,
      kind,
      // The conversation: a DM, group DM or small channel is one, its threads each another; in a channel you're
      // @-mentioned in, the thread
      key: whole && !ev.thread_ts ? ev.channel : `${ev.channel}/${threadTs}`,
      actor: ev.user,
      title: `${who}: ${text.split("\n")[0].slice(0, 80)}`,
      text: text + (files.length ? `\n\n${files.map((f) => (f.path ? `[附件] ${f.path}` : `[附件没下] ${f.name}：${f.error}`)).join("\n")}` : ""),
      url: `${ws_.url}/archives/${ev.channel}/p${ev.ts.replace(".", "")}`,
      data: { channel: ev.channel, channelType: ck, place, user: ev.user, userName: who, ts: ev.ts, threadTs, text: raw, files, workspace: ws_.url, context },
      // An answer goes out as you: subscribers that reply should mean to
      reply: { kind: "slack-me.send", data: { channel: ev.channel, threadTs } },
    },
  });
}

// The conversation's last few messages before ts (its thread's, or the DM's), oldest first, as Gerdr's chat sources
// hand them on (data.context, docs/dev/EVENTS.md in gerdr): { who, me, text, at }. Two days back at most: older
// talk is another conversation.
const CONTEXT = 8;
async function before(channel, ts, threadTs) {
  const oldest = String(Number(ts) - 2 * 86400);
  const j =
    threadTs && threadTs !== ts
      ? await api("conversations.replies", { channel, ts: threadTs, latest: ts, inclusive: "false", limit: "50" })
      : await api("conversations.history", { channel, latest: ts, oldest, inclusive: "false", limit: String(CONTEXT) });
  const msgs = (j.messages ?? [])
    .filter((m) => m.ts !== ts && Number(m.ts) < Number(ts) && Number(m.ts) >= Number(oldest) && (m.text || m.files?.length))
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .slice(-CONTEXT);
  const out = [];
  for (const m of msgs) {
    const mine = m.user === me;
    const name = m.bot_id && !m.user ? m.username || "bot" : await nameOf(m.user);
    const text = (await readable(m.text)).slice(0, 600) + (m.files?.length ? ` [附件：${m.files.map((f) => f.name).join("、")}]` : "");
    out.push({ who: name, me: mine, text, at: Math.round(Number(m.ts) * 1000) });
  }
  return out;
}

// One message as Slack stores it: a thread reply only shows up under its thread, anything else in the history
async function fullMessage(channel, ts, threadTs) {
  const j =
    threadTs && threadTs !== ts
      ? await api("conversations.replies", { channel, ts: threadTs, oldest: ts, latest: ts, inclusive: "true", limit: "5" })
      : await api("conversations.history", { channel, oldest: ts, latest: ts, inclusive: "true", limit: "1" });
  return (j.messages ?? []).find((m) => m.ts === ts) ?? null;
}

async function download(ev) {
  const max = Number(settings.maxFileMB ?? 20) * 1024 * 1024;
  if (!ev.files?.length) return [];
  const got = [];
  for (const f of ev.files) {
    const item = { name: f.name, mimetype: f.mimetype, size: f.size };
    if (!max) got.push({ ...item, error: T("没开下载", "downloads off") });
    else if (f.size > max) got.push({ ...item, error: T(`超过 ${settings.maxFileMB} MB`, `over ${settings.maxFileMB} MB`) });
    else {
      try {
        const r = await fetch(f.url_private_download || f.url_private, { headers: { Authorization: `Bearer ${ws_.token}`, Cookie: ws_.cookie } });
        // A session Slack doesn't accept here gets its sign-in page with 200, not an error
        if (!r.ok || (r.headers.get("content-type") ?? "").startsWith("text/html")) throw new Error(T("下不了", "couldn't download"));
        const dir = path.join(DATA, "files", ev.channel, ev.ts);
        await mkdir(dir, { recursive: true });
        const p = path.join(dir, path.basename(f.name || f.id));
        await writeFile(p, Buffer.from(await r.arrayBuffer()));
        got.push({ ...item, path: p });
      } catch (e) {
        got.push({ ...item, error: e.message });
      }
    }
  }
  return got;
}

// ---- events → Slack ----

// { kind: "slack-me.send", data: { channel, threadTs?, text } }: posted as you, by slackctl
// { ..., data: { channel, ts, react } }: an emoji reaction ("white_check_mark") on message ts instead, as you; the
// text is posted only when the reaction can't be added
async function onGerdrEvent(e) {
  if (e.kind !== "slack-me.send") return;
  const d = e.data ?? {};
  if (d.react && d.channel && d.ts) {
    const args = ["message", "react", "add", String(d.channel), String(d.ts), String(d.react)];
    if (ws_) args.unshift("--workspace", ws_.url);
    try {
      return void (await slackctl(args));
    } catch (err) {
      if (/already_reacted/.test(err.message)) return;
      log("react failed, posting the text", err.message);
    }
  }
  if (!d.channel || !d.text) return log("slack-me.send without channel / text, from", e.source);
  const args = ["message", "send", String(d.channel), String(d.text)];
  if (d.threadTs) args.push("--thread-ts", String(d.threadTs));
  if (ws_) args.unshift("--workspace", ws_.url);
  try {
    await slackctl(args);
  } catch (err) {
    log("send failed", err.message);
    status(T(`发不出去：${err.message}`, `Couldn't send: ${err.message}`));
  }
}

// ---- Gerdr ----

let gotSettings = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "hello") {
    if (m.lang) zh = m.lang === "zh";
  } else if (m.type === "settings") {
    const prev = settings;
    const first = !gotSettings;
    gotSettings = true;
    settings = m.settings ?? {};
    // smallChannel / threads / afterMe decide listen's flags (on: every channel message has to come through)
    if (first || prev.workspace !== settings.workspace || prev.slackctl !== settings.slackctl || needAll() !== needAll(prev)) {
      stopListen();
      backoff = 1000;
      (first ? loadInvolved() : Promise.resolve()).then(connect);
    }
  } else if (m.type === "event" && m.event) {
    onGerdrEvent(m.event).catch((e) => log("send failed", e.message));
  }
});
rl.on("close", () => {
  stopping = true;
  clearTimeout(reconnectTimer);
  stopListen();
  setTimeout(() => process.exit(0), 300);
});
