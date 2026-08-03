import { createHash } from "node:crypto";
import { BEAT_TARGET_S, BEAT_MIN_S, BEAT_MAX_S } from "./visualBeats";
import type { SpokenUnit } from "./spokenUnits";

/**
 * Beats that cover the narration exhaustively.
 *
 * `planPreliminaryBeats` gives each beat ONE representative sentence, sampled
 * as `sentences[floor(b * sentences.length / count)]`. That is deliberate and
 * correct for feasibility scoring — a beat is scored against a sentence that
 * typifies it. It is wrong as a description of what plays: in the data-centre
 * script it left 47% of the spoken characters inside no beat at all, so a
 * human review showed a clip beside a sentence that was not the sentence the
 * viewer would hear under it.
 *
 * These beats instead PARTITION each spoken unit: contiguous, gap-free,
 * non-overlapping ranges whose concatenation reproduces the unit byte for
 * byte. The sampled sentence is kept alongside as scoring metadata so the
 * existing ranking behaviour is unaffected, but it is clearly not the beat's
 * narration.
 */

export interface ExhaustiveBeat {
  beat: number;
  unitIndex: number;
  /** Character range within the spoken unit. */
  startOffset: number;
  endOffset: number;
  /** The complete text spoken during this beat. */
  narration: string;
  narrationSha256: string;
  durationS: number;
  /** How this beat's end boundary was chosen. */
  boundary: "unit-end" | "sentence" | "clause" | "word";
  /** Scoring proxy only — NEVER the beat's narration. */
  representativeSentence: string;
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** Split into sentences, keeping every character (trailing space included). */
export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[.!?]["')\]]*\s+|\n\n/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    out.push({ text: text.slice(last, end), start: last, end });
    last = end;
  }
  if (last < text.length) out.push({ text: text.slice(last), start: last, end: text.length });
  return out;
}

/**
 * Deterministic split point inside an over-long sentence.
 *
 * Prefers a clause boundary (comma, semicolon, colon, dash) nearest the
 * target, then a word boundary, then the exact target. Never splits inside a
 * word unless the run contains no whitespace at all.
 */
function splitInside(text: string, target: number): { at: number; kind: "clause" | "word" } {
  const clause = /[,;:]\s+|\s+[—–-]\s+/g;
  let best = -1, m: RegExpExecArray | null;
  while ((m = clause.exec(text)) !== null) {
    const at = m.index + m[0].length;
    if (at <= 0 || at >= text.length) continue;
    if (best === -1 || Math.abs(at - target) < Math.abs(best - target)) best = at;
  }
  if (best !== -1) return { at: best, kind: "clause" };

  const ws = /\s+/g;
  best = -1;
  while ((m = ws.exec(text)) !== null) {
    const at = m.index + m[0].length;
    if (at <= 0 || at >= text.length) continue;
    if (best === -1 || Math.abs(at - target) < Math.abs(best - target)) best = at;
  }
  return best !== -1 ? { at: best, kind: "word" } : { at: target, kind: "word" };
}

/** Beat count for one unit, using the same rules as the preliminary planner. */
export function beatCountFor(shareS: number): number {
  let count = Math.max(1, Math.round(shareS / BEAT_TARGET_S));
  count = Math.max(count, Math.ceil(shareS / BEAT_MAX_S));
  count = Math.min(count, Math.max(1, Math.floor(shareS / BEAT_MIN_S)));
  return Math.max(1, count);
}

/**
 * Partition every spoken unit into beats.
 *
 * Runtime is shared between units by character weight, then each unit's share
 * is divided into `beatCountFor` beats. Boundaries land on sentence ends
 * wherever possible; a sentence too long to fit a single beat is split at the
 * nearest clause, then word, boundary. Beat duration is proportional to the
 * characters the beat actually contains, so a short beat is short on screen.
 */
export function planExhaustiveBeats(
  units: SpokenUnit[],
  plannedVisualDurationS: number,
): ExhaustiveBeat[] {
  if (units.length === 0 || plannedVisualDurationS <= 0) return [];

  const weights = units.map((u) => Math.max(1, u.text.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const beats: ExhaustiveBeat[] = [];
  let clock = 0;

  units.forEach((unit, i) => {
    const share = i === units.length - 1
      ? plannedVisualDurationS - clock
      : (weights[i]! / totalWeight) * plannedVisualDurationS;
    clock += share;
    if (share <= 0) return;

    const count = beatCountFor(share);
    const text = unit.text;
    const sentences = splitSentences(text);
    // Seconds per character within this unit, so beat duration tracks the text
    // it actually holds rather than being uniform.
    const perChar = share / text.length;
    const targetChars = text.length / count;

    let cursor = 0, si = 0;
    for (let b = 0; b < count; b++) {
      const remainingBeats = count - b;
      let end: number;
      let boundary: ExhaustiveBeat["boundary"];

      if (remainingBeats === 1) {
        end = text.length;
        boundary = "unit-end";
      } else {
        // Take whole sentences until adding the next would overshoot the
        // target by more than leaving it out undershoots.
        const want = cursor + targetChars;
        let take = cursor;
        while (si < sentences.length && sentences[si]!.end <= want) {
          take = sentences[si]!.end;
          si += 1;
        }
        if (si < sentences.length && take < want) {
          const over = sentences[si]!.end - want;
          const under = want - take;
          if (take === cursor || over < under) {
            take = sentences[si]!.end;
            si += 1;
          }
        }
        boundary = "sentence";

        // Leave at least one character for every beat still to come.
        const maxEnd = text.length - (remainingBeats - 1);
        if (take <= cursor || take > maxEnd) {
          const t = Math.min(Math.max(Math.round(want), cursor + 1), maxEnd);
          const cut = splitInside(text.slice(cursor), t - cursor);
          take = cursor + cut.at;
          boundary = cut.kind;
          while (si < sentences.length && sentences[si]!.end <= take) si += 1;
        }
        // A beat longer than the hard cap is split inside its own text.
        if ((take - cursor) * perChar > BEAT_MAX_S) {
          const cut = splitInside(text.slice(cursor), Math.round(BEAT_MAX_S / perChar));
          take = cursor + cut.at;
          boundary = cut.kind;
          while (si < sentences.length && sentences[si]!.end <= take) si += 1;
        }
        end = take;
      }

      const narration = text.slice(cursor, end);
      const inRange = sentences.filter((s) => s.start >= cursor && s.end <= end);
      beats.push({
        beat: beats.length + 1,
        unitIndex: unit.index,
        startOffset: cursor,
        endOffset: end,
        narration,
        narrationSha256: sha(narration),
        durationS: +(narration.length * perChar).toFixed(3),
        boundary,
        representativeSentence: (inRange[0]?.text ?? narration).trim(),
      });
      cursor = end;
    }
  });

  return beats;
}

/** Fail-closed proof that the beats reproduce the units exactly. */
export function verifyExhaustive(units: SpokenUnit[], beats: ExhaustiveBeat[]): {
  ok: boolean; problems: string[];
} {
  const problems: string[] = [];
  for (const unit of units) {
    const mine = beats.filter((b) => b.unitIndex === unit.index);
    if (mine.length === 0) { problems.push(`unit ${unit.index} has no beats`); continue; }
    let cursor = 0;
    for (const b of mine) {
      if (b.startOffset !== cursor) {
        problems.push(`unit ${unit.index} beat ${b.beat}: starts at ${b.startOffset}, expected ${cursor}`);
      }
      if (b.endOffset <= b.startOffset) problems.push(`unit ${unit.index} beat ${b.beat}: empty range`);
      if (b.narration !== unit.text.slice(b.startOffset, b.endOffset)) {
        problems.push(`unit ${unit.index} beat ${b.beat}: stored text does not match its range`);
      }
      if (b.narrationSha256 !== sha(b.narration)) {
        problems.push(`unit ${unit.index} beat ${b.beat}: narration hash mismatch`);
      }
      cursor = b.endOffset;
    }
    if (cursor !== unit.text.length) {
      problems.push(`unit ${unit.index}: beats cover ${cursor} of ${unit.text.length} chars`);
    }
    if (mine.map((b) => b.narration).join("") !== unit.text) {
      problems.push(`unit ${unit.index}: concatenation does not reproduce the unit`);
    }
  }
  const ordered = beats.every((b, i) => i === 0 || b.beat > beats[i - 1]!.beat);
  if (!ordered) problems.push("beats are not in ascending order");
  return { ok: problems.length === 0, problems };
}
