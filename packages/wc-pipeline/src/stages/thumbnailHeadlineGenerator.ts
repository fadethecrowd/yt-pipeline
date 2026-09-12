import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  prisma, env, createMessage, checkMetadataClaim, performedEvidence,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, StageResult } from "@yt-pipeline/pipeline-core";

// ── Schema ───────────────────────────────────────────────────────────────

const responseSchema = z.object({
  thumbnailHeadline: z.string().min(1),
  thumbnailSubtext: z.string().optional().nullable(),
});

// ── Sanitizers (identical shape to AI Doom — both channels enforce the
//    same output-format rules) ────────────────────────────────────────────

// Awkward verb phrases that read poorly on thumbnails → simpler replacements.
// Applied after uppercasing, before word-count cap.
const HEADLINE_REWRITES: Array<[RegExp, string]> = [
  [/\bSHIPS STANDARD\b/, "STANDARD"],
  [/\bSHIPS INCLUDED\b/, "INCLUDED"],
  [/\bCOMES STANDARD\b/, "STANDARD"],
  [/\bCOMES INCLUDED\b/, "INCLUDED"],
  [/\bNOW SHIPS WITH\b/, "INCLUDES"],
  [/\bSHIPS WITH\b/, "INCLUDES"],
  [/\bCOMES WITH\b/, "INCLUDES"],
];

function sanitizeHeadline(raw: string): string | null {
  let cleaned = raw
    .replace(/["'""]/g, "")
    .replace(/[,—–\-:;.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  // Rewrite awkward phrasing before word-count cap
  for (const [pattern, replacement] of HEADLINE_REWRITES) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  const words = cleaned.split(" ").filter((w) => w.length > 0);
  if (words.length < 2) return null;
  return words.slice(0, 5).join(" ");
}

function sanitizeSubtext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/["'""]/g, "")
    .replace(/[,—–\-:;.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  const words = cleaned.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) return null;
  return words.slice(0, 3).join(" ");
}

// ── Prompt ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You write YouTube thumbnail text for Wet Circuit — a marine electronics
channel covering fishfinders, chartplotters, sonar/livescope, trolling
motors, batteries, wiring, power systems, and real-world boating tech.

You produce SHORT, URGENT, HIGH-CTR text — never full sentences.
Prefer PHYSICAL, MECHANICAL, CONSEQUENTIAL framing. Readers should feel a
part, a system, or a component doing something visceral (breaking, failing,
leaking, melting). Sharpen the script's claim as hard as you like; never
invent one it does not make.

Use this four-step process internally:

THE SCRIPT IS YOUR ONLY EVIDENCE. The headline advertises THAT script, so it
may not assert anything the script declines to. Three hard prohibitions,
which override every preference below:
  (a) NO "TESTED", "PROVEN", "WE TESTED" or "HANDS ON" unless the script
      describes testing ALREADY DONE. A script that PROMISES a comparison
      ("that video is coming", "subscribe and you'll see it") is proof no
      test happened. Never imply a count was verified either — no
      "ALL THREE TESTED".
  (b) NO SINGLE WINNER if the script refuses to name one. If it says "none
      of them are bad", "neither is better" or "it depends", then
      "X KILLS Y", "X BEATS Y", "BEST X" and "WRONG X" are all forbidden.
      Point at the DECISION instead: "PICK BY ECOSYSTEM", "DEPTH DECIDES".
  (c) NO DEATH OR FATALITY unless the script says someone could die. Safety
      topics are not licence for "KILLS YOU" — use the real consequence the
      script names ("INVISIBLE TO SHIPS", "NO ONE SEES YOU").
A headline that breaks one of these is rejected and regenerated, so the
constraint costs you nothing to respect and a retry to ignore.

STEP 1 — Identify the single most surprising or unusual action in the
topic. Look especially for:
- A component failing (battery, wire, seal, transducer, pump)
- One technology beating or killing another — ONLY when the script
  actually takes that side (lithium vs AGM, sidescan vs chirp)
- Something installed wrong and breaking in the field
- A cheap part letting water in / melting / shorting

STEP 2 — Use a strong PHYSICAL/MECHANICAL action verb for that action.
Preferred verbs (use when plausible):
  FAILS, BREAKS, KILLS, MELTS, LEAKS, CRACKS, BURNS, SHORTS,
  DRAINS, OVERHEATS, CORRODES, FLOODS, SNAPS, RUSTS, SEIZES
Other strong verbs that work:
  KILLS, BEATS, BURNS OUT, DIES, FRIES, GIVES UP, SINKS
AVOID weak/abstract verbs: KNOWS, HELPS, IMPROVES, ENABLES, SUPPORTS,
  PROVIDES, OFFERS, ALLOWS.

STEP 3 — Structure as three logical parts:
  SUBJECT — the failing/winning component (e.g. BATTERY, CHEAP PUMP,
            LITHIUM, THIS WIRE, BAD SEAL, MEGA LIVE)
  ACTION  — the strong physical verb
  OBJECT  — optional, what is affected (e.g. FIRST, AGM, EVERYTHING,
            YOUR RIG, AT 50 FEET)
Output them joined by spaces. Target-shape examples:
  BATTERY FAILS FIRST
  CHEAP PUMP BREAKS
  THIS WIRE MELTS
  BAD SEAL LEAKS
  TRANSDUCER DIES AT 30 FEET
  LITHIUM KILLS AGM            (ONLY if the script argues for lithium)
  MEGA LIVE BEATS LIVESCOPE    (ONLY if the script picks MEGA Live)
When the script compares options without choosing, name the deciding
factor rather than a victor:
  ECOSYSTEM DECIDES
  YOUR HULL PICKS ONE
  DEPTH CHANGES THE ANSWER

STEP 4 — Generate 5 candidate headlines internally, score each on
physical impact, consequential weight, and curiosity gap, then return
ONLY the highest-scoring one.

Final output constraints (apply after scoring):
- 2 to 5 words total
- ALL CAPS
- No punctuation, no commas, no quotes, no em-dashes, no periods
- No filler phrases ("here's why", "watch this first", "you won't believe")
- NEVER abstract — always tied to a physical component or action

Rules for thumbnailSubtext (optional):
- Maximum 3 words
- ALL CAPS, no punctuation
- Use only when it adds a visceral secondary cue (e.g. SALTWATER,
  OFFSHORE, DEAD BY DAY TWO, UNDER LOAD, FULL DRAW)
- Return null if you can't produce one that adds value

Respond with ONLY valid JSON: {"thumbnailHeadline": "...", "thumbnailSubtext": "..." | null}
Nothing else — do not include the candidate list or scores.`;

// ── Stage ────────────────────────────────────────────────────────────────

export async function wcThumbnailHeadlineGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  // NOTE: No DISABLE_ELEVEN guard here by design. This stage calls
  // Anthropic (LLM), not ElevenLabs. DISABLE_ELEVEN only gates:
  // voiceover, videoAssembly, youtubeUpload, shortsGenerator (plus
  // wcThumbnailGenerator's own guard on rendering).

  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const topicTitle = ctx.topic.title;
  const summary = ctx.topic.summary ?? "";
  const seoTitle = ctx.seo?.title ?? "";
  const scriptHook = ctx.script?.hook ?? "";

  // The FULL narration, not just the hook.
  //
  // This stage used to receive the topic, the summary, the SEO title and the
  // hook — and nothing else. Every stance a headline can contradict lives in
  // segment narration: "None of them are bad" is in segment 3, the promise that
  // the comparison "is coming" is in the CTA. So the generator could not have
  // known, and "ALL THREE TESTED" / "LIVESCOPE KILLS MEGA LIVE" were the
  // predictable result of asking for a winner while withholding the verdict.
  const narration = ctx.script
    ? [ctx.script.hook, ...ctx.script.segments.map((s) => s.narration), ctx.script.cta].join("\n")
    : "";

  // Promissory sentences are stripped here too, so what the model is shown as
  // "what the video establishes" is the same text the guard judges against.
  const established = performedEvidence(narration);

  const basePrompt = `Topic: ${topicTitle}
${summary ? `Summary: ${summary}\n` : ""}${seoTitle ? `SEO title: ${seoTitle}\n` : ""}${scriptHook ? `Script hook: ${scriptHook}\n` : ""}
What the video actually establishes (promises of future videos removed —
nothing here may be treated as tested or proven unless it says so):
${established || "(no script available)"}`;

  const attempt = async (extra: string) => {
    const message = await createMessage(anthropic, {
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: extra ? `${basePrompt}\n\n${extra}` : basePrompt }],
    });
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`no JSON object in response. Raw: ${text.slice(0, 200)}`);
    const validation = responseSchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!validation.success) {
      throw new Error(`Schema validation failed: ${validation.error.issues.map((i) => i.message).join("; ")}`);
    }
    return {
      headline: sanitizeHeadline(validation.data.thumbnailHeadline),
      subtext: sanitizeSubtext(validation.data.thumbnailSubtext),
      raw: validation.data.thumbnailHeadline,
    };
  };

  let headline: string | null;
  let subtext: string | null;
  let raw: string;
  try {
    ({ headline, subtext, raw } = await attempt(""));
  } catch (err) {
    return {
      success: false,
      error: `Failed to generate thumbnail text: ${err instanceof Error ? err.message : err}`,
      durationMs: Date.now() - start,
    };
  }

  if (!headline) {
    return {
      success: false,
      error: `Sanitized headline is empty (raw: "${raw}")`,
      durationMs: Date.now() - start,
    };
  }

  // ── Claim guard ────────────────────────────────────────────────────────
  // The prompt forbids these three claim classes; this is what makes the
  // prohibition binding. One regeneration with the specific violation quoted
  // back, then a fall back to subtext-free topic framing — never a hard stage
  // failure, because a thumbnail is recoverable and a burned render is not.
  if (narration) {
    const bad = (h: string, s: string | null) => {
      const hit = checkMetadataClaim(h, narration);
      if (!hit.ok) return { field: "headline", check: hit };
      if (s) {
        const st = checkMetadataClaim(s, narration);
        if (!st.ok) return { field: "subtext", check: st };
      }
      return null;
    };

    let violation = bad(headline, subtext);
    if (violation) {
      console.log(
        `[wc:thumbnailHeadlineGenerator] REJECTED ${violation.field} "${
          violation.field === "headline" ? headline : subtext
        }" — ${violation.check.reason}`,
      );
      try {
        const retry = await attempt(
          `Your previous ${violation.field} was REJECTED: "${
            violation.field === "headline" ? headline : subtext
          }".\nReason: ${violation.check.reason}\nThe script does not support that claim. Produce a headline that is just as`
          + ` punchy without asserting it. If you cannot name a winner, name the deciding factor.`
          + ` If nothing was tested, do not imply it was. Return null for subtext rather than forcing one.`,
        );
        if (retry.headline) {
          const still = bad(retry.headline, retry.subtext);
          if (!still) {
            headline = retry.headline;
            subtext = retry.subtext;
            console.log(`[wc:thumbnailHeadlineGenerator] regenerated: "${headline}"`);
          } else {
            console.log(`[wc:thumbnailHeadlineGenerator] retry also unsupported — ${still.check.reason}`);
          }
        }
      } catch (err) {
        console.log(`[wc:thumbnailHeadlineGenerator] retry failed: ${err instanceof Error ? err.message : err}`);
      }

      // Still unsupported: fall back to the topic, which asserts nothing the
      // script does not because the script was written from it.
      if (bad(headline, subtext)) {
        const fallback = sanitizeHeadline(topicTitle.split(/[:—–-]/)[0] ?? topicTitle);
        if (fallback && checkMetadataClaim(fallback, narration).ok) {
          console.log(
            `[wc:thumbnailHeadlineGenerator] using topic-derived fallback: "${fallback}" (subtext dropped)`,
          );
          headline = fallback;
          subtext = null;
        } else {
          return {
            success: false,
            error: `no supportable thumbnail headline: model output and topic fallback both assert what the script disclaims`,
            durationMs: Date.now() - start,
          };
        }
      }
    }
  }

  console.log(`[wc:thumbnailHeadlineGenerator] headline: "${headline}"`);
  if (subtext) console.log(`[wc:thumbnailHeadlineGenerator] subtext: "${subtext}"`);

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: {
      thumbnailHeadline: headline,
      thumbnailSubtext: subtext,
    },
  });

  return { success: true, data: { headline, subtext }, durationMs: Date.now() - start };
}
