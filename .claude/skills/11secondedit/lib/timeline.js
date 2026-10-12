// Turns a word-timestamped transcript plus a set of removed words into the
// segments of source video to keep, and maps every kept word to output time.
//
// The one hard rule lives here: a cut point is only ever placed in the gap
// between two words, never inside one. Cuts are expressed as word indices, so
// nothing upstream (Claude included) can ask for a mid-word cut.

const MIN_SEGMENT = 0.06;

export function buildTimeline(words, removed, opts = {}) {
  const duration = opts.duration ?? (words.length ? words[words.length - 1].end : 0);
  const silences = Boolean(opts.silences?.enabled);
  const maxGap = opts.silences?.maxGap ?? 0.35;
  const pad = opts.silences?.pad ?? 0.08;
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

  const raw = [];
  let segStart = startFor(kept[0]);
  for (let n = 1; n <= kept.length; n++) {
    const prev = kept[n - 1];
    const k = kept[n];
    if (k === undefined) {
      raw.push({ srcStart: segStart, srcEnd: endFor(prev) });
      break;
    }
    const contiguous = k === prev + 1;
    const gap = words[k].start - words[prev].end;
    if (!contiguous || (silences && gap > maxGap)) {
      raw.push({ srcStart: segStart, srcEnd: endFor(prev) });
      segStart = startFor(k);
    }
  }

  // Merge segments that touch or overlap (happens when the gap between two
  // kept words is shorter than the padding), drop slivers.
  const segments = [];
  for (const s of raw) {
    if (s.srcEnd - s.srcStart < MIN_SEGMENT) continue;
    const last = segments[segments.length - 1];
    if (last && s.srcStart <= last.srcEnd + 0.001) last.srcEnd = Math.max(last.srcEnd, s.srcEnd);
    else segments.push({ srcStart: s.srcStart, srcEnd: s.srcEnd });
  }

  let t = 0;
  for (const s of segments) {
    s.outStart = t;
    s.duration = s.srcEnd - s.srcStart;
    t += s.duration;
  }
  const total = t;

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
    duration: r(total),
    segments: segments.map((s) => ({
      srcStart: r(s.srcStart),
      srcEnd: r(s.srcEnd),
      outStart: r(s.outStart),
      duration: r(s.duration),
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
