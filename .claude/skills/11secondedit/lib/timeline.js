// Turns a word-timestamped transcript plus a set of removed words into the
// segments of source video to keep, and maps every kept word to output time.
//
// The one hard rule lives here: a cut point is only ever placed in the gap
// between two words, never inside one. Cuts are expressed as word indices, so
// nothing upstream (Claude included) can ask for a mid-word cut.

const MIN_SEGMENT = 0.06;
// A shot shorter than this flashes on screen and reads as a glitch. A
// silence cut that would leave one is cancelled (the pause stays in).
const MIN_SHOT = 0.6;

export function buildTimeline(words, removed, opts = {}) {
  const duration = opts.duration ?? (words.length ? words[words.length - 1].end : 0);
  const silences = Boolean(opts.silences?.enabled);
  const maxGap = opts.silences?.maxGap ?? 1.0;
  const pad = opts.silences?.pad ?? 0.2;
  const fps = opts.fps ?? 30;
  const isRemoved = (i) => Boolean(removed[i] ?? removed[String(i)]);

  const kept = [];
  for (let i = 0; i < words.length; i++) if (!isRemoved(i)) kept.push(i);
  if (!kept.length) return { segments: [], words: [], cuts: [], duration: 0 };

  // Earliest a segment may start before word k: the end of the word before it.
  const floorBefore = (k) => (k > 0 ? words[k - 1].end : 0);
  // Latest a segment may end after word k: the start of the word after it.
  const ceilAfter = (k) => (k < words.length - 1 ? words[k + 1].start : duration);

  const startFor = (k) => {
    if (k === 0 && !silences) return 0;
    return Math.max(floorBefore(k), words[k].start - pad, 0);
  };
  const endFor = (k) => {
    if (k === words.length - 1 && !silences) return duration;
    return Math.min(ceilAfter(k), words[k].end + pad, duration);
  };

  // softAfter: the split after this segment exists only to drop a pause, so
  // it may be undone. Splits around cut words are never undone.
  const raw = [];
  let segStart = startFor(kept[0]);
  for (let n = 1; n <= kept.length; n++) {
    const prev = kept[n - 1];
    const k = kept[n];
    if (k === undefined) {
      raw.push({ srcStart: segStart, srcEnd: endFor(prev), softAfter: false });
      break;
    }
    const contiguous = k === prev + 1;
    const gap = words[k].start - words[prev].end;
    if (!contiguous || (silences && gap > maxGap)) {
      raw.push({ srcStart: segStart, srcEnd: endFor(prev), softAfter: contiguous });
      segStart = startFor(k);
    }
  }

  // Merge segments that touch or overlap (happens when the gap between two
  // kept words is shorter than the padding), drop slivers.
  let segments = [];
  for (const s of raw) {
    if (s.srcEnd - s.srcStart < MIN_SEGMENT) continue;
    const last = segments[segments.length - 1];
    if (last && s.srcStart <= last.srcEnd + 0.001) {
      last.srcEnd = Math.max(last.srcEnd, s.srcEnd);
      last.softAfter = s.softAfter;
    } else segments.push({ ...s });
  }

  // Undo silence cuts that leave a shot under MIN_SHOT: join it to the
  // neighbour across the pause (the shorter join wins).
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 0; k < segments.length; k++) {
      const s = segments[k];
      if (s.srcEnd - s.srcStart >= MIN_SHOT) continue;
      const prevSoft = k > 0 && segments[k - 1].softAfter;
      const nextSoft = s.softAfter && k < segments.length - 1;
      if (!prevSoft && !nextSoft) continue;
      const gapPrev = prevSoft ? s.srcStart - segments[k - 1].srcEnd : Infinity;
      const gapNext = nextSoft ? segments[k + 1].srcStart - s.srcEnd : Infinity;
      if (gapPrev <= gapNext) {
        segments[k - 1].srcEnd = s.srcEnd;
        segments[k - 1].softAfter = s.softAfter;
        segments.splice(k, 1);
      } else {
        s.srcEnd = segments[k + 1].srcEnd;
        s.softAfter = segments[k + 1].softAfter;
        segments.splice(k + 1, 1);
      }
      changed = true;
      break;
    }
  }

  // Put cut points on the frame grid so the frame after a cut is the right
  // one, not a repeat or a skip. Snapping only moves a boundary further into
  // the gap, never into a word.
  const keptWords = kept.map((i) => words[i]);
  for (const s of segments) {
    const inSeg = keptWords.filter((w) => w.start >= s.srcStart - 1e-6 && w.end <= s.srcEnd + 1e-6);
    const firstStart = inSeg.length ? inSeg[0].start : s.srcEnd;
    const lastEnd = inSeg.length ? inSeg[inSeg.length - 1].end : s.srcStart;
    const up = Math.ceil(s.srcStart * fps - 1e-6) / fps + 0;
    const down = Math.floor(s.srcEnd * fps + 1e-6) / fps;
    if (up <= firstStart) s.srcStart = up;
    if (down >= lastEnd && down > s.srcStart) s.srcEnd = down;
  }
  segments = segments.map(({ srcStart, srcEnd }) => ({ srcStart, srcEnd }));

  // Lay segments out in whole output frames, so every segment starts exactly
  // on a frame of the finished video.
  let frames = 0;
  for (const s of segments) {
    const len = Math.max(1, Math.round((s.srcEnd - s.srcStart) * fps));
    s.outStart = frames / fps;
    s.duration = len / fps;
    frames += len;
  }
  const total = frames / fps;

  // Map each kept word into output time.
  const outWords = [];
  let si = 0;
  for (const i of kept) {
    const w = words[i];
    while (si < segments.length - 1 && w.start >= segments[si].srcEnd) si++;
    const s = segments[si];
    if (!s) continue;
    const start = s.outStart + Math.max(0, Math.max(w.start, s.srcStart) - s.srcStart);
    const end = s.outStart + Math.min(s.duration, Math.min(w.end, s.srcEnd) - s.srcStart);
    if (end <= start) continue;
    outWords.push({ i, text: w.text, start: r(start), end: r(end), seg: si });
  }

  const cuts = segments.slice(1).map((s) => r(s.outStart));
  return {
    duration: r5(total),
    fps,
    segments: segments.map((s) => ({
      srcStart: r5(s.srcStart),
      srcEnd: r5(s.srcEnd),
      outStart: r5(s.outStart),
      duration: r5(s.duration),
    })),
    words: outWords,
    cuts,
  };
}

// Output time span covered by words [from..to] (source indices). If the
// boundary words were cut, snaps inward to the nearest kept word.
export function spanForWords(timeline, from, to) {
  const inRange = timeline.words.filter((w) => w.i >= from && w.i <= to);
  if (!inRange.length) return null;
  return { start: inRange[0].start, end: inRange[inRange.length - 1].end };
}

// Output time of a single word, or of the next kept word if it was cut.
export function timeForWord(timeline, i) {
  const w = timeline.words.find((x) => x.i >= i);
  return w ? w.start : null;
}

const r = (n) => Math.round(n * 1000) / 1000;
const r5 = (n) => Math.round(n * 100000) / 100000;
