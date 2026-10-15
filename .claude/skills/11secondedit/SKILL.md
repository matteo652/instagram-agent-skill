---
name: 11secondedit
description: >-
  One-click AI video editor. Opens a local browser app where the user uploads
  raw talking-head footage (plus optional b-roll), picks features and clicks
  Edit Video; Claude then cuts bad takes, fillers and silences, enhances audio,
  grades colour, adds zoom cuts, b-roll, a text hook, a CTA card, word-by-word
  captions, music and sound effects, and hands back an edited 9:16 Reel (or
  16:9) as a HyperFrames composition with a transcript editor and an Export
  button. Use when the user types /11secondedit, or asks to edit a
  talking-head video, make a Reel from raw footage, or cut a video by its
  transcript.
---

# 11 Second Edit

You are the editor. The browser app collects the footage and settings, the
scripts do everything deterministic, and you make the editorial calls: what
is a bad take, which "like" is a filler, where the zooms and b-roll go, what
the hook and CTA say. You never touch pixels or audio yourself.

All commands below run from the project root. If the skill is installed
somewhere else (for example `~/.claude/skills/11secondedit`), use that folder
instead of `.claude/skills/11secondedit`.

`ED` below means `node .claude/skills/11secondedit/edit.js`. Run
`ED` with no arguments for the full command list.

## Rules

1. **Never modify the original video.** It lives read-only in
   `work/<project>/source/`. Every derived file goes elsewhere.
2. **Never cut mid-word.** Cuts are only ever word indices from the
   transcript; `lib/timeline.js` places every cut point in the gap between
   two words. Do not compute timestamps for cuts yourself.
3. **API keys live in `.env`** (project root or the skill folder, see
   `.env.example`). Never print, echo or commit them. Never ask the user to
   paste a key into the chat. Tell them which line to add to `.env`.
4. Deterministic work lives in scripts, never in your head. If you catch
   yourself doing arithmetic on timestamps, there is a command for it.
5. Report every step to the page. Each `ED` command already does it; for
   steps that are pure judgement, call `ED status <step> running "..."` before
   you think and the `apply` command marks it done.

## 1. Start

```bash
test -d .claude/skills/11secondedit/node_modules || npm install --prefix .claude/skills/11secondedit
ffmpeg -version >/dev/null && ffprobe -version >/dev/null || echo "MISSING ffmpeg"
command -v whisperx >/dev/null || echo "MISSING whisperx"
```

FFmpeg is required. If WhisperX is missing, tell the user to run
`pip install whisperx` (then set `WHISPERX_BIN` in `.env` if it is not on
PATH) and carry on, because they can still upload while it installs.

Start the server **in the background** (`run_in_background: true`). It opens
the app in the browser and keeps running:

```bash
node .claude/skills/11secondedit/server.js
```

If a server is already running, it just reopens the browser. Tell the user, in one
line: the app is open, upload your video, pick your settings, click Edit Video.

## 2. Wait for Edit Video

```bash
ED wait
```

It blocks until the click (100 seconds at a time, so it fits the Bash
timeout), then prints the job: format, which features are on, the user's
notes, and the ordered step list. Exit code 3 means still waiting, so run it again.
If you lose track mid-edit (a new session, a crash), `ED wait --resume`
prints the current job with the steps already done marked `x`. Do not ask the user anything while
waiting; the page is the interface.

Read the job. **Skip every step whose feature is off.** The page already
shows those as Off; do not run them.

## 3. Run the steps, in this order

### setup (always)

```bash
ED setup
```

Probes the footage, extracts audio, and writes `review/frames.jpg` (eight
frames from across the recording, times printed by `setup`) plus one contact
sheet per b-roll clip (`review/broll-<id>.jpg`). Look at `frames.jpg` with
the Read tool before any framing or zoom decision, and note where the
subject of the video sits: the food, the product, whatever is on the table.

### framing (always)

The output window slides over the full picture. `x`/`y` run 0 to 1: 0 is
the left/top edge, 0.5 the middle, 1 the right/bottom.

**The job says `framing: "middle"` (the default): keep the middle.** The
frame stays on the middle of the shot for the whole edit. Never move it to a
person because they are talking; the voice already tells the viewer who is
speaking, and the thing between them (usually the food) is what the video
is about. Leave the frame at 0.5, or, if `frames.jpg` shows the subject
sitting a little off-centre, put it on the subject:

```bash
ED apply framing '{"x":0.5,"y":0.5}'
```

**Only with `framing: "auto"`** may you reframe per moment, and even then
prefer the middle. Move off it only when the words are about something
visibly elsewhere in the frame, and come back after:

```bash
ED apply framing '{"x":0.5,"y":0.5,"shots":[{"from":40,"to":52,"x":0.2,"why":"the knife on the left gets picked up"}]}'
```

### enhance (if on)

```bash
ED enhance
```

Auphonic denoise, leveler and -16 LUFS. Without `AUPHONIC_API_KEY` it falls
back to a local FFmpeg chain and says so on the page. Mention that once to
the user at the end, not now.

### transcribe (always)

```bash
ED transcribe
ED transcript
```

`transcript` prints every word as `index:word`, pauses as `‖1.4s‖`, and cut
words as `~word~`. Read all of it before any cut. This is the only view of
the footage you need for the editorial steps.

### badtakes (if on)

```bash
ED status badtakes running "Reading for false starts and retakes"
```

Find every place the speaker restarted a sentence, flubbed a line or
retook it. The pattern is: a run of words, then the same idea again. **Keep
the last complete take** (the speaker restarted because the earlier one was
wrong), unless the last one is visibly worse (trails off, mumbled, stops
mid-sentence). Cut the whole earlier attempt, including its stray "I I" and
"sorry, let me" bits. Also cut asides to camera that are not content ("wait,
is this recording", "ok go").

Do not cut: a deliberate repetition ("Never. Never do this."), a callback,
the loop line at the end that echoes the hook.

```bash
ED apply cuts '{"kind":"badtake","summary":"2 retakes, 1 aside","cuts":[{"from":8,"to":14},{"from":51,"to":63}]}'
```

### fillers (if on)

```bash
ED fillers
```

Lists sounds (um, uh, erm) and context words (like, so, basically,
actually, literally, you know, I mean...) with the words around them. Cut
every sound unless it is clearly meant. For context words, cut only when the
sentence means the same without it: "it was, like, huge" cuts; "I like this
camera" does not; "so" opening a story can stay, "so" restarting a sentence
cuts. When in doubt, keep it; a cut that changes meaning is worse than a
filler.

```bash
ED apply cuts '{"kind":"filler","cuts":[{"from":1},{"from":22},{"from":40,"to":41}]}'
```

### silences (if on)

```bash
ED silences
```

Cuts every pause longer than 1 second, leaving 0.2s of air either side so it
still sounds like a person talking. A cut that would leave a shot under 0.6s
is skipped, because a shot that short flashes and looks like a glitch. For a
punchier, faster speaker use `ED silences 0.7 0.15`; never go tighter than
that. For a calm or conversational video (two people at a table), the
default is right.

### color (if on)

```bash
ED color
```

Measures exposure, contrast, saturation and white balance and sets a
gentle grade. Nothing to decide.

### prepare (always, after the cuts, color and enhance; before zooms and b-roll)

```bash
ED prepare
```

Encodes only the footage the edit uses (every kept stretch plus 2 seconds
either side), full frame, graded, with the enhanced voice, every frame a
keyframe so cuts land on the exact frame. Run it after the cut steps so it
encodes as little as possible. Rerun it if you change colour or audio.
Framing, zooms and further cuts need only `ED compose`; if a restored word
falls outside the encoded footage, `compose` re-encodes by itself.

### zooms (if on)

Read the transcript again (`ED transcript`, cuts now shown) next to
`frames.jpg`. Zooms are how the edit shows what is being talked about, so
put them **at the moments the words are about the subject in the middle**:
the dish being named, an ingredient, a reaction to the taste, the reveal,
the number that matters. Push in on the subject, not on a face.

Roughly one every 4 to 8 seconds of finished edit, never two in a row, never
on the first line (the hook already does that job). Ranges are word
indices; the script snaps each zoom to the nearest cut so it reads as a jump
cut.

```bash
ED apply zooms '{"zooms":[{"from":16,"to":21,"scale":1.25,"why":"names the dish"},{"from":30,"to":36,"scale":1.2,"originY":0.6,"why":"first bite"}]}'
```

`scale` 1.1 to 1.35. `originX`/`originY` (default 0.5, 0.5) are the point of
the visible frame the zoom pushes in on. Leave them on the middle unless
`frames.jpg` shows the subject sits higher or lower (a plate low on the
table: `"originY":0.65`). Never aim a zoom at a person who is speaking.

### broll (if on)

Look at each `review/broll-<id>.jpg` contact sheet with the Read tool so you
know what is in every clip. Place each clip over the words it illustrates,
the literal noun or action being talked about. Never over the hook (first
sentence) or the last line, and never over the moments you zoomed in on
the subject: those are the shots the video is for. Each placement 1.5 to 4
seconds of speech. A clip
can be used once; if there is nothing it fits, leave it out. `mediaStart`
picks where in the clip to start, in seconds.

```bash
ED apply broll '{"broll":[{"clip":"city-shot","from":23,"to":26,"mediaStart":0}]}'
```

### hook (if on)

Write the on-screen hook: 4 to 9 words, the reason to keep watching, in
the speaker's own words where possible. It is read while they say the first
line, so it should add to the spoken line, not repeat it word for word. No
emojis, no "Wait for it", no clickbait the video does not pay off. If the
user's notes include a hook, use it.

```bash
ED apply hook '{"text":"The edit that doubled my views"}'
```

### cta (if on)

One ask, matched to the content. If the notes name one, use it exactly (a
comment keyword, a link in bio, follow). Otherwise "Follow for more" plus a
subtext that says what more is. Keep `text` to 5 words or fewer.

```bash
ED apply cta '{"text":"Comment GUIDE","subtext":"I will DM you the free checklist"}'
```

### captions (if on)

```bash
ED captions
```

Word-by-word, active word in yellow. Captions sit low in the frame by
default. **Never let them cover the subject.** If `frames.jpg` (and your
zooms) put the food or product in the lower part of the frame, move the
captions above it, below the hook:

```bash
ED apply captions '{"y":0.36}'
```

`y` is the height of the caption line, 0.1 (top) to 0.9 (bottom). Pass a hex colour to change the
highlight (`ED captions "#7CFFB2"`), or
`ED apply captions '{"uppercase":false}'` for sentence case.

### music (if on)

Write a one-line prompt from the tone of the transcript and the user's notes:
genre, tempo, mood, "no vocals". Music sits under the voice at 12% volume.

```bash
ED music "warm lo-fi hip hop, 85 bpm, relaxed, soft keys, no vocals"
```

Without `ELEVENLABS_API_KEY` this fails. Then run
`ED status music skipped "Add ELEVENLABS_API_KEY to .env"` and move on.

### sfx (if on)

Place a few hits on edit events, not on every cut. 2 to 6 in a 30 to 60s
Reel. Kinds: `whoosh` (b-roll in, transitions), `pop` (hook, text appearing),
`ding` (CTA, a number landing), `click`, `riser` (before a reveal), `thud`
(a hard statement). Anchor with `word` (a word index) or `at`: `"hook"`,
`"cta"`, `"broll:0"`, `"zoom:1"`.

```bash
ED apply sfx '{"sfx":[{"kind":"pop","at":"hook"},{"kind":"whoosh","at":"broll:0"},{"kind":"ding","at":"cta","volume":0.4}]}'
ED sfx
```

Uses ElevenLabs sound generation when the key is set, otherwise built-in
synthesized effects.

### compose (always, last)

```bash
ED compose
```

Writes `comp/index.html`, the whole edit as one HyperFrames composition,
and `timeline.json`. The page switches to the editor: preview, timeline,
and a transcript where deleting words cuts the video. Export renders the MP4
with HyperFrames (headless Chrome + FFmpeg).

## 4. Hand over

Tell the user, briefly: the edit is ready in the browser, how long it is
against the raw footage, what was cut (takes, fillers, seconds of silence),
the hook and CTA you wrote, and anything that fell back (no Auphonic key, no
ElevenLabs key). They can delete words in the transcript to trim, then
Export. Do not render unless they ask; the Export button does it.

If they ask for changes in chat, make them with the same commands and run
`ED compose` again. The page reloads by itself. For example: a different hook
(`ED apply hook`), restore a cut (`ED apply uncut '{"cuts":[{"from":8,"to":14}]}'`),
remove zooms (`ED apply zooms '[]'`), move the frame (`ED apply framing`),
switch format (edit `format` in `edit.json`, then `ED prepare`, re-apply
b-roll, `ED compose`).

`ED render [draft|standard|high]` renders from the terminal; the file lands
in `work/<project>/export/`.

## If something fails

The failing command marks its step red on the page with the error. Read the
error, fix what you can (missing tool, wrong index, bad JSON) and rerun that
command; the page goes back to running. If the fix needs the user (installing
WhisperX, adding a key), tell them exactly what to do in one or two lines, mark
the step skipped if the edit can go on without it, and finish the rest.

## Files

```
.claude/skills/11secondedit/
  SKILL.md         this file
  server.js        local app server (uploads, progress, transcript edits, export)
  edit.js          the commands above
  app/             the browser app
  lib/core.js      paths, .env, status
  lib/timeline.js  words + cuts -> segments (the never-cut-mid-word logic)
  lib/media.js     FFmpeg, WhisperX, Auphonic, ElevenLabs
  lib/compose.js   edit.json -> HyperFrames index.html
  lib/render.js    HyperFrames render
  work/<project>/  source/ (read-only original + b-roll), transcript.json,
                   edit.json (every decision), comp/ (the composition), export/
```
