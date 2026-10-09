// Which models a block can use. Text comes from the agent harnesses installed on this machine, signed in as they
// already are for Cube's personas: Claude Code, Codex and opencode. Images come from Codex's own image generation
// (the ChatGPT sign-in, no key) or fal.ai; video from fal.ai.
import { spawn, execFile } from "node:child_process";

const CACHE_MS = 10 * 60_000;
let cache = null;

/** Claude Code has no command that lists its models, so these are the ones it accepts by name. */
const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5" },
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" },
];

export const FAL_MODELS = {
  image: [
    { id: "fal-ai/nano-banana-2", name: "Nano Banana 2", edit: "fal-ai/nano-banana-2/edit" },
  ],
  video: [
    { id: "fal-ai/kling-video/v3/pro/image-to-video", name: "Kling 3.0 Pro", needsImage: true },
    { id: "bytedance/seedance-2.5/image-to-video", name: "Seedance 2.5", needsImage: true },
  ],
};

function onPath(cmd) {
  return new Promise((resolve) => execFile("sh", ["-c", `command -v ${cmd}`], (err) => resolve(!err)));
}

function run(cmd, args, ms = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: ms, maxBuffer: 4 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Codex lists its models over its app-server protocol, the same list Cube's personas show. */
function codexModels(ms = 15_000) {
  return new Promise((resolve) => {
    const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const done = (v) => { clearTimeout(timer); p.kill(); resolve(v); };
    const timer = setTimeout(() => done([]), ms);
    p.on("error", () => done([]));
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { p.stdin.write(JSON.stringify({ method: "initialized" }) + "\n"); p.stdin.write(JSON.stringify({ id: 2, method: "model/list", params: {} }) + "\n"); }
        if (m.id === 2) done((m.result?.data ?? []).filter((x) => !x.hidden).map((x) => ({
          id: x.id, name: x.displayName ?? x.id, efforts: (x.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort), effort: x.defaultReasoningEffort ?? null, isDefault: !!x.isDefault,
        })));
      }
    });
    p.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "cube-surface", version: "0.1" } } }) + "\n");
  });
}

async function opencodeModels() {
  try {
    return (await run("opencode", ["models"])).split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:@-]+$/.test(l)).map((id) => ({ id, name: id.split("/")[1] }));
  } catch {
    return [];
  }
}

/** Every model a block can pick, grouped by what made it available. Cached for ten minutes. */
export async function listModels(custom = { image: [], video: [] }, force = false) {
  if (!cache || force || Date.now() - cache.at > CACHE_MS) {
    const [hasClaude, hasCodex, hasOpencode] = await Promise.all(["claude", "codex", "opencode"].map(onPath));
    const text = [];
    if (hasClaude) text.push({ provider: "claude", label: "Claude Code", models: CLAUDE_MODELS });
    if (hasCodex) text.push({ provider: "codex", label: "Codex", models: await codexModels() });
    if (hasOpencode) text.push({ provider: "opencode", label: "opencode", models: await opencodeModels() });
    cache = { at: Date.now(), text: text.filter((g) => g.models.length) };
  }
  const viaCodex = cache.text.some((g) => g.provider === "codex")
    ? [{ provider: "codex", label: "Codex (your ChatGPT sign-in)", models: [{ id: "image_generation", name: "GPT Image", edits: true }] }]
    : [];
  return {
    text: cache.text,
    image: [...viaCodex, { provider: "fal", label: "fal.ai", models: [...FAL_MODELS.image, ...custom.image.map((id) => ({ id, name: id }))] }],
    video: [{ provider: "fal", label: "fal.ai", models: [...FAL_MODELS.video, ...custom.video.map((id) => ({ id, name: id }))] }],
  };
}

/** A sensible model for a new block of `type`, from what is available. */
export function defaultModel(models, type) {
  const groups = type === "image" ? models.image : type === "video" ? models.video : models.text;
  // Text prefers Claude; images prefer GPT Image through Codex, which needs no key.
  const g = groups.find((x) => x.provider === (type === "image" ? "codex" : "claude")) ?? groups[0];
  const m = g?.models.find((x) => x.isDefault) ?? g?.models[0];
  return m ? { provider: g.provider, id: m.id } : null;
}
