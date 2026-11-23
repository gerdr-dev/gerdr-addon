// Meegle (Lark Project) → Gerdr events: to-dos that reach you and others' new comments on those work items; replies
// go back as comments, as you. No app or token of its own: everything goes through the meegle CLI
// (@lark-project/meegle), so it sees exactly what an agent with that CLI sees, signed in as the person.
//
// Meegle has no push for a personal account, so this polls: `meegle mywork todo` (every to-do, all spaces) and
// `meegle comment list` for each work item in it. What is new is what wasn't there last time:
// - a to-do entry (work item + node / status + subtask) not in the previous list → meegle/todo. An entry that leaves
//   and comes back (a defect reopened, a node sent back) is new again: it is your turn again.
// - a comment id not seen before on a tracked work item, not written by you → meegle/comment. A work item is tracked
//   while it is in your to-dos and for 7 days after (QA answering on a defect you just resolved).
// The very first run only records what is there, so turning it on doesn't flood the inbox with the whole backlog;
// a work item that newly becomes tracked has its existing comments recorded too (the todo event carries the latest).
//
// The event key is the work item (`<space>/<id>`), the same for its todo and every comment, so a subscriber that took
// the first one (the task board's task) gets the rest.
//
// Talks to Gerdr in JSON lines: stdin gets hello / settings / event, stdout sends status / event.

import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = process.env.GERDR_ADDON_DATA || process.cwd();
const STATE = path.join(DATA, "state.json");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const status = (text) => out({ type: "status", text });
const log = (...a) => console.error(new Date().toISOString(), ...a);
let zh = true;
const T = (z, e) => (zh ? z : e);

const KEEP_MS = 7 * 86400_000; // how long a work item that left the to-dos is still watched for comments
const CONTEXT = 8;

let settings = {};
let timer = null;
let polling = false;
let stopping = false;
let host = "project.larksuite.com";
let me = null; // { key, name }
const names = new Map(); // user_key → name
const spaces = new Map(); // project_key → simple_name (what URLs use)
const typeApi = new Map(); // `${project_key}/${type_key}` → api_name (what URLs use) and name

// ---- meegle CLI ----

// The service starts from Gerdr's backend, whose PATH may not have the node install meegle came with (version-fox,
// nvm): look there too, and put node's own folder on PATH since meegle is a `#!/usr/bin/env node` script.
async function meeglePath() {
  const want = (settings.meegle || "meegle").replace(/^~(?=\/)/, os.homedir());
  if (want.includes("/")) return want;
  const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", path.dirname(process.execPath)];
  for (const root of [path.join(os.homedir(), ".version-fox", "cache", "nodejs"), path.join(os.homedir(), ".nvm", "versions", "node")]) {
    for (const v of await readdir(root).catch(() => [])) {
      dirs.push(path.join(root, v, "bin"));
      for (const w of await readdir(path.join(root, v)).catch(() => [])) dirs.push(path.join(root, v, w, "bin"));
    }
  }
  for (const d of dirs) {
    const p = path.join(d, want);
    if (await access(p, constants.X_OK).then(() => true, () => false)) return p;
  }
  return "";
}

class AuthError extends Error {}
let bin = "";

async function meegle(args) {
  if (!bin) bin = await meeglePath();
  if (!bin) throw new Error(T("找不到 meegle（npm i -g @lark-project/meegle）", "meegle not found (npm i -g @lark-project/meegle)"));
  const env = { ...process.env, PATH: [path.dirname(bin), path.dirname(process.execPath), process.env.PATH].join(":") };
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 90_000, maxBuffer: 20 << 20, env }, (err, stdout, stderr) => {
      let j = null;
      try {
        j = JSON.parse(stdout);
      } catch {}
      if (!err && j && !j.error) return resolve(j);
      const msg = j?.error?.message || (stderr || err?.message || "").trim().split("\n").pop() || "failed";
      const E = /not logged in|unauthori|login|token.*(expire|invalid)|401/i.test(msg + (stderr || "")) ? AuthError : Error;
      reject(new E(`meegle ${args.slice(0, 2).join(" ")}: ${msg}`));
    }),
  );
}

async function signedIn() {
  try {
    const s = await meegle(["auth", "status"]);
    if (s.host) host = s.host;
    return s.authenticated !== false;
  } catch (e) {
    return !(e instanceof AuthError);
  }
}

async function nameOf(keys) {
  const want = [...new Set(keys.filter((k) => k && !names.has(k)))];
  for (let i = 0; i < want.length; i += 20) {
    const args = ["user", "search"];
    for (const k of want.slice(i, i + 20)) args.push("--user-keys", k);
    try {
      for (const u of await meegle(args)) names.set(String(u.user_key), u.name_cn || u.name_en || u.email || String(u.user_key));
    } catch (e) {
      log("user search failed", e.message);
    }
  }
  for (const k of want) if (!names.has(k)) names.set(k, k);
}

// ---- state ----

// { todo: [entry keys] | undefined (never polled), items: { [wid]: { project, seen: [comment ids], until?: ms } } }
let state = { todo: undefined, items: {} };
async function loadState() {
  try {
    state = JSON.parse(await readFile(STATE, "utf8"));
    state.items ??= {};
  } catch {}
}
async function saveState() {
  const tmp = STATE + ".tmp";
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, STATE);
}

// ---- reading Meegle ----

const entryKey = (x) => `${x.work_item_info.work_item_id}:${x.node_info?.node_state_key || ""}:${x.sub_task_info?.id || ""}`;

async function workItem(project, wid) {
  const j = await meegle(["workitem", "get", "--project-key", project, "--work-item-id", String(wid)]);
  const a = j.work_item_attribute ?? {};
  if (a.owned_project?.simple_name) spaces.set(project, a.owned_project.simple_name);
  const field = (k) => (j.work_item_fields ?? []).find((f) => f.key === k)?.value;
  const people = (v) => (Array.isArray(v) ? v.map((u) => u.name).filter(Boolean).join("、") : "");
  return {
    name: a.work_item_name,
    type: a.work_item_type?.name || "",
    typeKey: a.work_item_type?.key || "",
    status: a.work_item_status?.name || "",
    reporter: people(a.role_members?.find((r) => r.key === "reporter")?.members) || a.create_by?.name || "",
    // who the to-do is from, for the inbox's "only from these people": the reporter (updated_by is often "automation")
    from: a.role_members?.find((r) => r.key === "reporter")?.members?.[0] ?? a.create_by ?? null,
    owner: people(field("current_status_operator")),
    description: typeof field("description") === "string" ? field("description") : "",
  };
}

async function urlOf(project, typeKey, wid) {
  const k = `${project}/${typeKey}`;
  if (!typeApi.has(k)) {
    try {
      for (const t of (await meegle(["workitem", "meta-types", "--project-key", project])).list ?? []) typeApi.set(`${project}/${t.type_key}`, t.api_name || t.type_key);
    } catch (e) {
      log("meta-types failed", e.message);
    }
  }
  return `https://${host}/${spaces.get(project) || project}/${typeApi.get(k) || typeKey}/detail/${wid}`;
}

async function comments(project, wid) {
  const j = await meegle(["comment", "list", "--project-key", project, "--work-item-id", String(wid), "--auto-paginate"]);
  return (j.comments ?? []).slice().sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

// Mentions come as `@名字<!-- mention:{…} -->`: keep the name
const readable = (s) => String(s ?? "").replace(/<!--\s*mention:[\s\S]*?-->/g, "").trim();
// Meegle writes comment times in UTC without saying so ("2026-11-20 10:37:46", same instant as the item's create_time Z)
const atMs = (s) => {
  const t = Date.parse(String(s).replace(" ", "T") + "Z");
  return Number.isNaN(t) ? undefined : t;
};

// Screenshots in comments / descriptions are `![name](https://<host>/goapi/…/file/stream/download/…)`: only a signed-in
// client can open them, so an agent couldn't. Download them (meegle attachment +download) and put the local path in
// the text and in data.files, the way chat sources hand attachments on. At most MAX_FILES per event.
const MAX_FILES = 10;
const IMG = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+\/file\/stream\/download\/[^)\s]+)\)(<!--[\s\S]*?-->)?/g;
async function withFiles(text, project, wid, tag) {
  const files = [];
  const urls = [...String(text).matchAll(IMG)].map((m) => m[2]);
  const local = new Map();
  for (const [i, u] of [...new Set(urls)].slice(0, MAX_FILES).entries()) {
    const dest = path.join(DATA, "files", String(wid), `${tag}-${i + 1}`);
    try {
      await mkdir(path.dirname(dest), { recursive: true });
      const r = await meegle(["attachment", "+download", u, "--project-key", project, "--work-item-id", String(wid), "--output", dest, "--overwrite"]);
      const ext = path.extname(r.name || "") || { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[r.mime_type] || "";
      const final = dest + ext;
      if (ext) await rename(dest, final);
      local.set(u, final);
      files.push({ path: final, name: r.name || path.basename(final), mimetype: r.mime_type });
    } catch (e) {
      log("attachment download failed", wid, e.message);
    }
  }
  const out = String(text).replace(IMG, (all, name, u) => (local.has(u) ? `\n${T("[图片]", "[image]")} ${local.get(u)}\n` : T(`[图片没下：${name || "image"}]`, `[image not downloaded: ${name || "image"}]`)));
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), files };
}

// ---- polling ----

async function poll() {
  if (polling || stopping) return;
  polling = true;
  try {
    if (!me) {
      const u = await meegle(["user", "me"]);
      me = { key: String(u.user_key), name: u.name_cn || u.name_en || "" };
      names.set(me.key, me.name);
      await signedIn(); // for the host
    }
    const list = (await meegle(["mywork", "todo", "--action", "todo", "--todo-scope", "all", "--auto-paginate"])).list ?? [];
    const first = state.todo === undefined;
    const before = new Set(state.todo ?? []);
    const now = Date.now();

    // to-do entries by work item
    const byItem = new Map();
    for (const x of list) {
      const wid = String(x.work_item_info?.work_item_id ?? "");
      if (!wid) continue;
      if (!byItem.has(wid)) byItem.set(wid, { project: x.project_key, entries: [] });
      byItem.get(wid).entries.push(x);
    }

    // which work items are watched for comments: in the to-dos, or left them less than KEEP_MS ago
    for (const [wid, it] of byItem) {
      const s = (state.items[wid] ??= { project: it.project, seen: null });
      delete s.until;
    }
    for (const [wid, s] of Object.entries(state.items)) {
      if (byItem.has(wid)) continue;
      s.until ??= now + KEEP_MS;
      if (s.until < now) delete state.items[wid];
    }

    let sent = 0;
    for (const [wid, it] of byItem) {
      const fresh = it.entries.filter((x) => !before.has(entryKey(x)));
      if (!first && fresh.length) {
        await emitTodo(wid, it.project, fresh).catch((e) => log("todo event failed", wid, e.message));
        sent++;
      }
    }

    if (settings.comments !== false) {
      for (const [wid, s] of Object.entries(state.items)) {
        if (stopping) break;
        let cs;
        try {
          cs = await comments(s.project, wid);
        } catch (e) {
          if (e instanceof AuthError) throw e;
          log("comments failed", wid, e.message);
          continue;
        }
        if (s.seen === null || first) {
          // newly watched: what's there already is history (the todo event carries the latest)
          s.seen = cs.map((c) => String(c.comment_id)).slice(-200);
          continue;
        }
        const seen = new Set(s.seen);
        const newOnes = cs.filter((c) => !seen.has(String(c.comment_id)));
        for (const c of newOnes) {
          s.seen.push(String(c.comment_id));
          if (String(c.creator) === me.key) continue;
          await emitComment(wid, s.project, c, cs).catch((e) => log("comment event failed", wid, e.message));
          sent++;
        }
        s.seen = s.seen.slice(-200);
      }
    } else {
      for (const s of Object.values(state.items)) s.seen = null;
    }

    state.todo = list.map(entryKey);
    await saveState();
    loginWarned = false;
    const watched = Object.keys(state.items).length;
    status(
      T(
        `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} 查过：待办 ${list.length} 项（${byItem.size} 个工作项），看着 ${watched} 个工作项的评论${first ? "（第一次，只记下现状）" : sent ? `，发了 ${sent} 个事件` : ""}`,
        `Checked ${new Date().toLocaleTimeString("en-GB")}: ${list.length} to-dos (${byItem.size} work items), watching comments on ${watched}${first ? " (first run, recorded only)" : sent ? `, ${sent} events` : ""}`,
      ),
    );
  } catch (e) {
    log("poll failed", e.message);
    if (e instanceof AuthError || !(await signedIn())) await onLoggedOut();
    else status(T(`查不了：${e.message}`, `Check failed: ${e.message}`));
  } finally {
    polling = false;
    schedule();
  }
}

let loginWarned = false;
async function onLoggedOut() {
  status(T("meegle 没登录或登录过期：在终端跑 meegle auth login", "meegle isn't signed in: run meegle auth login in a terminal"));
  if (loginWarned) return;
  loginWarned = true;
  me = null;
  const day = new Date().toISOString().slice(0, 13);
  out({
    type: "event",
    event: {
      id: `meegle:login:${day}`,
      kind: "login",
      key: "login",
      title: T("Meegle 登录过期了", "Meegle sign-in expired"),
      text: T(
        "meegle 命令行的登录过期了，收不到 Meegle 的待办和评论。要用户在终端跑 `meegle auth login`（会打开浏览器授权）。",
        "The meegle CLI's sign-in expired, so Meegle to-dos and comments aren't coming in. The user needs to run `meegle auth login` in a terminal (it opens a browser).",
      ),
    },
  });
}

async function emitTodo(wid, project, entries) {
  const w = await workItem(project, wid);
  const url = await urlOf(project, w.typeKey, wid);
  const cs = await comments(project, wid).catch(() => []);
  await nameOf(cs.slice(-CONTEXT).map((c) => String(c.creator)));
  const nodes = [...new Set(entries.map((x) => x.node_info?.node_name).filter(Boolean))];
  const subtasks = entries.filter((x) => x.sub_task_info?.id).map((x) => x.sub_task_info.name || x.sub_task_info.id);
  const where = [nodes.length ? T(`节点：${nodes.join("、")}`, `Node: ${nodes.join(", ")}`) : "", subtasks.length ? T(`子任务：${subtasks.join("、")}`, `Subtasks: ${subtasks.join(", ")}`) : "", w.status ? T(`状态：${w.status}`, `Status: ${w.status}`) : ""]
    .filter(Boolean)
    .join("；");
  const desc = w.description ? await withFiles(w.description.slice(0, 5000), project, wid, "desc") : { text: "", files: [] };
  const text = [
    T(`Meegle 上新到我手里的待办：${w.type} ${wid}「${w.name}」`, `A Meegle to-do reached me: ${w.type} ${wid} "${w.name}"`),
    where,
    [w.reporter && T(`提出人：${w.reporter}`, `Reporter: ${w.reporter}`), w.owner && T(`当前负责人：${w.owner}`, `Current owner: ${w.owner}`)].filter(Boolean).join("；"),
    url,
    desc.text ? `\n${T("描述", "Description")}：\n${desc.text}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  out({
    type: "event",
    event: {
      id: `meegle:todo:${entries.map(entryKey).sort().join(",")}:${Date.now()}`,
      kind: "todo",
      key: `${spaces.get(project) || project}/${wid}`,
      actor: w.from?.key ? String(w.from.key) : undefined,
      title: T(`新待办：${w.name}`, `New to-do: ${w.name}`).slice(0, 120),
      text,
      url,
      data: {
        project,
        space: spaces.get(project),
        workItemId: wid,
        type: w.type,
        status: w.status,
        nodes,
        userName: w.from?.name,
        files: desc.files,
        context: cs.slice(-CONTEXT).map((c) => ({ who: names.get(String(c.creator)) || String(c.creator), me: String(c.creator) === me.key || undefined, text: readable(c.content).slice(0, 600), at: atMs(c.created_at) })),
      },
      reply: { kind: "meegle.comment", data: { project, workItemId: wid } },
    },
  });
}

async function emitComment(wid, project, c, all) {
  const w = await workItem(project, wid);
  const url = await urlOf(project, w.typeKey, wid);
  const i = all.findIndex((x) => x.comment_id === c.comment_id);
  const prior = all.slice(Math.max(0, i - CONTEXT), i);
  await nameOf([String(c.creator), ...prior.map((x) => String(x.creator))]);
  const who = names.get(String(c.creator)) || String(c.creator);
  const { text: body, files } = await withFiles(readable(c.content), project, wid, String(c.comment_id));
  out({
    type: "event",
    event: {
      id: `meegle:comment:${c.comment_id}`,
      kind: "comment",
      key: `${spaces.get(project) || project}/${wid}`,
      actor: String(c.creator),
      title: `${who} @ ${w.name}: ${body.split("\n")[0]}`.slice(0, 120),
      text: `${body}\n\n${T(`（Meegle 评论，在 ${w.type} ${wid}「${w.name}」下，状态：${w.status}）`, `(Meegle comment on ${w.type} ${wid} "${w.name}", status: ${w.status})`)}\n${url}`,
      url,
      data: {
        project,
        space: spaces.get(project),
        workItemId: wid,
        commentId: String(c.comment_id),
        type: w.type,
        status: w.status,
        userName: who,
        files,
        context: prior.map((x) => ({ who: names.get(String(x.creator)) || String(x.creator), me: String(x.creator) === me.key || undefined, text: readable(x.content).slice(0, 600), at: atMs(x.created_at) })),
      },
      reply: { kind: "meegle.comment", data: { project, workItemId: wid } },
    },
  });
}

function schedule() {
  clearTimeout(timer);
  if (stopping) return;
  const min = Math.min(120, Math.max(1, Number(settings.interval) || 5));
  timer = setTimeout(poll, min * 60_000);
}

// ---- replies: a comment, as you ----

async function onGerdrEvent(e) {
  if (e.kind !== "meegle.comment") return;
  const d = e.data ?? {};
  if (!d.project || !d.workItemId || !d.text) return log("meegle.comment without project / workItemId / text, from", e.source);
  try {
    const r = await meegle(["comment", "add", "--project-key", String(d.project), "--work-item-id", String(d.workItemId), "--content", String(d.text)]);
    // Our own comment shouldn't come back as an event: mark it seen
    const id = String(r?.comment_id ?? r?.data?.comment_id ?? "");
    const s = state.items[String(d.workItemId)];
    if (id && s?.seen) s.seen.push(id);
  } catch (err) {
    log("comment add failed", err.message);
    status(T(`评论发不出去：${err.message}`, `Couldn't post the comment: ${err.message}`));
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
    settings = m.settings ?? {};
    if (prev.meegle !== settings.meegle) bin = "";
    if (!gotSettings) {
      gotSettings = true;
      loadState().then(poll);
    } else if (prev.interval !== settings.interval) schedule();
  } else if (m.type === "event" && m.event) {
    onGerdrEvent(m.event).catch((e) => log("reply failed", e.message));
  }
});
rl.on("close", () => {
  stopping = true;
  clearTimeout(timer);
  setTimeout(() => process.exit(0), 300);
});
