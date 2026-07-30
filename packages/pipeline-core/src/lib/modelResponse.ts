import { createHash } from "node:crypto";
import type { ScriptFailureType } from "@prisma/client";
import { prisma } from "./db";

/**
 * Model-response classification.
 *
 * A model declining to write a script is a legitimate outcome — usually a
 * correct one. Wet Circuit's failures were all of this kind: topic discovery
 * surfaced aviation, motorsport, motorcycle and earnings items from Garmin's
 * general PR feed, and the scriptwriter correctly refused to write a marine
 * electronics script about them. The pipeline then fed the refusal prose to
 * JSON.parse and recorded "Invalid JSON from Claude", which hid the real cause
 * and invited pointless retries of an identical prompt.
 *
 * Responses are now classified BEFORE parsing, so a refusal can never be
 * mistaken for a script, and each failure kind is stored distinctly.
 */

export type Classification =
  | { type: "VALID"; json: unknown }
  | { type: Exclude<ScriptFailureType, "VALID">; detail: string };

/** Phrases that mark a decline. Matched only near the start of the response. */
const REFUSAL_MARKERS = [
  "i can't write", "i cannot write", "i can't create", "i cannot create",
  "i can't produce", "i cannot produce", "i won't write", "i will not write",
  "i need to pause", "i need to flag", "i have to flag", "i should flag",
  "i'm not able to", "i am not able to", "i'd rather not", "i must decline",
  "i can't help with", "i cannot help with", "before writing this script",
  "before i write this",
];

/** Phrases indicating the topic was judged out of scope for the channel. */
const OFF_TOPIC_MARKERS = [
  "doesn't fit the channel", "does not fit the channel",
  "not a marine electronics", "isn't a marine electronics",
  "is an aviation", "is a motorcycle", "is a racing", "for motorsports",
  "not marine electronics", "zero relevance", "out of scope",
  "not relevant to this channel",
];

/** Phrases indicating the source material was too thin to write from. */
const THIN_SOURCE_MARKERS = [
  "source content is extremely thin", "source content is thin",
  "no actual specs", "there are no new products", "not a product announcement",
  "no specifications", "insufficient detail", "not enough detail",
  "no model numbers", "financial earnings press release",
];

function startsWithProse(text: string): boolean {
  const t = text.trimStart();
  return !(t.startsWith("{") || t.startsWith("[") || t.startsWith("```"));
}

function stripFence(text: string): string {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return raw.trim();
}

/** Heuristic: a JSON document that begins well but never closes. */
function looksTruncated(raw: string): boolean {
  if (!raw.startsWith("{") && !raw.startsWith("[")) return false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of raw) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth > 0 || inStr;
}

/**
 * Classify a raw model response before any parsing is attempted.
 *
 * @param text      the model's text block ("" if none)
 * @param stopReason the API stop_reason, used to detect hitting max_tokens
 */
export function classifyModelResponse(
  text: string,
  stopReason?: string | null,
): Classification {
  if (!text || text.trim().length === 0) {
    return { type: "EMPTY_RESPONSE", detail: "Model returned no text content." };
  }

  const head = text.slice(0, 600).toLowerCase();

  // Refusals and scope objections are prose, never JSON. Check them first so a
  // decline can never reach JSON.parse.
  if (startsWithProse(text)) {
    const offTopic = OFF_TOPIC_MARKERS.find((m) => head.includes(m));
    if (offTopic) {
      return {
        type: "OFF_TOPIC",
        detail: `Model judged the topic out of scope ("${offTopic}"): ${text.slice(0, 400)}`,
      };
    }
    const thin = THIN_SOURCE_MARKERS.find((m) => head.includes(m));
    if (thin) {
      return {
        type: "THIN_SOURCE",
        detail: `Model judged the source too thin ("${thin}"): ${text.slice(0, 400)}`,
      };
    }
    const refusal = REFUSAL_MARKERS.find((m) => head.includes(m));
    if (refusal) {
      return {
        type: "MODEL_REFUSAL",
        detail: `Model declined ("${refusal}"): ${text.slice(0, 400)}`,
      };
    }
  }

  const raw = stripFence(text);

  if (stopReason === "max_tokens" || looksTruncated(raw)) {
    return {
      type: "TRUNCATED_JSON",
      detail:
        `Response appears truncated (stop_reason=${stopReason ?? "unknown"}, ${raw.length} chars). ` +
        `Raise max_tokens or shorten the requested script.`,
    };
  }

  try {
    return { type: "VALID", json: JSON.parse(raw) };
  } catch (e) {
    // Prose that did not match a known marker still is not JSON.
    if (startsWithProse(text)) {
      return {
        type: "MODEL_REFUSAL",
        detail: `Non-JSON prose response (unrecognised decline): ${text.slice(0, 400)}`,
      };
    }
    return {
      type: "MALFORMED_JSON",
      detail: `${e instanceof Error ? e.message : e} — starts: ${raw.slice(0, 200)}`,
    };
  }
}

/** Stable identity of a prompt, so identical prompts are not retried blindly. */
export function promptHash(system: string, user: string): string {
  return createHash("sha256").update(`${system}\n---\n${user}`).digest("hex");
}

export interface RecordFailureInput {
  channel: string;
  videoId?: string | null;
  topicId?: string | null;
  topicTitle?: string | null;
  pillar?: string | null;
  failureType: Exclude<ScriptFailureType, "VALID">;
  detail: string;
  promptHash: string;
  attempt?: number;
}

export async function recordScriptFailure(input: RecordFailureInput): Promise<void> {
  await prisma.scriptGenerationFailure
    .create({
      data: {
        channel: input.channel,
        videoId: input.videoId ?? null,
        topicId: input.topicId ?? null,
        topicTitle: input.topicTitle?.slice(0, 500) ?? null,
        pillar: input.pillar ?? null,
        failureType: input.failureType,
        detail: input.detail.slice(0, 4000),
        promptHash: input.promptHash,
        attempt: input.attempt ?? 1,
      },
    })
    .catch(() => { /* diagnostics must never mask the real failure */ });
}

/**
 * Failure kinds where retrying the SAME prompt cannot help. Retrying a refusal
 * or an out-of-scope judgement just burns Anthropic calls to get the same
 * answer; the topic needs replacing, not the request repeating.
 */
export const NON_RETRYABLE: ScriptFailureType[] = [
  "MODEL_REFUSAL",
  "OFF_TOPIC",
  "THIN_SOURCE",
];

export function isRetryable(t: ScriptFailureType): boolean {
  return !NON_RETRYABLE.includes(t);
}

/** How many times this exact prompt has already failed. */
export async function priorAttemptsForPrompt(hash: string): Promise<number> {
  return prisma.scriptGenerationFailure.count({ where: { promptHash: hash } });
}
