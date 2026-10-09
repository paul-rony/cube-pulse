// Pulse's page. The server streams what it sees; the page draws it, and asks for one session's details on demand.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// Cube may open the page with ?theme=light|dark.
try { const t = new URLSearchParams(location.search).get("theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}

let view = null;
let project = store.get("pulse.project"); // null for all
let selected = null; // session id
let detail = null; // the selected session's details
let showing = null; // the asset path in the viewer
let showEarlier = store.get("pulse.earlier") ?? false;

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const fileUrl = (p) => `/file?path=${encodeURIComponent(p)}`;
const HARNESS = { claude: "Claude", codex: "Codex" };

function md(text) {
  const blocks = [];
  const src = String(text ?? "").replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => { blocks.push(code); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return src.split(/\n{2,}/).map((para) => {
    const code = para.match(/^\u0000(\d+)\u0000$/);
    if (code) return `<pre><code>${esc(blocks[code[1]])}</code></pre>`;
    const lines = para.split("\n");
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    return `<p>${lines.map((l) => inline(l.replace(/^#+\s+/, ""))).join("<br>")}</p>`.replace(/\u0000(\d+)\u0000/g, (_, i) => `</p><pre><code>${esc(blocks[i])}</code></pre><p>`);
  }).join("");
}

function thumb(a, cls = "thumb") {
  if (a.kind === "image") return `<img class="${cls}" src="${fileUrl(a.path)}" alt="${esc(a.name)}" loading="lazy">`;
  const label = { page: "◇ page", video: "▶ video", pdf: "PDF", model: "3D" }[a.kind] ?? a.kind;
  return cls === "thumb" ? `<span class="chip" title="${esc(a.name)}">${label}</span>` : `<span class="${cls}">${label}</span>`;
}

// ---- Left --------------------------------------------------------------------------------------------------------

function renderProjects() {
  const all = view?.sessions ?? [];
  const working = all.filter((s) => s.status === "working").length, ready = all.filter((s) => s.status === "ready").length;
  const counts = (w, r, n) => `<span class="counts">${w ? `<span class="pill working">${w}</span>` : ""}${r ? `<span class="pill ready">${r}</span>` : ""}<span>${n}</span></span>`;
  $("projects").innerHTML = `<button class="proj${project === null ? " on" : ""}" data-project=""><span class="n">All sessions</span>${counts(working, ready, all.length)}</button>
    <h4>Projects</h4>
    ${(view?.projects ?? []).map((p) => `<button class="proj${project === p.name ? " on" : ""}" data-project="${esc(p.name)}"><span class="n">${esc(p.name)}</span>${counts(p.working, p.ready, p.count)}</button>`).join("")}`;
}
$("projects").addEventListener("click", (e) => {
  const b = e.target.closest("[data-project]");
  if (!b) return;
  project = b.dataset.project || null;
  store.set("pulse.project", project);
  render();
});

// ---- Middle ------------------------------------------------------------------------------------------------------

function card(s) {
  const sum = s.summary;
  const more = s.assetCount - Math.min(s.assets.length, 6);
  return `<button class="sess${s.id === selected ? " on" : ""}" data-sid="${s.id}">
    <div class="top"><span class="dot ${s.status}"></span><b>${esc(s.title)}</b><span class="harness ${s.harness}">${HARNESS[s.harness]}</span><time title="${new Date(s.lastAt).toLocaleString()}">${ago(s.lastAt)}</time></div>
    <div class="where mono">${esc(s.repo ?? "")}${s.branch ? ` · ${esc(s.branch)}` : ""}</div>
    ${sum?.doing ? `<p class="doing">${esc(sum.doing)}</p>${sum.state ? `<p class="state${sum.needsYou && s.status !== "working" ? " needs" : ""}">${esc(sum.state)}</p>` : ""}` : s.lastAsk ? `<p class="asked">You asked: ${esc(s.lastAsk)}</p>` : ""}
    ${s.assets.length ? `<div class="thumbs">${s.assets.slice(0, 6).map((a) => thumb(a)).join("")}${more > 0 ? `<span class="more-assets">+${more}</span>` : ""}</div>` : ""}
  </button>`;
}

function renderPage() {
  const page = $("page");
  if (!view) return;
  if (view.error) { page.innerHTML = `<div class="inner"><div class="notice">${esc(view.error)}</div></div>`; return; }
  const list = view.sessions.filter((s) => project === null || (s.repo ?? "Elsewhere") === project);
  const working = list.filter((s) => s.status === "working");
  const ready = list.filter((s) => s.status === "ready");
  const quiet = list.filter((s) => s.status === "quiet");
  const needYou = ready.filter((s) => s.summary?.needsYou).length;
  const now = new Date();
  const when = `${now.toLocaleDateString(undefined, { weekday: "long" })} ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const bits = [working.length && `${working.length} working`, ready.length && `${ready.length} ready for you`].filter(Boolean);
  const scroll = page.scrollTop;
  page.innerHTML = `<div class="glow" aria-hidden="true"></div><div class="inner">
    <div class="meta"><span>${esc(project ?? "All projects")}</span><span>·</span><span>${esc(when)}</span></div>
    <h1 class="headline">${bits.length ? esc(bits.join(", ")) : "All quiet"}</h1>
    <p class="lede">${needYou ? `${needYou} ${needYou === 1 ? "is" : "are"} waiting on an answer from you. ` : ""}${list.length} session${list.length === 1 ? "" : "s"} open${project ? "" : ` across ${view.projects.length} project${view.projects.length === 1 ? "" : "s"}`}.</p>
    <section class="group"><h2><span class="dot working"></span>Working now <span class="count">${working.length}</span></h2>
      ${working.length ? `<div class="cards">${working.map(card).join("")}</div>` : `<p class="empty">Nothing is running right now.</p>`}</section>
    <section class="group"><h2><span class="dot ready"></span>Ready for you <span class="count">${ready.length}</span></h2>
      ${ready.length ? `<div class="cards">${ready.map(card).join("")}</div>` : `<p class="empty">No session has finished a turn in the last two days.</p>`}</section>
    ${quiet.length ? `<details class="earlier group"${showEarlier ? " open" : ""}><summary>Earlier <span class="count muted">${quiet.length}</span></summary><div class="cards">${quiet.map(card).join("")}</div></details>` : ""}
  </div>`;
  page.scrollTop = scroll;
}

$("page").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sid]");
  if (b) select(b.dataset.sid);
});
$("page").addEventListener("toggle", (e) => {
  if (e.target.matches?.("details.earlier")) { showEarlier = e.target.open; store.set("pulse.earlier", showEarlier); }
}, true);

async function select(id) {
  if (selected === id) { selected = null; detail = null; showing = null; return render(); }
  selected = id;
  showing = null;
  render();
  await loadDetail();
}

async function loadDetail() {
  if (!selected) return;
  const res = await fetch(`/api/sessions/${selected}`);
  detail = res.ok ? await res.json() : null;
  if (!detail) selected = null;
  renderRight();
}

// ---- Right -------------------------------------------------------------------------------------------------------

function viewer(a) {
  const url = fileUrl(a.path);
  const body = a.kind === "image" ? `<img src="${url}" alt="${esc(a.name)}">`
    : a.kind === "video" ? `<video src="${url}" controls muted playsinline></video>`
    : a.kind === "page" || a.kind === "pdf" ? `<iframe src="${url}" title="${esc(a.name)}"></iframe>`
    : `<div class="model">A 3D model. Open it to download it.</div>`;
  return `<div class="viewer" data-path="${esc(a.path)}"><div class="bar"><span class="nm" title="${esc(a.path)}">${esc(a.name)}</span><a class="icon" href="${url}" target="_blank" rel="noopener" title="Open in a new tab">↗</a><button class="icon" data-close title="Close">×</button></div>${body}</div>`;
}

function renderRight() {
  const right = $("right");
  const scroll = right.scrollTop;
  // Keep an open viewer as it is, so a playing video or a page does not reload on every update.
  const kept = [...right.querySelectorAll(".viewer")].find((v) => v.dataset.path === showing) ?? null;
  if (selected && detail) {
    const s = view.sessions.find((x) => x.id === selected) ?? detail;
    const sum = s.summary;
    const shown = detail.assets.find((a) => a.path === showing);
    right.innerHTML = `
      <section>
        <h3><span class="dot ${s.status}"></span><span>${{ working: "Working now", ready: "Ready for you", quiet: "Earlier" }[s.status]}</span><span class="sp"></span><button class="icon" data-deselect title="Close">×</button></h3>
        <p class="title">${esc(s.title)}</p>
        <div class="where mono">${HARNESS[s.harness]} · ${esc(s.repo ?? "")}${s.branch ? ` · ${esc(s.branch)}` : ""}</div>
        <div class="path">${esc(s.dir ?? "")}</div>
      </section>
      ${sum?.doing ? `<section class="summary"><h3>What it's up to</h3><p>${esc(sum.doing)}</p>${sum.state ? `<p class="state${sum.needsYou && s.status !== "working" ? " needs" : ""}">${esc(sum.state)}</p>` : ""}</section>` : ""}
      ${shown ? `<section id="viewerSlot"></section>` : ""}
      ${detail.assets.length ? `<section><h3>Made in this session <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">${detail.assets.length}</span></h3><div class="gallery">${detail.assets.map((a) => `<button class="tile${a.path === showing ? " on" : ""}" data-show="${esc(a.path)}" title="${esc(a.path)}">${thumb(a, "pic")}<span class="nm">${esc(a.name)}</span><span class="from">${ago(a.at)} ago${a.how === "written" ? "" : " · named"}</span></button>`).join("")}</div></section>` : ""}
      ${detail.asks.length ? `<section><h3>You asked</h3><ul class="asks">${detail.asks.slice(-3).reverse().map((a) => `<li class="${a.text.length > 400 ? "long" : ""}"><time>${ago(a.at)} ago</time>${esc(a.text.slice(0, 1200))}</li>`).join("")}</ul></section>` : ""}
      ${detail.replies.length ? `<section><h3>Its latest reply</h3><div class="reply"><time>${ago(detail.replies.at(-1).at)} ago</time>${md(detail.replies.at(-1).text.slice(0, 4000))}</div></section>` : ""}`;
  } else {
    // Nothing picked: everything made lately, newest first.
    const list = (view?.sessions ?? []).filter((s) => project === null || (s.repo ?? "Elsewhere") === project);
    // Each file once, credited to the session that touched it most recently.
    const byPath = new Map();
    for (const s of list) for (const a of s.assets) if (!byPath.has(a.path) || byPath.get(a.path).lastAt < s.lastAt) byPath.set(a.path, { ...a, sid: s.id, from: s.title, lastAt: s.lastAt });
    const made = [...byPath.values()].sort((a, b) => b.at - a.at).slice(0, 36);
    right.innerHTML = `<section><h3>Made lately</h3>${made.length ? `<div class="gallery">${made.map((a) => `<button class="tile" data-sid="${a.sid}" data-show="${esc(a.path)}" title="${esc(a.path)}">${thumb(a, "pic")}<span class="nm">${esc(a.name)}</span><span class="from">${esc(a.from)} · ${ago(a.at)}</span></button>`).join("")}</div>` : `<p class="muted">Images, pages, videos and documents your sessions make show up here.</p>`}</section>`;
  }
  const slot = $("viewerSlot");
  if (slot) {
    const a = detail.assets.find((x) => x.path === showing);
    if (kept) slot.appendChild(kept); else slot.innerHTML = viewer(a);
  }
  right.scrollTop = scroll;
}

$("right").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.deselect !== undefined) { selected = null; detail = null; showing = null; return render(); }
  if (b.dataset.close !== undefined) { showing = null; return renderRight(); }
  if (b.dataset.sid && b.dataset.sid !== selected) { selected = b.dataset.sid; showing = b.dataset.show; render(); return loadDetail(); }
  if (b.dataset.show) { showing = b.dataset.show; renderRight(); $("right").scrollTop = 0; }
});

$("resizer").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const move = (ev) => {
    const w = Math.max(320, Math.min(window.innerWidth * 0.6, window.innerWidth - ev.clientX - 6));
    document.documentElement.style.setProperty("--right-w", `${w}px`);
    store.set("pulse.rightW", w);
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.classList.remove("resizing"); };
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
if (store.get("pulse.rightW")) document.documentElement.style.setProperty("--right-w", `${store.get("pulse.rightW")}px`);

// ---- Live --------------------------------------------------------------------------------------------------------

function render() {
  renderProjects();
  renderPage();
  renderRight();
}

const es = new EventSource("/api/events");
es.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.type !== "view") return;
  view = ev.view;
  if (project && !view.projects.some((p) => p.name === project)) project = null;
  renderProjects();
  renderPage();
  // A selected session's details move on too; fetch them again (the viewer stays as it is).
  if (selected) loadDetail(); else renderRight();
};
// Times on the page ("5m") age even when nothing changes.
setInterval(() => { if (view && !document.hidden) renderPage(); }, 60_000);
