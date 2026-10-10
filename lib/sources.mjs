// Where Pulse learns about your Cube sessions, without driving any of them:
// - Cube's catalog (the daemon keeps it as a JSON file): every terminal agent, its title, folder, repository, and
//   whether it is working right now or has finished its turn.
// - Each session's transcript (Claude Code's or Codex's own log): what you asked, what it answered, and the files it
//   wrote or pointed at. Transcripts only grow, so each is read from where the last read stopped.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HOME = homedir();

/** The Cube daemon's folder: $CUBE_DAEMON_DIR, or wherever this machine keeps it. */
export function findDaemonDir() {
  const candidates = [process.env.CUBE_DAEMON_DIR, join(HOME, "..", ".cube", "daemon"), join(HOME, ".cube", "daemon"), "/workspace/.cube/daemon"].filter(Boolean);
  return candidates.find((d) => existsSync(join(d, "catalog.json"))) ?? null;
}

export function readCatalog(dir) {
  const c = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
  const repos = new Map((Array.isArray(c.repos) ? c.repos : Object.values(c.repos ?? {})).map((r) => [r.id, r]));
  return { repos, items: c.items ?? [] };
}

const GLYPH = /^[⠀-⣿◐-◓✳✶✻✽✢·*✳✶✻✽✢⏺●○◯]+\s*/u;

/** Cube's terminal agents that are still open, as Pulse sees them. */
export function sessionsFrom(catalog) {
  return catalog.items.filter((i) => i.type === "term" && (i.target === "claude" || i.target === "codex") && !i.exitedAt).map((i) => {
    const repo = catalog.repos.get(i.repoId);
    const raw = String(i.agentTitle ?? "").replace(GLYPH, "").trim();
    const repoName = repo?.name ?? null;
    let title = (i.userTitle || raw).trim();
    // Codex titles end with " | <folder>"; Claude's idle title is just "Claude Code".
    title = title.replace(/\s*\|\s*[^|]+$/, "").trim();
    if (!title || title === "Claude Code" || title === repoName || title === (i.workingDir ?? "").split("/").pop()) title = "";
    return {
      // How Cube's sidebar names it: your rename if you gave one, else the agent's own title.
      cubeTitle: (i.userTitle || raw || (i.target === "claude" ? "Claude Code" : "Codex")).trim(),
      id: i.id, harness: i.target, title, transcriptId: i.agentSessionId ?? null,
      dir: i.workingDir ?? (i.cwd && !i.cwd.startsWith("/@") ? i.cwd : repo?.root ?? null),
      repo: repoName, repoRoot: repo?.root ?? null, createdAt: Date.parse(i.createdAt) || 0,
      working: i.agentActivity === "running", turnEndedAt: Date.parse(i.turnEndedAt) || null,
    };
  });
}

/** Files Cube's catalog knows as artifacts and images, for attributing them to sessions by folder. */
export function catalogAssets(catalog) { // kept for the catalog's own artifact titles
  return catalog.items.filter((i) => (i.type === "artifact" || i.type === "image") && i.filePath).map((i) => ({ path: i.filePath, title: i.agentTitle ?? null, at: Date.parse(i.createdAt) || 0 }));
}

// ---- Transcripts ----------------------------------------------------------------------------------------------

/** Claude Code keeps ~/.claude/projects/<folder with / and . as ->/<session>.jsonl. */
export function claudeTranscript(id, dir) {
  const root = join(HOME, ".claude", "projects");
  if (dir) {
    const guess = join(root, dir.replace(/[/.]/g, "-"), `${id}.jsonl`);
    if (existsSync(guess)) return guess;
  }
  try {
    for (const d of readdirSync(root)) if (existsSync(join(root, d, `${id}.jsonl`))) return join(root, d, `${id}.jsonl`);
  } catch {}
  return null;
}

let codexIndex = { at: 0, files: new Map() };
/** Codex keeps ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl. Indexed, and re-indexed at most every 20 s. */
export function codexTranscript(id) {
  if (codexIndex.files.has(id)) return codexIndex.files.get(id);
  if (Date.now() - codexIndex.at < 20_000) return null;
  const files = new Map();
  const walk = (d, depth) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (depth < 3) walk(p, depth + 1);
      else if (n.endsWith(".jsonl")) { const m = n.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/); if (m) files.set(m[1], p); }
    }
  };
  walk(join(HOME, ".codex", "sessions"), 0);
  codexIndex = { at: Date.now(), files };
  return files.get(id) ?? null;
}

const ASSET_EXT = "png|jpe?g|webp|gif|svg|html|mp4|webm|mov|pdf|glb|gltf";
// Bounded on purpose: tool output holds long unbroken runs (base64, minified code) that would make open-ended
// patterns backtrack for ever.
const ABS_PATH = new RegExp(`(?:/[\\w.@~+%-]{1,100}){1,16}\\.(?:${ASSET_EXT})(?![\\w/])`, "gi");
const REL_PATH = new RegExp(`(?<![\\w/.~-])(?:[\\w@+-][\\w.@+-]{0,100}/){1,12}[\\w.@+-]{1,100}\\.(?:${ASSET_EXT})(?![\\w/])`, "gi");
// Pull requests a session opened or worked on show up as links in its conversation.
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,6})(?![\d\w])/g;
const NOISE = /<(task-notification|environment_context|user_instructions|system-reminder|command-name|command-message|local-command-stdout|local-command-caveat|permissions instructions|INSTRUCTIONS)\b|^# AGENTS\.md|^Caveat: /i;

const TAIL = 6 << 20;
const reads = new Map(); // transcript path -> { offset, carry, asks, replies, mentioned, written, lastAt, lastRole }

/** What a transcript says so far: your asks, its replies (latest last), and asset paths it wrote or named. */
export function readTranscript(path, harness) {
  let st;
  try { st = statSync(path); } catch { return null; }
  let r = reads.get(path);
  if (!r || st.size < r.offset) {
    // A transcript can run to gigabytes. The first read starts near its end, where the recent work is; after that,
    // only what was added is read.
    const start = Math.max(0, st.size - TAIL);
    r = { offset: start, carry: "", skipFirst: start > 0, asks: [], replies: [], mentioned: new Set(), written: new Set(), prs: new Set(), lastAt: 0, lastRole: null, size: 0 };
  }
  if (st.size > r.offset) {
    // Read what is new, in chunks, so a long transcript never sits whole in memory.
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(1 << 20);
      while (r.offset < st.size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, st.size - r.offset), r.offset);
        if (n <= 0) break;
        r.offset += n;
        const text = r.carry + buf.toString("utf8", 0, n);
        const lines = text.split("\n");
        r.carry = lines.pop();
        if (r.skipFirst) { lines.shift(); r.skipFirst = false; } // started mid-line
        for (const line of lines) take(r, line, harness);
      }
    } finally {
      closeSync(fd);
    }
  }
  if (r.tailStart === undefined) r.tailStart = Math.max(0, st.size - TAIL);
  if (!r.asks.length && r.tailStart > 0 && !r.searchedBack) {
    r.searchedBack = true;
    r.asks = asksBefore(path, r.tailStart, harness);
  }
  r.size = st.size;
  r.mtime = st.mtimeMs;
  reads.set(path, r);
  return r;
}

function keep(list, item, max = 12) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function take(r, line, harness) {
  if (!line.trim()) return;
  // Tool output can be huge; paths worth knowing appear early in a line.
  const head = line.length > 200_000 ? line.slice(0, 200_000) : line;
  for (const m of head.match(ABS_PATH) ?? []) r.mentioned.add(m);
  for (const m of head.match(REL_PATH) ?? []) r.mentioned.add(m);
  for (const m of head.matchAll(PR_URL)) r.prs?.add(`https://github.com/${m[1]}/pull/${m[2]}`);
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  const at = Date.parse(ev.timestamp) || r.lastAt;
  if (harness === "claude") {
    const msg = ev.message;
    if (ev.type === "user" && msg && !ev.isMeta) {
      const texts = typeof msg.content === "string" ? [msg.content] : (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
      const t = texts.join("\n").trim();
      if (t && !NOISE.test(t)) { keep(r.asks, { text: t, at }); r.lastRole = "user"; }
    }
    if (ev.type === "assistant" && msg) {
      for (const c of msg.content ?? []) {
        if (c.type === "text" && c.text.trim()) { keep(r.replies, { text: c.text.trim(), at }); r.lastRole = "assistant"; }
        if (c.type === "tool_use" && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name) && c.input?.file_path) r.written.add(c.input.file_path);
      }
    }
  } else {
    const p = ev.payload ?? {};
    if (ev.type === "response_item" && p.type === "message") {
      const t = (p.content ?? []).filter((c) => c.type === "input_text" || c.type === "output_text").map((c) => c.text).join("\n").trim();
      if (t && !NOISE.test(t) && !t.startsWith("<")) {
        if (p.role === "user") { keep(r.asks, { text: t, at }); r.lastRole = "user"; }
        if (p.role === "assistant") { keep(r.replies, { text: t, at }); r.lastRole = "assistant"; }
      }
    }
    if (ev.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) {
      const input = String(p.input ?? p.arguments ?? "");
      for (const m of input.matchAll(/\*\*\* (?:Add|Update) File: ([^\\\n"]+)/g)) r.written.add(m[1].trim());
    }
  }
  if (at) r.lastAt = at;
}

/** The asset files a session made: ones it wrote, and ones it named that live in its folder and changed while it was
 *  open (renders, exports). Files it only mentioned elsewhere are someone else's. */
export function assetsOf(r, session) {
  const base = session.dir ?? session.repoRoot ?? HOME;
  const found = new Map();
  const consider = (p, how) => {
    const abs = isAbsolute(p) ? p : resolve(base, p);
    if (found.has(abs) || !new RegExp(`\\.(${ASSET_EXT})$`, "i").test(abs) || abs.includes("/node_modules/") || abs.includes("/.git/")) return;
    if (how === "named" && !(abs.startsWith(base + "/") || (session.repoRoot && abs.startsWith(session.repoRoot + "/")))) return;
    let st;
    try { st = statSync(abs); } catch { return; }
    if (!st.isFile()) return;
    if (how === "named" && st.mtimeMs < session.createdAt) return;
    found.set(abs, { path: abs, name: abs.split("/").pop(), kind: kindOf(abs), size: st.size, at: st.mtimeMs, how });
  };
  for (const p of r?.written ?? []) consider(p, "written");
  for (const p of r?.mentioned ?? []) consider(p, "named");
  return [...found.values()].sort((a, b) => b.at - a.at).slice(0, 60);
}

/** Your latest asks in a long transcript, found by reading backwards from where the tail began. */
function asksBefore(path, end, harness, want = 3, budget = 256 << 20) {
  const found = [];
  const fd = openSync(path, "r");
  try {
    const chunk = 4 << 20;
    let pos = end, carry = "";
    while (pos > 0 && end - pos < budget && found.length < want) {
      const start = Math.max(0, pos - chunk);
      const buf = Buffer.alloc(pos - start);
      readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8") + carry;
      const lines = text.split("\n");
      carry = start > 0 ? lines.shift() : "";
      for (const line of lines.reverse()) {
        if (!line.includes(harness === "claude" ? '"type":"user"' : '"role":"user"')) continue;
        const tmp = { asks: [], replies: [], mentioned: new Set(), written: new Set(), lastAt: 0 };
        take(tmp, line, harness);
        if (tmp.asks.length) { found.unshift(tmp.asks[0]); if (found.length >= want) break; }
      }
      pos = start;
    }
  } finally {
    closeSync(fd);
  }
  return found;
}

export function kindOf(path) {
  const ext = path.split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  if (ext === "html") return "page";
  if (ext === "pdf") return "pdf";
  return "model";
}
