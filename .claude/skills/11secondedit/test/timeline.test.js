import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, spanForWords } from "../lib/timeline.js";
import { captionChunks } from "../lib/compose.js";

// "so um today I want to show you" with a long pause before "today"
const words = [
  { text: "So", start: 0.5, end: 0.7 },
  { text: "um", start: 0.8, end: 1.1 },
  { text: "today", start: 2.6, end: 2.9 },
  { text: "I", start: 2.95, end: 3.0 },
  { text: "want", start: 3.02, end: 3.2 },
  { text: "to", start: 3.2, end: 3.3 },
  { text: "show", start: 3.35, end: 3.6 },
  { text: "you.", start: 3.6, end: 3.8 },
];

const insideAnyWord = (t) => words.some((w) => t > w.start + 1e-9 && t < w.end - 1e-9);

test("no cuts, no silence removal keeps the whole clip", () => {
  const tl = buildTimeline(words, {}, { duration: 4.5 });
  assert.equal(tl.segments.length, 1);
  assert.deepEqual([tl.segments[0].srcStart, tl.segments[0].srcEnd], [0, 4.5]);
  assert.equal(tl.duration, 4.5);
});

test("cut boundaries never land inside a word", () => {
  const tl = buildTimeline(words, { 1: "filler", 4: "manual" }, { duration: 4.5, silences: { enabled: true } });
  for (const s of tl.segments) {
    assert.ok(!insideAnyWord(s.srcStart), `start ${s.srcStart} is mid-word`);
    assert.ok(!insideAnyWord(s.srcEnd), `end ${s.srcEnd} is mid-word`);
  }
  // removed words are not in the output
  assert.ok(!tl.words.some((w) => w.i === 1 || w.i === 4));
});

test("silence removal tightens the long pause", () => {
  const loose = buildTimeline(words, {}, { duration: 4.5 });
  const tight = buildTimeline(words, {}, { duration: 4.5, silences: { enabled: true, maxGap: 0.35, pad: 0.08 } });
  assert.ok(tight.duration < loose.duration - 1.5, `${tight.duration} vs ${loose.duration}`);
});

test("output word times are monotonic and inside the edit", () => {
  const tl = buildTimeline(words, { 1: "filler" }, { duration: 4.5, silences: { enabled: true } });
  for (let k = 1; k < tl.words.length; k++) assert.ok(tl.words[k].start >= tl.words[k - 1].end - 1e-6);
  assert.ok(tl.words.at(-1).end <= tl.duration + 1e-6);
});

test("cutting everything gives an empty timeline", () => {
  const all = Object.fromEntries(words.map((_, i) => [i, "manual"]));
  assert.equal(buildTimeline(words, all, { duration: 4.5 }).segments.length, 0);
});

test("spans snap inward past cut words", () => {
  const tl = buildTimeline(words, { 2: "manual" }, { duration: 4.5 });
  const span = spanForWords(tl, 2, 4);
  const want = tl.words.find((w) => w.i === 3).start;
  assert.equal(span.start, want);
});

test("captions chunk at 3 words and at sentence ends", () => {
  const tl = buildTimeline(words, {}, { duration: 4.5 });
  const chunks = captionChunks(tl.words);
  assert.ok(chunks.every((c) => c.words.length <= 3));
  assert.ok(chunks.at(-1).words.at(-1).text === "you.");
});

test("silence cuts that would leave a sub-0.6s shot are undone", () => {
  // "Yes." alone between two long pauses would be a 0.3s flash
  const ws = [
    { text: "Okay", start: 0.0, end: 0.4 },
    { text: "so", start: 0.45, end: 0.6 },
    { text: "Yes.", start: 2.2, end: 2.4 },
    { text: "Then", start: 4.0, end: 4.3 },
    { text: "we", start: 4.35, end: 4.5 },
    { text: "eat.", start: 4.55, end: 5.0 },
  ];
  const tl = buildTimeline(ws, {}, { duration: 5.2, silences: { enabled: true } });
  assert.ok(tl.segments.every((s) => s.duration >= 0.6 - 1e-6), JSON.stringify(tl.segments));
  assert.ok(tl.words.some((w) => w.text === "Yes."));
});

test("default silence trimming only cuts pauses over 1s and leaves 0.2s breaths", () => {
  const tl = buildTimeline(words, {}, { duration: 4.5, silences: { enabled: true } });
  // the 1.5s pause before "today" is cut, leaving roughly 0.4s of air
  const so = tl.words.find((w) => w.i === 1);
  const today = tl.words.find((w) => w.i === 2);
  const air = today.start - so.end;
  assert.ok(air > 0.3 && air < 0.5, `air ${air}`);
});

test("cut points sit on the 30fps frame grid", () => {
  const tl = buildTimeline(words, { 1: "filler" }, { duration: 4.5, silences: { enabled: true } });
  for (const s of tl.segments) {
    for (const t of [s.srcStart, s.srcEnd]) {
      const f = t * 30;
      assert.ok(Math.abs(f - Math.round(f)) < 0.02, `${t} off grid`);
    }
  }
});
