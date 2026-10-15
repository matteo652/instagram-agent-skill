// Builds the edit as one HyperFrames composition (comp/index.html) plus a
// timeline.json the browser editor draws from. Pure function of edit.json,
// transcript.json and probe.json, so the transcript editor can call it on
// every keystroke-delete and get the same result Claude would.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readJSON, writeJSON, FORMATS, SKILL_DIR, ffprobe, round } from "./core.js";
import { buildTimeline, spanForWords, timeForWord } from "./timeline.js";
import { brollMediaPath, mainFileTime, prepareMain } from "./media.js";

const require = createRequire(import.meta.url);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = (x) => String(round(x, 3));
// A time that must land on a frame: written a hair early, never late, so
// rounding can't push a clip's first frame onto the next one.
const fr = (x) => String(Math.floor(x * 10000 + 1e-6) / 10000);

// Groups output words into short caption chunks: at most 3 words, 1.4s, and
// never across a sentence end or a pause.
export function captionChunks(words) {
  const chunks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.4 || w.end - cur[0].start > 1.4 || cur.length >= 3)) flush();
    cur.push(w);
    if (/[.?!,;:]$/.test(w.text)) flush();
  }
  flush();
  return chunks.map((ws) => ({ start: ws[0].start, end: ws[ws.length - 1].end, words: ws }));
}

const clean = (t) => t.replace(/^[^\p{L}\p{N}$£€#@]+|[^\p{L}\p{N}%?!]+$/gu, "");

// Composes, re-encoding main.mp4 first when the edit now reaches footage
// that was not encoded (a word restored far from every kept span).
export async function composeOrPrepare(p, log = () => {}) {
  try {
    return await compose(p);
  } catch (err) {
    if (err.code !== "NEEDS_PREPARE") throw err;
    log("Encoding the restored footage");
    await prepareMain(p, readJSON(p.edit), log);
    return compose(p);
  }
}

export async function compose(p) {
  const edit = readJSON(p.edit);
  const transcript = readJSON(p.transcript);
  const probe = readJSON(p.probe);
  const { width: W, height: H } = FORMATS[edit.format];
  const portrait = H > W;
  const tl = buildTimeline(transcript.words, edit.removed, { duration: probe.duration, silences: edit.silences });
  if (!tl.segments.length) throw new Error("Every word has been cut. Restore some words in the transcript.");

  const videoEnd = tl.duration;
  const ctaDur = edit.cta ? round(edit.cta.duration ?? 2.5) : 0;
  const total = videoEnd + ctaDur;

  const html = [];
  const anim = [];
  const tracks = { video: [], broll: [], zooms: [], text: [], captions: [], audio: [] };

  // ---- A-roll: one <video> per kept segment, all reading main.mp4.
  // main.mp4 holds only the spans the edit used when it was encoded; find
  // each segment in it. Start a quarter frame early: the renderer shows the
  // first frame at or after the seek time, so this lands on the intended
  // frame even after the start is rounded to the millisecond. (Measured: a
  // quarter frame late shows the next frame at every cut.)
  const fileStarts = tl.segments.map((s) => mainFileTime(p, s.srcStart, s.srcEnd));
  if (fileStarts.some((t) => t === null)) {
    const err = new Error("Part of this edit is outside the encoded footage. Run: ED prepare");
    err.code = "NEEDS_PREPARE";
    throw err;
  }
  tl.segments.forEach((s, k) => {
    const mediaStart = fileStarts[k] - 0.25 / 30;
    html.push(
      `<video id="seg-${k}" class="clip seg" src="media/main.mp4" playsinline data-has-audio="true" ` +
        `data-start="${fr(s.outStart)}" data-duration="${fr(s.duration)}" data-media-start="${fr(mediaStart)}" ` +
        `data-fade-in="0.012" data-fade-out="0.012" data-track-index="0"></video>`,
    );
    tracks.video.push({ start: s.outStart, end: round(s.outStart + s.duration), label: `${n(s.srcStart)}s` });
  });

  // ---- Camera: framing + zoom cuts on one wrapper holding the full frame.
  // The wrapper is the whole source picture scaled to cover the output, and
  // the output window slides across it. Framing defaults to edit.crop (the
  // middle unless Claude set otherwise) and only moves for an explicit shot.
  // Zooms push in on a point of the visible frame (the middle by default),
  // never towards whoever happens to be talking.
  const cover = Math.max(W / probe.width, H / probe.height);
  const CW = round(probe.width * cover, 1);
  const CH = round(probe.height * cover, 1);
  const camHtml = { width: CW, height: CH };
  const base = { x: edit.crop?.x ?? 0.5, y: edit.crop?.y ?? 0.5 };

  const snapSpan = (from, to) => {
    const span = spanForWords(tl, from, to ?? from);
    if (!span) return null;
    return { start: snapToCut(tl.cuts, span.start - 0.04), end: Math.min(snapToCut(tl.cuts, span.end + 0.05), videoEnd) };
  };
  const shots = (edit.framing?.shots || [])
    .map((f) => ({ ...f, span: snapSpan(f.from, f.to) }))
    .filter((f) => f.span)
    .sort((a, b) => a.span.start - b.span.start);
  const zooms = edit.zooms
    .map((z) => ({ ...z, span: snapSpan(z.from, z.to) }))
    .filter((z) => z.span)
    .sort((a, b) => a.span.start - b.span.start);
  zooms.forEach((z, k) => {
    if (zooms[k + 1]) z.span.end = Math.min(z.span.end, zooms[k + 1].span.start);
  });

  const at = (list, t) => list.find((x) => t >= x.span.start && t < x.span.end);
  const camAt = (t) => {
    const shot = at(shots, t);
    const zoom = at(zooms, t);
    const fx = shot?.x ?? base.x;
    const fy = shot?.y ?? base.y;
    const tx = round(-(CW - W) * fx, 1);
    const ty = round(-(CH - H) * fy, 1);
    const scale = round(zoom ? zoom.scale ?? 1.18 : 1);
    // Zoom centre in the visible frame (0..1), converted into wrapper pixels
    // so the push-in lands on that point however the frame is positioned.
    const ox = round(W * (zoom?.originX ?? 0.5) - tx, 1);
    const oy = round(H * (zoom?.originY ?? 0.5) - ty, 1);
    return { tx, ty, scale, ox, oy };
  };
  const times = new Set([0]);
  for (const x of [...shots, ...zooms]) {
    times.add(x.span.start);
    times.add(x.span.end);
  }
  let prev = null;
  for (const t of [...times].filter((t) => t < videoEnd).sort((a, b) => a - b)) {
    const c = camAt(t);
    const key = JSON.stringify(c);
    if (key === prev) continue;
    prev = key;
    anim.push(`tl.set("#cam", { x: ${c.tx}, y: ${c.ty}, scale: ${c.scale}, transformOrigin: "${c.ox}px ${c.oy}px" }, ${n(t)});`);
  }
  zooms.forEach((z) => tracks.zooms.push({ start: round(z.span.start), end: round(z.span.end), label: `${round(z.scale ?? 1.18)}x` }));
  shots.forEach((f) => tracks.zooms.push({ start: round(f.span.start), end: round(f.span.end), label: `frame ${Math.round((f.x ?? base.x) * 100)}%` }));

  // ---- B-roll: full-frame cutaways over the A-roll, voice keeps playing.
  const brollMeta = Object.fromEntries((probe.broll || []).map((b) => [b.id, b]));
  edit.broll.forEach((b, k) => {
    const span = spanForWords(tl, b.from, b.to ?? b.from);
    const meta = brollMeta[b.clip];
    if (!span || !meta) return;
    const mediaStart = Math.max(0, b.mediaStart ?? 0);
    const dur = round(Math.min(span.end - span.start + 0.15, meta.duration - mediaStart, videoEnd - span.start));
    if (dur < 0.4) return;
    const id = `broll-${k}`;
    html.push(
      `<video id="${id}" class="clip broll" src="media/${brollMediaPath(b.clip, edit.format)}" muted playsinline ` +
        `data-start="${n(span.start)}" data-duration="${n(dur)}" data-media-start="${n(mediaStart)}" data-track-index="1"></video>`,
    );
    anim.push(`tl.fromTo("#${id}", { scale: 1.08 }, { scale: 1, duration: ${n(dur)}, ease: "none" }, ${n(span.start)});`);
    tracks.broll.push({ start: span.start, end: round(span.start + dur), label: meta.name });
  });

  // ---- Captions: word-by-word, active word highlighted.
  if (edit.captions) {
    const chunks = captionChunks(tl.words.filter((w) => w.end <= videoEnd));
    const hl = edit.captions.highlight || "#FFE14D";
    chunks.forEach((c, k) => {
      const end = Math.min(chunks[k + 1]?.start ?? c.end + 0.3, c.end + 0.3);
      const id = `cap-${k}`;
      const spans = c.words.map((w) => `<span class="w" id="w-${w.i}">${esc(clean(w.text) || w.text)}</span>`).join(" ");
      html.push(`<div id="${id}" class="clip cap" data-start="${n(c.start)}" data-duration="${n(end - c.start)}" data-track-index="4"><span class="cap-line">${spans}</span></div>`);
      anim.push(`tl.fromTo("#${id} .cap-line", { scale: 0.86, y: 14 }, { scale: 1, y: 0, duration: 0.14, ease: "back.out(2.5)" }, ${n(c.start)});`);
      c.words.forEach((w) => {
        anim.push(`tl.set("#w-${w.i}", { color: "${hl}", scale: 1.08 }, ${n(w.start)});`);
        anim.push(`tl.set("#w-${w.i}", { color: "#FFFFFF", scale: 1 }, ${n(w.end)});`);
      });
      tracks.captions.push({ start: c.start, end: round(end), label: c.words.map((w) => clean(w.text)).join(" ") });
    });
  }

  // ---- Text hook over the opening.
  if (edit.hook?.text) {
    const firstSentenceEnd = tl.words.find((w, k) => k > 2 && /[.?!]$/.test(w.text))?.end ?? 2.8;
    const dur = round(Math.min(Math.max(edit.hook.duration ?? firstSentenceEnd + 0.3, 1.8), 4, videoEnd));
    html.push(`<div id="hook" class="clip hook" data-start="0" data-duration="${n(dur)}" data-track-index="3"><span class="hook-box">${esc(edit.hook.text)}</span></div>`);
    anim.push(`tl.fromTo("#hook .hook-box", { y: -40, scale: 0.9, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.35, ease: "back.out(2)" }, 0.05);`);
    anim.push(`tl.to("#hook .hook-box", { opacity: 0, y: -20, duration: 0.2 }, ${n(dur - 0.22)});`);
    tracks.text.push({ start: 0, end: dur, label: `Hook: ${edit.hook.text}` });
  }

  // ---- Call-to-action end card.
  if (edit.cta) {
    html.push(
      `<div id="cta" class="clip cta" data-start="${fr(videoEnd)}" data-duration="${n(ctaDur)}" data-track-index="3">` +
        `<span class="cta-text">${esc(edit.cta.text)}</span>` +
        (edit.cta.subtext ? `<span class="cta-sub">${esc(edit.cta.subtext)}</span>` : "") +
        `</div>`,
    );
    anim.push(`tl.fromTo("#cta", { opacity: 0 }, { opacity: 1, duration: 0.25 }, ${fr(videoEnd)});`);
    anim.push(`tl.fromTo("#cta .cta-text", { y: 60, scale: 0.9, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.45, ease: "back.out(1.8)" }, ${n(videoEnd + 0.1)});`);
    if (edit.cta.subtext) anim.push(`tl.fromTo("#cta .cta-sub", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35 }, ${n(videoEnd + 0.35)});`);
    tracks.text.push({ start: videoEnd, end: total, label: `CTA: ${edit.cta.text}` });
  }

  // ---- Music bed under everything.
  if (edit.music?.file && fs.existsSync(path.join(p.compDir, edit.music.file))) {
    html.push(
      `<audio id="music" src="${esc(edit.music.file)}" data-start="0" data-duration="${fr(total)}" ` +
        `data-volume="${n(edit.music.volume ?? 0.12)}" data-fade-in="0.6" data-fade-out="1.5" data-track-index="5"></audio>`,
    );
    tracks.audio.push({ start: 0, end: total, label: "Music" });
  }

  // ---- Sound effects, anchored to words or to edit events.
  for (const [k, fx] of edit.sfx.entries()) {
    const file = `media/sfx/${fx.kind}.mp3`;
    const abs = path.join(p.compDir, file);
    if (!fs.existsSync(abs)) continue;
    const at = resolveSfxTime(fx, { tl, tracks, videoEnd });
    if (at === null || at >= total) continue;
    const len = round(Math.min((await ffprobe(abs)).duration, total - at));
    html.push(`<audio id="sfx-${k}" src="${file}" data-start="${n(at)}" data-duration="${n(len)}" data-volume="${n(fx.volume ?? 0.5)}" data-track-index="6"></audio>`);
    tracks.audio.push({ start: at, end: round(at + len), label: fx.kind });
  }

  writeComposition(p, { W, H, portrait, total, videoEnd, html, anim, captions: edit.captions, cam: camHtml });

  const timeline = {
    builtAt: new Date().toISOString(),
    format: edit.format,
    width: W,
    height: H,
    duration: total,
    videoDuration: videoEnd,
    sourceDuration: probe.duration,
    segments: tl.segments,
    cuts: tl.cuts,
    words: tl.words.map(({ i, start, end }) => ({ i, start, end })),
    tracks,
  };
  writeJSON(p.timeline, timeline);
  return timeline;
}

function snapToCut(cuts, t, within = 0.25) {
  let best = t;
  let bestD = within;
  for (const c of cuts) {
    const d = Math.abs(c - t);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return Math.max(0, round(best));
}

function resolveSfxTime(fx, { tl, tracks, videoEnd }) {
  const lead = fx.kind === "whoosh" || fx.kind === "riser" ? (fx.kind === "riser" ? 1.1 : 0.18) : 0;
  let t = null;
  if (typeof fx.word === "number") t = timeForWord(tl, fx.word);
  else if (fx.at === "hook") t = 0.05;
  else if (fx.at === "cta") t = videoEnd;
  else if (typeof fx.at === "string" && fx.at.startsWith("broll:")) t = tracks.broll[Number(fx.at.slice(6))]?.start ?? null;
  else if (typeof fx.at === "string" && fx.at.startsWith("zoom:")) t = tracks.zooms[Number(fx.at.slice(5))]?.start ?? null;
  else if (typeof fx.at === "number") t = fx.at;
  if (t === null) return null;
  return Math.max(0, round(t - lead));
}

function writeComposition(p, { W, H, portrait, total, html, anim, captions, cam }) {
  fs.mkdirSync(p.compDir, { recursive: true });
  fs.copyFileSync(require.resolve("gsap/dist/gsap.min.js"), path.join(p.compDir, "gsap.min.js"));
  const unit = Math.min(W, H) / 1080; // 1 at 1080 wide portrait or 1080 tall landscape
  const capBottom = portrait ? 0.27 : 0.1;
  const px = (v) => `${Math.round(v * unit)}px`;
  const doc = `<!doctype html>
<html lang="en" data-resolution="${portrait ? "portrait" : "landscape"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- Generated by 11 Second Edit from edit.json. Edit the transcript in the app, or edit.json and recompose. -->
    <script src="gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      body { font-family: "Montserrat", "Inter", "Helvetica Neue", Arial, sans-serif; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #cam { position: absolute; left: 0; top: 0; width: ${cam.width}px; height: ${cam.height}px; z-index: 1; will-change: transform; }
      .seg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; }
      .broll { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 2; }
      .cap { position: absolute; left: 0; right: 0; ${captions?.y !== undefined
        ? `top: ${Math.round(H * captions.y)}px; transform: translateY(-50%);`
        : `bottom: ${Math.round(H * capBottom)}px;`} z-index: 4;
             display: flex; justify-content: center; padding: 0 ${px(70)}; }
      .cap-line { display: block; text-align: center; font-weight: 900; font-size: ${px(portrait ? 84 : 70)}; line-height: 1.12;
                  text-transform: ${captions?.uppercase === false ? "none" : "uppercase"}; color: #fff; letter-spacing: 0.01em;
                  -webkit-text-stroke: ${px(3)} #000; paint-order: stroke fill;
                  text-shadow: 0 ${px(6)} ${px(18)} rgba(0,0,0,.55); }
      .cap-line .w { display: inline-block; }
      .hook { position: absolute; left: 0; right: 0; top: ${portrait ? Math.round(H * 0.14) : Math.round(H * 0.08)}px; z-index: 5;
              display: flex; justify-content: center; padding: 0 ${px(60)}; }
      .hook-box { display: block; background: #fff; color: #0b0b0b; font-weight: 900; font-size: ${px(portrait ? 68 : 58)}; line-height: 1.12;
                  padding: ${px(22)} ${px(34)}; border-radius: ${px(22)}; text-align: center; max-width: ${portrait ? "92%" : "70%"};
                  box-shadow: 0 ${px(14)} ${px(40)} rgba(0,0,0,.35); }
      .cta { position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column; align-items: center; justify-content: center;
             gap: ${px(30)}; padding: ${px(90)}; text-align: center;
             background: radial-gradient(120% 80% at 50% 30%, #2b2b60 0%, #101025 55%, #05050c 100%); }
      .cta-text { display: block; color: #fff; font-weight: 900; font-size: ${px(portrait ? 104 : 88)}; line-height: 1.05; }
      .cta-sub { display: block; color: #FFE14D; font-weight: 800; font-size: ${px(portrait ? 50 : 44)}; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${fr(total)}" data-width="${W}" data-height="${H}">
      <div id="cam">
        ${html.filter((h) => h.includes('class="clip seg"')).join("\n        ")}
      </div>
      ${html.filter((h) => !h.includes('class="clip seg"')).join("\n      ")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${anim.join("\n      ")}
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(p.compDir, "index.html"), doc);
  const meta = path.join(p.compDir, "meta.json");
  if (!fs.existsSync(meta)) writeJSON(meta, { id: path.basename(p.dir), name: "11 Second Edit", createdAt: new Date().toISOString() });
  const hf = path.join(p.compDir, "hyperframes.json");
  if (!fs.existsSync(hf)) writeJSON(hf, { paths: { assets: "media" }, media: { autoProxy: true } });
}

export const HYPERFRAMES_BIN = path.join(SKILL_DIR, "node_modules", ".bin", "hyperframes");
