// Shared plumbing: paths, .env, JSON state, child processes, step status.
// Everything here is deterministic. No AI calls live in this folder.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORK_DIR = process.env.ELEVEN_WORK_DIR || path.join(SKILL_DIR, "work");
export const CURRENT_FILE = path.join(WORK_DIR, "current.json");

// ---------------------------------------------------------------- .env

// Loads KEY=VALUE pairs from the project root .env and the skill's own .env.
// Real environment variables win. Keys are never logged or written anywhere.
export function loadEnv() {
  const candidates = [path.join(process.cwd(), ".env"), path.join(SKILL_DIR, ".env")];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = value;
    }
  }
}
loadEnv();

// ---------------------------------------------------------------- JSON

export function readJSON(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

// Atomic write so the server never reads half a file.
export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- projects

export function projectPaths(dir) {
  return {
    dir,
    sourceDir: path.join(dir, "source"),
    brollSrcDir: path.join(dir, "source", "broll"),
    job: path.join(dir, "job.json"),
    status: path.join(dir, "status.json"),
    probe: path.join(dir, "probe.json"),
    audioDir: path.join(dir, "audio"),
    voice16k: path.join(dir, "audio", "voice-16k.wav"),
    voice48k: path.join(dir, "audio", "voice-48k.wav"),
    enhanced: path.join(dir, "audio", "voice-enhanced.wav"),
    transcript: path.join(dir, "transcript.json"),
    whisperDir: path.join(dir, "whisperx"),
    edit: path.join(dir, "edit.json"),
    timeline: path.join(dir, "timeline.json"),
    reviewDir: path.join(dir, "review"),
    decisionsDir: path.join(dir, "decisions"),
    compDir: path.join(dir, "comp"),
    compMedia: path.join(dir, "comp", "media"),
    exportDir: path.join(dir, "export"),
  };
}

export function currentProjectDir() {
  const cur = readJSON(CURRENT_FILE, null);
  if (!cur || !cur.dir || !fs.existsSync(cur.dir)) {
    throw new Error("No active project. Start the app with /11secondedit and upload a video first.");
  }
  return cur.dir;
}

export function setCurrentProject(dir) {
  writeJSON(CURRENT_FILE, { dir, updatedAt: new Date().toISOString() });
}

// The original upload. Never opened for writing after it lands.
export function originalVideo(p) {
  const name = fs.readdirSync(p.sourceDir).find((f) => f.startsWith("original."));
  if (!name) throw new Error(`No original video in ${p.sourceDir}`);
  return path.join(p.sourceDir, name);
}

export function brollSources(p) {
  if (!fs.existsSync(p.brollSrcDir)) return [];
  return fs
    .readdirSync(p.brollSrcDir)
    .filter((f) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f))
    .sort()
    .map((f) => ({ name: f, file: path.join(p.brollSrcDir, f), id: brollId(f) }));
}

export function brollId(filename) {
  return filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clip";
}

// ---------------------------------------------------------------- edit state

export const FORMATS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
};

export function defaultEdit(job) {
  return {
    version: 1,
    format: job?.format === "16:9" ? "16:9" : "9:16",
    removed: {}, // word index -> reason ("badtake" | "filler" | "manual")
    silences: { enabled: false, maxGap: 0.35, pad: 0.08 },
    crop: { x: 0.5, y: 0.5 },
    color: null, // { filter, stats }
    audio: { source: "original" }, // or "enhanced"
    zooms: [], // { from, to, scale, originY }
    broll: [], // { clip, from, to, mediaStart }
    hook: null, // { text, duration }
    cta: null, // { text, subtext, duration }
    captions: null, // { style }
    music: null, // { file, volume, prompt }
    sfx: [], // { kind, at, word, file, volume }
  };
}

export function loadEdit(p) {
  const job = readJSON(p.job, {});
  const edit = readJSON(p.edit, null) || defaultEdit(job);
  return { ...defaultEdit(job), ...edit };
}

export function saveEdit(p, edit) {
  edit.updatedAt = new Date().toISOString();
  writeJSON(p.edit, edit);
}

// ---------------------------------------------------------------- status

export const STEPS = [
  { id: "setup", label: "Prepare footage", always: true },
  { id: "enhance", label: "Enhance audio", feature: "enhanceAudio" },
  { id: "transcribe", label: "Transcribe (word timestamps)", always: true },
  { id: "badtakes", label: "Remove bad takes and false starts", feature: "badTakes" },
  { id: "fillers", label: "Remove filler words", feature: "fillers" },
  { id: "silences", label: "Remove silences", feature: "silences" },
  { id: "color", label: "Auto color correction", feature: "color" },
  { id: "zooms", label: "Add zoom cuts", feature: "zooms" },
  { id: "broll", label: "Add b-roll", feature: "broll" },
  { id: "hook", label: "Text hook at the start", feature: "hook" },
  { id: "cta", label: "Call to action card", feature: "cta" },
  { id: "captions", label: "Animated captions", feature: "captions" },
  { id: "music", label: "Background music", feature: "music" },
  { id: "sfx", label: "Sound effects", feature: "sfx" },
  { id: "compose", label: "Build the edit", always: true },
];

export const FEATURES = STEPS.filter((s) => s.feature).map((s) => ({ key: s.feature, label: s.label }));

export function initialStatus(job) {
  return {
    state: "running",
    startedAt: new Date().toISOString(),
    steps: STEPS.map((s) => ({
      id: s.id,
      label: s.label,
      state: s.always || job.features?.[s.feature] ? "pending" : "skipped",
      message: s.always || job.features?.[s.feature] ? "" : "Off",
    })),
  };
}

export function setStatus(p, stepId, state, message = "") {
  const status = readJSON(p.status, null);
  if (!status) return;
  const step = status.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown step "${stepId}". Steps: ${status.steps.map((s) => s.id).join(", ")}`);
  if (step.state === "skipped" && state !== "skipped") {
    // A step the user switched off stays off.
    return;
  }
  step.state = state;
  if (message !== undefined) step.message = message;
  step.updatedAt = new Date().toISOString();
  if (stepId === "compose" && state === "done") status.state = "review";
  if (state === "error") status.lastError = `${step.label}: ${message}`;
  writeJSON(p.status, status);
}

export function featureOn(p, feature) {
  const job = readJSON(p.job, {});
  return Boolean(job.features?.[feature]);
}

// ---------------------------------------------------------------- processes

export function run(cmd, args, { cwd, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    const feed = (chunk) => {
      if (!onLine) return;
      buf += chunk;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      lines.forEach(onLine);
    };
    child.stdout.on("data", (d) => {
      stdout += d;
      feed(d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      feed(d.toString());
    });
    child.on("error", (err) =>
      reject(err.code === "ENOENT" ? new Error(`"${cmd}" is not installed or not on PATH.`) : err),
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

export async function ffprobe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  const rotation = Math.abs(
    Number(v?.tags?.rotate || v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0),
  );
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const [num, den] = (v?.avg_frame_rate || "30/1").split("/").map(Number);
  return {
    duration: Number(info.format.duration),
    width,
    height,
    fps: den ? num / den : 30,
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    sampleRate: a ? Number(a.sample_rate) : null,
  };
}

export const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
