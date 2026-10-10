// The timeline beside the sessions: pull requests opened, merged or closed; files made; commits; turns finished.
// Built from what Pulse already reads, plus two lookups kept cheap by caching: `gh pr view` for the pull requests
// sessions linked to, and `git log` for the folders they work in.
import { execFile } from "node:child_process";

const DAYS = 3 * 86_400_000;
const PR_TTL = 5 * 60_000;
const LOG_TTL = 2 * 60_000;

const prs = new Map(); // url -> { at, info }
const logs = new Map(); // folder -> { at, commits }
let lookups = 0;

function run(cmd, args, cwd) {
  return new Promise((resolve) => execFile(cmd, args, { cwd, timeout: 20_000, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? null : out)));
}

/** A pull request's title and state, from GitHub, at most every five minutes, a few lookups at a time. */
function pr(url) {
  const c = prs.get(url);
  if ((!c || Date.now() - c.at > PR_TTL) && lookups < 3) {
    prs.set(url, { at: Date.now(), info: c?.info ?? null });
    lookups++;
    run("gh", ["pr", "view", url, "--json", "number,title,state,createdAt,mergedAt,closedAt,isDraft"]).then((out) => {
      lookups--;
      if (!out) return;
      try { prs.set(url, { at: Date.now(), info: JSON.parse(out) }); } catch {}
    });
  }
  return prs.get(url)?.info ?? null;
}

/** Commits of the last three days in a folder, refreshed every two minutes. */
function commits(dir) {
  const c = logs.get(dir);
  if (!c || Date.now() - c.at > LOG_TTL) {
    logs.set(dir, { at: Date.now(), commits: c?.commits ?? [] });
    run("git", ["-C", dir, "log", "--since=3.days", "--max-count=30", "--format=%h%x09%ct%x09%s"]).then((out) => {
      if (out === null) return;
      logs.set(dir, { at: Date.now(), commits: out.trim().split("\n").filter(Boolean).map((l) => { const [sha, t, ...s] = l.split("\t"); return { sha, at: Number(t) * 1000, subject: s.join("\t") }; }) });
    });
  }
  return logs.get(dir)?.commits ?? [];
}

/** The timeline across `sessions`. `extra(id)` gives a session's full asset list and the pull requests it linked. */
export function buildTimeline(sessions, extra) {
  const since = Date.now() - DAYS;
  const out = [];
  const seenFiles = new Set();
  const seenPr = new Set();
  const byDir = new Map();
  for (const s of sessions) {
    const x = extra(s.id);
    for (const a of x.assets) {
      if (a.at < since || seenFiles.has(a.path)) continue;
      seenFiles.add(a.path);
      out.push({ kind: "file", at: a.at, sid: s.id, session: s.title, repo: s.repo, name: a.name, path: a.path, file: a.kind });
    }
    for (const url of x.prs) {
      if (seenPr.has(url)) continue;
      seenPr.add(url);
      const info = pr(url);
      if (!info) continue;
      const base = { sid: s.id, session: s.title, repo: url.split("/")[4], url, number: info.number, title: info.title };
      const opened = Date.parse(info.createdAt);
      if (opened > since) out.push({ kind: "pr-opened", at: opened, draft: info.isDraft, ...base });
      if (info.mergedAt && Date.parse(info.mergedAt) > since) out.push({ kind: "pr-merged", at: Date.parse(info.mergedAt), ...base });
      else if (info.closedAt && info.state === "CLOSED" && Date.parse(info.closedAt) > since) out.push({ kind: "pr-closed", at: Date.parse(info.closedAt), ...base });
    }
    if (s.turnEndedAt && s.turnEndedAt > since && s.status !== "working") out.push({ kind: "turn", at: s.turnEndedAt, sid: s.id, session: s.title, repo: s.repo, needsYou: !!s.summary?.needsYou });
    if (s.dir) byDir.set(s.dir, [...(byDir.get(s.dir) ?? []), s]);
  }
  for (const [dir, list] of byDir) {
    // A commit belongs to the folder; it is credited to a session only when one session alone works there.
    const only = list.length === 1 ? list[0] : null;
    for (const c of commits(dir)) if (c.at > since) out.push({ kind: "commit", at: c.at, sid: only?.id ?? null, session: only?.title ?? null, repo: list[0].repo, sha: c.sha, title: c.subject });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 150);
}
