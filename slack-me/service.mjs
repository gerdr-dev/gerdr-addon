// Messages people send *you* on Slack (direct messages, optionally @-mentions) → Gerdr events, and replies → Slack, as
// you. No Slack app: it uses the session the Slack desktop app is signed in with, which slackctl imports
// (`slackctl auth import-desktop` → ~/.config/agent-slack/credentials.json: an xoxc token plus the d cookie).
//
// slackctl has no way to listen, only one-off commands, so receiving is done here: the same credentials open Slack's
// real-time socket (rtm.connect, what the desktop client and wee-slack use). Measured on an Enterprise Grid: a DM
// arrives on the connection of any of its workspaces (DMs are org-wide), and the enterprise address itself refuses
// rtm.connect (enterprise_is_restricted) — so one connection, to one workspace, is enough and the right one.
// Sending goes through `slackctl message send`, so what the add-on posts is exactly what an agent with slackctl would.
//
// Talks to Gerdr in JSON lines: stdin gets hello / settings / event, stdout sends status / event.

import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
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

// Node 22 is the first with a global WebSocket. An older one says so in Settings → Add-ons rather than crash-looping.
const NEED_NODE = 22;
const tooOld = () =>
  Number(process.versions.node.split(".")[0]) < NEED_NODE || typeof WebSocket !== "function"
    ? T(
        `需要 Node ${NEED_NODE} 以上（带内置 WebSocket），现在是 v${process.versions.node}（${process.execPath}）`,
        `Needs Node ${NEED_NODE}+ (with a built-in WebSocket); this is v${process.versions.node} (${process.execPath})`,
      )
    : "";

let settings = {};
let ws = null; // the open socket
let ws_ = null; // { url, name, token, cookie }: the workspace we're connected to
let me = "";
let stopping = false;
let backoff = 1000;
let reconnectTimer = null;
let pingTimer = null;
let lastFrame = 0;
let lastImport = 0;
const names = new Map(); // user id → display name
const kinds = new Map(); // channel id → "im" | "mpim" | "channel"

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

// The socket's message events don't say what kind of conversation they're in. A D… id is always a DM; anything else
// is asked once.
async function kindOf(channel) {
  if (channel.startsWith("D")) return "im";
  if (kinds.has(channel)) return kinds.get(channel);
  let k = "channel";
  try {
    const j = await api("conversations.info", { channel });
    k = j.channel?.is_im ? "im" : j.channel?.is_mpim ? "mpim" : "channel";
  } catch {}
  kinds.set(channel, k);
  return k;
}

// ---- the connection ----

async function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (stopping) return;
  const old = tooOld();
  if (old) return status(old);
  if (!(await slackctlPath())) {
    return status(
      T(
        "找不到 slackctl：先装（go install github.com/cluas/slackctl/cmd/slackctl@latest，或 brew tap cluas/tap && brew install slackctl），或在设置里填它的路径",
        "slackctl not found: install it (go install github.com/cluas/slackctl/cmd/slackctl@latest, or brew tap cluas/tap && brew install slackctl), or set its path",
      ),
    );
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
    const a = await api("auth.test");
    me = a.user_id;
    const r = await api("rtm.connect");
    const sock = new WebSocket(r.url, { headers: { Cookie: ws_.cookie } });
    ws = sock;
    let id = 0;
    sock.onopen = () => {
      backoff = 1000;
      lastFrame = Date.now();
      status(T(`已连上 ${ws_.name}（${a.user}）`, `Connected to ${ws_.name} (${a.user})`));
      log("connected", ws_.url, me);
      // Slack drops a socket that goes quiet without saying so: ping, and give up on one that stopped answering
      pingTimer = setInterval(() => {
        if (Date.now() - lastFrame > 90_000) return sock.close();
        sock.send(JSON.stringify({ id: ++id, type: "ping" }));
      }, 30_000);
    };
    sock.onmessage = (m) => {
      lastFrame = Date.now();
      onFrame(sock, m.data);
    };
    sock.onclose = () => {
      // A socket replaced on purpose (settings changed) isn't a disconnection: the new one is already on its way
      if (ws !== sock) return;
      clearInterval(pingTimer);
      ws = null;
      if (!stopping) later(T("连接断了，重连中…", "Disconnected, reconnecting…"));
    };
    sock.onerror = (e) => log("socket error", e?.message ?? e);
  } catch (e) {
    log("connect failed", e.message);
    if (e instanceof AuthError) {
      const again = await importDesktop().catch((err) => (log("import failed", err.message), false));
      if (again) return later(T("登录过期，已从 Slack 桌面版重新导入，重连中…", "Sign-in expired; imported again from Slack desktop, reconnecting…"), 1000);
      return later(
        T(`登录失效（${e.message}）：打开 Slack 桌面版登录后会自动重试`, `Sign-in no longer valid (${e.message}): sign in to Slack desktop, it retries by itself`),
        10 * 60_000,
      );
    }
    later(T(`连不上：${e.message}`, `Can't connect: ${e.message}`));
  }
}

function later(text, wait) {
  status(text);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, wait ?? backoff);
  if (wait === undefined) backoff = Math.min(backoff * 2, 60_000);
}

function onFrame(sock, raw) {
  let f;
  try {
    f = JSON.parse(raw);
  } catch {
    return;
  }
  // Slack is moving this connection: take a new one
  if (f.type === "goodbye") return sock.close();
  if (f.type === "message") onMessage(f).catch((e) => log("message failed", e.message));
}

// ---- Slack → events ----

const allowList = () =>
  (settings.allow ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

async function onMessage(ev) {
  // Edits, deletions, joins… aren't someone saying something; files and thread broadcasts are
  if (ev.subtype && ev.subtype !== "file_share" && ev.subtype !== "thread_broadcast") return;
  // Bots (including a Gerdr bot answering in its own DM) and what you say yourself aren't messages *to* you
  if (ev.bot_id || !ev.user || ev.user === me || !ev.channel || !ev.ts) return;
  const allow = allowList();
  if (allow.length && !allow.includes(ev.user)) return;

  const text = ev.text ?? "";
  const ck = await kindOf(ev.channel);
  let kind;
  if (ck === "im") kind = "direct";
  else if (ck === "mpim") {
    if (settings.groupDMs === false) return;
    kind = "direct";
  } else if (settings.mentions && text.includes(`<@${me}>`)) kind = "mention";
  else return;

  // Replies go in the message's thread, except a DM's top level, which is a conversation already
  const threadTs = ev.thread_ts || (kind === "direct" ? undefined : ev.ts);
  const who = await nameOf(ev.user);
  const files = await download(ev);
  out({
    type: "event",
    event: {
      id: `slack-me:${ev.channel}:${ev.ts}`,
      kind,
      // The conversation: a DM (or group DM) is one, its threads each another; in a channel, the thread
      key: kind === "direct" && !ev.thread_ts ? ev.channel : `${ev.channel}/${threadTs}`,
      actor: ev.user,
      title: `${who}: ${text.split("\n")[0].slice(0, 80)}`,
      text: text + (files.length ? `\n\n${files.map((f) => (f.path ? `[附件] ${f.path}` : `[附件没下] ${f.name}：${f.error}`)).join("\n")}` : ""),
      url: `${ws_.url}/archives/${ev.channel}/p${ev.ts.replace(".", "")}`,
      data: { channel: ev.channel, channelType: ck, user: ev.user, userName: who, ts: ev.ts, threadTs, text, files, workspace: ws_.url },
      // An answer goes out as you: subscribers that reply should mean to
      reply: { kind: "slack-me.send", data: { channel: ev.channel, threadTs } },
    },
  });
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
async function onGerdrEvent(e) {
  if (e.kind !== "slack-me.send") return;
  const d = e.data ?? {};
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
    if (first || prev.workspace !== settings.workspace || prev.slackctl !== settings.slackctl) {
      const s = ws;
      ws = null;
      s?.close();
      backoff = 1000;
      connect();
    }
  } else if (m.type === "event" && m.event) {
    onGerdrEvent(m.event).catch((e) => log("send failed", e.message));
  }
});
rl.on("close", () => {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  ws?.close();
  setTimeout(() => process.exit(0), 300);
});
