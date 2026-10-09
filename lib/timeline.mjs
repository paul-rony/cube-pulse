// A session's conversation, read from its transcript for display: your messages, the agent's replies, and the steps
// it took in between (commands, edits, searches). Read by byte range, so the page can follow the end of a transcript
// as it grows and page back through it a slice at a time, however large the file.
import { closeSync, openSync, readSync, statSync } from "node:fs";

const NOISE = /<(task-notification|environment_context|user_instructions|system-reminder|command-name|command-message|local-command-stdout|local-command-caveat|permissions instructions|INSTRUCTIONS)\b|^# AGENTS\.md|^Caveat: /i;
const SLICE = 2 << 20; // how far back one page of history reaches

/** A short line for a Claude Code tool call. */
function claudeStep(name, input = {}) {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  const short = (p) => String(p ?? "").split("/").slice(-3).join("/");
  switch (name) {
    case "Bash": return { verb: "ran", what: String(input.command ?? "").split("\n")[0].slice(0, 200) };
    case "Edit": case "MultiEdit": return { verb: "edited", what: short(file), path: file };
    case "Write": return { verb: "wrote", what: short(file), path: file };
    case "Read": return { verb: "read", what: short(file) };
    case "Grep": return { verb: "searched for", what: String(input.pattern ?? "") };
    case "Glob": return { verb: "looked for", what: String(input.pattern ?? "") };
    case "WebFetch": return { verb: "fetched", what: String(input.url ?? "") };
    case "WebSearch": return { verb: "searched the web for", what: String(input.query ?? "") };
    case "Task": case "Agent": return { verb: "asked a helper to", what: String(input.description ?? input.prompt ?? "").slice(0, 160) };
    case "TodoWrite": return null;
    default: return { verb: "used", what: name };
  }
}

/** A short line for a Codex tool call. */
function codexStep(p) {
  const raw = String(p.input ?? p.arguments ?? "");
  const patch = [...raw.matchAll(/\*\*\* (Add|Update|Delete) File: ([^\\\n"]+)/g)];
  if (patch.length) return patch.map((m) => ({ verb: m[1] === "Add" ? "wrote" : m[1] === "Delete" ? "deleted" : "edited", what: m[2].trim().split("/").slice(-3).join("/"), path: m[2].trim() }));
  let cmd = null;
  try {
    const j = JSON.parse(raw);
    cmd = Array.isArray(j.command) ? j.command.join(" ") : j.cmd ?? j.command ?? null;
  } catch {
    const m = raw.match(/(?:cmd|command)\s*[:=]\s*["'`]([^"'`]{1,300})/);
    if (m) cmd = m[1];
  }
  if (cmd) return [{ verb: "ran", what: String(cmd).replace(/^(bash|sh|zsh) -l?c\s+/, "").replace(/^['"]|['"]$/g, "").split("\n")[0].slice(0, 200) }];
  return [{ verb: "used", what: p.name ?? "a tool" }];
}

function entriesOf(line, harness) {
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }
  const at = Date.parse(ev.timestamp) || null;
  const out = [];
  if (harness === "claude") {
    const msg = ev.message;
    if (!msg) return out;
    if (ev.type === "user" && !ev.isMeta) {
      const t = (typeof msg.content === "string" ? [msg.content] : (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text)).join("\n").trim();
      if (t && !NOISE.test(t)) out.push({ kind: "you", text: t, at });
    }
    if (ev.type === "assistant") {
      for (const c of msg.content ?? []) {
        if (c.type === "text" && c.text.trim()) out.push({ kind: "agent", text: c.text.trim(), at });
        if (c.type === "tool_use") { const s = claudeStep(c.name, c.input); if (s) out.push({ kind: "step", ...s, at }); }
      }
    }
  } else {
    const p = ev.payload ?? {};
    if (ev.type === "response_item" && p.type === "message") {
      const t = (p.content ?? []).filter((c) => c.type === "input_text" || c.type === "output_text").map((c) => c.text).join("\n").trim();
      if (t && !NOISE.test(t) && !t.startsWith("<")) out.push({ kind: p.role === "user" ? "you" : "agent", text: t, at });
    }
    if (ev.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) for (const s of codexStep(p)) out.push({ kind: "step", ...s, at });
  }
  return out;
}

const WANT = 30; // entries worth a page
const REACH = 48 << 20; // how far back a page may reach to find them

/** Entries between byte offsets `from` and `to` of a transcript (whole lines only), with the offsets actually used.
 *  Without `from`, it reads back from `to` (or the end) far enough to fill a page: tool output can make the last few
 *  megabytes hold almost no conversation. */
export function timeline(path, harness, { from = null, to = null } = {}) {
  const size = statSync(path).size;
  const end = to === null ? size : Math.min(to, size);
  if (from !== null) return readRange(path, harness, Math.max(0, from), end, size);
  let span = SLICE, got;
  for (;;) {
    got = readRange(path, harness, Math.max(0, end - span), end, size);
    if (got.entries.length >= WANT || got.from === 0 || span >= REACH) return got;
    span *= 2;
  }
}

// Lines that can hold a message or a step; everything else (tool output, token counts) is skipped unparsed.
const USEFUL = { claude: /"type":"(user|assistant)"/, codex: /"type":"(message|function_call|custom_tool_call)"/ };

function readRange(path, harness, start, end, size) {
  if (start >= end) return { entries: [], from: start, to: end, size };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, buf.length, start);
    let first = start, last = end;
    // Begin and end on whole lines: a range that starts mid-line drops that partial line.
    let a = 0, b = buf.length;
    if (start > 0) { const nl = buf.indexOf(10); a = nl + 1; first = start + a; }
    if (buf[b - 1] !== 10) { const nl = buf.lastIndexOf(10); b = nl + 1; last = start + b; }
    if (b <= a) return { entries: [], from: start, to: start, size };
    const entries = [];
    let i = a;
    while (i < b) {
      let j = buf.indexOf(10, i);
      if (j < 0 || j > b) j = b;
      // Peek at the start of the line for its type before decoding all of it.
      const head = buf.toString("utf8", i, Math.min(j, i + 400));
      if (USEFUL[harness].test(head)) entries.push(...entriesOf(buf.toString("utf8", i, j), harness));
      i = j + 1;
    }
    return { entries: entries.slice(-600), from: first, to: last, size };
  } finally {
    closeSync(fd);
  }
}
