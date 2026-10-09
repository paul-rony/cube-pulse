// The morning brief: once a day, at the hour you choose in your own timezone, a short post on what your sessions did
// since the last one, which need you, what is still running, and what they made. One file per day, kept as a log.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Briefs {
  constructor(dir) {
    this.dir = join(dir, "briefs");
    mkdirSync(this.dir, { recursive: true });
    this.settingsPath = join(dir, "brief-settings.json");
    this.settings = { tz: null, hour: 7, ...read(this.settingsPath, {}) };
    this.writing = false;
  }

  saveSettings(patch) {
    if (typeof patch.tz === "string" && isTimeZone(patch.tz)) this.settings.tz = patch.tz;
    if (Number.isInteger(patch.hour) && patch.hour >= 0 && patch.hour <= 23) this.settings.hour = patch.hour;
    write(this.settingsPath, this.settings);
    return this.settings;
  }

  /** Today's date and hour where you are. */
  now(at = Date.now()) {
    const tz = this.settings.tz ?? "UTC";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  }

  list() {
    return readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().map((f) => {
      const b = read(join(this.dir, f), null);
      return b && { date: b.date, at: b.at, headline: b.headline };
    }).filter(Boolean);
  }

  get(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? read(join(this.dir, `${date}.json`), null) : null;
  }

  latest() {
    const first = this.list()[0];
    return first ? this.get(first.date) : null;
  }

  /** Due when you have said where you are, it is past your hour, and today has no brief yet. */
  due(at = Date.now()) {
    if (!this.settings.tz || this.writing) return false;
    const { date, hour } = this.now(at);
    return hour >= this.settings.hour && !existsSync(join(this.dir, `${date}.json`));
  }

  /** Writes today's brief from what the sessions did since the previous one. `ask` is the small model. */
  async write(sessions, summaries, ask, at = Date.now()) {
    if (this.writing) return null;
    this.writing = true;
    try {
      const prev = this.latest();
      const since = prev && prev.date !== this.now(at).date ? prev.at : prev?.since ?? at - 24 * 3_600_000;
      const moved = sessions.filter((s) => s.lastAt > since || s.status === "working");
      const made = [];
      const seen = new Set();
      for (const s of sessions) for (const a of s.assets) if (a.at > since && !seen.has(a.path)) { seen.add(a.path); made.push({ ...a, sid: s.id, from: s.title }); }
      made.sort((a, b) => b.at - a.at);

      let text = { headline: "", overnight: [], needsYou: [], running: [] };
      if (moved.length) {
        const lines = moved.map((s) => {
          const sum = summaries[s.id];
          return `- id ${s.id} · "${s.title}" · ${s.harness === "claude" ? "Claude Code" : "Codex"} in ${s.repo ?? "a folder"} · ${s.status === "working" ? "WORKING NOW" : s.status === "ready" ? "turn finished" : "quiet"}${sum?.needsYou ? " · WAITING ON THE PERSON" : ""}
  doing: ${sum?.doing || "(no summary)"}
  state: ${sum?.state || "(no summary)"}
  last ask: ${(s.lastAsk ?? "").replace(/\s+/g, " ").slice(0, 300)}
  made since: ${s.assets.filter((a) => a.at > since).map((a) => a.name).slice(0, 6).join(", ") || "nothing"}`;
        }).join("\n");
        const reply = await ask(`You write a short morning post for a busy person about the AI agent sessions running on their computer since they last looked. Plain, warm, specific; English; no file paths. Reply with JSON only, no fences:
{"headline": "one sentence on the most important thing this morning",
 "overnight": [{"session": "<id>", "text": "one sentence on what it got done"}],
 "needsYou": [{"session": "<id>", "text": "one sentence on what it needs from them: an answer, a review, a decision"}],
 "running": [{"session": "<id>", "text": "one sentence on what it is doing and how far along"}]}
Put a session in at most one list. needsYou: only sessions waiting on the person, most urgent first. running: only sessions working now. overnight: sessions that finished something; skip ones with nothing new. Keep each list to the sessions that matter, eight at most.

Sessions:
${lines}`);
        const j = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
        // Models sometimes shorten an id or give the title instead: match on any of them.
        const find = (ref) => {
          const r = String(ref ?? "").trim().replace(/^id\s+/i, "").toLowerCase();
          if (!r) return null;
          return moved.find((s) => s.id === r) ?? (r.length >= 6 ? moved.find((s) => s.id.startsWith(r)) : null) ?? moved.find((s) => s.title.toLowerCase() === r) ?? null;
        };
        const taken = new Set();
        const clean = (list) => (Array.isArray(list) ? list : []).map((x) => ({ s: find(x?.session ?? x?.id ?? x?.title), text: String(x?.text ?? "").slice(0, 400) }))
          .filter((x) => x.s && x.text && !taken.has(x.s.id) && taken.add(x.s.id)).map((x) => ({ session: x.s.id, text: x.text })).slice(0, 8);
        const needsYou = clean(j.needsYou), running = clean(j.running), overnight = clean(j.overnight);
        text = { headline: String(j.headline ?? "").slice(0, 300), overnight, needsYou, running };
      } else {
        text.headline = "A quiet night: no session moved since the last post.";
      }
      const { date } = this.now(at);
      const brief = {
        date, at, since, ...text,
        titles: Object.fromEntries(moved.map((s) => [s.id, { title: s.title, repo: s.repo, harness: s.harness }])),
        made: made.slice(0, 16).map(({ path, name, kind, at: t, sid, from }) => ({ path, name, kind, at: t, sid, from })),
      };
      write(join(this.dir, `${date}.json`), brief);
      return brief;
    } finally {
      this.writing = false;
    }
  }
}

function isTimeZone(tz) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}
function read(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function write(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
}
