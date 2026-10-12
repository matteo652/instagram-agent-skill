// 11 Second Edit, browser side. Three views driven by server state:
// setup (upload + toggles) -> progress (checklist) -> editor (preview,
// transcript, timeline, export).
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
};
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;

const FEATURE_HINTS = {
  enhanceAudio: "Denoise, level and loudness via Auphonic",
  badTakes: "Claude reads the transcript and keeps your best take",
  fillers: "Um, uh, and the likes that are not doing any work",
  silences: "Tightens every pause",
  broll: "Cuts your clips in where they match what you say",
  zooms: "Punch-ins on the lines that matter",
  color: "Exposure, contrast and white balance",
  hook: "A text hook over the first seconds",
  cta: "End card with one ask",
  captions: "Animated word-by-word",
  music: "A bed from ElevenLabs, under your voice",
  sfx: "Whooshes and pops on the edit points",
};
const DEFAULT_OFF = new Set();

let S = null; // latest server state
let features = {};
let format = "9:16";
let view = null;

// ------------------------------------------------------------------ server

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => apply(JSON.parse(e.data)));
  es.addEventListener("export", (e) => renderExport(JSON.parse(e.data)));
  es.onerror = () => {
    es.close();
    setTimeout(connect, 1500);
  };
}

function apply(state) {
  const prev = S;
  S = { ...state, features: state.features || S?.features || [] };
  const next =
    !S.job ? "setup" :
    S.status?.state === "review" && S.timeline ? "editor" :
    "progress";
  if (next !== view) {
    view = next;
    for (const v of ["setup", "progress", "editor"]) $(`#view-${v}`).hidden = v !== view;
    if (view === "editor") enterEditor();
  }
  $("#project-label").textContent = S.originalName || "";
  $("#new-edit").hidden = !S.job;
  if (view === "setup") renderSetup();
  if (view === "progress") renderProgress();
  if (view === "editor") updateEditor(prev);
  if (S.exportState) renderExport(S.exportState);
}

// ------------------------------------------------------------------ setup

function renderSetup() {
  const has = Boolean(S.original);
  $("#drop-main-empty").hidden = has;
  $("#drop-main-done").hidden = !has;
  if (has) {
    $("#main-name").textContent = S.originalName;
    const src = `/files/source/${S.original}?p=${S.project}#t=1`;
    if ($("#main-preview").dataset.src !== src) {
      $("#main-preview").dataset.src = src;
      $("#main-preview").src = src;
    }
  }
  $("#broll-list").replaceChildren(
    ...(S.broll || []).map((b) =>
      el("li", {}, el("span", {}, b.name), el("button", { title: "Remove", onclick: (e) => { e.preventDefault(); removeBroll(b.name); } }, "✕")),
    ),
  );
  const list = $("#features");
  if (!list.children.length) {
    for (const f of S.features || []) {
      if (!(f.key in features)) features[f.key] = !DEFAULT_OFF.has(f.key);
      const input = el("input", { type: "checkbox", id: `f-${f.key}`, onchange: (e) => { features[f.key] = e.target.checked; } });
      input.checked = features[f.key];
      list.append(
        el("li", { "data-key": f.key },
          el("label", { for: `f-${f.key}` }, f.label, el("small", {}, FEATURE_HINTS[f.key] || "")),
          el("label", { class: "switch" }, input, el("span")),
        ),
      );
    }
  }
  const noBroll = !(S.broll || []).length;
  const li = list.querySelector('[data-key="broll"]');
  if (li) {
    li.classList.toggle("disabled", noBroll);
    li.querySelector("small").textContent = noBroll ? "Add clips in step 2 to use this" : FEATURE_HINTS.broll;
  }
  $("#edit-btn").disabled = !has;
}

function upload(file, kind, bar) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload/${kind}?name=${encodeURIComponent(file.name)}`);
    bar.hidden = false;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`; };
    xhr.onload = () => {
      bar.hidden = true;
      bar.firstElementChild.style.width = "0";
      const data = JSON.parse(xhr.responseText || "{}");
      xhr.status === 200 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

async function handleFiles(files, kind) {
  const err = $("#setup-error");
  err.hidden = true;
  try {
    const list = [...files].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
    if (!list.length) throw new Error("That is not a video file.");
    for (const f of kind === "main" ? list.slice(0, 1) : list) apply(await upload(f, kind, $(`#bar-${kind}`)));
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

async function removeBroll(name) {
  apply(await api(`/api/broll?name=${encodeURIComponent(name)}`, { method: "DELETE" }));
}

function wireDrop(id, input, kind) {
  const zone = $(id);
  $(input).addEventListener("change", (e) => handleFiles(e.target.files, kind).then(() => (e.target.value = "")));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    handleFiles(e.dataTransfer.files, kind);
  });
}

// ------------------------------------------------------------------ progress

function renderProgress() {
  const steps = S.status?.steps || [];
  const icon = { done: "✓", error: "!", skipped: "", running: "", pending: "" };
  $("#checklist").replaceChildren(
    ...steps.map((s) =>
      el("li", { class: s.state },
        el("span", { class: "ico" }, icon[s.state]),
        el("div", {}, el("span", { class: "label" }, s.label), s.message ? el("span", { class: "msg" }, s.message) : null),
      ),
    ),
  );
  const started = steps.some((s) => s.state !== "pending" && s.state !== "skipped");
  $("#waiting-hint").hidden = started;
  const err = steps.find((s) => s.state === "error");
  $("#progress-title").textContent = err ? "Claude hit a problem" : "Claude is editing";
  $("#progress-sub").textContent = err ? `${err.label}: ${err.message}. Claude will retry or tell you what it needs in the terminal.` : "Each step runs in order. This page updates by itself.";
}

// ------------------------------------------------------------------ editor

let player = null;
let selA = null;
let selB = null;
let dragging = false;
let lastBuilt = null;
let resumeAt = 0;

function enterEditor() {
  buildPlayer();
  renderTranscript();
  renderTimeline();
  requestAnimationFrame(tick);
}

function updateEditor() {
  if (S.timeline?.builtAt !== lastBuilt) {
    resumeAt = player?.currentTime || 0;
    buildPlayer();
    renderTimeline();
  }
  renderTranscript();
}

function buildPlayer() {
  if (!S.timeline) return;
  lastBuilt = S.timeline.builtAt;
  const wrap = $("#player-wrap");
  const p = document.createElement("hyperframes-player");
  p.setAttribute("src", `/files/comp/index.html?preview&v=${encodeURIComponent(lastBuilt)}`);
  p.setAttribute("width", S.timeline.width);
  p.setAttribute("height", S.timeline.height);
  p.setAttribute("controls", "");
  p.addEventListener("ready", () => { if (resumeAt) p.seek(Math.min(resumeAt, S.timeline.duration - 0.05)); });
  wrap.replaceChildren(p);
  player = p;
  const t = S.timeline;
  const cut = Object.keys(S.removed || {}).length;
  $("#edit-duration").textContent = `${fmt(t.duration)}`;
  $("#edit-summary").textContent = `from ${fmt(t.sourceDuration)} of footage · ${t.segments.length} segments · ${cut} words cut · ${S.job?.format}`;
}

function seek(t) {
  if (!player) return;
  try { player.seek(Math.max(0, t)); } catch {}
}

// Transcript: every word is a span. Cut words stay visible, struck through.
function renderTranscript() {
  const box = $("#transcript");
  if (!S.transcript) return;
  const removed = S.removed || {};
  if (box.childElementCount !== countNodes()) {
    const nodes = [];
    S.transcript.forEach((w, k) => {
      const prev = S.transcript[k - 1];
      if (prev && w.sentence && k > 0 && w.start - prev.end > 0.9) nodes.push(el("span", { class: "para" }));
      if (prev && w.start - prev.end > 0.6) nodes.push(el("span", { class: "gap", title: "Pause" }, `${(w.start - prev.end).toFixed(1)}s`));
      nodes.push(el("span", { class: "w", "data-i": w.i }, w.text), " ");
    });
    box.replaceChildren(...nodes);
  }
  for (const s of box.querySelectorAll(".w")) {
    const r = removed[s.dataset.i];
    s.classList.toggle("cut", Boolean(r));
    if (r) {
      s.dataset.reason = r;
      s.title = { badtake: "Cut: bad take", filler: "Cut: filler", manual: "Cut by you" }[r] || "Cut";
    } else {
      delete s.dataset.reason;
      s.removeAttribute("title");
    }
  }
  paintSelection();
}

function countNodes() {
  let n = 0;
  S.transcript.forEach((w, k) => {
    const prev = S.transcript[k - 1];
    if (prev && w.sentence && w.start - prev.end > 0.9) n++;
    if (prev && w.start - prev.end > 0.6) n++;
    n++;
  });
  return n;
}

function selection() {
  if (selA === null) return [];
  const [a, b] = [Math.min(selA, selB ?? selA), Math.max(selA, selB ?? selA)];
  return Array.from({ length: b - a + 1 }, (_, k) => a + k);
}

function paintSelection() {
  const sel = new Set(selection());
  for (const s of $("#transcript").querySelectorAll(".w")) s.classList.toggle("sel", sel.has(Number(s.dataset.i)));
  const any = sel.size > 0;
  const removed = S?.removed || {};
  $("#cut-btn").disabled = !any || [...sel].every((i) => removed[i]);
  $("#restore-btn").disabled = !any || ![...sel].some((i) => removed[i]);
}

async function changeWords(action) {
  const indices = selection();
  if (!indices.length) return;
  const removed = S.removed || {};
  const act = action || (indices.every((i) => removed[i]) ? "restore" : "delete");
  try {
    $("#transcript").style.opacity = 0.6;
    apply(await api("/api/words", { method: "POST", body: JSON.stringify({ action: act, indices }) }));
  } catch (e) {
    alert(e.message);
  } finally {
    $("#transcript").style.opacity = 1;
  }
}

function wireTranscript() {
  const box = $("#transcript");
  box.addEventListener("mousedown", (e) => {
    const w = e.target.closest(".w");
    if (!w) return;
    const i = Number(w.dataset.i);
    if (e.shiftKey && selA !== null) selB = i;
    else {
      selA = i;
      selB = i;
      dragging = true;
      const out = S.timeline?.words.find((x) => x.i === i);
      if (out) seek(out.start);
    }
    box.focus();
    paintSelection();
  });
  box.addEventListener("mouseover", (e) => {
    const w = e.target.closest(".w");
    if (dragging && w) {
      selB = Number(w.dataset.i);
      paintSelection();
    }
  });
  window.addEventListener("mouseup", () => (dragging = false));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      changeWords();
    } else if (e.key === "Escape") {
      selA = selB = null;
      paintSelection();
    }
  });
  $("#cut-btn").addEventListener("click", () => changeWords("delete"));
  $("#restore-btn").addEventListener("click", () => changeWords("restore"));
}

// Timeline: one row per track, fitted to width, click to seek.
const TRACKS = [
  ["video", "Video", "--t-video"],
  ["broll", "B-roll", "--t-broll"],
  ["zooms", "Zoom", "--t-zoom"],
  ["text", "Text", "--t-text"],
  ["captions", "Captions", "--t-caption"],
  ["audio", "Audio", "--t-audio"],
];

function renderTimeline() {
  const t = S.timeline;
  if (!t) return;
  const pct = (x) => `${(x / t.duration) * 100}%`;
  const rows = TRACKS.filter(([k]) => k === "video" || t.tracks[k]?.length).map(([k, name, color]) =>
    el("div", { class: "tl-track" },
      el("span", { class: "name" }, name),
      ...t.tracks[k].map((c) =>
        el("div", {
          class: "tl-clip",
          title: `${c.label}  ${fmt(c.start)}-${fmt(c.end)}`,
          style: `left:${pct(c.start)};width:${pct(Math.max(c.end - c.start, 0.02))};background:var(${color})`,
        }, k === "video" ? "" : c.label),
      ),
    ),
  );
  $("#tl-tracks").replaceChildren(...rows);
  const step = t.duration > 90 ? 15 : t.duration > 40 ? 5 : t.duration > 15 ? 2 : 1;
  const marks = [];
  for (let s = 0; s <= t.duration; s += step) marks.push(el("span", { style: `left:${pct(s)}` }, fmt(s).replace(/\.\d$/, "")));
  $("#tl-ruler").replaceChildren(...marks);
}

function wireTimeline() {
  const tl = $("#timeline");
  const seekFromEvent = (e) => {
    const r = $("#tl-tracks").getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    seek((x / r.width) * S.timeline.duration);
  };
  let down = false;
  tl.addEventListener("mousedown", (e) => { down = true; seekFromEvent(e); });
  window.addEventListener("mousemove", (e) => down && seekFromEvent(e));
  window.addEventListener("mouseup", () => (down = false));
}

let lastNow = null;
function tick() {
  if (view !== "editor") return;
  requestAnimationFrame(tick);
  if (!player || !S.timeline) return;
  const t = player.currentTime || 0;
  const r = $("#tl-tracks").getBoundingClientRect();
  const host = $("#timeline").getBoundingClientRect();
  $("#tl-playhead").style.left = `${r.left - host.left + (t / S.timeline.duration) * r.width - 1}px`;
  // Highlight the word being spoken.
  const ws = S.timeline.words;
  let lo = 0, hi = ws.length - 1, hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ws[mid].end < t) lo = mid + 1;
    else if (ws[mid].start > t) hi = mid - 1;
    else { hit = ws[mid].i; break; }
  }
  if (hit !== lastNow) {
    $("#transcript").querySelector(".w.now")?.classList.remove("now");
    if (hit !== null) {
      const span = $("#transcript").querySelector(`.w[data-i="${hit}"]`);
      span?.classList.add("now");
      if (span && !player.paused) span.scrollIntoView({ block: "nearest" });
    }
    lastNow = hit;
  }
}

// ------------------------------------------------------------------ export

function renderExport(x) {
  const box = $("#export-status");
  if (!x || x.state === "idle") {
    const last = S?.exports?.[0];
    box.hidden = !last;
    if (last) {
      $("#export-bar").style.width = "100%";
      $("#export-text").replaceChildren("Last export: ", el("a", { href: `/files/export/${last}?download` }, last));
    }
    $("#export-btn").disabled = false;
    return;
  }
  box.hidden = false;
  $("#export-bar").style.width = `${x.pct}%`;
  $("#export-btn").disabled = x.state === "running";
  if (x.state === "running") $("#export-text").textContent = `Rendering with HyperFrames… ${x.pct}%`;
  if (x.state === "done") $("#export-text").replaceChildren("Done. ", el("a", { href: `/files/export/${x.file}?download` }, `Download ${x.file}`));
  if (x.state === "error") $("#export-text").textContent = `Export failed: ${x.error}`;
}

// ------------------------------------------------------------------ boot

wireDrop("#drop-main", "#file-main", "main");
wireDrop("#drop-broll", "#file-broll", "broll");
wireTranscript();
wireTimeline();

$("#format").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  format = b.dataset.format;
  for (const x of $("#format").children) x.classList.toggle("on", x === b);
});

$("#edit-btn").addEventListener("click", async () => {
  $("#edit-btn").disabled = true;
  try {
    apply(await api("/api/edit", { method: "POST", body: JSON.stringify({ features, format, notes: $("#notes").value }) }));
  } catch (e) {
    $("#setup-error").textContent = e.message;
    $("#setup-error").hidden = false;
    $("#edit-btn").disabled = false;
  }
});

$("#export-btn").addEventListener("click", async () => {
  try {
    renderExport(await api("/api/export", { method: "POST", body: JSON.stringify({ quality: $("#quality").value }) }));
  } catch (e) {
    alert(e.message);
  }
});

$("#studio-btn").addEventListener("click", async () => {
  const b = $("#studio-btn");
  b.disabled = true;
  b.textContent = "Starting Studio…";
  try {
    const r = await api("/api/studio", { method: "POST" });
    if (r.url) window.open(r.url, "_blank");
    else alert("HyperFrames Studio started. Check the terminal for its address.");
  } catch (e) {
    alert(e.message);
  } finally {
    b.disabled = false;
    b.textContent = "Open in HyperFrames Studio";
  }
});

$("#new-edit").addEventListener("click", async () => {
  if (!confirm("Start a new edit? This one stays saved in the work folder.")) return;
  $("#features").replaceChildren();
  apply(await api("/api/project", { method: "POST" }));
});

connect();
