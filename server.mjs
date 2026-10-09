// Cube Pulse. Cube runs it with `node server.mjs` and sets $PORT.
//
// It watches the agent sessions open in your Cube, without driving any of them: which are working, which have
// finished and are waiting for you, a two-line summary of each, and the files each has made. It reads Cube's catalog
// and the sessions' own transcripts; the only thing it runs is a small model, to write the summaries.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "./lib/ask.mjs";
import { assetsOf, claudeTranscript, codexTranscript, findDaemonDir, readCatalog, readTranscript, sessionsFrom } from "./lib/sources.mjs";

const port = Number(process.env.PORT);
if (!port) throw new Error("PORT is not set; Cube sets it when it starts the app.");

const here = dirname(fileURLToPath(import.meta.url));
const STATE = process.env.PULSE_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cube-pulse");
mkdirSync(STATE, { recursive: true });
const POLL_MS = 5000;
const RECENT_MS = 3 * 86_400_000; // sessions quiet for longer than this get no new summary

const daemon = findDaemonDir();
const summaries = loadJson(join(STATE, "summaries.json"), {}); // session id -> { doing, state, needsYou, at, size }
function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
let saveTimer = null;
function saveSummaries() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFileSync(join(STATE, "summaries.json.tmp"), JSON.stringify(summaries));
    renameSync(join(STATE, "summaries.json.tmp"), join(STATE, "summaries.json"));
  }, 500);
}

// ---- Looking -----------------------------------------------------------------------------------------------------

let view = { sessions: [], projects: [], error: null, at: 0 }; // what the page shows
const details = new Map(); // session id -> { asks, replies, assets }
const allowed = new Set(); // files the page may load: only ones attributed to a session
const branches = new Map(); // folder -> { branch, at }

function branchOf(dir) {
  if (!dir) return null;
  const b = branches.get(dir);
  if (!b || Date.now() - b.at > 60_000) {
    branches.set(dir, { branch: b?.branch ?? null, at: Date.now() });
    execFile("git", ["-C", dir, "branch", "--show-current"], { timeout: 5000 }, (err, out) => { if (!err) branches.set(dir, { branch: out.trim() || null, at: Date.now() }); });
  }
  return b?.branch ?? null;
}

function look() {
  if (!daemon) {
    view = { ...view, error: "Cube's catalog was not found on this machine. Set CUBE_DAEMON_DIR to the Cube daemon's folder.", at: Date.now() };
    return;
  }
  let catalog;
  try { catalog = readCatalog(daemon); } catch (err) { view = { ...view, error: `Cube's catalog could not be read: ${err.message}` }; return; }
  const sessions = [];
  allowed.clear();
  for (const s of sessionsFrom(catalog)) {
    if (!s.transcriptId) continue; // a terminal where no conversation ever started
    const path = s.harness === "claude" ? claudeTranscript(s.transcriptId, s.dir) : codexTranscript(s.transcriptId);
    const r = path ? readTranscript(path, s.harness) : null;
    if (!r) continue;
    const assets = assetsOf(r, s);
    for (const a of assets) allowed.add(a.path);
    const lastAt = Math.max(r.lastAt || 0, s.turnEndedAt || 0, r.mtime || 0);
    const status = s.working ? "working" : r.lastRole === "assistant" && Date.now() - lastAt < 2 * 86_400_000 ? "ready" : "quiet";
    const sum = summaries[s.id];
    details.set(s.id, { asks: r.asks.slice(-5), replies: r.replies.slice(-3), assets });
    sessions.push({
      ...s, status, lastAt, branch: branchOf(s.dir), size: r.size, lastRole: r.lastRole,
      title: s.title || firstWords(r.asks[0]?.text) || s.repo || "Untitled session",
      summary: sum ? { doing: sum.doing, state: sum.state, needsYou: sum.needsYou, at: sum.at, stale: sum.size !== r.size } : null,
      lastAsk: r.asks.at(-1)?.text.slice(0, 300) ?? null,
      assets: assets.slice(0, 8).map(({ path, name, kind, at }) => ({ path, name, kind, at })), assetCount: assets.length,
    });
  }
  sessions.sort((a, b) => b.lastAt - a.lastAt);
  const projects = new Map();
  for (const s of sessions) {
    const key = s.repo ?? "Elsewhere";
    const p = projects.get(key) ?? { name: key, count: 0, working: 0, ready: 0 };
    p.count++;
    if (s.status === "working") p.working++;
    if (s.status === "ready") p.ready++;
    projects.set(key, p);
  }
  const next = { sessions, projects: [...projects.values()].sort((a, b) => b.working - a.working || b.ready - a.ready || b.count - a.count), error: null, at: Date.now() };
  const hash = createHash("sha1").update(JSON.stringify([next.sessions.map((s) => [s.id, s.status, s.title, s.summary, s.assetCount, s.assets[0]?.at, s.branch, s.lastAsk]), next.error])).digest("hex");
  view = next;
  if (hash !== look.hash) { look.hash = hash; send({ type: "view", view }); }
  queueSummaries();
}

function firstWords(t) {
  if (!t) return "";
  const line = t.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 60 ? `${line.slice(0, 57).replace(/\s+\S*$/, "")}…` : line;
}

// ---- Summaries ---------------------------------------------------------------------------------------------------

const writing = new Set();
const MAX_WRITERS = 2;

/** Which sessions need a new summary: changed since the last one, recent, and (when working) not rewritten too often. */
function queueSummaries() {
  const due = view.sessions.filter((s) => {
    if (writing.has(s.id) || Date.now() - s.lastAt > RECENT_MS) return false;
    const sum = summaries[s.id];
    if (!sum) return true;
    if (sum.size === s.size) return false;
    // A working session moves on constantly: rewrite at most every three minutes. A finished turn: right away.
    return s.status === "working" ? Date.now() - sum.at > 3 * 60_000 : sum.lastRole !== s.lastRole || Date.now() - sum.at > 60_000;
  }).sort((a, b) => (a.status === "working" ? 0 : 1) - (b.status === "working" ? 0 : 1) || b.lastAt - a.lastAt);
  for (const s of due) {
    if (writing.size >= MAX_WRITERS) break;
    writeSummary(s);
  }
}

async function writeSummary(s) {
  writing.add(s.id);
  const d = details.get(s.id);
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
  const prompt = `You watch an AI coding agent's session for a busy person who runs many at once. Say in plain words what this session is up to, so they can pick it up at a glance. Reply with JSON only, no fences:
{"doing": "one short sentence: what it is working on", "state": "one short sentence: where it stands now, or what it needs from the person", "needsYou": true or false (true only if it is waiting for an answer, a decision or a check from the person)}
Write in English. Name concrete things (features, files, pages) but no file paths.

Session: ${s.title} · ${s.harness === "claude" ? "Claude Code" : "Codex"} in ${s.repo ?? "a folder"}${s.branch ? ` on ${s.branch}` : ""}. Status: ${s.status === "working" ? "working right now" : "its turn has ended"}.

What the person asked most recently:
${d.asks.map((a) => `- ${clip(a.text, 900)}`).join("\n") || "(nothing found)"}

The agent's latest replies:
${d.replies.map((r) => `- ${clip(r.text, 1500)}`).join("\n") || "(nothing yet)"}

Files it made recently: ${d.assets.slice(0, 8).map((a) => a.name).join(", ") || "none"}`;
  try {
    const reply = await ask(prompt);
    const j = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
    summaries[s.id] = { doing: String(j.doing ?? "").slice(0, 300), state: String(j.state ?? "").slice(0, 300), needsYou: !!j.needsYou, at: Date.now(), size: s.size, lastRole: s.lastRole };
    saveSummaries();
  } catch {
    // Try again on a later look, not straight away.
    summaries[s.id] = { ...(summaries[s.id] ?? { doing: "", state: "", needsYou: false }), at: Date.now(), size: summaries[s.id]?.size ?? -1, lastRole: s.lastRole };
  } finally {
    writing.delete(s.id);
    look.hash = null;
    look();
  }
}

// ---- HTTP --------------------------------------------------------------------------------------------------------

const streams = new Set();
function send(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of streams) res.write(data);
}
setInterval(() => { for (const res of streams) res.write(": keepalive\n\n"); }, 15_000);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".pdf": "application/pdf", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
};
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://local");
  const path = url.pathname;
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Pulse only looks." });
  if (path === "/") return sendStatic(res, "index.html");
  if (/^\/[a-z0-9-]+\.(mjs|css|svg)$/.test(path)) return sendStatic(res, path.slice(1));
  if (path === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "view", view })}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  const sm = path.match(/^\/api\/sessions\/([\w-]+)$/);
  if (sm) {
    const s = view.sessions.find((x) => x.id === sm[1]);
    const d = details.get(sm[1]);
    if (!s || !d) return json(res, 404, { error: "No such session open in Cube." });
    return json(res, 200, { ...s, asks: d.asks, replies: d.replies, assets: d.assets.map(({ path, name, kind, at, size, how }) => ({ path, name, kind, at, size, how })) });
  }
  if (path === "/file") {
    // Only files Pulse attributed to a session, served as they are.
    const p = url.searchParams.get("path") ?? "";
    if (!allowed.has(p)) return json(res, 404, { error: "Not a file Pulse knows." });
    try {
      const st = lstatSync(p);
      if (!st.isFile()) throw new Error();
      res.writeHead(200, { "content-type": TYPES[extname(p).toLowerCase()] ?? "application/octet-stream", "content-length": st.size, "cache-control": "private, max-age=60" });
      createReadStream(p).pipe(res);
    } catch {
      json(res, 404, { error: "That file is gone." });
    }
    return;
  }
  json(res, 404, { error: "Not found." });
});

function sendStatic(res, name) {
  try {
    res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(readFileSync(join(here, "public", name)));
  } catch {
    json(res, 404, { error: "Not found." });
  }
}

server.listen(port, "127.0.0.1", () => console.log(`Cube Pulse on 127.0.0.1:${port}, watching ${daemon ?? "(no Cube catalog found)"}`));
look();
setInterval(look, POLL_MS);
