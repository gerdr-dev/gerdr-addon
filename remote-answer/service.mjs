// What agents wait on you for → the chat you last messaged your bot from; your reply there → the answer, and the
// agent goes on. No dependencies.
//
// It knows no chat. The "chat" setting picks one of the installed add-ons that bring direct messages in as
// `<source>/dm` events with a `reply` address (Gerdr lists them: optionsFrom). The conversation in it is the one you
// last wrote the bot from: it posts through that message's reply address (an event of the reply's kind, which the
// chat add-on posts) and reads your answer from the next dm events of the same conversation (same source and key).
//
// Gerdr gives it the requests because addon.json says "pending": true: {"type":"pending"} lists them, taken apart
// (options with ids, questions), and {"type":"answer"} answers one. See GUIDE.md, "Answering for the person".

import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA = process.env.GERDR_ADDON_DATA || process.cwd();
const HOMES = path.join(DATA, "homes.json");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (...a) => console.error(new Date().toISOString(), ...a);

// Gerdr's language (hello's lang): the request summaries and the agents' option names it hands over are in it, so
// what this writes matches them. Until hello arrives, a guess from the environment.
let zh = /^zh/i.test(process.env.GERDR_LANG || process.env.LANG || "");
const T = (z, e) => (zh ? z : e);

let settings = { delay: 60, on: true };
// Per chat source, the conversation you last wrote the bot from: { key, reply: { kind, data } }. Kept, so a restart
// (or switching the "chat" setting back and forth) still knows. home: the one of the chosen chat.
let homes = {};
let home = null;
const pickHome = () => {
  const h = settings.chat ? homes[settings.chat] : undefined;
  home = h ? { source: settings.chat, ...h } : null;
};
let pending = new Map(); // reqId → the request, as Gerdr last listed it
const firstSeen = new Map(); // reqId → when this service first saw it (the delay counts from here)
const queue = []; // reqIds due to be asked, oldest first
let current = null; // { req, q: index of the question being asked, answers: {} } — the one asked in the chat now
let timer = null;

readFile(HOMES, "utf8").then(
  (t) => {
    homes = JSON.parse(t);
    pickHome();
    status();
    ask();
  },
  () => status(),
);

function status() {
  const text = !settings.chat
    ? T("没有能私信的聊天插件：先装一个（比如 Slack），再在设置里选它", "No chat add-on that does direct messages: install one (e.g. Slack), then pick it in the settings")
    : !home
    ? T(`给 ${settings.chat} 的 bot 私信一句，我就知道发进哪个对话`, `Send your ${settings.chat} bot a direct message so I know which conversation to use`)
    : current
      ? T(`等你在 ${home.source} 里回复（还有 ${queue.length} 个排着）`, `Waiting for your reply in ${home.source} (${queue.length} more queued)`)
      : T(`发到 ${home.source}`, `Posting to ${home.source}`);
  out({ type: "status", text });
}

// ---- talking in the chat ----

function say(text) {
  if (!home) return;
  // The same shape as a panel's ctx.events.reply: the reply's kind, its data plus the text, the conversation's key
  out({ type: "event", event: { kind: home.reply.kind, key: home.key, text, data: { ...home.reply.data, text } } });
}

function code(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern;
  const s = typeof v === "string" ? v : JSON.stringify(input);
  return s ? "\n```\n" + (s.length > 1500 ? s.slice(0, 1500) + "\n…" : s) + "\n```" : "";
}

function ask() {
  if (current || !home || !queue.length) return status();
  const req = pending.get(queue.shift());
  if (!req) return ask();
  current = { req, q: 0, answers: {} };
  const more = queue.length ? T(`\n（后面还有 ${queue.length} 个）`, `\n(${queue.length} more after this)`) : "";
  const who = `*${req.title}*（${req.agent}）`;
  if (req.kind === "permission") {
    const opts = (req.options ?? []).map((o, i) => `${i + 1} ${o.name}`).join(" · ");
    say(T(`🔔 ${who} 在等你审批：${req.tool?.title ?? req.summary}`, `🔔 ${who} wants approval: ${req.tool?.title ?? req.summary}`) + code(req.tool?.input) + `\n${T("回复", "Reply")}：${opts}${more}`);
  } else {
    say(T(`❓ ${who} 有问题要问你`, `❓ ${who} has a question for you`) + more);
    askQuestion();
  }
  status();
}

function askQuestion() {
  const qs = current.req.questions ?? [];
  const q = qs[current.q];
  const n = qs.length > 1 ? `(${current.q + 1}/${qs.length}) ` : "";
  const opts = (q.options ?? []).map((o, i) => `${i + 1} ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
  const how = [
    q.options?.length ? (q.multiSelect ? T("回复编号，可以多个（1 3）", "Reply with numbers, several allowed (1 3)") : T("回复编号", "Reply with a number")) : "",
    !q.options?.length ? T("直接写答案", "Write your answer") : q.allowOther ? T("也可以直接写答案", "or write your own answer") : "",
    T("「跳过」不回答", "\"skip\" to leave it"),
  ].filter(Boolean);
  say(`${n}${q.question}${opts ? "\n" + opts : ""}\n${how.join(T("；", "; "))}`);
}

// ---- your reply ----

const SKIP = /^(跳过|不回答|skip)$/i;
const ALLOW = /^(允许|同意|可以|好|行|ok|y|yes|allow)$/i;
const DENY = /^(拒绝|不行|不|no|n|deny|reject)$/i;

function onReply(text) {
  if (!current) return; // not an answer: some other subscriber's business
  const req = current.req;
  text = text.trim();
  if (req.kind === "permission") {
    const opts = req.options ?? [];
    let o = /^\d+$/.test(text) ? opts[+text - 1] : undefined;
    if (!o && ALLOW.test(text)) o = opts.find((x) => x.kind === "allow_once") ?? opts.find((x) => x.kind.startsWith("allow"));
    if (!o && DENY.test(text)) o = opts.find((x) => x.kind === "reject_once") ?? opts.find((x) => x.kind.startsWith("reject"));
    if (!o) return say(T(`没看懂，回复编号 1-${opts.length}`, `Didn't get that: reply 1-${opts.length}`));
    current.picked = o.name;
    return out({ type: "answer", session: req.session, reqId: req.reqId, optionId: o.id });
  }
  const q = req.questions[current.q];
  if (SKIP.test(text)) {
    current.picked = T("跳过", "skipped");
    return out({ type: "answer", session: req.session, reqId: req.reqId, skip: true });
  }
  let picked;
  const nums = text.split(/[\s,，、]+/).filter(Boolean);
  if (q.options?.length && nums.every((x) => /^\d+$/.test(x) && +x >= 1 && +x <= q.options.length)) {
    picked = nums.map((x) => q.options[+x - 1].label);
    if (picked.length > 1 && !q.multiSelect) return say(T("这题只能选一个", "Pick just one for this question"));
  } else if (q.allowOther || !q.options?.length) {
    picked = [text];
  } else {
    return say(T(`没看懂，回复编号 1-${q.options.length}`, `Didn't get that: reply 1-${q.options.length}`));
  }
  current.answers[q.id] = picked;
  if (current.q + 1 < req.questions.length) {
    current.q++;
    return askQuestion();
  }
  current.picked = Object.values(current.answers).flat().join(", ");
  out({ type: "answer", session: req.session, reqId: req.reqId, answers: current.answers });
}

function onAnswered(m) {
  if (!current || m.reqId !== current.req.reqId) return;
  say(m.error ? T(`✗ 没成：${m.error}`, `✗ Didn't go through: ${m.error}`) : T(`✓ ${current.picked}，它接着跑了`, `✓ ${current.picked} — it's going on`));
  current = null;
  ask();
}

// ---- what Gerdr says is pending ----

function onPending(list) {
  const now = Date.now();
  const next = new Map(list.map((r) => [r.reqId, r]));
  for (const id of firstSeen.keys()) if (!next.has(id)) firstSeen.delete(id);
  for (const id of next.keys()) if (!firstSeen.has(id)) firstSeen.set(id, now);
  pending = next;
  // Handled somewhere else (at the computer, timed out): drop it, and say so if it was the one asked
  for (let i = queue.length - 1; i >= 0; i--) if (!pending.has(queue[i])) queue.splice(i, 1);
  if (current && !pending.has(current.req.reqId)) {
    say(T(`（${current.req.title} 的已经在别处处理了）`, `(${current.req.title}'s was handled elsewhere)`));
    current = null;
  }
  schedule();
  ask();
}

// Due: still pending after the delay, not muted (do-not-disturb group), not asked yet
function schedule() {
  clearTimeout(timer);
  if (settings.on === false) return;
  const delay = Math.max(0, Number(settings.delay ?? 60)) * 1000;
  const now = Date.now();
  let soonest = Infinity;
  for (const [id, r] of pending) {
    if (r.muted || queue.includes(id) || current?.req.reqId === id || r.asked) continue;
    const due = firstSeen.get(id) + delay;
    if (due <= now) {
      r.asked = true;
      queue.push(id);
    } else soonest = Math.min(soonest, due);
  }
  if (soonest < Infinity)
    timer = setTimeout(() => {
      schedule();
      ask();
    }, soonest - now + 50);
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
  switch (m.type) {
    case "hello":
      if (m.lang) zh = m.lang === "zh";
      status();
      break;
    case "settings": {
      const before = settings.chat;
      settings = { ...settings, ...m.settings };
      pickHome();
      // Moved to another chat while one was asked in the old: ask it again in the new one
      if (before !== settings.chat && current) {
        queue.unshift(current.req.reqId);
        current = null;
      }
      status();
      schedule();
      ask();
      break;
    }
    case "pending":
      // "asked" is ours: keep it across lists
      for (const r of m.pending ?? []) if (pending.get(r.reqId)?.asked) r.asked = true;
      onPending(m.pending ?? []);
      break;
    case "answered":
      onAnswered(m);
      break;
    case "event": {
      const e = m.event;
      // Only the chosen chat: a dm to another bot is none of our business
      if (!e?.reply?.kind || e.kind !== "dm" || e.source !== settings.chat) break;
      const same = home && home.key === e.key;
      if (!same) {
        // You wrote the bot from another conversation of this chat: that's where you are now
        homes[e.source] = { key: e.key, reply: e.reply };
        pickHome();
        mkdir(DATA, { recursive: true })
          .then(() => writeFile(HOMES, JSON.stringify(homes)))
          .catch((err) => log("homes not saved", err.message));
        status();
        if (!current) return ask();
      }
      onReply(e.data?.text ?? e.text ?? "");
      break;
    }
  }
});
rl.on("close", () => process.exit(0));
