#!/usr/bin/env node
// Local server for the 11 Second Edit browser app. No dependencies beyond
// Node. Serves the app, takes uploads, streams progress to the page over SSE,
// applies transcript edits and runs the export.
//
//   node server.js [--no-open] [--port 4111]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  SKILL_DIR, WORK_DIR, CURRENT_FILE, readJSON, writeJSON, projectPaths, setCurrentProject, initialStatus,
  FEATURES, defaultEdit, loadEdit, saveEdit, brollSources, run,
} from "./lib/core.js";
import { compose } from "./lib/compose.js";
import { render } from "./lib/render.js";

const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1] || 0) || Number(process.env.PORT) || 4111;
const OPEN = !argv.includes("--no-open");
const APP_DIR = path.join(SKILL_DIR, "app");

fs.mkdirSync(WORK_DIR, { recursive: true });

// ------------------------------------------------------------------ state

let exportState = { state: "idle", pct: 0, file: null, error: null };
let composing = Promise.resolve();
const clients = new Set();

function current() {
  const cur = readJSON(CURRENT_FILE, null);
  if (!cur?.dir || !fs.existsSync(cur.dir)) return null;
  return projectPaths(cur.dir);
}

function newProject() {
  const id = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) + "-" + Math.random().toString(36).slice(2, 6);
  const dir = path.join(WORK_DIR, id);
  const p = projectPaths(dir);
  fs.mkdirSync(p.brollSrcDir, { recursive: true });
  setCurrentProject(dir);
  exportState = { state: "idle", pct: 0, file: null, error: null };
  return p;
}

function state() {
  const p = current();
  if (!p) return { project: null, features: FEATURES };
  const job = readJSON(p.job, null);
  const status = readJSON(p.status, null);
  const transcript = readJSON(p.transcript, null);
  const timeline = readJSON(p.timeline, null);
  const edit = readJSON(p.edit, null);
  const original = fs.existsSync(p.sourceDir) && fs.readdirSync(p.sourceDir).find((f) => f.startsWith("original."));
  return {
    project: path.basename(p.dir),
    original: original || null,
    originalName: job?.originalName || readJSON(path.join(p.dir, "upload.json"), {}).originalName || original,
    broll: brollSources(p).map((b) => ({ id: b.id, name: b.name })),
    job,
    status,
    transcript: transcript ? transcript.words.map((w) => ({ i: w.i, text: w.text, start: w.start, end: w.end, sentence: w.sentence })) : null,
    removed: edit?.removed || {},
    timeline,
    exports: fs.existsSync(p.exportDir) ? fs.readdirSync(p.exportDir).filter((f) => f.endsWith(".mp4")).sort().reverse() : [],
    exportState,
    features: FEATURES,
  };
}

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// Watch the active project's status and timeline files; the CLI writes them.
const mtimes = {};
setInterval(() => {
  const p = current();
  if (!p) return;
  for (const [key, file] of [["status", p.status], ["timeline", p.timeline], ["edit", p.edit], ["transcript", p.transcript]]) {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    const k = `${p.dir}:${key}`;
    if (mtimes[k] !== undefined && mtimes[k] !== m) broadcast("state", state());
    mtimes[k] = m;
  }
}, 400);

// ------------------------------------------------------------------ http helpers

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
};

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(req, res, file, { download } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { return send(res, 404, { error: "Not found" }); }
  if (!stat.isFile()) return send(res, 404, { error: "Not found" });
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (download) headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"`;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  fs.createReadStream(file).pipe(res);
}

// Resolves a URL path inside a root, refusing anything that climbs out.
function inside(root, rel) {
  const target = path.resolve(root, "." + path.sep + decodeURIComponent(rel));
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const safeName = (name) => path.basename(String(name || "clip.mp4")).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "clip.mp4";

// ------------------------------------------------------------------ routes

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /" || route === "GET /index.html") return serveFile(req, res, path.join(APP_DIR, "index.html"));
  if (url.pathname.startsWith("/app/")) {
    const f = inside(APP_DIR, url.pathname.slice(5));
    return f ? serveFile(req, res, f) : send(res, 403, { error: "Forbidden" });
  }
  if (route === "GET /vendor/player.js") {
    return serveFile(req, res, path.join(SKILL_DIR, "node_modules", "@hyperframes", "player", "dist", "hyperframes-player.global.js"));
  }
  if (route === "GET /vendor/hyperframe.runtime.js") {
    return serveFile(req, res, path.join(SKILL_DIR, "node_modules", "@hyperframes", "core", "dist", "hyperframe.runtime.iife.js"));
  }
  if (route === "GET /api/ping") return send(res, 200, { app: "11secondedit" });
  if (route === "GET /api/state") return send(res, 200, state());

  if (route === "GET /api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (route === "POST /api/project") {
    newProject();
    broadcast("state", state());
    return send(res, 200, state());
  }

  // Raw-body uploads: PUT /api/upload/main?name=x.mp4, PUT /api/upload/broll?name=y.mp4
  if (req.method === "PUT" && url.pathname.startsWith("/api/upload/")) {
    const kind = url.pathname.split("/").pop();
    let p = current();
    const name = safeName(url.searchParams.get("name"));
    if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name)) return send(res, 400, { error: "Upload a video file (mp4, mov, m4v, webm, mkv)." });
    if (kind === "main") {
      // A new main video always starts a fresh project. The old original is never overwritten.
      if (!p || fs.readdirSync(p.sourceDir).some((f) => f.startsWith("original.")) || readJSON(p.job, null)) {
        const keepBroll = p && !readJSON(p.job, null) ? brollSources(p) : [];
        p = newProject();
        for (const b of keepBroll) fs.copyFileSync(b.file, path.join(p.brollSrcDir, b.name));
      }
    } else if (!p || readJSON(p.job, null)) {
      p = newProject();
    }
    const dest = kind === "main"
      ? path.join(p.sourceDir, `original${path.extname(name).toLowerCase()}`)
      : path.join(p.brollSrcDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.uploading`;
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    ws.on("finish", () => {
      fs.renameSync(tmp, dest);
      if (kind === "main") {
        fs.chmodSync(dest, 0o444); // the original is read-only from here on
        writeJSON(path.join(p.dir, "upload.json"), { originalName: name, uploadedAt: new Date().toISOString() });
      }
      broadcast("state", state());
      send(res, 200, state());
    });
    ws.on("error", (err) => send(res, 500, { error: err.message }));
    return;
  }

  if (route === "DELETE /api/broll") {
    const p = current();
    if (!p || readJSON(p.job, null)) return send(res, 409, { error: "The edit already started" });
    const f = inside(p.brollSrcDir, safeName(url.searchParams.get("name")));
    if (f && fs.existsSync(f)) fs.rmSync(f);
    broadcast("state", state());
    return send(res, 200, state());
  }

  if (route === "POST /api/edit") {
    const p = current();
    if (!p || !fs.readdirSync(p.sourceDir).some((f) => f.startsWith("original."))) return send(res, 400, { error: "Upload your video first." });
    if (readJSON(p.job, null)?.submittedAt) return send(res, 409, { error: "This edit is already running." });
    const b = await body(req);
    const features = Object.fromEntries(FEATURES.map((f) => [f.key, Boolean(b.features?.[f.key])]));
    if (!brollSources(p).length) features.broll = false;
    const job = {
      submittedAt: new Date().toISOString(),
      format: b.format === "16:9" ? "16:9" : "9:16",
      framing: b.framing === "auto" ? "auto" : "middle",
      features,
      notes: String(b.notes || "").slice(0, 2000),
      originalName: readJSON(path.join(p.dir, "upload.json"), {}).originalName,
    };
    writeJSON(p.status, initialStatus(job));
    writeJSON(p.edit, defaultEdit(job));
    writeJSON(p.job, job);
    broadcast("state", state());
    return send(res, 200, state());
  }

  // Transcript edits: delete or restore words, then recompose.
  if (route === "POST /api/words") {
    const p = current();
    if (!p || !fs.existsSync(p.timeline)) return send(res, 409, { error: "The edit is not ready yet." });
    const b = await body(req);
    const indices = (b.indices || []).filter(Number.isInteger);
    const run = async () => {
      const edit = loadEdit(p);
      for (const i of indices) {
        if (b.action === "restore") delete edit.removed[i];
        else if (!edit.removed[i]) edit.removed[i] = "manual";
      }
      saveEdit(p, edit);
      return compose(p);
    };
    composing = composing.then(run, run);
    try {
      await composing;
      const s = state();
      broadcast("state", s);
      return send(res, 200, s);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (route === "POST /api/export") {
    const p = current();
    if (!p || !fs.existsSync(path.join(p.compDir, "index.html"))) return send(res, 409, { error: "Nothing to export yet." });
    if (exportState.state === "running") return send(res, 409, { error: "Already exporting." });
    const b = await body(req);
    exportState = { state: "running", pct: 0, file: null, error: null };
    broadcast("export", exportState);
    composing
      .then(() => render(p, { quality: b.quality || "standard", onProgress: (pct) => { exportState.pct = pct; broadcast("export", exportState); } }))
      .then((file) => { exportState = { state: "done", pct: 100, file: path.basename(file), error: null }; })
      .catch((err) => { exportState = { state: "error", pct: 0, file: null, error: err.message.split("\n").slice(0, 3).join(" ") }; })
      .finally(() => broadcast("export", exportState) || broadcast("state", state()));
    return send(res, 200, exportState);
  }

  if (route === "POST /api/studio") {
    const p = current();
    if (!p || !fs.existsSync(path.join(p.compDir, "index.html"))) return send(res, 409, { error: "Nothing to preview yet." });
    try {
      const bin = path.join(SKILL_DIR, "node_modules", ".bin", "hyperframes");
      const { stdout, stderr } = await run(bin, ["preview", "--background", "--json"], { cwd: p.compDir, env: { HYPERFRAMES_SKIP_SKILLS: "1" } });
      const m = (stdout + stderr).match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s"]*/);
      return send(res, 200, { url: m ? m[0] : null, output: stdout.slice(-500) });
    } catch (err) {
      return send(res, 500, { error: err.message.split("\n")[0] });
    }
  }

  // Project files: /files/comp/index.html, /files/comp/media/main.mp4, /files/export/x.mp4 ...
  if (req.method === "GET" && url.pathname.startsWith("/files/")) {
    const p = current();
    if (!p) return send(res, 404, { error: "No project" });
    const f = inside(p.dir, url.pathname.slice(7));
    if (!f) return send(res, 403, { error: "Forbidden" });
    // The in-app preview gets the HyperFrames runtime from local node_modules
    // instead of the player fetching it from a CDN. The file on disk is untouched.
    if (f === path.join(p.compDir, "index.html") && url.searchParams.has("preview") && fs.existsSync(f)) {
      const html = fs.readFileSync(f, "utf8").replace("</body>", `  <script src="/vendor/hyperframe.runtime.js"></script>\n  </body>`);
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    return serveFile(req, res, f, { download: url.searchParams.has("download") });
  }

  send(res, 404, { error: "Not found" });
}

// ------------------------------------------------------------------ start

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

async function alreadyRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return (await res.json()).app === "11secondedit";
  } catch {
    return false;
  }
}

async function start(port, attempts = 10) {
  if (await alreadyRunning(port)) {
    const url = `http://localhost:${port}`;
    console.log(`11 Second Edit is already running at ${url}`);
    if (OPEN) openBrowser(url);
    return;
  }
  const server = http.createServer((req, res) =>
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: err.message });
    }),
  );
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempts > 0) return start(port + 1, attempts - 1);
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    writeJSON(path.join(WORK_DIR, "server.json"), { url, pid: process.pid, startedAt: new Date().toISOString() });
    console.log(`11 Second Edit is running at ${url}`);
    if (OPEN) openBrowser(url);
  });
}

start(PORT);
