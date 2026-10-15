#!/usr/bin/env node
// The command line Claude drives during an edit. Every command works on the
// project the browser app is showing, and reports progress to the page.
//
//   node edit.js <command> [args]
//
// Run with no command for the full list.
import fs from "node:fs";
import path from "node:path";
import {
  currentProjectDir, projectPaths, readJSON, writeJSON, loadEdit, saveEdit, setStatus,
  brollSources, round, FORMATS, SKILL_DIR,
} from "./lib/core.js";
import { buildTimeline } from "./lib/timeline.js";
import * as media from "./lib/media.js";
import { composeOrPrepare } from "./lib/compose.js";
import { render } from "./lib/render.js";

const [, , cmd, ...args] = process.argv;
function out(s = "") {
  process.stdout.write(s + "\n");
}

const COMMANDS = {
  wait: [cmdWait, "wait [seconds] [--resume]  Block until Edit Video is clicked, print the job. Exit 3 = run again."],
  status: [cmdStatus, "status <step> <pending|running|done|skipped|error> [message]  Report progress to the page."],
  setup: [cmdSetup, "Probe footage, extract audio, write review stills (review/frame.jpg, review/broll-*.jpg)."],
  enhance: [cmdEnhance, "Enhance the voice with Auphonic (local FFmpeg chain if no key)."],
  transcribe: [cmdTranscribe, "Transcribe with WhisperX. transcribe --import <whisperx.json> to reuse one."],
  transcript: [cmdTranscript, "Print the transcript with word indices, pauses and current cuts."],
  fillers: [cmdFillers, "List filler-word candidates with context. You decide which are fillers."],
  apply: [cmdApply, "apply <cuts|zooms|framing|broll|hook|cta|sfx|captions|uncut> '<json>'|file.json  Validate and save a decision."],
  silences: [cmdSilences, "silences [maxGap=1.0] [pad=0.2]  Cut pauses longer than maxGap, leaving pad of air each side."],
  color: [cmdColor, "Measure the footage and set an automatic colour grade."],
  prepare: [cmdPrepare, "Encode the cropped, graded A-roll with the enhanced voice, and the b-roll."],
  captions: [cmdCaptions, "captions [highlightColor]  Turn on word-by-word captions."],
  music: [cmdMusic, "music \"<prompt>\" [volume]  Generate a background bed with ElevenLabs."],
  sfx: [cmdSfx, "Generate the sound effects placed with apply sfx."],
  compose: [cmdCompose, "Build comp/index.html (HyperFrames) and timeline.json. Opens the editor."],
  info: [cmdInfo, "Summary of the edit: duration, cuts, tracks."],
  render: [cmdRender, "render [draft|standard|high]  Render the MP4 (the Export button does the same)."],
  path: [() => out(currentProjectDir()), "Print the active project folder."],
};

if (!cmd || !COMMANDS[cmd]) {
  out("11 Second Edit\n");
  for (const [name, [, help]] of Object.entries(COMMANDS)) out(`  ${name.padEnd(11)} ${help}`);
  process.exit(cmd ? 1 : 0);
}

const STEP_FOR = {
  setup: "setup", enhance: "enhance", transcribe: "transcribe", silences: "silences", color: "color",
  captions: "captions", music: "music", sfx: "sfx", compose: "compose", prepare: "compose",
};

let p;
try {
  if (cmd !== "wait") p = projectPaths(currentProjectDir());
  await COMMANDS[cmd][0](args);
} catch (err) {
  if (p && STEP_FOR[cmd]) {
    try { setStatus(p, STEP_FOR[cmd], "error", err.message.split("\n")[0]); } catch {}
  }
  process.stderr.write(`\n✗ ${err.message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------ helpers

function step(id, state, message) {
  setStatus(p, id, state, message);
}

function parseJSONArg(raw) {
  if (raw === undefined) throw new Error("Missing JSON. Pass it inline in single quotes or as a .json file path.");
  if (raw === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  if (fs.existsSync(raw)) return JSON.parse(fs.readFileSync(raw, "utf8"));
  return JSON.parse(raw);
}

function words() {
  if (!fs.existsSync(p.transcript)) throw new Error("No transcript yet. Run: transcribe");
  return readJSON(p.transcript).words;
}

function timelineNow(edit = loadEdit(p)) {
  const probe = readJSON(p.probe);
  return buildTimeline(words(), edit.removed, { duration: probe.duration, silences: edit.silences });
}

function checkIndex(i, label) {
  const max = words().length - 1;
  if (!Number.isInteger(i) || i < 0 || i > max) throw new Error(`${label} must be a word index 0..${max}, got ${JSON.stringify(i)}`);
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

// ------------------------------------------------------------------ commands

async function cmdWait(a) {
  const timeout = Number(a.find((x) => /^\d+$/.test(x)) || 100) * 1000;
  const resume = a.includes("--resume");
  const until = Date.now() + timeout;
  let announced = false;
  for (;;) {
    let dir = null;
    try { dir = currentProjectDir(); } catch {}
    if (dir) {
      const pp = projectPaths(dir);
      const job = readJSON(pp.job, null);
      const finished = readJSON(pp.status, {})?.state === "review";
      if (job?.submittedAt && (!job.claimedAt || (resume && !finished))) {
        job.claimedAt = new Date().toISOString();
        writeJSON(pp.job, job);
        p = pp;
        out(JSON.stringify(job, null, 2));
        out("");
        const status = readJSON(pp.status);
        out("Steps to run, in order:");
        for (const s of status.steps) {
          const mark = s.state === "skipped" ? "-" : s.state === "done" ? "x" : "*";
          out(`  ${mark} ${s.id.padEnd(11)} ${s.label}${s.state === "skipped" ? " (off)" : s.state === "done" ? " (done)" : ""}`);
        }
        out(`\nProject: ${dir}`);
        return;
      }
    }
    if (!announced) {
      out("Waiting for you to click Edit Video in the browser...");
      announced = true;
    }
    if (Date.now() > until) {
      out("Still waiting. Run `node edit.js wait` again.");
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cmdStatus([id, state, ...msg]) {
  if (!["pending", "running", "done", "skipped", "error"].includes(state)) throw new Error("state must be pending|running|done|skipped|error");
  step(id, state, msg.join(" "));
  out(`${id}: ${state}${msg.length ? ` - ${msg.join(" ")}` : ""}`);
}

async function cmdSetup() {
  step("setup", "running", "Reading footage");
  const probe = await media.setup(p);
  const job = readJSON(p.job, {});
  const edit = loadEdit(p);
  edit.format = job.format === "16:9" ? "16:9" : "9:16";
  saveEdit(p, edit);
  const shape = probe.width >= probe.height ? "landscape" : "portrait";
  step("setup", "done", `${fmt(probe.duration)} ${shape} ${probe.width}x${probe.height}, ${probe.broll.length} b-roll clip(s)`);
  out(`Footage: ${probe.width}x${probe.height} ${shape}, ${round(probe.duration, 1)}s, ${round(probe.fps, 2)} fps`);
  out(`Output:  ${edit.format} (${FORMATS[edit.format].width}x${FORMATS[edit.format].height})`);
  out(`Framing: ${job.framing === "auto" ? "Claude chooses" : "keep the middle of the shot (never follow the speaker)"}`);
  out(`Frames:  ${path.join(p.reviewDir, "frames.jpg")}  (8 frames, left to right then down, at ${probe.reviewFrames.map((t) => `${t}s`).join(", ")})`);
  for (const b of probe.broll) out(`B-roll:  ${b.id}  ${b.duration}s  ${path.join(p.reviewDir, `broll-${b.id}.jpg`)}`);
  if (job.notes) out(`\nNotes from the user: ${job.notes}`);
}

async function cmdEnhance() {
  step("enhance", "running", "Cleaning up the voice");
  const res = await media.enhanceAudio(p, (m) => step("enhance", "running", m));
  const edit = loadEdit(p);
  edit.audio = { source: "enhanced", engine: res.engine };
  saveEdit(p, edit);
  step("enhance", "done", res.engine === "auphonic" ? "Auphonic: denoise, leveler, -16 LUFS" : res.note);
  out(`Enhanced with ${res.engine}${res.note ? ` (${res.note})` : ""}`);
}

async function cmdTranscribe(a) {
  step("transcribe", "running", "WhisperX is listening");
  const imp = a.indexOf("--import");
  const t = imp >= 0 ? media.importWhisperX(p, a[imp + 1]) : await media.transcribe(p, (m) => step("transcribe", "running", m));
  step("transcribe", "done", `${t.words.length} words`);
  out(`${t.words.length} words. Next: node edit.js transcript`);
}

async function cmdTranscript() {
  const ws = words();
  const edit = loadEdit(p);
  const lines = [];
  let line = [];
  let lineStart = ws[0]?.start ?? 0;
  const flush = () => {
    if (line.length) lines.push(`${fmt(lineStart).padStart(7)}  ${line.join(" ")}`);
    line = [];
  };
  ws.forEach((w, i) => {
    const prev = ws[i - 1];
    const gap = prev ? w.start - prev.end : 0;
    if (prev && (w.sentence || gap > 0.7 || line.length >= 18)) {
      flush();
      lineStart = w.start;
    }
    if (gap > 0.5) line.push(`‖${gap.toFixed(1)}s‖`);
    const tag = edit.removed[i] ? `~${w.text}~` : w.text;
    line.push(`${i}:${tag}`);
  });
  flush();
  out(lines.join("\n"));
  const removed = Object.keys(edit.removed).length;
  out(`\n${ws.length} words, ${removed} cut (~word~). Format is index:word. ‖n‖ marks a pause in seconds.`);
}

async function cmdFillers() {
  const lists = readJSON(path.join(SKILL_DIR, "assets", "fillers.json"));
  const ws = words();
  const norm = (t) => t.toLowerCase().replace(/[^a-z']/g, "");
  const ctx = (a, b) => ws.slice(Math.max(0, a - 4), b + 5).map((w, k) => {
    const i = Math.max(0, a - 4) + k;
    return i >= a && i <= b ? `[${w.text}]` : w.text;
  }).join(" ");
  const always = [];
  const maybe = [];
  ws.forEach((w, i) => {
    const t = norm(w.text);
    if (lists.always.includes(t)) always.push(i);
    else if (lists.context.includes(t)) maybe.push({ from: i, to: i });
  });
  for (const ph of lists.phrases) {
    for (let i = 0; i + ph.length <= ws.length; i++) {
      if (ph.every((x, k) => norm(ws[i + k].text) === x)) maybe.push({ from: i, to: i + ph.length - 1 });
    }
  }
  maybe.sort((a, b) => a.from - b.from);
  out("CERTAIN (sounds, not words). Cut these unless one is clearly meant:");
  always.forEach((i) => out(`  ${String(i).padStart(5)}  ${ctx(i, i)}`));
  if (!always.length) out("  none");
  out("\nCONTEXT (filler in some sentences, meaning in others). Read each one:");
  maybe.forEach((m) => out(`  ${`${m.from}${m.to > m.from ? `-${m.to}` : ""}`.padStart(9)}  ${ctx(m.from, m.to)}`));
  if (!maybe.length) out("  none");
  out(`\nThen: node edit.js apply cuts '{"kind":"filler","cuts":[{"from":12,"to":12}, ...]}'`);
}

async function cmdApply([kind, raw]) {
  const data = parseJSONArg(raw);
  const edit = loadEdit(p);
  const ws = words();
  const brollIds = brollSources(p).map((b) => b.id);
  fs.mkdirSync(p.decisionsDir, { recursive: true });
  writeJSON(path.join(p.decisionsDir, `${kind}-${Date.now()}.json`), data);

  switch (kind) {
    case "cuts": {
      const reason = data.kind || "manual";
      let n = 0;
      for (const c of data.cuts || []) {
        const to = c.to ?? c.from;
        checkIndex(c.from, "from");
        checkIndex(to, "to");
        if (to < c.from) throw new Error(`Cut ${c.from}-${to} runs backwards`);
        for (let i = c.from; i <= to; i++) if (!edit.removed[i]) { edit.removed[i] = reason; n++; }
      }
      const pct = Object.keys(edit.removed).length / ws.length;
      saveEdit(p, edit);
      const tl = timelineNow(edit);
      out(`Cut ${n} words (${reason}). ${Object.keys(edit.removed).length}/${ws.length} words cut, edit now ${round(tl.duration, 1)}s.`);
      if (pct > 0.5) out("WARNING: more than half the words are cut. Check this is what you meant.");
      const stepId = reason === "badtake" ? "badtakes" : reason === "filler" ? "fillers" : null;
      if (stepId) step(stepId, "done", `${n} words cut${data.summary ? `: ${data.summary}` : ""}`);
      break;
    }
    case "uncut": {
      for (const c of data.cuts || []) for (let i = c.from; i <= (c.to ?? c.from); i++) delete edit.removed[i];
      saveEdit(p, edit);
      out("Restored.");
      break;
    }
    case "zooms": {
      const list = data.zooms || data;
      for (const z of list) {
        checkIndex(z.from, "zoom.from");
        checkIndex(z.to ?? z.from, "zoom.to");
        if (z.scale !== undefined && (z.scale < 1 || z.scale > 1.6)) throw new Error("zoom.scale must be 1.0-1.6");
        for (const k of ["originX", "originY"]) if (z[k] !== undefined && (z[k] < 0 || z[k] > 1)) throw new Error(`zoom.${k} must be 0-1`);
      }
      edit.zooms = list.map((z) => ({
        from: z.from, to: z.to ?? z.from, scale: z.scale ?? 1.18,
        originX: z.originX ?? 0.5, originY: z.originY ?? 0.5, ...(z.why ? { why: z.why } : {}),
      }));
      saveEdit(p, edit);
      step("zooms", "done", `${list.length} punch-ins`);
      out(`${list.length} zooms saved.`);
      break;
    }
    case "framing": {
      // Where the output window sits on the full frame. x/y 0..1: 0 = left/top
      // edge, 0.5 = the middle. shots move it for a word range only.
      const unit = (v, label) => {
        if (v === undefined) return undefined;
        if (typeof v !== "number" || v < 0 || v > 1) throw new Error(`${label} must be 0-1`);
        return v;
      };
      const shots = (data.shots || []).map((f) => {
        checkIndex(f.from, "shot.from");
        checkIndex(f.to ?? f.from, "shot.to");
        return { from: f.from, to: f.to ?? f.from, x: unit(f.x, "shot.x") ?? 0.5, y: unit(f.y, "shot.y") ?? 0.5, ...(f.why ? { why: f.why } : {}) };
      });
      edit.crop = { x: unit(data.x, "x") ?? edit.crop?.x ?? 0.5, y: unit(data.y, "y") ?? edit.crop?.y ?? 0.5 };
      edit.framing = { ...(edit.framing || {}), shots };
      saveEdit(p, edit);
      out(`Frame sits at x=${edit.crop.x} y=${edit.crop.y}${shots.length ? `, ${shots.length} reframed moment(s)` : ""}.`);
      break;
    }
    case "broll": {
      const list = data.broll || data;
      for (const b of list) {
        if (!brollIds.includes(b.clip)) throw new Error(`Unknown b-roll clip "${b.clip}". Clips: ${brollIds.join(", ") || "none uploaded"}`);
        checkIndex(b.from, "broll.from");
        checkIndex(b.to ?? b.from, "broll.to");
      }
      edit.broll = list.map((b) => ({ clip: b.clip, from: b.from, to: b.to ?? b.from, mediaStart: b.mediaStart ?? 0, why: b.why }));
      saveEdit(p, edit);
      step("broll", "running", `${list.length} cutaways placed, encoding`);
      await media.prepareBroll(p, edit);
      step("broll", "done", `${list.length} cutaways`);
      out(`${list.length} b-roll placements saved and encoded.`);
      break;
    }
    case "hook": {
      if (!data.text || typeof data.text !== "string") throw new Error('hook needs {"text": "..."}');
      const wc = data.text.trim().split(/\s+/).length;
      if (wc > 12) throw new Error(`Hook is ${wc} words. Keep it to 12 or fewer, it has to be read in two seconds.`);
      edit.hook = { text: data.text.trim(), ...(data.duration ? { duration: data.duration } : {}) };
      saveEdit(p, edit);
      step("hook", "done", `"${edit.hook.text}"`);
      out("Hook saved.");
      break;
    }
    case "cta": {
      if (!data.text) throw new Error('cta needs {"text": "...", "subtext": "..."}');
      edit.cta = { text: data.text.trim(), subtext: data.subtext?.trim() || "", duration: data.duration ?? 2.5 };
      saveEdit(p, edit);
      step("cta", "done", `"${edit.cta.text}"`);
      out("CTA saved.");
      break;
    }
    case "sfx": {
      const list = data.sfx || data;
      for (const s of list) {
        if (!Object.keys(media.SFX_PROMPTS).includes(s.kind)) throw new Error(`sfx.kind must be one of ${Object.keys(media.SFX_PROMPTS).join(", ")}`);
        if (s.word !== undefined) checkIndex(s.word, "sfx.word");
      }
      edit.sfx = list.map((s) => ({ kind: s.kind, ...(s.word !== undefined ? { word: s.word } : { at: s.at }), volume: s.volume ?? 0.5 }));
      saveEdit(p, edit);
      out(`${list.length} sound effects placed. Next: node edit.js sfx`);
      break;
    }
    case "crop": {
      edit.crop = { x: Math.min(1, Math.max(0, data.x ?? 0.5)), y: Math.min(1, Math.max(0, data.y ?? 0.5)) };
      saveEdit(p, edit);
      out(`Frame sits at x=${edit.crop.x} y=${edit.crop.y}.`);
      break;
    }
    case "captions": {
      if (data.y !== undefined && (typeof data.y !== "number" || data.y < 0.1 || data.y > 0.9)) {
        throw new Error("captions.y is the caption line's height in the frame, 0.1 (top) to 0.9 (bottom)");
      }
      edit.captions = { ...(edit.captions || {}), ...data };
      saveEdit(p, edit);
      out("Caption style saved.");
      break;
    }
    default:
      throw new Error(`Unknown decision "${kind}"`);
  }
}

async function cmdSilences([maxGap, pad]) {
  step("silences", "running", "Tightening pauses");
  const edit = loadEdit(p);
  const before = timelineNow({ ...edit, silences: { ...edit.silences, enabled: false } }).duration;
  const gap = Number(maxGap ?? 1.0);
  const air = Number(pad ?? 0.2);
  if (!(gap >= 0.7) || !(air >= 0.15)) throw new Error("Go no tighter than silences 0.7 0.15: below that, speech sounds clipped and shots flash.");
  edit.silences = { enabled: true, maxGap: gap, pad: air };
  saveEdit(p, edit);
  const after = timelineNow(edit).duration;
  step("silences", "done", `${round(before - after, 1)}s of dead air removed`);
  out(`Removed ${round(before - after, 1)}s of silence (${round(before, 1)}s -> ${round(after, 1)}s).`);
}

async function cmdColor() {
  step("color", "running", "Measuring exposure and white balance");
  const res = await media.analyzeColor(p);
  const edit = loadEdit(p);
  edit.color = res;
  saveEdit(p, edit);
  const pr = res.params;
  step("color", "done", `brightness ${pr.brightness >= 0 ? "+" : ""}${pr.brightness}, contrast ${pr.contrast}, saturation ${pr.saturation}`);
  out(`Grade: ${res.filter}\nMeasured: ${JSON.stringify(res.stats)}`);
}

async function cmdPrepare() {
  step("compose", "running", "Encoding the A-roll");
  const edit = loadEdit(p);
  await media.prepareMain(p, edit, (m) => step("compose", "running", m));
  await media.prepareBroll(p, edit);
  step("compose", "running", "Footage ready");
  out(`Wrote ${path.join(p.compMedia, "main.mp4")}`);
}

async function cmdCaptions([highlight]) {
  const edit = loadEdit(p);
  edit.captions = { ...(edit.captions || {}), highlight: highlight || edit.captions?.highlight || "#FFE14D" };
  saveEdit(p, edit);
  step("captions", "done", "Word-by-word, active word highlighted");
  out("Captions on.");
}

async function cmdMusic([prompt, volume]) {
  if (!prompt) throw new Error('Usage: music "<prompt>" [volume]');
  step("music", "running", "ElevenLabs is composing");
  const edit = loadEdit(p);
  const seconds = timelineNow(edit).duration + (edit.cta ? edit.cta.duration ?? 2.5 : 0);
  await media.generateMusic(p, prompt, seconds);
  edit.music = { file: "media/music.mp3", prompt, volume: Number(volume ?? 0.12) };
  saveEdit(p, edit);
  step("music", "done", prompt.slice(0, 80));
  out(`Music saved (${round(seconds, 1)}s).`);
}

async function cmdSfx() {
  const edit = loadEdit(p);
  step("sfx", "running", "Generating sound effects");
  const kinds = [...new Set(edit.sfx.map((s) => s.kind))];
  const engines = [];
  for (const k of kinds) engines.push(`${k}:${(await media.generateSfx(p, k)).engine}`);
  step("sfx", "done", `${edit.sfx.length} hits (${kinds.join(", ") || "none"})`);
  out(`Ready: ${engines.join(", ") || "nothing placed"}`);
}

async function cmdCompose() {
  step("compose", "running", "Writing the HyperFrames composition");
  if (!fs.existsSync(path.join(p.compMedia, "main.mp4"))) {
    const edit = loadEdit(p);
    step("compose", "running", "Encoding the A-roll");
    await media.prepareMain(p, edit, (m) => step("compose", "running", m));
  }
  const tl = await composeOrPrepare(p, (m) => step("compose", "running", m));
  step("compose", "done", `${round(tl.duration, 1)}s edit, ${tl.segments.length} segments`);
  out(`Composition: ${path.join(p.compDir, "index.html")}`);
  out(`Edit is ${round(tl.duration, 1)}s (source ${round(tl.sourceDuration, 1)}s). The editor is open in the browser.`);
}

async function cmdInfo() {
  const edit = loadEdit(p);
  const tl = timelineNow(edit);
  const probe = readJSON(p.probe);
  out(`Format ${edit.format}. Source ${round(probe.duration, 1)}s -> edit ${round(tl.duration, 1)}s${edit.cta ? ` + ${edit.cta.duration}s CTA` : ""}.`);
  out(`${tl.segments.length} segments, ${Object.keys(edit.removed).length} words cut, silences ${edit.silences.enabled ? "tightened" : "kept"}.`);
  out(`Zooms ${edit.zooms.length}, b-roll ${edit.broll.length}, sfx ${edit.sfx.length}, hook ${edit.hook ? "yes" : "no"}, cta ${edit.cta ? "yes" : "no"}, captions ${edit.captions ? "yes" : "no"}, music ${edit.music ? "yes" : "no"}.`);
}

async function cmdRender([quality]) {
  const file = await render(p, { quality: quality || "standard", onProgress: (pct) => process.stdout.write(`\rRendering ${pct}%   `) });
  out(`\n${file}`);
}
