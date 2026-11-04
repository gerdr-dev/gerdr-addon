// Slack → Gerdr events, and slack.send events → Slack. No dependencies: Node 22+ has WebSocket and fetch.
//
// Socket Mode (apps.connections.open with the app token, then a WebSocket the app dials out on): no public address,
// one connection per machine — why this is an add-on service and not a panel's function. What a message means and
// what to do about it is the subscriber's (a panel's triggers/, a session's `gerdr event watch`); this only reports.
//
// Talks to Gerdr in JSON lines: stdin gets hello / settings / event, stdout sends status / event.

import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA = process.env.GERDR_ADDON_DATA || process.cwd();
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const status = (text) => out({ type: "status", text });
const log = (...a) => console.error(new Date().toISOString(), ...a);

let settings = {};
let ws = null;
let stopping = false;
let me = { user: "", team: "", url: "" }; // auth.test: the bot's own user id, the workspace and its address
let backoff = 1000;
let reconnectTimer = null;
const names = new Map(); // user id → display name (users.info, best effort)

// ---- Slack Web API ----

async function api(method, body, token = settings.botToken) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(`${method}: ${j.error}${j.needed ? ` (needs ${j.needed})` : ""}`);
  return j;
}

async function nameOf(user) {
  if (!user) return "";
  if (names.has(user)) return names.get(user);
  let n = user;
  try {
    const j = await api("users.info", { user });
    n = j.user?.profile?.display_name || j.user?.real_name || j.user?.name || user;
  } catch {
    // no users:read scope: the id it is
  }
  names.set(user, n);
  return n;
}

// ---- the connection ----

function tokensOK() {
  return /^xoxb-/.test(settings.botToken ?? "") && /^xapp-/.test(settings.appToken ?? "");
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (stopping) return;
  if (!tokensOK()) {
    status("在设置里填 Bot Token（xoxb-）和 App Token（xapp-）后连接");
    return;
  }
  try {
    const a = await api("auth.test", {});
    me = { user: a.user_id, team: a.team, url: (a.url || "").replace(/\/$/, "") };
    const { url } = await api("apps.connections.open", {}, settings.appToken);
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      backoff = 1000;
      status(`已连上 ${me.team}`);
      log("connected", me.team, me.user);
    };
    sock.onmessage = (m) => onFrame(sock, m.data);
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (!stopping) later("连接断了，重连中…");
    };
    sock.onerror = (e) => log("socket error", e?.message ?? e);
  } catch (e) {
    log("connect failed", e.message);
    later(`连不上：${e.message}`);
  }
}

function later(text) {
  status(text);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 60_000);
}

function onFrame(sock, raw) {
  let f;
  try {
    f = JSON.parse(raw);
  } catch {
    return;
  }
  // Every envelope is acknowledged at once, or Slack sends it again
  if (f.envelope_id) sock.send(JSON.stringify({ envelope_id: f.envelope_id }));
  if (f.type === "disconnect") {
    // Slack rotates connections: open a fresh one before this one goes
    log("disconnect asked:", f.reason);
    sock.close();
    return;
  }
  if (f.type === "events_api" && f.payload?.event) {
    onSlackEvent(f.payload.event).catch((e) => log("event failed", e.message));
  }
}

// ---- Slack → events ----

const allowList = () =>
  (settings.allow ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

async function onSlackEvent(ev) {
  if (ev.type !== "message" && ev.type !== "app_mention") return;
  // Edits, deletions, joins… aren't someone saying something; files and thread broadcasts are
  if (ev.subtype && ev.subtype !== "file_share" && ev.subtype !== "thread_broadcast") return;
  if (ev.bot_id || !ev.user || ev.user === me.user) return;
  const allow = allowList();
  if (allow.length && !allow.includes(ev.user)) return;

  const text = ev.text ?? "";
  const mentioned = ev.type === "app_mention" || (me.user && text.includes(`<@${me.user}>`));
  let kind;
  if (ev.channel_type === "im") kind = "dm";
  else if (mentioned) kind = "mention";
  else if (settings.channelMessages) kind = "message";
  else return;

  const who = await nameOf(ev.user);
  const clean = text.replaceAll(`<@${me.user}>`, "").trim();
  const files = await download(ev);
  // A mention arrives twice (app_mention and message): the same id, so Gerdr keeps one
  const id = `slack:${ev.channel}:${ev.ts}`;
  // Replies go in the message's thread, except a DM's top level, which is a conversation already
  const threadTs = ev.thread_ts || (kind === "dm" ? undefined : ev.ts);
  out({
    type: "event",
    event: {
      id,
      kind,
      // key: the channel, or channel/thread for a message in a thread — subscribe to C0123* for both
      key: ev.thread_ts ? `${ev.channel}/${ev.thread_ts}` : ev.channel,
      title: `${who}: ${clean.split("\n")[0].slice(0, 80)}`,
      text: clean + (files.length ? `\n\n${files.map((f) => (f.path ? `[附件] ${f.path}` : `[附件没下] ${f.name}：${f.error}`)).join("\n")}` : ""),
      url: me.url ? `${me.url}/archives/${ev.channel}/p${ev.ts.replace(".", "")}` : undefined,
      data: { channel: ev.channel, channelType: ev.channel_type, user: ev.user, userName: who, ts: ev.ts, threadTs, text: clean, files, team: me.team },
      // Where an answer goes: a subscriber's ctx.events.reply comes back to us as slack.send with this plus its text
      reply: { kind: "slack.send", data: { channel: ev.channel, threadTs } },
    },
  });
}

async function download(ev) {
  const max = Number(settings.maxFileMB ?? 20) * 1024 * 1024;
  if (!ev.files?.length) return [];
  const got = [];
  for (const f of ev.files) {
    const item = { name: f.name, mimetype: f.mimetype, size: f.size };
    if (!max) {
      got.push({ ...item, error: "没开下载" });
      continue;
    }
    if (f.size > max) {
      got.push({ ...item, error: `超过 ${settings.maxFileMB} MB` });
      continue;
    }
    try {
      const r = await fetch(f.url_private_download || f.url_private, { headers: { Authorization: `Bearer ${settings.botToken}` } });
      // Without files:read Slack answers 200 with its login page, not an error
      if (!r.ok || (r.headers.get("content-type") ?? "").startsWith("text/html")) throw new Error("下不了（多半缺 files:read scope）");
      const dir = path.join(DATA, "files", ev.channel, ev.ts);
      await mkdir(dir, { recursive: true });
      const p = path.join(dir, path.basename(f.name || f.id));
      await writeFile(p, Buffer.from(await r.arrayBuffer()));
      got.push({ ...item, path: p });
    } catch (e) {
      got.push({ ...item, error: e.message });
    }
  }
  return got;
}

// ---- events → Slack ----

// A panel answering: { kind: "slack.send", data: { channel, threadTs?, text } }
async function onGerdrEvent(e) {
  if (e.kind !== "slack.send") return;
  const d = e.data ?? {};
  if (!d.channel || !d.text) {
    log("slack.send without channel / text, from", e.source);
    return;
  }
  try {
    await api("chat.postMessage", { channel: d.channel, thread_ts: d.threadTs || undefined, text: String(d.text), mrkdwn: true });
  } catch (err) {
    log("post failed", err.message);
    status(`发不出去：${err.message}`);
  }
}

// ---- Gerdr ----

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "settings") {
    const prev = settings;
    settings = m.settings ?? {};
    if (prev.botToken !== settings.botToken || prev.appToken !== settings.appToken) {
      ws?.close();
      ws = null;
      backoff = 1000;
      connect();
    }
  } else if (m.type === "event" && m.event) {
    onGerdrEvent(m.event).catch((e) => log("send failed", e.message));
  }
});
// stdin closing means Gerdr is going: let go and leave
rl.on("close", () => {
  stopping = true;
  clearTimeout(reconnectTimer);
  ws?.close();
  setTimeout(() => process.exit(0), 300);
});
