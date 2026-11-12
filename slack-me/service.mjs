// Messages people send *you* on Slack (direct messages, optionally @-mentions) → Gerdr events, and replies → Slack, as
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

// listen only flags D… DMs; a group DM it lets through (or a channel @-mention) is told apart here, asked once per channel.
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
  const p = spawn(bin, ["listen", "--workspace", ws_.url, "--mentions-or-dms", "--include-bots=false"], { stdio: ["ignore", "pipe", "pipe"] });
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
// just "@a @b" while only image-only messages (empty text) got their files. Only DMs and @-mentions get here, so one
// conversations.history call each is nothing next to the rate limit.

async function onMessage(ev) {
  // listen already drops edits, deletions, joins…; files, thread broadcasts and /me are someone saying something
  if (ev.subtype && !["file_share", "thread_broadcast", "me_message"].includes(ev.subtype)) return;
  // Bots (including a Gerdr bot answering in its own DM) and what you say yourself aren't messages *to* you
  if (ev.bot_id || ev.from_self || !ev.user || ev.user === me || !ev.channel || !ev.ts) return;
  const allow = allowList();
  if (allow.length && !allow.includes(ev.user)) return;

  const ck = ev.is_dm ? "im" : await kindOf(ev.channel);
  let kind;
  if (ck === "im") kind = "direct";
  else if (ck === "mpim") {
    if (settings.groupDMs === false) return;
    kind = "direct";
  } else if (settings.mentions && ev.is_mention) kind = "mention";
  else return;

  const full = await fullMessage(ev.channel, ev.ts, ev.thread_ts).catch((e) => (log("fetch message failed", e.message), null));
  if (full) ev = { ...ev, text: full.text ?? ev.text, files: full.files };
  const text = ev.text ?? "";

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
      stopListen();
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
  stopListen();
  setTimeout(() => process.exit(0), 300);
});
