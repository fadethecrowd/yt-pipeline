import { createHash } from "node:crypto";

/**
 * The single definition of what actually gets spoken.
 *
 * A script carries `hook`, `segments[]` and `cta`. Whether the hook and CTA
 * are ALSO copied inside the segment bodies has varied: the generator folds
 * them in (scriptGenerator writes segments[0] already containing the hook),
 * but a hand-edited script may rewrite the segments and leave the top-level
 * fields orphaned. Voiceover synthesises `segments` only, so an orphaned hook
 * is never spoken — the video simply opens without it — while beat planning
 * weighted its runtime against a character count that included it. Nothing
 * detected the divergence because each path was independently self-consistent.
 *
 * This module is the one place that decides. Both narration generation and
 * visual planning consume `buildSpokenUnits`, so they cannot disagree about
 * what the audio contains.
 */

/**
 * Separator placed between a folded hook (or CTA) and the segment body it
 * joins. A blank line is what the script format already uses between
 * paragraphs, and ElevenLabs reads it as a sentence-level pause rather than
 * running the hook into the first line. It is two characters and it IS
 * submitted to the API, so it is counted in the billed character total.
 */
export const SPOKEN_UNIT_SEPARATOR = "\n\n";

export interface SpokenUnitPart {
  /** Which script field this run of text came from. */
  field: "hook" | "segment" | "cta";
  /** Segment index for `segment` parts. */
  segmentIndex?: number;
  text: string;
  /** Offset of this part within the finished unit. */
  startOffset: number;
  endOffset: number;
}

export interface SpokenUnit {
  index: number;
  /** Exactly the string submitted to ElevenLabs and planned against. */
  text: string;
  parts: SpokenUnitPart[];
  sha256: string;
}

export interface ScriptLike {
  hook?: string | null;
  cta?: string | null;
  segments: { segmentIndex: number; narration: string }[];
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** Whitespace-insensitive containment, so a reflowed copy still counts as folded. */
function alreadyContains(body: string, part: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const b = norm(body), p = norm(part);
  return p.length > 0 && b.includes(p);
}

/**
 * Build the exact strings that will be spoken.
 *
 * Five units are produced from five segments — the hook folds into the first
 * and the CTA into the last — so the number of billed requests is unchanged.
 * A hook or CTA already present in its segment body is NOT folded again;
 * duplicating it would make the voice say it twice.
 */
export function buildSpokenUnits(script: ScriptLike): SpokenUnit[] {
  if (!script.segments || script.segments.length === 0) {
    throw new Error("buildSpokenUnits: script has no segments");
  }
  const segs = [...script.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const hook = (script.hook ?? "").trim();
  const cta = (script.cta ?? "").trim();
  const last = segs.length - 1;

  return segs.map((seg, i) => {
    const parts: SpokenUnitPart[] = [];
    let text = "";
    const push = (field: SpokenUnitPart["field"], t: string, segmentIndex?: number) => {
      if (text.length > 0) text += SPOKEN_UNIT_SEPARATOR;
      const startOffset = text.length;
      text += t;
      parts.push({ field, segmentIndex, text: t, startOffset, endOffset: text.length });
    };

    if (i === 0 && hook && !alreadyContains(seg.narration, hook)) push("hook", hook);
    push("segment", seg.narration, seg.segmentIndex);
    if (i === last && cta && !alreadyContains(seg.narration, cta)) push("cta", cta);

    return { index: i, text, parts, sha256: sha(text) };
  });
}

/** Ordered concatenation of every unit — the whole spoken script, once. */
export function spokenScriptText(units: SpokenUnit[]): string {
  return units.map((u) => u.text).join(SPOKEN_UNIT_SEPARATOR);
}

/** Characters actually submitted to ElevenLabs, which is what gets billed. */
export function spokenCharacterCount(units: SpokenUnit[]): number {
  return units.reduce((a, u) => a + u.text.length, 0);
}
