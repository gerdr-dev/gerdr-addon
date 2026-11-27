// Messages people send *you* on Feishu / Lark (direct messages, optionally group @-mentions and replies in threads
// you're in) → Gerdr events, and replies → Feishu / Lark, as *you*. Uses the official `lark-cli` (@larksuite/cli)
// signed in as your personal account (--as user), so no desktop-cookie hacking is needed and what this sees matches
// what an agent with lark-cli sees.
//
// Feishu's WebSocket event subscription only delivers bot-scoped events, so personal messages are polled:
// - Primary path: `lark-cli im +messages-search --as user` (1 call for p2p DMs + 1 call for group @-mentions, with a
//   5-minute overlap window deduplicated by message_id so search indexing lag never drops a message).
// - Fallback path: if `search:message` scope is not granted, falls back to `lark-cli im +chat-list --as user --types p2p
//   --sort active_time` + `im +chat-messages-list` on recently active DMs.
// - Followed group threads: `lark-cli im +threads-messages-list --as user` on threads where you were @-mentioned or replied.
// - Bot notifications: chat history for explicitly selected groups, using a separate cursor for each group.
//
// First run only records the current baseline so enabling it does not flood the inbox with history.
// Talks to Gerdr in JSON lines: stdin gets hello / settings / event, stdout sends status / event.

import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATA = process.env.GERDR_ADDON_DATA || process.cwd();
const STATE = path.join(DATA, "state.json");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const status = (text) => out({ type: "status", text });
const log = (...a) => console.error(new Date().toISOString(), ...a);

let zh = /^zh/i.test(process.env.GERDR_LANG || process.env.LANG || "zh");
const T = (z, e) => (zh ? z : e);

const CONTEXT_LIMIT = 8;
const OVERLAP_MS = 5 * 60_000;
const MAX_BACKFILL_MS = 2 * 3600_000;
const THREAD_KEEP_MS = 7 * 86400_000;
const MAX_TRACKED_THREADS = 20;
const MAX_SEEN = 5000;

let settings = { interval: 30, mentions: true, threads: true, excludeMuted: false, maxFileMB: 20 };
let bin = "";
let me = null; // { openId, userName, brand }
let timer = null;
let polling = false;
let stopping = false;
let loginWarned = false;
let searchScopeRetryAt = 0;
let state = {
  initialized: false,
  lastPollAt: 0,
  seen: [], // newest-last array of message_ids
  threads: {}, // thread_id (omt_... or om_...) -> { chatId, chatName, rootId, lastAt }
  botChats: {},
};
let seenSet = new Set();

// ---- finding & running lark-cli ----

async function findLarkCli() {
  const want = (settings.larkCli || "lark-cli").replace(/^~(?=\/)/, os.homedir());
  if (want.includes("/")) return want;
  const dirs = [
    ...(process.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.dirname(process.execPath),
  ];
  for (const root of [
    path.join(os.homedir(), ".version-fox", "cache", "nodejs"),
    path.join(os.homedir(), ".nvm", "versions", "node"),
  ]) {
    for (const v of await readdir(root).catch(() => [])) {
      dirs.push(path.join(root, v, "bin"));
      for (const w of await readdir(path.join(root, v)).catch(() => [])) {
        dirs.push(path.join(root, v, w, "bin"));
      }
    }
  }
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, want);
    if (await access(p, constants.X_OK).then(() => true, () => false)) return p;
  }
  return "";
}

class AuthError extends Error {}
class ScopeError extends Error {
  constructor(msg, scopes = []) {
    super(msg);
    this.scopes = scopes;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJsonMaybe(text) {
  const s = (text ?? "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // Sometimes CLI prints a notice line before/after JSON; try extracting the JSON object
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1));
      } catch {}
    }
    return null;
  }
}

async function larkCli(args, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await larkCliOnce(args, opts);
    } catch (e) {
      if (attempt >= 2 || !/rate.?limit|too many requests|99991400/i.test(e.message)) throw e;
      await sleep(1500 * 2 ** attempt);
    }
  }
}

async function larkCliOnce(args, opts = {}) {
  if (!bin) bin = await findLarkCli();
  if (!bin) {
    throw new Error(T("找不到 lark-cli（先跑 npx @larksuite/cli@latest install）", "lark-cli not found (run npx @larksuite/cli@latest install)"));
  }
  const profile = String(settings.profile ?? "").trim();
  const fullArgs = profile ? ["--profile", profile, ...args] : args;
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    PATH: [path.dirname(bin), path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(":"),
  };
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      fullArgs,
      { timeout: opts.timeout ?? 60_000, maxBuffer: 20 << 20, env, cwd: opts.cwd || DATA },
      (err, stdout, stderr) => {
        const j = parseJsonMaybe(stdout) ?? parseJsonMaybe(stderr);
        // `auth status` returns a plain JSON object without `ok` wrapper
        if (args[0] === "auth" && args[1] === "status" && j && !j.error) return resolve(j);
        if (!err && j && j.ok !== false && !j.error) return resolve(j);

        const eObj = j?.error;
        const msg = eObj?.message || (stderr || stdout || err?.message || "failed").trim().split("\n").pop();
        if (eObj?.subtype === "missing_scope" || Array.isArray(eObj?.missing_scopes)) {
          return reject(new ScopeError(msg, eObj?.missing_scopes ?? []));
        }
        if (
          eObj?.type === "authentication" ||
          eObj?.type === "authorization" ||
          /not logged in|unauthori|expired|invalid.*token|login required|need.*auth|no user/i.test(msg)
        ) {
          return reject(new AuthError(msg));
        }
        reject(new Error(`lark-cli ${args.slice(0, 2).join(" ")}: ${msg}`));
      },
    );
  });
}

// ---- state persistence ----

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(STATE, "utf8"));
    state = {
      initialized: Boolean(raw.initialized),
      lastPollAt: Number(raw.lastPollAt) || 0,
      seen: Array.isArray(raw.seen) ? raw.seen.slice(-MAX_SEEN) : [],
      threads: raw.threads && typeof raw.threads === "object" ? raw.threads : {},
      botChats: raw.botChats && typeof raw.botChats === "object" ? raw.botChats : {},
    };
    seenSet = new Set(state.seen);
  } catch {
    state = { initialized: false, lastPollAt: 0, seen: [], threads: {}, botChats: {} };
    seenSet = new Set();
  }
}

async function saveState() {
  const cutoff = Date.now() - THREAD_KEEP_MS;
  for (const [k, v] of Object.entries(state.threads)) {
    if (!v || (v.lastAt || 0) < cutoff) delete state.threads[k];
  }
  if (state.seen.length > MAX_SEEN) {
    state.seen = state.seen.slice(-MAX_SEEN);
    seenSet = new Set(state.seen);
  }
  await mkdir(DATA, { recursive: true });
  const tmp = `${STATE}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, STATE);
}

function markSeen(id) {
  if (!id || seenSet.has(id)) return false;
  seenSet.add(id);
  state.seen.push(id);
  return true;
}

function trackThread(threadKey, info) {
  if (!threadKey) return;
  state.threads[threadKey] = {
    ...(state.threads[threadKey] ?? {}),
    ...info,
    lastAt: Math.max(state.threads[threadKey]?.lastAt || 0, info.lastAt || Date.now()),
  };
}

// ---- formatting helpers ----

export function formatLocalIso(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

export function parseTimeMs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  // lark-cli formats create_time as local "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss"
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (local) {
    return new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +(local[6] || 0)).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Extract downloadable image/file/audio/video resource keys from lark-cli's rendered message content.
 * lark-cli renders:
 *   ![Image](img_xxx)
 *   <file key="file_xxx" name="foo.pdf" .../>
 *   <audio key="file_xxx" duration="3s"/>
 *   <video key="file_xxx" .../>
 */
export function extractResources(content) {
  const s = String(content ?? "");
  const items = [];
  const seen = new Set();
  for (const m of s.matchAll(/!\[[^\]]*\]\((img_[A-Za-z0-9_-]+)\)/g)) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, type: "image", name: `${key}.png` });
  }
  for (const m of s.matchAll(/<(file|audio|video)\b([^>]*)\/?>/g)) {
    const tag = m[1];
    const attrs = m[2] ?? "";
    const key = attrs.match(/\bkey="([^"]+)"/)?.[1];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const name = attrs.match(/\bname="([^"]+)"/)?.[1] || (tag === "audio" ? `${key}.opus` : tag === "video" ? `${key}.mp4` : key);
    items.push({ key, type: "file", name });
  }
  return items;
}

export function cleanMessageText(content, mentions = []) {
  let s = String(content ?? "");
  // If raw JSON slipped through (e.g. text {"text":"..."}), unwrap it
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const j = JSON.parse(s);
      if (typeof j.text === "string") s = j.text;
    } catch {}
  }
  for (const m of mentions ?? []) {
    if (m?.key && m?.name) s = s.replaceAll(m.key, `@${m.name}`);
  }
  // Normalize <at user_id="ou_xxx">Name</at> if present
  s = s.replace(/<at\b[^>]*>([^<]*)<\/at>/g, (_, name) => (name ? `@${name}` : ""));
  return s.trim();
}

function senderIdOf(m) {
  return String(m?.sender?.id ?? m?.sender?.open_id ?? m?.sender?.sender_id?.open_id ?? "");
}

function senderNameOf(m) {
  return String(m?.sender?.name || m?.chat_partner?.name || senderIdOf(m) || "");
}

function isBotSender(m) {
  const t = String(m?.sender?.sender_type ?? m?.sender?.type ?? "").toLowerCase();
  return t === "app" || t === "bot";
}

// ---- attachments download via lark-cli ----

async function downloadResources(chatId, messageId, items) {
  if (!items.length) return [];
  const maxMB = Number(settings.maxFileMB ?? 20);
  const maxBytes = maxMB * 1024 * 1024;
  const got = [];
  const dir = path.join(DATA, "files", chatId || "chat", messageId);
  for (const it of items) {
    if (!maxBytes) {
      got.push({ name: it.name, error: T("没开下载", "downloads off") });
      continue;
    }
    try {
      await mkdir(dir, { recursive: true });
      const safeName = path.basename(it.name).replace(/[\\/:*?"<>|]/g, "_") || it.key;
      const res = await larkCli(
        [
          "im",
          "+messages-resources-download",
          "--as",
          "user",
          "--message-id",
          messageId,
          "--file-key",
          it.key,
          "--type",
          it.type,
          "--output",
          safeName,
          "--format",
          "json",
        ],
        { cwd: dir },
      );
      const savedRel = res?.data?.saved_path || res?.data?.path || res?.data?.output || safeName;
      const fullPath = path.isAbsolute(savedRel) ? savedRel : path.join(dir, savedRel);
      const st = await stat(fullPath).catch(() => null);
      if (st && st.size > maxBytes) {
        got.push({ name: path.basename(fullPath), size: st.size, error: T(`超过 ${maxMB} MB`, `over ${maxMB} MB`) });
        continue;
      }
      got.push({ name: path.basename(fullPath), size: st?.size, path: fullPath });
    } catch (e) {
      got.push({ name: it.name, error: e.message });
    }
  }
  return got;
}

// ---- conversation context (best effort) ----

async function fetchContext(chatId, messageId, threadId, createTimeMs, curPosition) {
  try {
    const args = threadId
      ? ["im", "+threads-messages-list", "--as", "user", "--thread", threadId, "--order", "desc", "--page-size", "12", "--no-reactions", "--format", "json"]
      : ["im", "+chat-messages-list", "--as", "user", "--chat-id", chatId, "--order", "desc", "--page-size", "12", "--no-reactions", "--format", "json"];
    const r = await larkCli(args);
    const msgs = r?.data?.messages ?? [];
    const oldest = createTimeMs - 2 * 86400_000;
    const curPos = Number(curPosition);
    const hasCurPos = Number.isFinite(curPos) && curPos > 0;
    return msgs
      .filter((m) => {
        if (!m || m.deleted || m.message_id === messageId || m.msg_type === "system") return false;
        const at = parseTimeMs(m.create_time);
        if (at < oldest) return false;
        const mPos = Number(m.message_position);
        if (hasCurPos && Number.isFinite(mPos) && mPos > 0) return mPos < curPos;
        return at <= createTimeMs;
      })
      .sort((a, b) => {
        const pa = Number(a.message_position);
        const pb = Number(b.message_position);
        if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
        return parseTimeMs(a.create_time) - parseTimeMs(b.create_time);
      })
      .slice(-CONTEXT_LIMIT)
      .map((m) => {
        const sid = senderIdOf(m);
        const mine = Boolean(me?.openId && sid === me.openId);
        const text = cleanMessageText(m.content, m.mentions).slice(0, 600);
        return { who: mine ? me.userName || "我" : senderNameOf(m), me: mine, text, at: parseTimeMs(m.create_time) };
      })
      .filter((c) => c.text);
  } catch (e) {
    log("fetchContext skipped:", e.message);
    return [];
  }
}

// ---- auth & polling ----

async function checkAuth() {
  const s = await larkCli(["auth", "status"]);
  const u = s?.identities?.user;
  if (!u || !u.available || !u.openId) {
    throw new AuthError(u?.message || T("lark-cli 未登录用户账号", "lark-cli user account not signed in"));
  }
  me = {
    openId: u.openId,
    userName: u.userName || u.openId,
    brand: s.brand || "feishu",
  };
  return me;
}

const allowList = () =>
  (settings.allow ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

async function pollViaSearch(sinceIso) {
  const candidates = [];
  // 1. Direct messages (p2p)
  const dmRes = await larkCli([
    "im",
    "+messages-search",
    "--as",
    "user",
    "--query",
    "",
    "--chat-type",
    "p2p",
    "--exclude-sender-type",
    "bot",
    "--start",
    sinceIso,
    "--page-size",
    "50",
    "--no-reactions",
    "--format",
    "json",
  ]);
  for (const m of dmRes?.data?.messages ?? []) {
    candidates.push({ msg: m, kind: "direct", chatType: "p2p" });
  }

  // 2. Group @-mentions (optional)
  if (settings.mentions !== false) {
    const atRes = await larkCli([
      "im",
      "+messages-search",
      "--as",
      "user",
      "--query",
      "",
      "--chat-type",
      "group",
      "--is-at-me",
      "--exclude-sender-type",
      "bot",
      "--start",
      sinceIso,
      "--page-size",
      "50",
      "--no-reactions",
      "--format",
      "json",
    ]);
    for (const m of atRes?.data?.messages ?? []) {
      candidates.push({ msg: m, kind: "mention", chatType: "group" });
    }
  }
  return candidates;
}

async function pollViaChatList(sinceIso) {
  const args = [
    "im",
    "+chat-list",
    "--as",
    "user",
    "--types",
    "p2p",
    "--sort",
    "active_time",
    "--page-size",
    "20",
    "--format",
    "json",
  ];
  if (settings.excludeMuted) args.push("--exclude-muted");
  const cl = await larkCli(args);
  const chats = cl?.data?.chats ?? [];
  const candidates = [];
  // Check most recently active human DMs (skip bot assistant chats; cap at 15 per poll)
  for (const c of chats.filter((x) => x.p2p_target_type !== "bot").slice(0, 15)) {
    if (!c.chat_id || c.chat_status === "dissolved") continue;
    try {
      const ml = await larkCli([
        "im",
        "+chat-messages-list",
        "--as",
        "user",
        "--chat-id",
        c.chat_id,
        "--start",
        sinceIso,
        "--order",
        "desc",
        "--page-size",
        "15",
        "--no-reactions",
        "--format",
        "json",
      ]);
      for (const m of ml?.data?.messages ?? []) {
        candidates.push({
          msg: {
            ...m,
            chat_id: m.chat_id || c.chat_id,
            chat_type: "p2p",
            chat_name: m.chat_name || c.name,
          },
          kind: "direct",
          chatType: "p2p",
        });
      }
    } catch (e) {
      log("chat-messages-list failed", c.chat_id, e.message);
    }
  }
  return candidates;
}

async function pollTrackedThreads() {
  if (settings.threads === false) return [];
  const entries = Object.entries(state.threads)
    .sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0))
    .slice(0, MAX_TRACKED_THREADS);
  const candidates = [];
  for (const [threadKey, info] of entries) {
    try {
      const r = await larkCli([
        "im",
        "+threads-messages-list",
        "--as",
        "user",
        "--thread",
        threadKey,
        "--order",
        "desc",
        "--page-size",
        "15",
        "--no-reactions",
        "--format",
        "json",
      ]);
      for (const m of r?.data?.messages ?? []) {
        candidates.push({
          msg: {
            ...m,
            chat_id: m.chat_id || info.chatId,
            chat_type: "group",
            chat_name: m.chat_name || info.chatName,
            thread_id: m.thread_id || threadKey,
            root_id: m.root_id || info.rootId,
          },
          kind: "thread",
          chatType: "group",
        });
      }
    } catch (e) {
      log("threads-messages-list failed", threadKey, e.message);
    }
  }
  return candidates;
}

async function pollBotChats(now) {
  const chats = new Set(String(settings.botChats ?? "").split(/[,，\s]+/).filter((id) => /^oc_[\w-]+$/.test(id)));
  for (const chatId of Object.keys(state.botChats)) {
    if (!chats.has(chatId)) delete state.botChats[chatId];
  }

  let emitted = 0;
  const failed = [];
  for (const chatId of chats) {
    const cursor = state.botChats[chatId] ??= { since: Math.ceil(now / 1000) * 1000, checkedAt: now };
    const start = Math.max(cursor.since, cursor.checkedAt - OVERLAP_MS);
    const args = [
      "im", "+chat-messages-list", "--as", "user", "--chat-id", chatId,
      "--start", formatLocalIso(start), "--order", "asc", "--page-size", "50", "--no-reactions",
    ];
    try {
      let token = "";
      do {
        const result = await larkCli(token ? [...args, "--page-token", token] : args);
        for (const msg of result.data?.messages ?? []) {
          if (msg.chat_id !== chatId || !msg.message_id || msg.deleted || !isBotSender(msg)) continue;
          const actor = senderIdOf(msg);
          const body = cleanMessageText(msg.content, msg.mentions);
          if (!actor || !body || !markSeen(msg.message_id)) continue;
          const who = senderNameOf(msg);
          out({
            type: "event",
            event: {
              id: `feishu-me:${chatId}:${msg.message_id}`,
              kind: "bot.message",
              key: chatId,
              actor,
              title: `${who}: ${body.split("\n")[0].slice(0, 80)}`,
              text: body,
              url: msg.message_app_link || undefined,
              data: {
                chat_id: chatId,
                chatType: "group",
                message_id: msg.message_id,
                userName: who,
                place: msg.chat_name || chatId,
                text: body,
                brand: me?.brand || "feishu",
              },
            },
          });
          emitted++;
        }
        const next = result.data?.page_token;
        if (result.data?.has_more && (!next || next === token)) throw new Error("Missing next page");
        token = result.data?.has_more ? next : "";
      } while (token);
      cursor.checkedAt = now;
    } catch (e) {
      failed.push(chatId);
      log("bot chat poll failed", chatId, e.message);
    }
  }
  return { emitted, failed, count: chats.size };
}

async function emitMessage(item) {
  const { msg, kind, chatType } = item;
  const chatId = msg.chat_id;
  const msgId = msg.message_id;
  const sid = senderIdOf(msg);
  const who = senderNameOf(msg);
  const at = parseTimeMs(msg.create_time) || Date.now();
  const isDM = chatType === "p2p" || kind === "direct";

  // Root id for conversation key & replies
  const rootId = msg.root_id || (isDM ? undefined : msgId);
  const threadId = msg.thread_id || undefined;
  if (!isDM && settings.threads !== false) {
    trackThread(threadId || rootId, { chatId, chatName: msg.chat_name || "", rootId, lastAt: at });
  }

  const rawText = cleanMessageText(msg.content, msg.mentions);
  const resources = extractResources(msg.content);
  const [files, context] = await Promise.all([
    downloadResources(chatId, msgId, resources),
    fetchContext(chatId, msgId, threadId, at, msg.message_position),
  ]);

  const groupName = msg.chat_name || T("群聊", "group");
  const place = isDM
    ? T("私聊", "DM")
    : threadId || rootId || kind === "mention" || kind === "thread"
      ? T(`${groupName} 的话题`, `${groupName} thread`)
      : groupName;

  const fileLines = files.map((f) => (f.path ? `[附件] ${f.path}` : `[附件没下] ${f.name}：${f.error}`)).join("\n");
  const fullText = rawText + (fileLines ? `${rawText ? "\n\n" : ""}${fileLines}` : "");
  const titleBody = (rawText || files[0]?.name || `[${msg.msg_type || "message"}]`).split("\n")[0].slice(0, 80);

  const replyData = isDM
    ? { chat_id: chatId }
    : {
        chat_id: chatId,
        reply_to: rootId || msgId,
        reply_in_thread: Boolean(threadId || kind === "mention" || kind === "thread"),
      };

  out({
    type: "event",
    event: {
      id: `feishu-me:${chatId}:${msgId}`,
      kind,
      key: isDM && !msg.root_id ? chatId : `${chatId}/${rootId}`,
      actor: sid,
      title: `${who}: ${titleBody}`,
      text: fullText,
      url: msg.message_app_link || undefined,
      data: {
        chat_id: chatId,
        chatType,
        message_id: msgId,
        root_id: rootId,
        thread_id: threadId,
        open_id: sid,
        user: sid,
        userName: who,
        place,
        text: rawText,
        files,
        context,
        brand: me?.brand || "feishu",
      },
      reply: { kind: "feishu-me.send", data: replyData },
    },
  });
}

async function poll() {
  if (polling || stopping) return;
  polling = true;
  clearTimeout(timer);
  try {
    await checkAuth();
    const now = Date.now();
    const first = !state.initialized;
    const baseFrom = first
      ? now - 30 * 60_000
      : Math.max(now - MAX_BACKFILL_MS, (state.lastPollAt || now) - OVERLAP_MS);
    const sinceIso = formatLocalIso(baseFrom);

    let candidates = [];
    let mode = "search";
    if (Date.now() >= searchScopeRetryAt) {
      try {
        candidates = await pollViaSearch(sinceIso);
        searchScopeRetryAt = 0;
      } catch (e) {
        if (e instanceof ScopeError && e.scopes.some((s) => s.includes("search:message"))) {
          searchScopeRetryAt = Date.now() + 10 * 60_000;
          log("search:message scope missing, falling back to +chat-list:", e.message);
          mode = "chat-list";
          candidates = await pollViaChatList(sinceIso);
        } else {
          throw e;
        }
      }
    } else {
      mode = "chat-list";
      candidates = await pollViaChatList(sinceIso);
    }

    if (!first) {
      const threadMsgs = await pollTrackedThreads();
      candidates.push(...threadMsgs);
    }

    // Sort oldest-first and deduplicate within this batch (prefer mention > direct > thread if same id)
    const byId = new Map();
    for (const c of candidates) {
      const id = c.msg?.message_id;
      if (!id) continue;
      if (!byId.has(id) || c.kind === "mention") byId.set(id, c);
    }
    const ordered = [...byId.values()].sort((a, b) => parseTimeMs(a.msg.create_time) - parseTimeMs(b.msg.create_time));

    const allow = allowList();
    let emitted = 0;
    for (const item of ordered) {
      const m = item.msg;
      if (!m?.message_id || !m?.chat_id || isBotSender(m)) continue;
      if (seenSet.has(m.message_id)) continue;
      markSeen(m.message_id);

      if (first) continue; // Baseline only on very first run
      if (m.deleted || m.msg_type === "system") continue;
      const sid = senderIdOf(m);
      if (!sid || (me?.openId && sid === me.openId)) continue;
      if (allow.length && !allow.includes(sid)) continue;

      await emitMessage(item);
      emitted++;
    }

    const bots = await pollBotChats(now);
    emitted += bots.emitted;
    state.initialized = true;
    state.lastPollAt = now;
    await saveState();
    loginWarned = false;

    const clock = new Date().toLocaleTimeString(zh ? "zh-CN" : "en-GB", { hour12: false });
    const modeNote = mode === "chat-list" ? T("（会话列表模式）", " (chat-list mode)") : "";
    const botNote = bots.failed.length
      ? T(`；机器人消息读取失败：${bots.failed.join(", ")}`, `; could not read bot messages: ${bots.failed.join(", ")}`)
      : bots.count ? T(`；已查 ${bots.count} 个机器人消息群`, `; checked ${bots.count} groups for bot messages`) : "";
    status(
      T(
        `${clock} 已查（${me.userName}）${modeNote}${first ? "：首次运行，已记下现状" : emitted ? `：新收 ${emitted} 条` : ""}${botNote}`,
        `Checked ${clock} (${me.userName})${modeNote}${first ? ": first run, baseline saved" : emitted ? `: ${emitted} new` : ""}${botNote}`,
      ),
    );
  } catch (e) {
    log("poll failed:", e.message);
    if (e instanceof ScopeError) {
      // Allow retrying search mode immediately once user grants scopes
      searchScopeRetryAt = 0;
      const pFlag = String(settings.profile ?? "").trim() ? ` --profile ${String(settings.profile).trim()}` : "";
      const scopeHint = e.scopes.length
        ? `lark-cli${pFlag} auth login --scope "${e.scopes.join(" ")}"`
        : `lark-cli${pFlag} auth login --domain im --scope "im:message.send_as_user"`;
      status(
        T(
          `缺少飞书 IM 权限：在终端跑 ${scopeHint}（或 lark-cli${pFlag} auth login --domain im --scope "im:message.send_as_user"）`,
          `Missing Feishu IM scope(s): run ${scopeHint} (or lark-cli${pFlag} auth login --domain im --scope "im:message.send_as_user")`,
        ),
      );
      emitLoginAlert(scopeHint);
    } else if (e instanceof AuthError) {
      const pFlag = String(settings.profile ?? "").trim() ? ` --profile ${String(settings.profile).trim()}` : "";
      status(
        T(
          `lark-cli 未登录或登录过期：在终端跑 lark-cli${pFlag} auth login --domain im --scope "im:message.send_as_user"`,
          `lark-cli not signed in or expired: run lark-cli${pFlag} auth login --domain im --scope "im:message.send_as_user"`,
        ),
      );
      emitLoginAlert(`lark-cli${pFlag} auth login --domain im --scope "im:message.send_as_user"`);
    } else {
      status(T(`查不了：${e.message}`, `Poll failed: ${e.message}`));
    }
  } finally {
    polling = false;
    schedule();
  }
}

function emitLoginAlert(cmd) {
  if (loginWarned) return;
  loginWarned = true;
  const hour = new Date().toISOString().slice(0, 13);
  out({
    type: "event",
    event: {
      id: `feishu-me:login:${hour}`,
      kind: "login",
      key: "login",
      title: T("飞书 CLI 需要登录 / 授权 IM 权限", "lark-cli needs sign-in / IM scopes"),
      text: T(
        `飞书私聊插件暂时收不到消息，请在终端运行 \`${cmd}\` 完成授权。`,
        `Feishu DM add-on cannot poll right now. Run \`${cmd}\` in a terminal to authorize.`,
      ),
    },
  });
}

function schedule() {
  clearTimeout(timer);
  if (stopping) return;
  const sec = Math.min(3600, Math.max(10, Number(settings.interval) || 30));
  timer = setTimeout(poll, sec * 1000);
}

// ---- Gerdr events → Feishu (as you) ----

async function sendReply(d) {
  const text = String(d.text);
  let res = null;

  if (d.reply_to) {
    const attempts = d.reply_in_thread
      ? [
          ["--markdown", text, "--reply-in-thread"],
          ["--text", text, "--reply-in-thread"],
          ["--markdown", text],
          ["--text", text],
        ]
      : [
          ["--markdown", text],
          ["--text", text],
        ];
    for (const extra of attempts) {
      try {
        res = await larkCli(["im", "+messages-reply", "--as", "user", "--message-id", String(d.reply_to), ...extra, "--format", "json"]);
        const sentId = res?.data?.message_id;
        if (sentId) markSeen(sentId);
        if (d.chat_id && d.reply_to) {
          trackThread(res?.data?.thread_id || String(d.reply_to), { chatId: String(d.chat_id), rootId: String(d.reply_to), lastAt: Date.now() });
        }
        await saveState().catch(() => {});
        return;
      } catch (err) {
        log("reply attempt failed:", err.message);
      }
    }
  }

  if (!d.chat_id) throw new Error("missing chat_id");
  let lastErr;
  for (const flag of ["--markdown", "--text"]) {
    try {
      res = await larkCli(["im", "+messages-send", "--as", "user", "--chat-id", String(d.chat_id), flag, text, "--format", "json"]);
      const sentId = res?.data?.message_id;
      if (sentId) {
        markSeen(sentId);
        await saveState().catch(() => {});
      }
      return;
    } catch (err) {
      lastErr = err;
      log(`send attempt (${flag}) failed:`, err.message);
    }
  }
  throw lastErr;
}

async function onGerdrEvent(e) {
  if (e.kind !== "feishu-me.send") return;
  const d = e.data ?? {};
  const reactTarget = d.message_id || d.reply_to;
  if (d.react && reactTarget) {
    try {
      await larkCli([
        "im",
        "reactions",
        "create",
        "--as",
        "user",
        "--params",
        JSON.stringify({ message_id: String(reactTarget) }),
        "--data",
        JSON.stringify({ reaction_type: { emoji_type: String(d.react) } }),
        "--format",
        "json",
      ]);
      return;
    } catch (err) {
      log("react failed, posting text:", err.message);
    }
  }
  if ((!d.chat_id && !d.reply_to) || !d.text) {
    log("feishu-me.send without chat_id / text, from", e.source);
    return;
  }
  try {
    await sendReply(d);
  } catch (err) {
    log("send failed:", err.message);
    status(T(`发不出去：${err.message}`, `Couldn't send: ${err.message}`));
  }
}

// ---- Gerdr IPC ----

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
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
      settings = { interval: 30, mentions: true, threads: true, excludeMuted: false, maxFileMB: 20, ...(m.settings ?? {}) };
      if (prev.larkCli !== settings.larkCli) bin = "";
      if (!gotSettings) {
        gotSettings = true;
        loadState().then(poll);
      } else {
        searchScopeRetryAt = 0;
        if (prev.profile !== settings.profile) {
          me = null;
          loginWarned = false;
          poll();
        } else if (prev.interval !== settings.interval) {
          schedule();
        }
      }
    } else if (m.type === "event" && m.event) {
      onGerdrEvent(m.event).catch((e) => log("reply failed:", e.message));
    }
  });
  rl.on("close", () => {
    stopping = true;
    clearTimeout(timer);
    setTimeout(() => process.exit(0), 300);
  });
}
