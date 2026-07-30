import type { Alignment } from "./elevenlabs";

/**
 * Caption construction.
 *
 * Every cue time here derives from the character-level alignment ElevenLabs
 * returned for the exact audio bytes that get rendered, offset by that
 * segment's exact decoded position in the narration track. There is no
 * words-per-minute estimate and no uniform division of a segment across its
 * cues, so cumulative drift is structurally impossible rather than merely
 * tuned away.
 *
 * The previous implementation split each segment into fixed 10-word chunks and
 * gave every chunk `segmentDuration / chunkCount` seconds. Because ~24% of a
 * typical segment is pause, cues drifted monotonically within each segment —
 * measured at up to 1.96 s of lead by the end of a 58 s segment — then snapped
 * back at the segment boundary.
 */

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

// Caption shape.
//
// These used to be sized so a line survived the centre 9:16 crop that the
// Shorts path took out of the burned long-form video — a 440 px column at
// FontSize 20, i.e. ~2% of frame height. That made long-form captions barely
// legible in order to serve the Short. The Shorts path now crops a caption-free
// master and burns its own captions, so long-form can be sized for long-form.
export const SUBTITLE_MAX_CHARS_PER_LINE = 42;
const MAX_CHARS_PER_CUE = 84;
const MAX_CUE_SECONDS = 5.0;
const MIN_CUE_SECONDS = 0.6;
/** Hold a cue slightly past the last word so it does not flash off mid-breath. */
const CUE_TAIL_HOLD = 0.15;

/**
 * Rebuild words (with real times) from a character alignment.
 *
 * A word's start is its first non-space character's start time; its end is its
 * last character's end time.
 */
export function wordsFromAlignment(a: Alignment, offset = 0): Word[] {
  const words: Word[] = [];
  let buf = "";
  let start = 0;
  let end = 0;
  let open = false;

  const flush = () => {
    if (open && buf.trim().length > 0) {
      words.push({ text: buf, start: start + offset, end: end + offset });
    }
    buf = "";
    open = false;
  };

  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (!open) {
      start = a.startTimes[i];
      open = true;
    }
    buf += ch;
    end = a.endTimes[i];
  }
  flush();
  return words;
}

/** True when a word ends a sentence — a natural, readable cue boundary. */
function endsSentence(w: string): boolean {
  return /[.!?…](["')\]]+)?$/.test(w);
}

function endsClause(w: string): boolean {
  return /[,;:—–](["')\]]+)?$/.test(w);
}

/**
 * Group timed words into cues, breaking on sentence boundaries first, then
 * clauses, then length/duration limits. Cue times are the real word times.
 */
export function cuesFromWords(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];

  const emit = () => {
    if (cur.length === 0) return;
    const text = cur.map((w) => w.text).join(" ");
    const start = cur[0].start;
    let end = cur[cur.length - 1].end + CUE_TAIL_HOLD;
    if (end - start < MIN_CUE_SECONDS) end = start + MIN_CUE_SECONDS;
    cues.push({ start, end, text });
    cur = [];
  };

  for (const w of words) {
    const projected = cur.map((x) => x.text).join(" ") + (cur.length ? " " : "") + w.text;
    const projectedSpan = cur.length ? w.end - cur[0].start : 0;

    if (cur.length > 0 && (projected.length > MAX_CHARS_PER_CUE || projectedSpan > MAX_CUE_SECONDS)) {
      emit();
    }
    cur.push(w);

    if (endsSentence(w.text)) {
      emit();
    } else if (endsClause(w.text) && cur.map((x) => x.text).join(" ").length >= MAX_CHARS_PER_CUE * 0.6) {
      emit();
    }
  }
  emit();

  // A cue must never outlive the next one's start.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  return cues.filter((c) => c.end > c.start);
}

/**
 * Wrap a cue so no rendered line exceeds `maxChars`, splitting at the word
 * boundary nearest the midpoint and recursing while a half still overflows.
 */
export function wrapCue(text: string, maxChars = SUBTITLE_MAX_CHARS_PER_LINE): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return clean;

  const words = clean.split(" ");
  if (words.length < 2) return clean; // single overlong token — unsplittable

  const mid = clean.length / 2;
  let bestSplit = 1;
  let bestDelta = Infinity;
  let running = 0;
  for (let i = 0; i < words.length - 1; i++) {
    running += words[i].length + (i > 0 ? 1 : 0);
    const delta = Math.abs(running - mid);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestSplit = i + 1;
    }
  }
  const a = words.slice(0, bestSplit).join(" ");
  const b = words.slice(bestSplit).join(" ");
  return `${a.length > maxChars ? wrapCue(a, maxChars) : a}\n${
    b.length > maxChars ? wrapCue(b, maxChars) : b
  }`;
}

export function formatASSTime(totalSeconds: number): string {
  const t = Math.max(0, totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t % 1) * 100);
  // Guard the 99.5→100 centisecond rounding case.
  if (cs === 100) return formatASSTime(Math.floor(t) + 1);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export interface AssStyle {
  playResX: number;
  playResY: number;
  fontSize: number;
  marginL: number;
  marginR: number;
  marginV: number;
  bold: boolean;
  outline: number;
}

/**
 * Long-form: ~4.4% of frame height, in a 1120 px column, 90 px off the bottom.
 * Comfortably legible at 1080p and on a phone, and clear of the lower-third
 * where most stock footage puts its subject.
 */
export const LONGFORM_STYLE: AssStyle = {
  playResX: 1920, playResY: 1080, fontSize: 48,
  marginL: 400, marginR: 400, marginV: 90, bold: true, outline: 3,
};

export const SHORTS_STYLE: AssStyle = {
  playResX: 1080, playResY: 1920, fontSize: 72,
  marginL: 60, marginR: 60, marginV: 300, bold: true, outline: 4,
};

export function renderASS(cues: Cue[], style: AssStyle): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${style.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outline},1,2,${style.marginL},${style.marginR},${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const lines = cues
    .filter((c) => c.end > 0)
    .map((c) => {
      const wrapped = wrapCue(c.text).replace(/\n/g, "\\N");
      return `Dialogue: 0,${formatASSTime(Math.max(0, c.start))},${formatASSTime(c.end)},Default,,0,0,0,,${wrapped}`;
    });

  return `${header}\n${lines.join("\n")}\n`;
}

export interface BuiltCaptions {
  ass: string;
  cues: Cue[];
  words: Word[];
  firstCueStart: number;
  lastCueEnd: number;
}

/**
 * Build long-form captions.
 *
 * @param alignments  per-segment character alignments (segment-local times)
 * @param offsets     exact decoded start of each segment in the narration track
 * @param narrationStart  where narration begins on the video timeline
 *                        (i.e. the title-card duration) — applied exactly once
 */
export function buildLongformCaptions(
  alignments: Alignment[],
  offsets: number[],
  narrationStart: number,
  style: AssStyle = LONGFORM_STYLE,
): BuiltCaptions {
  const words: Word[] = [];
  for (let i = 0; i < alignments.length; i++) {
    words.push(...wordsFromAlignment(alignments[i], offsets[i] + narrationStart));
  }
  const cues = cuesFromWords(words);
  return {
    ass: renderASS(cues, style),
    cues,
    words,
    firstCueStart: cues[0]?.start ?? 0,
    lastCueEnd: cues[cues.length - 1]?.end ?? 0,
  };
}

/**
 * Build Shorts captions for a window [windowStart, windowEnd) of the narration
 * timeline, re-based so the window starts at `renderOffset` on the Short's own
 * timeline. Used so the hook clip's duration is applied exactly once.
 */
export function buildShortsCaptions(
  words: Word[],
  windowStart: number,
  windowEnd: number,
  renderOffset: number,
  style: AssStyle = SHORTS_STYLE,
): BuiltCaptions {
  const inWindow = words
    .filter((w) => w.end > windowStart && w.start < windowEnd)
    .map((w) => ({
      text: w.text,
      start: w.start - windowStart + renderOffset,
      end: w.end - windowStart + renderOffset,
    }));
  const cues = cuesFromWords(inWindow);
  return {
    ass: renderASS(cues, style),
    cues,
    words: inWindow,
    firstCueStart: cues[0]?.start ?? 0,
    lastCueEnd: cues[cues.length - 1]?.end ?? 0,
  };
}
