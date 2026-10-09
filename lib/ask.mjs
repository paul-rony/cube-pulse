// One quick question to a small model, for summaries: Haiku through Claude Code, else Codex's lightest model.
// Run as the user, signed in as they already are; no tools, nothing kept.
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";

let harness;
async function pick() {
  if (harness !== undefined) return harness;
  const has = (cmd) => new Promise((r) => execFile("sh", ["-c", `command -v ${cmd}`], (e) => r(!e)));
  harness = (await has("claude")) ? "claude" : (await has("codex")) ? "codex" : null;
  return harness;
}

export async function ask(prompt) {
  const h = await pick();
  if (!h) throw new Error("No Claude Code or Codex on this machine to write summaries.");
  const args = h === "claude"
    ? ["-p", "--model", "claude-haiku-4-5-20251001", "--output-format", "text", "--tools", "", "--no-session-persistence", "--strict-mcp-config"]
    : ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-m", "gpt-6-luna", "-"];
  return new Promise((resolve, reject) => {
    const p = spawn(h, args, { stdio: ["pipe", "pipe", "pipe"], cwd: process.env.HOME });
    let out = "";
    const timer = setTimeout(() => p.kill(), 120_000);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error("The summary could not be written.")); });
    p.stdin.end(prompt);
  });
}
