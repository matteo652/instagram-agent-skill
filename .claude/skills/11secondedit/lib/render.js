// Renders comp/index.html to export/<name>.mp4 with HyperFrames (headless
// Chrome + FFmpeg). Reports percent through onProgress.
import fs from "node:fs";
import path from "node:path";
import { run, SKILL_DIR } from "./core.js";

export async function render(p, { quality = "standard", onProgress = () => {} } = {}) {
  const bin = path.join(SKILL_DIR, "node_modules", ".bin", process.platform === "win32" ? "hyperframes.cmd" : "hyperframes");
  if (!fs.existsSync(bin)) throw new Error(`HyperFrames is not installed. Run: npm install --prefix "${SKILL_DIR}"`);
  fs.mkdirSync(p.exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const out = path.join(p.exportDir, `edit-${stamp}.mp4`);
  let last = -1;
  await run(bin, ["render", "-o", out, "-q", quality, "-f", "30"], {
    cwd: p.compDir,
    env: { HYPERFRAMES_SKIP_SKILLS: "1", NO_COLOR: "1" },
    onLine: (line) => {
      const m = line.match(/@hf-progress (\{.*\})/);
      if (!m) return;
      try {
        const ev = JSON.parse(m[1]);
        const pct = Math.round(ev.pct ?? 0);
        if (pct !== last) {
          last = pct;
          onProgress(pct, ev.code);
        }
      } catch {}
    },
  });
  if (!fs.existsSync(out)) throw new Error("HyperFrames finished without writing the MP4");
  onProgress(100, "done");
  return out;
}
