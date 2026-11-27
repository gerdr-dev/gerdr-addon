// Feishu / Lark → Gerdr events, and feishu.send events → Feishu / Lark. No dependencies: Node 22+ has WebSocket and fetch.
//
// Persistent WebSocket connection (Feishu's long-connection event subscription: POST /callback/ws/endpoint for the
// signed WebSocket URL, then binary pbbp2.Frame protobuf envelopes for pings, pongs, fragmented events and ACKs): no
// public callback address, one connection per machine — why this is an add-on service and not a panel's function.
//
// Talks to Gerdr in JSON lines: stdin gets hello / settings / event, stdout sends status / event.

import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATA = process.env.GERDR_ADDON_DATA || process.cwd();
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const status = (text) => out({ type: "status", text });
const log = (...a) => console.error(new Date().toISOString(), ...a);

let zh = /^zh/i.test(process.env.GERDR_LANG || process.env.LANG || "zh");
const T = (z, e) => (zh ? z : e);

const NEED_NODE = 22;
const nodeMajor = Number(process.versions.node.split(".")[0]);
const tooOld = () =>
  nodeMajor < NEED_NODE
    ? T(
        `需要 Node ${NEED_NODE} 以上，现在用的是 v${process.versions.node}（${process.execPath}）：升级后在设置里关掉再打开这个插件`,
        `Needs Node ${NEED_NODE}+, running v${process.versions.node} (${process.execPath}): upgrade and toggle this add-on off and on`,
      )
    : typeof WebSocket !== "function" || typeof fetch !== "function"
      ? T(
          `这个 Node（v${process.versions.node}，${process.execPath}）没有内置的 WebSocket / fetch：换一个标准的 Node ${NEED_NODE}+`,
          `This Node (v${process.versions.node}, ${process.execPath}) has no global WebSocket / fetch: use a standard Node ${NEED_NODE}+`,
        )
      : "";

const DOMAINS = {
  feishu: { base: "https://open.feishu.cn", label: () => T("飞书", "Feishu") },
  lark: { base: "https://open.larksuite.com", label: () => "Lark" },
};

// ---- minimal protobuf codec for Feishu pbbp2.Frame & pbbp2.Header ----
//
// message Header { required string key = 1; required string value = 2; }
// message Frame {
//   required uint64 SeqID = 1;
//   required uint64 LogID = 2;
//   required int32 service = 3;
//   required int32 method = 4;            // 0 = control (ping/pong), 1 = data (event)
//   repeated Header headers = 5;
//   optional string payload_encoding = 6;
//   optional string payload_type = 7;
//   optional bytes payload = 8;
//   optional string LogIDNew = 9;
// }

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const buf = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return buf;
}

function writeVarint(v) {
  let n = typeof v === "bigint" ? BigInt.asUintN(64, v) : BigInt.asUintN(64, BigInt(Math.trunc(v || 0)));
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Uint8Array.from(bytes);
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, pos };
    shift += 7n;
    if (shift > 63n) throw new Error("protobuf varint too long");
  }
  throw new Error("protobuf varint truncated");
}

function skipField(buf, pos, wireType) {
  if (wireType === 0) return readVarint(buf, pos).pos;
  if (wireType === 1) return pos + 8;
  if (wireType === 2) {
    const { value, pos: next } = readVarint(buf, pos);
    return next + Number(value);
  }
  if (wireType === 5) return pos + 4;
  throw new Error(`unsupported protobuf wireType ${wireType}`);
}

function writeTag(field, wireType) {
  return writeVarint((field << 3) | wireType);
}

function writeBytesField(field, bytes) {
  return concatBytes([writeTag(field, 2), writeVarint(bytes.length), bytes]);
}

function writeStringField(field, str) {
  return writeBytesField(field, enc.encode(String(str)));
}

function encodeHeader(h) {
  return concatBytes([writeStringField(1, h.key ?? ""), writeStringField(2, h.value ?? "")]);
}

function decodeHeader(buf, start, end) {
  let pos = start;
  let key = "";
  let value = "";
  while (pos < end) {
    const t = readVarint(buf, pos);
    pos = t.pos;
    const field = Number(t.value >> 3n);
    const wire = Number(t.value & 7n);
    if (field === 1 && wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const n = Number(l.value);
      key = dec.decode(buf.subarray(pos, pos + n));
      pos += n;
    } else if (field === 2 && wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const n = Number(l.value);
      value = dec.decode(buf.subarray(pos, pos + n));
      pos += n;
    } else {
      pos = skipField(buf, pos, wire);
    }
  }
  return { key, value };
}

export function encodeFrame(frame) {
  const parts = [
    writeTag(1, 0),
    writeVarint(frame.SeqID ?? 0n),
    writeTag(2, 0),
    writeVarint(frame.LogID ?? 0n),
    writeTag(3, 0),
    writeVarint(frame.service ?? 0),
    writeTag(4, 0),
    writeVarint(frame.method ?? 0),
  ];
  for (const h of frame.headers ?? []) parts.push(writeBytesField(5, encodeHeader(h)));
  if (frame.payloadEncoding) parts.push(writeStringField(6, frame.payloadEncoding));
  if (frame.payloadType) parts.push(writeStringField(7, frame.payloadType));
  if (frame.payload && frame.payload.length) parts.push(writeBytesField(8, frame.payload));
  if (frame.LogIDNew) parts.push(writeStringField(9, frame.LogIDNew));
  return concatBytes(parts);
}

export function decodeFrame(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  const frame = {
    SeqID: 0n,
    LogID: 0n,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: "",
    payloadType: "",
    payload: new Uint8Array(0),
    LogIDNew: "",
  };
  while (pos < buf.length) {
    const t = readVarint(buf, pos);
    pos = t.pos;
    const field = Number(t.value >> 3n);
    const wire = Number(t.value & 7n);
    if (field === 1 && wire === 0) {
      const v = readVarint(buf, pos);
      frame.SeqID = v.value;
      pos = v.pos;
    } else if (field === 2 && wire === 0) {
      const v = readVarint(buf, pos);
      frame.LogID = v.value;
      pos = v.pos;
    } else if (field === 3 && wire === 0) {
      const v = readVarint(buf, pos);
      frame.service = Number(BigInt.asIntN(32, v.value));
      pos = v.pos;
    } else if (field === 4 && wire === 0) {
      const v = readVarint(buf, pos);
      frame.method = Number(BigInt.asIntN(32, v.value));
      pos = v.pos;
    } else if (field === 5 && wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const n = Number(l.value);
      frame.headers.push(decodeHeader(buf, pos, pos + n));
      pos += n;
    } else if (field === 6 && wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const n = Number(l.value);
      frame.payloadEncoding = dec.decode(buf.subarray(pos, pos + n));
      pos += n;
    } else if (field === 7 && wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const n = Number(l.value);
      frame.payloadType = dec.decode(buf.subarray(pos, pos + n));
      pos += n;
    } else if (field === 8 && wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const n = Number(l.value);
      frame.payload = buf.slice(pos, pos + n);
      pos += n;
    } else if (field === 9 && wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const n = Number(l.value);
      frame.LogIDNew = dec.decode(buf.subarray(pos, pos + n));
      pos += n;
    } else {
      pos = skipField(buf, pos, wire);
    }
  }
  return frame;
}

// ---- fragmented event reassembly ----

export class FragmentCache {
  constructor() {
    this.map = new Map();
  }
  merge(messageId, sum, seq, data) {
    if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      throw new Error(`invalid fragment metadata (sum=${sum}, seq=${seq})`);
    }
    if (sum === 1) return data;
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.at > 15_000) this.map.delete(k);
    }
    let entry = this.map.get(messageId);
    if (!entry) {
      entry = { parts: new Array(sum).fill(null), at: now };
      this.map.set(messageId, entry);
    } else if (entry.parts.length !== sum) {
      throw new Error(`inconsistent fragment sum (${sum} != ${entry.parts.length})`);
    }
    entry.parts[seq] = data;
    if (!entry.parts.every(Boolean)) return null;
    this.map.delete(messageId);
    return concatBytes(entry.parts);
  }
  clear() {
    this.map.clear();
  }
}

// ---- state ----

let settings = { domain: "feishu", maxFileMB: 20 };
let ws = null;
let generation = 0;
let stopping = false;
let bot = { openId: "", appName: "" };
let tokenCache = { token: "", expiresAt: 0 };
let tokenPromise = null;
let pingTimer = null;
let livenessTimer = null;
let reconnectTimer = null;
let backoff = 1000;
let wsConfig = { serviceId: 0, pingInterval: 120_000, reconnectInterval: 120_000, reconnectNonce: 30_000 };
const fragments = new FragmentCache();

// Caches: user open_id → name, chat_id → name, recent event/message ids for dedup
const names = new Map(); // open_id → { name, at, ok }
const chats = new Map(); // chat_id → { name, at }
const seenEvents = new Set();
const NAME_TTL = 3600_000;
const NAME_FAIL_TTL = 600_000;
const CHAT_TTL = 3600_000;
let noContactScope = false;

// Threads / reply chains the bot is part of: "<chat_id>/<root_id>". Messages in them come through without an @.
const THREADS = path.join(DATA, "threads.json");
let threads = new Set();
readFile(THREADS, "utf8").then(
  (t) => {
    try {
      threads = new Set(JSON.parse(t));
    } catch {}
  },
  () => {},
);
function joinThread(chatId, rootId) {
  if (!chatId || !rootId) return;
  const k = `${chatId}/${rootId}`;
  if (threads.has(k)) return;
  threads.add(k);
  if (threads.size > 2000) threads = new Set([...threads].slice(-2000));
  mkdir(DATA, { recursive: true })
    .then(() => writeFile(THREADS, JSON.stringify([...threads])))
    .catch((e) => log("threads not saved", e.message));
}

function rememberSeen(id) {
  if (!id) return false;
  if (seenEvents.has(id)) return true;
  seenEvents.add(id);
  if (seenEvents.size > 2000) {
    const keep = [...seenEvents].slice(-1000);
    seenEvents.clear();
    for (const x of keep) seenEvents.add(x);
  }
  return false;
}

// ---- Feishu Open API ----

function domainInfo() {
  return DOMAINS[settings.domain === "lark" ? "lark" : "feishu"];
}

async function getTenantToken(force = false) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (tokenPromise && !force) return tokenPromise;
  const p = (async () => {
    const r = await fetch(`${domainInfo().base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: settings.appId, app_secret: settings.appSecret }),
    });
    const j = await r.json().catch(() => ({ code: -1, msg: `HTTP ${r.status}` }));
    if (j.code !== 0 || !j.tenant_access_token) {
      throw new Error(`tenant_access_token: code=${j.code} ${j.msg || ""}`.trim());
    }
    const expireSec = Number(j.expire) || 7200;
    tokenCache = { token: j.tenant_access_token, expiresAt: Date.now() + Math.max(60, expireSec - 120) * 1000 };
    return tokenCache.token;
  })();
  tokenPromise = p;
  try {
    return await p;
  } finally {
    if (tokenPromise === p) tokenPromise = null;
  }
}

const TOKEN_EXPIRED_CODES = new Set([99991661, 99991663, 99991664, 99991668]);

async function api(method, apiPath, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getTenantToken(attempt > 0);
    const url = `${domainInfo().base}/open-apis${apiPath}`;
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({ code: -1, msg: `HTTP ${r.status}` }));
    if (j.code === 0) return j;
    if (attempt === 0 && TOKEN_EXPIRED_CODES.has(Number(j.code))) {
      tokenCache = { token: "", expiresAt: 0 };
      continue;
    }
    const err = new Error(`${apiPath}: code=${j.code} ${j.msg || ""}`.trim());
    err.code = j.code;
    throw err;
  }
}

async function fetchBotInfo() {
  const j = await api("GET", "/bot/v3/info/");
  const b = j.bot ?? j.data?.bot ?? {};
  bot = { openId: b.open_id || "", appName: b.app_name || "" };
  return bot;
}

async function nameOf(openId) {
  if (!openId) return "";
  const hit = names.get(openId);
  if (hit && Date.now() - hit.at < (hit.ok ? NAME_TTL : NAME_FAIL_TTL)) return hit.name;
  if (noContactScope) return hit?.name || openId;
  let name = openId;
  let ok = false;
  try {
    const j = await api("GET", `/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`);
    const u = j.data?.user;
    if (u?.name || u?.en_name) {
      name = u.name || u.en_name;
      ok = true;
    }
  } catch (e) {
    // Missing contact:user.base:readonly scope: don't hammer the API on every message
    if (Number(e.code) === 99991672) {
      noContactScope = true;
      log("contact scope missing, using open_id as fallback:", e.message);
    } else {
      log("nameOf failed", openId, e.message);
    }
  }
  names.set(openId, { name, at: Date.now(), ok });
  return name;
}

async function chatNameOf(chatId) {
  if (!chatId) return "";
  const hit = chats.get(chatId);
  if (hit && Date.now() - hit.at < CHAT_TTL) return hit.name;
  let name = "";
  try {
    const j = await api("GET", `/im/v1/chats/${encodeURIComponent(chatId)}`);
    name = j.data?.name || "";
  } catch (e) {
    log("chatNameOf failed", chatId, e.message);
  }
  chats.set(chatId, { name, at: Date.now() });
  return name;
}

// ---- WebSocket long connection ----

function credsOK() {
  return Boolean((settings.appId ?? "").trim() && (settings.appSecret ?? "").trim());
}

function clearTimers() {
  clearTimeout(pingTimer);
  pingTimer = null;
  clearTimeout(livenessTimer);
  livenessTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function closeSocket() {
  clearTimers();
  const s = ws;
  ws = null;
  if (s) {
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
    try {
      s.close();
    } catch {}
  }
}

async function pullConnectConfig() {
  const r = await fetch(`${domainInfo().base}/callback/ws/endpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", locale: zh ? "zh" : "en" },
    body: JSON.stringify({ AppID: settings.appId.trim(), AppSecret: settings.appSecret.trim() }),
  });
  const j = await r.json().catch(() => ({ code: -1, msg: `HTTP ${r.status}` }));
  if (j.code !== 0 || !j.data?.URL) {
    const err = new Error(j.msg || `code=${j.code}`);
    err.code = j.code;
    throw err;
  }
  const url = j.data.URL;
  const parsed = new URL(url);
  const serviceId = Number(parsed.searchParams.get("service_id") || 0);
  const cfg = j.data.ClientConfig || {};
  return {
    url,
    serviceId,
    pingInterval: (Number(cfg.PingInterval) || 120) * 1000,
    reconnectInterval: (Number(cfg.ReconnectInterval) || 120) * 1000,
    reconnectNonce: (Number(cfg.ReconnectNonce) || 30) * 1000,
  };
}

function sendFrame(sock, frame) {
  if (sock?.readyState === WebSocket.OPEN) {
    sock.send(encodeFrame(frame));
  }
}

function sendPing(sock, gen) {
  if (stopping || gen !== generation || ws !== sock || sock.readyState !== WebSocket.OPEN) return;
  sendFrame(sock, {
    SeqID: 0n,
    LogID: 0n,
    service: wsConfig.serviceId,
    method: 0,
    headers: [{ key: "type", value: "ping" }],
  });
  clearTimeout(livenessTimer);
  // If no pong / inbound frame arrives within 30s (e.g. after sleep), force a clean reconnect
  livenessTimer = setTimeout(() => {
    if (gen !== generation || ws !== sock) return;
    log("ws pong timeout, reconnecting");
    try {
      sock.close();
    } catch {}
  }, 30_000);
}

function schedulePing(sock, gen, immediate = false) {
  clearTimeout(pingTimer);
  if (immediate) sendPing(sock, gen);
  pingTimer = setTimeout(() => {
    sendPing(sock, gen);
    schedulePing(sock, gen, false);
  }, wsConfig.pingInterval);
}

async function connect() {
  clearTimers();
  if (stopping) return;
  const old = tooOld();
  if (old) {
    status(old);
    return;
  }
  if (!credsOK()) {
    status(T("在设置里填 App ID 和 App Secret 后连接", "Fill App ID and App Secret in settings to connect"));
    return;
  }

  const gen = ++generation;
  try {
    // Validate credentials & learn bot open_id / name first
    await fetchBotInfo().catch((e) => {
      log("bot/v3/info failed (continuing):", e.message);
    });
    if (stopping || gen !== generation) return;

    const cfg = await pullConnectConfig();
    if (stopping || gen !== generation) return;
    wsConfig = cfg;

    const sock = new WebSocket(cfg.url);
    sock.binaryType = "arraybuffer";
    ws = sock;

    sock.onopen = () => {
      if (gen !== generation) {
        try {
          sock.close();
        } catch {}
        return;
      }
      backoff = 1000;
      const who = bot.appName ? `${domainInfo().label()} · ${bot.appName}` : domainInfo().label();
      status(T(`已连上 ${who}`, `Connected to ${who}`));
      log("connected", domainInfo().base, bot.appName, bot.openId, `serviceId=${wsConfig.serviceId}`, `ping=${wsConfig.pingInterval}ms`);
      schedulePing(sock, gen, true);
    };

    sock.onmessage = (m) => {
      if (gen !== generation) return;
      clearTimeout(livenessTimer);
      livenessTimer = null;
      handleSocketMessage(sock, m.data).catch((e) => log("frame error:", e.message));
    };

    sock.onclose = (ev) => {
      if (ws === sock) {
        ws = null;
        clearTimers();
      }
      if (!stopping && gen === generation) {
        log("ws closed", ev?.code, ev?.reason || "");
        later(T("连接断了，重连中…", "Disconnected, reconnecting…"));
      }
    };

    sock.onerror = (e) => {
      log("socket error", e?.message ?? e?.type ?? e);
    };
  } catch (e) {
    if (stopping || gen !== generation) return;
    log("connect failed", e.code ?? "", e.message);
    const code = Number(e.code);
    if (code === 514 || code === 403 || code === 10003 || code === 20001) {
      later(
        T(`鉴权失败（${e.message}）：检查 App ID / App Secret 和平台版本`, `Auth failed (${e.message}): check App ID / App Secret and platform`),
        30_000,
      );
    } else if (code === 1000040350) {
      later(T("连接数超过上限（多台设备共用同一个应用？），稍后重试…", "Connection limit exceeded, retrying later…"), 60_000);
    } else {
      later(T(`连不上：${e.message}`, `Couldn't connect: ${e.message}`));
    }
  }
}

function later(text, wait) {
  status(text);
  clearTimeout(reconnectTimer);
  const delay = wait ?? backoff;
  reconnectTimer = setTimeout(connect, delay);
  if (wait === undefined) backoff = Math.min(backoff * 2, 60_000);
}

async function handleSocketMessage(sock, raw) {
  let bytes;
  if (raw instanceof Uint8Array) bytes = raw;
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (typeof Blob !== "undefined" && raw instanceof Blob) bytes = new Uint8Array(await raw.arrayBuffer());
  else return;

  const frame = decodeFrame(bytes);
  const hdrs = Object.fromEntries(frame.headers.map((h) => [h.key, h.value]));

  if (frame.method === 0) {
    // Control frame (ping / pong)
    if (hdrs.type === "pong" && frame.payload?.length) {
      try {
        const pong = JSON.parse(dec.decode(frame.payload));
        if (pong.PingInterval) wsConfig.pingInterval = Number(pong.PingInterval) * 1000;
        if (pong.ReconnectInterval) wsConfig.reconnectInterval = Number(pong.ReconnectInterval) * 1000;
        if (pong.ReconnectNonce) wsConfig.reconnectNonce = Number(pong.ReconnectNonce) * 1000;
        log("pong", `pingInterval=${wsConfig.pingInterval}ms`);
      } catch (e) {
        log("invalid pong payload:", e.message);
      }
    }
    return;
  }

  if (frame.method !== 1) {
    log("unknown frame method:", frame.method, hdrs.type);
    return;
  }
  if (hdrs.type !== "event") {
    log("non-event data frame:", hdrs.type);
    return;
  }

  log("rx frame", `msg=${hdrs.message_id}`, `seq=${hdrs.seq}/${hdrs.sum}`, `bytes=${frame.payload?.length ?? 0}`);

  const merged = fragments.merge(hdrs.message_id || "", Number(hdrs.sum || 1), Number(hdrs.seq || 0), frame.payload);
  if (!merged) return;

  // Acknowledge immediately (Feishu retries if no ACK within 3s; downloading files / looking up users runs async after ACK)
  const start = Date.now();
  sendFrame(sock, {
    ...frame,
    headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - start) }],
    payload: enc.encode(JSON.stringify({ code: 200 })),
  });

  let body;
  try {
    body = JSON.parse(dec.decode(merged));
  } catch (e) {
    log("event json parse failed:", e.message);
    return;
  }

  onFeishuEvent(body).catch((e) => log("event failed:", e.message));
}

// ---- message content parsing ----

export function parseMessageContent(messageType, rawContent, mentions = [], botOpenId = "") {
  let obj = {};
  try {
    obj = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent || {};
  } catch {
    return { text: String(rawContent ?? "").trim(), attachments: [] };
  }

  const attachments = [];
  let text = "";

  const replaceMentions = (s) => {
    let out = String(s ?? "");
    for (const m of mentions ?? []) {
      if (!m?.key) continue;
      if (botOpenId && m.id?.open_id === botOpenId) {
        out = out.replaceAll(m.key, "");
      } else {
        out = out.replaceAll(m.key, `@${m.name || m.id?.open_id || ""}`);
      }
    }
    out = out.replaceAll("@_all", T("@所有人", "@all"));
    return out;
  };

  switch (messageType) {
    case "text":
      text = replaceMentions(obj.text ?? "");
      break;
    case "post": {
      const body = obj.content ? obj : obj.zh_cn || obj.en_us || obj.ja_jp || Object.values(obj).find((v) => v && Array.isArray(v.content)) || {};
      const lines = [];
      if (body.title) lines.push(replaceMentions(body.title));
      for (const para of body.content ?? []) {
        if (!Array.isArray(para)) continue;
        let line = "";
        for (const el of para) {
          if (!el) continue;
          if (el.tag === "text") line += el.text ?? "";
          else if (el.tag === "a") line += el.href ? `[${el.text || el.href}](${el.href})` : el.text ?? "";
          else if (el.tag === "at") {
            const uid = el.user_id || el.open_id || "";
            if (botOpenId && uid === botOpenId) continue;
            line += `@${el.user_name || uid}`;
          } else if (el.tag === "img" && el.image_key) {
            attachments.push({ key: el.image_key, type: "image", name: `${el.image_key}.png`, mimetype: "image/png" });
          } else if (el.tag === "media" && el.file_key) {
            attachments.push({ key: el.file_key, type: "file", name: el.file_name || `${el.file_key}.mp4` });
          } else if (el.tag === "code_block") {
            line += `\n\`\`\`${el.language || ""}\n${el.text ?? ""}\n\`\`\`\n`;
          } else if (el.tag === "md") {
            line += el.text ?? "";
          } else if (el.tag === "hr") {
            line += "\n---\n";
          } else if (el.tag === "emotion") {
            line += el.emoji_type ? `[${el.emoji_type}]` : "";
          }
        }
        lines.push(replaceMentions(line));
      }
      text = lines.join("\n");
      break;
    }
    case "image":
      if (obj.image_key) attachments.push({ key: obj.image_key, type: "image", name: `${obj.image_key}.png`, mimetype: "image/png" });
      break;
    case "file":
      if (obj.file_key) attachments.push({ key: obj.file_key, type: "file", name: obj.file_name || obj.file_key });
      break;
    case "audio":
      if (obj.file_key) attachments.push({ key: obj.file_key, type: "file", name: `${obj.file_key}.opus`, mimetype: "audio/opus" });
      text = T("[语音消息]", "[audio message]");
      break;
    case "media":
      if (obj.file_key) attachments.push({ key: obj.file_key, type: "file", name: obj.file_name || `${obj.file_key}.mp4` });
      break;
    case "sticker":
      text = T("[表情]", "[sticker]");
      break;
    case "merge_forward":
      text = T("[合并转发消息]", "[forwarded messages]");
      break;
    case "interactive":
      text = extractInteractiveText(obj) || T("[卡片消息]", "[interactive card]");
      break;
    default:
      text = `[${messageType || "unknown"}]`;
      break;
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), attachments };
}

function extractInteractiveText(obj) {
  const parts = [];
  const title = obj.header?.title?.content || obj.title;
  if (title) parts.push(title);
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node !== "object") return;
    if (typeof node.content === "string" && (node.tag === "markdown" || node.tag === "lark_md" || node.tag === "plain_text")) {
      parts.push(node.content);
    } else if (typeof node.text === "string" && node.tag === "text") {
      parts.push(node.text);
    }
    for (const k of ["elements", "text", "fields", "columns", "body"]) {
      if (node[k]) walk(node[k]);
    }
  };
  walk(obj.elements || obj.body);
  return parts.join("\n").trim();
}

// ---- attachments download ----

const MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "audio/opus": ".opus",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
};

function safeFilename(name, contentType, fallback) {
  const base = path.basename(String(name || fallback || "file")).replace(/[\\/:*?"<>|]/g, "_");
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  const ext = MIME_EXT[ct];
  if (!ext) return base;
  // Replace default .png placeholder with actual image subtype if different
  const curExt = path.extname(base).toLowerCase();
  if (!curExt) return base + ext;
  if (curExt === ".png" && ext !== ".png" && ct.startsWith("image/")) return base.slice(0, -4) + ext;
  return base;
}

async function downloadAttachments(chatId, messageId, items) {
  if (!items.length) return [];
  const max = Number(settings.maxFileMB ?? 20) * 1024 * 1024;
  const got = [];
  for (const a of items) {
    const baseItem = { name: a.name, mimetype: a.mimetype };
    if (!max) {
      got.push({ ...baseItem, error: T("没开下载", "downloads off") });
      continue;
    }
    try {
      const token = await getTenantToken();
      const url = `${domainInfo().base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(a.key)}?type=${encodeURIComponent(a.type)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || ct.includes("application/json")) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.msg ? `${j.msg} (code=${j.code})` : `HTTP ${r.status}`);
      }
      const cl = Number(r.headers.get("content-length") || 0);
      if (cl > max) {
        got.push({ ...baseItem, size: cl, error: T(`超过 ${settings.maxFileMB} MB`, `over ${settings.maxFileMB} MB`) });
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) {
        got.push({ ...baseItem, size: buf.length, error: T(`超过 ${settings.maxFileMB} MB`, `over ${settings.maxFileMB} MB`) });
        continue;
      }
      const fname = safeFilename(a.name, ct, a.key);
      const dir = path.join(DATA, "files", chatId, messageId);
      await mkdir(dir, { recursive: true });
      const p = path.join(dir, fname);
      await writeFile(p, buf);
      got.push({ name: fname, mimetype: ct.split(";")[0].trim() || a.mimetype, size: buf.length, path: p });
    } catch (e) {
      got.push({ ...baseItem, error: e.message });
    }
  }
  return got;
}

// ---- recent conversation context (best effort) ----

const CONTEXT_LIMIT = 8;
async function fetchContext(chatId, messageId, threadId, createTimeMs) {
  try {
    const containerType = threadId ? "thread" : "chat";
    const containerId = threadId || chatId;
    const j = await api(
      "GET",
      `/im/v1/messages?container_id_type=${containerType}&container_id=${encodeURIComponent(containerId)}&sort_type=ByCreateTimeDesc&page_size=12`,
    );
    const items = j.data?.items ?? [];
    const oldest = createTimeMs - 2 * 86400_000;
    const prev = items
      .filter((m) => {
        if (!m || m.deleted || m.message_id === messageId) return false;
        const at = Number(m.create_time || 0);
        return at < createTimeMs && at >= oldest;
      })
      .sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0))
      .slice(-CONTEXT_LIMIT);

    const list = [];
    for (const m of prev) {
      const senderId = m.sender?.id || "";
      const isBot = m.sender?.sender_type === "app" || (bot.openId && senderId === bot.openId);
      const who = isBot ? bot.appName || "bot" : await nameOf(senderId);
      const parsed = parseMessageContent(m.msg_type, m.body?.content, m.mentions, bot.openId);
      const attNote = parsed.attachments.length ? ` [${T("附件", "attachment")}：${parsed.attachments.map((x) => x.name).join("、")}]` : "";
      const text = (parsed.text + attNote).trim().slice(0, 600);
      if (!text) continue;
      list.push({ who, me: isBot, text, at: Number(m.create_time || 0) });
    }
    return list;
  } catch {
    // Missing history scope (e.g. im:message.group_msg) is normal: context is best effort
    return [];
  }
}

// ---- Feishu → Gerdr events ----

const allowList = () =>
  (settings.allow ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

async function onFeishuEvent(body) {
  const eventType = body?.header?.event_type;
  const eventId = body?.header?.event_id;
  log("event", eventType, `id=${eventId}`, `chatType=${body?.event?.message?.chat_type}`, `msgType=${body?.event?.message?.message_type}`);
  if (eventType !== "im.message.receive_v1") return;
  if (rememberSeen(eventId)) return;

  const ev = body.event ?? {};
  const sender = ev.sender ?? {};
  const msg = ev.message ?? {};
  if (!msg.message_id || !msg.chat_id) return;
  if (rememberSeen(msg.message_id)) return;

  // Ignore messages sent by bots/apps (including ourselves)
  if (sender.sender_type && sender.sender_type !== "user") return;
  const senderOpenId = sender.sender_id?.open_id || "";
  if (!senderOpenId || (bot.openId && senderOpenId === bot.openId)) return;

  const allow = allowList();
  if (allow.length && !allow.includes(senderOpenId)) return;

  // Harvest display names from mentions to warm up the name cache even without contact scope
  for (const m of msg.mentions ?? []) {
    if (m.id?.open_id && m.name) names.set(m.id.open_id, { name: m.name, at: Date.now(), ok: true });
  }

  const isDM = msg.chat_type === "p2p";
  const mentioned = (msg.mentions ?? []).some(
    (m) => (bot.openId && m.id?.open_id === bot.openId) || (!bot.openId && bot.appName && m.name === bot.appName),
  );
  const inThread =
    !isDM &&
    ((msg.root_id && threads.has(`${msg.chat_id}/${msg.root_id}`)) ||
      (msg.parent_id && threads.has(`${msg.chat_id}/${msg.parent_id}`)));

  let kind;
  if (isDM) kind = "dm";
  else if (mentioned || inThread) kind = "mention";
  else if (settings.groupMessages) kind = "message";
  else return;

  // Conversation root for replies & thread tracking: DM top-level has no rootId; group @ starts or continues a thread
  const rootId = msg.root_id || (kind === "dm" ? undefined : msg.message_id);
  if (kind === "mention" && rootId) joinThread(msg.chat_id, rootId);

  const parsed = parseMessageContent(msg.message_type, msg.content, msg.mentions, bot.openId);
  const [who, chatName, files, context] = await Promise.all([
    nameOf(senderOpenId),
    isDM ? Promise.resolve("") : chatNameOf(msg.chat_id),
    downloadAttachments(msg.chat_id, msg.message_id, parsed.attachments),
    fetchContext(msg.chat_id, msg.message_id, msg.thread_id, Number(msg.create_time || Date.now())),
  ]);

  const clean = parsed.text;
  const groupLabel = chatName || T("群聊", "group");
  const place = isDM
    ? T("私聊", "DM")
    : msg.thread_id || msg.root_id || kind === "mention"
      ? T(`${groupLabel} 的话题`, `${groupLabel} thread`)
      : groupLabel;

  const fileLines = files.map((f) => (f.path ? `[附件] ${f.path}` : `[附件没下] ${f.name}：${f.error}`)).join("\n");
  const fullText = clean + (fileLines ? `${clean ? "\n\n" : ""}${fileLines}` : "");
  const titleBody = (clean || files[0]?.name || `[${msg.message_type}]`).split("\n")[0].slice(0, 80);

  // Reply goes directly to DM chat, or replies to the message / thread in groups
  const replyData =
    isDM && !msg.root_id
      ? { chat_id: msg.chat_id }
      : {
          chat_id: msg.chat_id,
          reply_to: msg.root_id || msg.message_id,
          reply_in_thread: Boolean(msg.thread_id || msg.root_id || kind === "mention"),
        };

  out({
    type: "event",
    event: {
      id: `feishu:${msg.chat_id}:${msg.message_id}`,
      kind,
      key: isDM && !msg.root_id ? msg.chat_id : `${msg.chat_id}/${rootId}`,
      actor: senderOpenId,
      title: `${who}: ${titleBody}`,
      text: fullText,
      data: {
        chat_id: msg.chat_id,
        chatType: msg.chat_type,
        message_id: msg.message_id,
        root_id: rootId,
        thread_id: msg.thread_id || undefined,
        open_id: senderOpenId,
        user: senderOpenId,
        userName: who,
        place,
        text: clean,
        files,
        context,
        domain: settings.domain === "lark" ? "lark" : "feishu",
      },
      reply: { kind: "feishu.send", data: replyData },
    },
  });
}

// ---- Gerdr events → Feishu ----

function buildSendPayload(text) {
  // Post with `md` tag renders Markdown cleanly in Feishu / Lark (bold, code blocks, links, lists)
  return {
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        content: [[{ tag: "md", text: String(text) }]],
      },
    }),
  };
}

function buildTextPayload(text) {
  return {
    msg_type: "text",
    content: JSON.stringify({ text: String(text) }),
  };
}

async function sendMessage(d) {
  const text = String(d.text);
  const payloads = [buildSendPayload(text), buildTextPayload(text)];

  // 1. Reply to a message / thread when reply_to is given
  if (d.reply_to) {
    const attempts = d.reply_in_thread ? [true, false] : [false];
    for (const inThread of attempts) {
      for (const payload of payloads) {
        try {
          await api("POST", `/im/v1/messages/${encodeURIComponent(d.reply_to)}/reply`, {
            ...payload,
            ...(inThread ? { reply_in_thread: true } : {}),
          });
          if (d.chat_id) joinThread(d.chat_id, d.reply_to);
          return;
        } catch (err) {
          log(`reply failed (inThread=${inThread}, type=${payload.msg_type}):`, err.message);
        }
      }
    }
  }

  // 2. Direct send to chat_id (normal DM path, or fallback if reply_to was deleted)
  if (!d.chat_id) throw new Error("missing chat_id");
  let lastErr;
  for (const payload of payloads) {
    try {
      await api("POST", "/im/v1/messages?receive_id_type=chat_id", {
        receive_id: d.chat_id,
        ...payload,
      });
      return;
    } catch (err) {
      lastErr = err;
      log(`send failed (type=${payload.msg_type}):`, err.message);
    }
  }
  throw lastErr;
}

async function onGerdrEvent(e) {
  if (e.kind !== "feishu.send") return;
  const d = e.data ?? {};
  const reactTarget = d.message_id || d.reply_to;
  if (d.react && reactTarget) {
    try {
      await api("POST", `/im/v1/messages/${encodeURIComponent(reactTarget)}/reactions`, {
        reaction_type: { emoji_type: String(d.react) },
      });
      return;
    } catch (err) {
      log("react failed, posting text:", err.message);
    }
  }
  if ((!d.chat_id && !d.reply_to) || !d.text) {
    log("feishu.send without chat_id / text, from", e.source);
    return;
  }
  try {
    await sendMessage(d);
  } catch (err) {
    log("send failed", err.message);
    status(T(`发不出去：${err.message}`, `Couldn't send: ${err.message}`));
  }
}

// ---- Gerdr IPC ----

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const old = tooOld();
  if (old) {
    status(old);
    log(old);
  }

  let gotSettings = false;
  setTimeout(() => {
    if (!gotSettings && !stopping) {
      status(
        tooOld() ||
          T(
            "Gerdr 没把设置发过来：这个插件要新版 Gerdr（插件 service 能收到设置的版本），升级 Gerdr 后再开",
            "Gerdr did not send settings: upgrade Gerdr and re-enable this add-on",
          ),
      );
    }
  }, 5000).unref();

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
      settings = { domain: "feishu", maxFileMB: 20, ...(m.settings ?? {}) };
      if (first || prev.appId !== settings.appId || prev.appSecret !== settings.appSecret || prev.domain !== settings.domain) {
        tokenCache = { token: "", expiresAt: 0 };
        bot = { openId: "", appName: "" };
        noContactScope = false;
        names.clear();
        chats.clear();
        fragments.clear();
        closeSocket();
        backoff = 1000;
        connect();
      }
    } else if (m.type === "event" && m.event) {
      onGerdrEvent(m.event).catch((e) => log("send failed", e.message));
    }
  });

  rl.on("close", () => {
    stopping = true;
    closeSocket();
    setTimeout(() => process.exit(0), 300);
  });
}
