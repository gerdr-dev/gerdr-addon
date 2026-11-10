// GitLab MRs' states, for the MRs someone waits on. No dependencies; GitLab is reached through `glab api`, so whatever
// `glab auth login --hostname <host>` set up is the login, for any number of GitLabs, and nothing is stored here.
//
// This reports what an MR is like now; it doesn't decide what's news. A session (`gerdr wait gitlab <key> --until
// '<condition>'`) or a panel (a trigger with until) says what it waits for, and Gerdr checks that against the
// state reported here (docs/dev/EVENTS.md in gerdr, "Waiting for a state"). Because a condition is checked against
// the state as it is, nobody misses anything by waiting late — the reason this reports states and not events.
//
// Which MRs: Gerdr asks, {"type":"get","id":…,"key":…}, for each MR someone waits on — at once for a new one, then
// every poll interval (addon.json states[].poll) — and this answers {"type":"state","id":…} or {"type":"error","id":…,
// "reason","retry"}. Nothing else: no list of keys, no timer, no memory beyond caches. A key is
// <host>/<project path>!<iid>, as in the MR's address (https://<host>/<project path>/-/merge_requests/<iid>): the
// host in the key is what lets one add-on serve every GitLab without knowing who waits.
// Moved here from the superagent panel's mrwatch.ts (2026-11), which polled only its own tasks' MRs.

import { createInterface } from "node:readline";
import { execFile } from "node:child_process";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (...a) => console.error(new Date().toISOString(), ...a);

let lang = "zh";
const L = (zh, en) => (lang === "zh" ? zh : en);

const hosts = new Map(); // host → { ok, reason, me, at }: glab's login there
const logs = new Map(); // "<host>/<project>:<pipeline id>" → the failed jobs' log tails (a pipeline's log doesn't change)

const MR = /^([^/!]+)\/(.+)!(\d+)$/;
const NOTE_MAX = 1500;
const isHost = (h) => h.includes(".") || h.includes(":") || h === "localhost";

function parse(key) {
  const m = MR.exec(key);
  return m && isHost(m[1]) ? { host: m[1], project: m[2], iid: Number(m[3]) } : null;
}

// ---- glab ----

function glab(host, args) {
  return new Promise((resolve, reject) => {
    execFile("glab", ["api", "--hostname", host, ...args], { timeout: 60_000, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") return reject(new Error(L("没找到 glab：先装 glab（brew install glab）", "glab not found: install it (brew install glab)")));
        const msg = String(stderr || err.message).trim();
        if (/401|unauthori[sz]ed|authentication|auth login|not logged|token.*expired/i.test(msg))
          return reject(new Error(L(`glab 没登录 ${host}：运行 glab auth login --hostname ${host}`, `glab isn't logged in to ${host}: run glab auth login --hostname ${host}`)));
        if (/404/.test(msg)) return reject(new Error(L("GitLab 上没有这个 MR（或者没有权限看）", "no such MR on that GitLab (or no access to it)")));
        return reject(new Error(`glab api ${args.join(" ")}: ${msg.slice(0, 400)}`));
      }
      resolve(stdout);
    });
  });
}

const get = async (host, endpoint) => JSON.parse(await glab(host, ["--method", "GET", endpoint]));
const text = (host, endpoint) => glab(host, ["--method", "GET", endpoint]);

/** Can glab reach this host as someone? Cached; the username is who "others" are measured against. */
async function login(host) {
  const c = hosts.get(host);
  // A login that works is checked again every 10 minutes, one that doesn't every minute (the person may be fixing
  // it), a network hiccup after 15 seconds
  if (c && Date.now() - c.at < (c.ok ? 600_000 : c.transient ? 15_000 : 60_000)) return c;
  let r;
  try {
    const u = await get(host, "user");
    r = { ok: true, me: u.username, at: Date.now() };
  } catch (e) {
    // Not logged in / no glab: the person has to act. Anything else (EOF, a timeout): the network, tried again soon
    const transient = !/没登录|isn't logged in|没找到 glab|glab not found/.test(e.message);
    r = { ok: false, transient, reason: transient ? L(`暂时连不上 ${host}，马上重试：${e.message.slice(0, 200)}`, `can't reach ${host} right now, retrying shortly: ${e.message.slice(0, 200)}`) : e.message, at: Date.now() };
  }
  hosts.set(host, r);
  return r;
}

// ---- answering ----

/** Asked about in the last 10 minutes, for the status line. */
const asked = new Map();

function statusLine() {
  const now = Date.now();
  for (const [k, at] of asked) if (now - at > 10 * 60_000) asked.delete(k);
  const at = new Date().toTimeString().slice(0, 5);
  out({ type: "status", text: asked.size ? L(`有人在等 ${asked.size} 个 MR，上次查是 ${at}`, `${asked.size} MRs waited on, last looked at ${at}`) : L("没人在等 MR", "nobody waits on an MR") });
}

/** One get: the MR's state, or why not (retry: whether it may go away by itself). */
async function get1(id, key) {
  const p = parse(key);
  if (!p) {
    return out({ type: "error", id, retry: false, reason: L("key 要写成 <GitLab 地址>/<项目路径>!<MR 号>，比如 gitlab.example.com/group/repo!34（照 MR 的网址）", "a key is <GitLab host>/<project path>!<MR iid>, e.g. gitlab.example.com/group/repo!34 (as in the MR's address)") });
  }
  const h = await login(p.host);
  if (!h.ok) return out({ type: "error", id, retry: !!h.transient, reason: h.reason });
  try {
    const st = await one(key, p, h.me);
    out({ type: "state", id, ...st });
    asked.set(key, Date.now());
  } catch (e) {
    log(key, e.message);
    out({ type: "error", id, retry: !/没有这个 MR|no such MR/.test(e.message), reason: e.message });
  }
  statusLine();
}

// ---- one MR ----

/** Looks at one MR: { state, detail, url }. */
async function one(key, { host, project, iid }, me) {
  const proj = encodeURIComponent(project);
  const base = `projects/${proj}/merge_requests/${iid}`;
  const mr = await get(host, base);
  const url = mr.web_url;
  const label = `MR !${iid}`;
  const mstate = mr.detailed_merge_status ?? mr.merge_status ?? "";
  const pipe = mr.head_pipeline;
  const discussions = await get(host, `${base}/discussions?per_page=100`);
  const notes = discussions.flatMap((d) => d.notes ?? []);
  const others = notes.filter((n) => !n.system && n.author?.username !== me);
  const unresolved = discussions.filter((d) => (d.notes ?? []).some((n) => n.resolvable && !n.resolved));
  const ap = mr.state === "opened" ? await get(host, `${base}/approvals`).catch(() => null) : null;
  const approvedBy = (ap?.approved_by ?? []).map((a) => a.user?.username).filter(Boolean);

  const state = {
    state: mr.state, // opened / merged / closed / locked
    draft: !!(mr.draft ?? mr.work_in_progress),
    pipeline: pipe?.status ?? "none",
    pipeline_id: pipe?.id ?? 0,
    reviews: others.length,
    unresolved: unresolved.length,
    last_note: others.reduce((m, n) => Math.max(m, n.id), 0),
    conflict: !!mr.has_conflicts || mstate === "conflict",
    need_rebase: mstate === "need_rebase",
    mergeable: mstate === "mergeable",
    approvals: approvedBy.length,
    head: mr.sha ?? "",
    target: mr.target_branch ?? "",
    // Who glab is (whose comments aren't "others'"), and every comment, newest 100, for conditions that filter:
    // notes.some(n => n.author != me && n.resolvable && !n.resolved)
    me,
    notes: notes
      .filter((n) => !n.system)
      .sort((a, b) => b.id - a.id)
      .slice(0, 100)
      .map((n) => ({
        id: n.id,
        author: n.author?.username ?? "",
        body: String(n.body ?? "").slice(0, 300),
        resolvable: !!n.resolvable,
        resolved: !!n.resolved,
        path: n.position?.new_path ?? "",
        line: n.position?.new_line ?? 0,
        created: n.created_at ?? "",
      })),
  };

  // What the woken one reads: where it stands, the latest comments by others, the failed jobs' logs
  const parts = [];
  if (mr.state === "merged") {
    const by = mr.merged_by?.username;
    const sha = mr.merge_commit_sha ? String(mr.merge_commit_sha).slice(0, 10) : "";
    parts.push(L(`${label} 已经合并进 ${mr.target_branch}${by ? `（${by} 合的）` : ""}${sha ? `，merge commit ${sha}` : ""}。`, `${label} is merged into ${mr.target_branch}${by ? ` (by ${by})` : ""}${sha ? `, merge commit ${sha}` : ""}.`));
  } else if (mr.state === "closed") {
    parts.push(L(`${label} 被关掉了，没有合并。`, `${label} was closed without merging.`));
  } else {
    const flags = [state.conflict && L("有冲突", "conflicts"), state.need_rebase && L("要变基", "needs a rebase"), state.mergeable && L("可以合并", "can be merged"), state.draft && "draft"].filter(Boolean);
    const who = approvedBy.length ? approvedBy.join(L("、", ", ")) : L("没有", "nobody");
    parts.push(L(`${label}：流水线 ${state.pipeline}，别人的意见 ${state.reviews} 条（未解决的讨论 ${state.unresolved} 个），批准：${who}${flags.length ? `，${flags.join("、")}` : ""}。`, `${label}: pipeline ${state.pipeline}, ${state.reviews} comments by others (${state.unresolved} unresolved threads), approved by ${who}${flags.length ? `, ${flags.join(", ")}` : ""}.`));
  }
  // Unresolved threads first (whoever started them), then the latest comments by others
  const firsts = unresolved.map((d) => d.notes[0]).filter(Boolean);
  const recent = [...firsts, ...others.slice().sort((a, b) => b.id - a.id)].filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i).slice(0, 8);
  if (recent.length) {
    parts.push(L("未解决的讨论和最近的意见：", "Unresolved threads and the latest comments:"));
    for (const n of recent) {
      const where = n.position?.new_path ? ` ${n.position.new_path}${n.position.new_line ? `:${n.position.new_line}` : ""}` : "";
      const res = n.resolvable ? (n.resolved ? L("（已解决）", " (resolved)") : L("（未解决）", " (unresolved)")) : "";
      parts.push(`- #${n.id} @${n.author?.username}${where}${res}${L("：", ":")}\n${String(n.body ?? "").slice(0, NOTE_MAX)}\n${url}#note_${n.id}`);
    }
  }
  if (pipe?.status === "failed") {
    const lk = `${host}/${project}:${pipe.id}`;
    if (!logs.has(lk)) {
      const jobs = await get(host, `projects/${proj}/pipelines/${pipe.id}/jobs?scope[]=failed&per_page=20`).catch(() => []);
      const tails = [];
      for (const j of jobs.slice(0, 2)) {
        const trace = await text(host, `projects/${proj}/jobs/${j.id}/trace`).catch(() => "");
        tails.push(`### ${j.name}（job ${j.id}，${j.web_url}）\n\`\`\`\n${trace.split("\n").slice(-60).join("\n")}\n\`\`\``);
      }
      const names = jobs.map((j) => j.name).join(L("、", ", ")) || L("（没拿到 job）", "(no jobs found)");
      logs.set(lk, L(`流水线挂了，失败的 job：${names}。${pipe.web_url}`, `The pipeline failed; failed jobs: ${names}. ${pipe.web_url}`) + (tails.length ? `\n\n${tails.join("\n\n")}` : ""));
      if (logs.size > 200) logs.delete(logs.keys().next().value);
    }
    parts.push(logs.get(lk));
  }
  return { state, detail: parts.join("\n\n"), url };
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
  if (m.type === "hello") {
    lang = m.lang === "en" ? "en" : "zh";
    statusLine();
  } else if (m.type === "get" && m.id) {
    get1(m.id, m.key ?? "").catch((e) => out({ type: "error", id: m.id, retry: true, reason: String(e?.message ?? e) }));
  }
});
// stdin closing means Gerdr is going: leave
rl.on("close", () => setTimeout(() => process.exit(0), 300));
