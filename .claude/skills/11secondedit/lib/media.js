// FFmpeg, WhisperX, Auphonic and ElevenLabs. Every function here is a
// deterministic script step: same inputs, same outputs, no judgement calls.
import fs from "node:fs";
import path from "node:path";
import { run, ffprobe, writeJSON, readJSON, originalVideo, brollSources, FORMATS, clamp, round } from "./core.js";

// ---------------------------------------------------------------- setup

export async function setup(p) {
  for (const d of [p.audioDir, p.reviewDir, p.decisionsDir, p.compMedia, p.exportDir]) fs.mkdirSync(d, { recursive: true });
  const src = originalVideo(p);
  const probe = await ffprobe(src);
  if (!probe.hasAudio) throw new Error("The video has no audio track. 11 Second Edit needs speech to edit.");
  const broll = [];
  for (const b of brollSources(p)) {
    const info = await ffprobe(b.file);
    broll.push({ id: b.id, name: b.name, duration: round(info.duration), width: info.width, height: info.height });
  }
  probe.broll = broll;

  await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", p.voice16k]);
  await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", p.voice48k]);

  // Stills Claude can look at: framing of the speaker, and each b-roll clip.
  const at = Math.min(probe.duration / 2, 5);
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(at), "-i", src, "-frames:v", "1", "-vf", "scale=-2:720", path.join(p.reviewDir, "frame.jpg")]);
  // Eight frames across the whole recording, so framing decisions are made
  // on what is actually in shot over time, not on one still.
  const every = probe.duration / 8;
  probe.reviewFrames = Array.from({ length: 8 }, (_, k) => round(every * (k + 0.5), 1));
  const tmp = path.join(p.reviewDir, "frames-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  for (const [k, t] of probe.reviewFrames.entries()) {
    await run("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", path.join(tmp, `${k}.jpg`)]);
  }
  await run("ffmpeg", ["-y", "-v", "error", "-i", path.join(tmp, "%d.jpg"), "-vf", "tile=4x2:padding=6", "-frames:v", "1", path.join(p.reviewDir, "frames.jpg")]);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const b of brollSources(p)) {
    const info = broll.find((x) => x.id === b.id);
    const step = Math.max(info.duration / 4, 0.1);
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", b.file,
      "-vf", `fps=1/${step.toFixed(3)},scale=360:-2,tile=4x1:padding=4`,
      "-frames:v", "1", path.join(p.reviewDir, `broll-${b.id}.jpg`),
    ]);
  }
  writeJSON(p.probe, probe);
  return probe;
}

// ---------------------------------------------------------------- audio

const LOCAL_CHAIN =
  "highpass=f=80,lowpass=f=16000,afftdn=nf=-25,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,loudnorm=I=-16:TP=-1.5:LRA=11";

export async function enhanceAudio(p, log = () => {}) {
  const key = process.env.AUPHONIC_API_KEY;
  if (!key) {
    await run("ffmpeg", ["-y", "-v", "error", "-i", p.voice48k, "-af", LOCAL_CHAIN, "-ar", "48000", "-c:a", "pcm_s16le", p.enhanced]);
    return { engine: "ffmpeg", note: "AUPHONIC_API_KEY not set in .env, used the local FFmpeg chain instead" };
  }
  const api = "https://auphonic.com/api";
  const headers = { Authorization: `Bearer ${key}` };
  const call = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Auphonic ${res.status}: ${body.error_message || JSON.stringify(body).slice(0, 300)}`);
    return body.data;
  };
  log("Creating Auphonic production");
  const prod = await call(`${api}/productions.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: { title: "11 Second Edit voice" },
      algorithms: { filtering: true, leveler: true, normloudness: true, loudnesstarget: -16, denoise: true },
      output_files: [{ format: "wav" }],
    }),
  });
  log("Uploading audio to Auphonic");
  const form = new FormData();
  form.append("input_file", await fs.openAsBlob(p.voice48k), "voice.wav");
  await call(`${api}/production/${prod.uuid}/upload.json`, { method: "POST", body: form });
  await call(`${api}/production/${prod.uuid}/start.json`, { method: "POST" });
  const started = Date.now();
  let data;
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    data = await call(`${api}/production/${prod.uuid}.json`);
    if (data.status === 3) break; // Done
    if (data.status === 2 || data.status === 9) throw new Error(`Auphonic failed: ${data.error_message || data.status_string}`);
    if (Date.now() - started > 15 * 60 * 1000) throw new Error("Auphonic took longer than 15 minutes");
    log(`Auphonic: ${data.status_string}`);
  }
  const out = data.output_files?.[0];
  if (!out?.download_url) throw new Error("Auphonic finished without an output file");
  const res = await fetch(out.download_url, { headers });
  if (!res.ok) throw new Error(`Auphonic download ${res.status}`);
  const raw = path.join(p.audioDir, "auphonic-output");
  fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", p.enhanced]);
  fs.rmSync(raw);
  return { engine: "auphonic", production: prod.uuid };
}

// ---------------------------------------------------------------- transcription

export async function transcribe(p, log = () => {}) {
  const bin = process.env.WHISPERX_BIN || "whisperx";
  const args = [
    p.voice16k,
    "--model", process.env.WHISPERX_MODEL || "small",
    "--device", process.env.WHISPERX_DEVICE || "cpu",
    "--compute_type", process.env.WHISPERX_COMPUTE_TYPE || "int8",
    "--output_format", "json",
    "--output_dir", p.whisperDir,
  ];
  if (process.env.WHISPERX_LANGUAGE) args.push("--language", process.env.WHISPERX_LANGUAGE);
  fs.mkdirSync(p.whisperDir, { recursive: true });
  try {
    await run(bin, args, { onLine: (l) => l.trim() && log(l.trim().slice(0, 160)) });
  } catch (err) {
    if (/not installed/.test(err.message)) {
      throw new Error(`WhisperX is not installed. Run: pip install whisperx  (or set WHISPERX_BIN in .env). ${err.message}`);
    }
    throw err;
  }
  const out = path.join(p.whisperDir, "voice-16k.json");
  return importWhisperX(p, out);
}

// Normalises WhisperX JSON into one flat word list. Words WhisperX could not
// align (numbers, symbols) get times interpolated from their neighbours.
export function importWhisperX(p, file) {
  const wx = readJSON(file);
  const words = [];
  for (const seg of wx.segments || []) {
    const segWords = seg.words || [];
    segWords.forEach((w, n) => {
      const text = String(w.word ?? w.text ?? "").trim();
      if (!text) return;
      words.push({
        text,
        start: typeof w.start === "number" ? w.start : null,
        end: typeof w.end === "number" ? w.end : null,
        score: typeof w.score === "number" ? round(w.score, 2) : null,
        segStart: n === 0,
        segFallback: [seg.start, seg.end],
      });
    });
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.start === null) {
      const prev = words[i - 1];
      w.start = prev ? prev.end : w.segFallback[0];
    }
    if (w.end === null) {
      const next = words.slice(i + 1).find((x) => x.start !== null);
      w.end = Math.max(w.start + 0.05, next ? Math.min(next.start, w.start + 0.6) : w.start + 0.3);
    }
    // Whisper occasionally overlaps neighbours; keep times monotonic.
    if (i > 0 && w.start < words[i - 1].end) w.start = words[i - 1].end;
    if (w.end <= w.start) w.end = w.start + 0.05;
  }
  const transcript = {
    source: "whisperx",
    language: wx.language || null,
    words: words.map((w, i) => ({
      i,
      text: w.text,
      start: round(w.start),
      end: round(w.end),
      score: w.score,
      ...(w.segStart ? { sentence: true } : {}),
    })),
  };
  writeJSON(p.transcript, transcript);
  return transcript;
}

// ---------------------------------------------------------------- color

// Samples frames, measures exposure, contrast, saturation and colour cast,
// and turns the numbers into a gentle FFmpeg grade.
export async function analyzeColor(p) {
  const src = originalVideo(p);
  const probe = readJSON(p.probe);
  const every = Math.max(probe.duration / 12, 0.5);
  const { stderr, stdout } = await run("ffmpeg", [
    "-v", "error", "-i", src,
    "-vf", `fps=1/${every.toFixed(3)},scale=320:-2,signalstats,metadata=print:file=-`,
    "-an", "-f", "null", "-",
  ]);
  const text = stdout + stderr;
  const keys = ["YAVG", "YLOW", "YHIGH", "SATAVG", "UAVG", "VAVG"];
  const acc = Object.fromEntries(keys.map((k) => [k, []]));
  for (const k of keys) {
    for (const m of text.matchAll(new RegExp(`lavfi\\.signalstats\\.${k}=([0-9.]+)`, "g"))) acc[k].push(Number(m[1]));
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const stats = Object.fromEntries(keys.map((k) => [k, round(mean(acc[k]), 1)]));
  if (Number.isNaN(stats.YAVG)) throw new Error("Could not measure the footage");

  const brightness = round(clamp((118 - stats.YAVG) / 255 * 0.6, -0.08, 0.08));
  const span = Math.max(stats.YHIGH - stats.YLOW, 1);
  const contrast = round(clamp(190 / span, 0.95, 1.2));
  const saturation = round(clamp(1 + (32 - stats.SATAVG) / 80, 0.95, 1.25));
  const uCast = stats.UAVG - 128; // + means blue cast
  const vCast = stats.VAVG - 128; // + means red cast
  const bm = round(clamp(-uCast / 128, -0.1, 0.1));
  const rm = round(clamp(-vCast / 128, -0.1, 0.1));
  const filter =
    `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}` +
    (Math.abs(bm) > 0.005 || Math.abs(rm) > 0.005 ? `,colorbalance=rm=${rm}:bm=${bm}` : "");
  return { filter, stats, params: { brightness, contrast, saturation, rm, bm } };
}

// ---------------------------------------------------------------- media for the composition

function fillFilter(width, height, crop) {
  const cx = clamp(crop?.x ?? 0.5, 0, 1);
  const cy = clamp(crop?.y ?? 0.5, 0, 1);
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height}:(iw-${width})*${cx}:(ih-${height})*${cy},setsar=1`
  );
}

// Writes comp/media/main.mp4: the whole original frame (never pre-cropped),
// colour-graded, with the enhanced voice muxed in. Framing happens in the
// composition, so the shot can sit on a different part of the frame at
// different moments. The original file is only ever read.
export async function prepareMain(p, edit, log = () => {}) {
  const { width, height } = FORMATS[edit.format];
  const src = originalVideo(p);
  const probe = readJSON(p.probe);
  // Never wider than needed to fill the output frame, never upscaled.
  const cover = Math.max(width / probe.width, height / probe.height);
  const k = Math.min(1, cover);
  const ew = Math.round((probe.width * k) / 2) * 2;
  const eh = Math.round((probe.height * k) / 2) * 2;
  const vf = [`scale=${ew}:${eh},setsar=1`, edit.color?.filter, "fps=30", "format=yuv420p"].filter(Boolean).join(",");
  const useEnhanced = edit.audio?.source === "enhanced" && fs.existsSync(p.enhanced);
  const args = ["-y", "-v", "error", "-stats", "-i", src];
  if (useEnhanced) args.push("-i", p.enhanced, "-map", "0:v:0", "-map", "1:a:0");
  else args.push("-map", "0:v:0", "-map", "0:a:0");
  args.push(
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "30", "-keyint_min", "30",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", String(probe.duration),
    "-movflags", "+faststart",
    path.join(p.compMedia, "main.mp4"),
  );
  await run("ffmpeg", args, { onLine: (l) => /time=/.test(l) && log(`Encoding ${l.match(/time=(\S+)/)?.[1] || ""}`) });
}

// Relative to comp/media. The format is in the name so switching 9:16 <-> 16:9
// never reuses a clip cropped for the other shape.
export const brollMediaPath = (id, format) => `broll/${id}.${format.replace(":", "x")}.mp4`;

export async function prepareBroll(p, edit) {
  const { width, height } = FORMATS[edit.format];
  const dir = path.join(p.compMedia, "broll");
  fs.mkdirSync(dir, { recursive: true });
  const used = new Set(edit.broll.map((b) => b.clip));
  for (const b of brollSources(p)) {
    if (!used.has(b.id)) continue;
    const out = path.join(p.compMedia, brollMediaPath(b.id, edit.format));
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(b.file).mtimeMs) continue;
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", b.file, "-an",
      "-vf", `${fillFilter(width, height)},fps=30,format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "30", "-movflags", "+faststart", out,
    ]);
  }
}

// ---------------------------------------------------------------- music + sound effects

async function elevenlabs(endpoint, body, outFile) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set in .env");
  const res = await fetch(`https://api.elevenlabs.io${endpoint}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${text.slice(0, 300)}`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
}

export async function generateMusic(p, prompt, seconds) {
  const out = path.join(p.compMedia, "music.mp3");
  const ms = Math.round(clamp(seconds + 2, 10, 300) * 1000);
  await elevenlabs("/v1/music?output_format=mp3_44100_128", { prompt, music_length_ms: ms, model_id: "music_v1", force_instrumental: true }, out);
  return out;
}

// Short synthesized fallbacks so sound effects work without an API key.
const SYNTH = {
  whoosh: ["anoisesrc=d=0.45:c=pink:a=0.6", "highpass=f=400,lowpass=f=5000,afade=t=in:d=0.2,afade=t=out:st=0.2:d=0.25"],
  pop: ["sine=f=880:d=0.12", "afade=t=out:st=0.02:d=0.1,volume=0.7"],
  ding: ["sine=f=1318:d=0.6", "afade=t=out:st=0.05:d=0.55,volume=0.5"],
  click: ["sine=f=2000:d=0.03", "afade=t=out:d=0.03,volume=0.6"],
  riser: ["anoisesrc=d=1.2:c=white:a=0.4", "highpass=f=1200,afade=t=in:d=1.1,afade=t=out:st=1.1:d=0.1"],
  thud: ["sine=f=60:d=0.35", "afade=t=out:st=0.03:d=0.3,volume=1.2"],
};
export const SFX_PROMPTS = {
  whoosh: "a quick clean whoosh transition, short",
  pop: "a soft UI pop, bubbly, short",
  ding: "a bright notification ding",
  click: "a crisp mouse click",
  riser: "a short tension riser",
  thud: "a deep cinematic impact thud",
};

export async function generateSfx(p, kind) {
  const out = path.join(p.compMedia, "sfx", `${kind}.mp3`);
  if (fs.existsSync(out)) return { file: out, engine: "cache" };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (process.env.ELEVENLABS_API_KEY && SFX_PROMPTS[kind]) {
    try {
      await elevenlabs("/v1/sound-generation", { text: SFX_PROMPTS[kind], duration_seconds: kind === "riser" ? 1.5 : 0.8, prompt_influence: 0.6 }, out);
      return { file: out, engine: "elevenlabs" };
    } catch (err) {
      if (!SYNTH[kind]) throw err;
    }
  }
  const synth = SYNTH[kind];
  if (!synth) throw new Error(`Unknown sound effect "${kind}". Use one of: ${Object.keys(SYNTH).join(", ")}`);
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", synth[0], "-af", synth[1], "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-q:a", "4", out]);
  return { file: out, engine: "ffmpeg" };
}
