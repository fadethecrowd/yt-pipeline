/**
 * Anthropic vision benchmark against the frozen, independently approved labels.
 *
 *   npx tsx scripts/run-vision-benchmark.ts
 *
 * Two independent passes over every metric case. Nothing here may change a
 * label, retry a disagreement, or pick a favourable output: a transport
 * failure gets one retry only when no valid response came back, and a schema
 * failure is recorded as a failure rather than re-rolled.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

// ── Pinned configuration ────────────────────────────────────────────────
export const MODEL = "claude-sonnet-5";
export const PROMPT_VERSION = "vision-judge-v1";
export const SCHEMA_VERSION = "judgment-v1";
export const SHELL_VERSION = "shell-v1";
const RATE_IN = 3 / 1e6, RATE_OUT = 15 / 1e6;
const MAX_CALLS = 56, CEILING_USD = 5.0;
const WORST_CASE_PER_CALL = 2745 * RATE_IN + 500 * RATE_OUT;
const MAX_OUTPUT_TOKENS = 500;

/**
 * Deterministic shell thresholds — FIXED BEFORE THE BENCHMARK RAN and not
 * touched afterwards. Tuning these against observed failures would be fitting
 * the judge to its own exam.
 */
export const MIN_CONFIDENCE_FOR_DIRECT = 0.6;
export const MIN_COMPONENT_SCORE = 0.6;

const APPROVED = "tests/fixtures/visual-semantic-benchmark.v2.approved.json";
const CACHE = "tmp/bench2/judgments.cache.json";
const RESULTS = "tmp/bench2/benchmark-results.json";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const SYSTEM = `You judge whether a stock video clip visually depicts what a specific requirement asks for.

You are shown one contact sheet: five frames sampled across a single clip, labelled F1..F5 with timestamps.

Judge ONLY from what is visibly present in those frames. Do not infer objects or relationships you cannot see. If a required thing is not visible, say so.

Definitions:
- subjectMatch: the required subject is visibly present as a subject of the shot.
- settingMatch: the shot visibly takes place in the required setting.
- actionMatch: the required action is visibly happening. Set observable=false if the action could not be judged from still frames.
- jointMatch: ONE frame shows the required subject AND the required setting/relationship together. Separate frames showing each separately do NOT satisfy a joint match.
- contradictions: content that positively conflicts with the requirement.
- brandRisk: visible company logos, product branding or identifiable liveries.

finalVerdict:
- DIRECT: every required component is visibly satisfied.
- RELATED: genuinely on-topic but at least one required component is missing.
- IRRELEVANT: does not depict the requirement.
- AMBIGUOUS: the frames genuinely cannot settle it.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"subjectMatch":{"score":0.0,"matchedConcepts":[],"evidenceFrames":[]},
"settingMatch":{"score":0.0,"matchedConcepts":[],"evidenceFrames":[]},
"actionMatch":{"score":0.0,"matchedConcepts":[],"evidenceFrames":[],"observable":true},
"contradictions":{"detectedConcepts":[],"evidenceFrames":[]},
"brandRisk":{"result":"NONE","evidenceFrames":[]},
"jointMatch":{"satisfied":false,"evidenceFrames":[],"explanation":""},
"confidence":0.0,"finalVerdict":"DIRECT","explanation":""}
Scores are 0..1. evidenceFrames are integers 1..5. Keep explanations under 200 characters.`;

/** Exactly what the model sees. No label, role, rationale, split or flag. */
export function judgePayload(c: any) {
  return {
    requiredSubject: c.requirement.primarySubjects,
    requiredSetting: c.requirement.settings,
    requiredAction: c.requirement.action ?? null,
    compositionPolicy: c.compositionPolicy,
    jointEvidenceRequired: c.jointRequired,
    narrationContext: c.narration,
    visualPromptContext: c.visualPrompt,
  };
}

export function validate(o: any): { ok: true; value: any } | { ok: false; reason: string } {
  const num = (v: any) => typeof v === "number" && v >= 0 && v <= 1;
  const frames = (v: any) => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  if (!o || typeof o !== "object") return { ok: false, reason: "not an object" };
  for (const k of ["subjectMatch", "settingMatch", "actionMatch"]) {
    if (!o[k] || !num(o[k].score)) return { ok: false, reason: `${k}.score invalid` };
    if (!frames(o[k].evidenceFrames)) return { ok: false, reason: `${k}.evidenceFrames invalid` };
  }
  if (typeof o.actionMatch.observable !== "boolean") return { ok: false, reason: "actionMatch.observable invalid" };
  if (!o.contradictions || !Array.isArray(o.contradictions.detectedConcepts)) return { ok: false, reason: "contradictions invalid" };
  if (!o.brandRisk || !["NONE", "POSSIBLE", "VISIBLE"].includes(o.brandRisk.result)) return { ok: false, reason: "brandRisk invalid" };
  if (!o.jointMatch || typeof o.jointMatch.satisfied !== "boolean") return { ok: false, reason: "jointMatch invalid" };
  if (!num(o.confidence)) return { ok: false, reason: "confidence invalid" };
  if (!["DIRECT", "RELATED", "IRRELEVANT", "AMBIGUOUS"].includes(o.finalVerdict)) return { ok: false, reason: "finalVerdict invalid" };
  return { ok: true, value: o };
}

/** Deterministic shell over the structured result. Never trusts the string alone. */
export function applyShell(c: any, j: any): { verdict: string; reasons: string[] } {
  const reasons: string[] = [];
  let v = j.finalVerdict;
  const needSubject = (c.requirement.primarySubjects ?? []).length > 0;
  const needSetting = (c.requirement.settings ?? []).length > 0;

  if (needSubject && j.subjectMatch.score < MIN_COMPONENT_SCORE) {
    reasons.push(`subject ${j.subjectMatch.score} < ${MIN_COMPONENT_SCORE}`);
    if (v === "DIRECT") v = "RELATED";
  }
  if (needSetting && j.settingMatch.score < MIN_COMPONENT_SCORE) {
    reasons.push(`setting ${j.settingMatch.score} < ${MIN_COMPONENT_SCORE}`);
    if (v === "DIRECT") v = "RELATED";
  }
  if (c.requirement.action && j.actionMatch.observable && j.actionMatch.score < MIN_COMPONENT_SCORE) {
    reasons.push(`action ${j.actionMatch.score} < ${MIN_COMPONENT_SCORE}`);
    if (v === "DIRECT") v = "RELATED";
  }
  if (c.jointRequired && !(j.jointMatch.satisfied && (j.jointMatch.evidenceFrames ?? []).length > 0)) {
    reasons.push("joint evidence required but not cited");
    if (v === "DIRECT") v = "RELATED";
  }
  if ((j.contradictions.detectedConcepts ?? []).length > 0 && v === "DIRECT") {
    reasons.push(`contradiction: ${j.contradictions.detectedConcepts.join(",")}`);
    v = "RELATED";
  }
  if (v === "DIRECT" && j.confidence < MIN_CONFIDENCE_FOR_DIRECT) {
    reasons.push(`confidence ${j.confidence} < ${MIN_CONFIDENCE_FOR_DIRECT}`);
    v = "AMBIGUOUS";
  }
  return { verdict: v, reasons };
}

async function main() {
  const bench = JSON.parse(readFileSync(APPROVED, "utf8"));
  const cases = bench.cases.filter((c: any) => c.includeInMetrics);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const cache: Record<string, any> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

  let calls = 0, cost = 0, schemaFailures = 0;
  const results: any[] = [];
  const t0 = Date.now();

  for (const run of [1, 2]) {
    for (const c of cases) {
      const sheetPath = `tmp/bench2/review/sheets/${c.contactSheet.file}`;
      const img = readFileSync(sheetPath);
      const payload = judgePayload(c);
      const key = [c.source.id, c.frames.map((f: any) => f.sha256.slice(0, 8)).join(""),
        sha(JSON.stringify(payload)).slice(0, 16), MODEL, PROMPT_VERSION,
        SCHEMA_VERSION, SHELL_VERSION, bench.samplingVersion, `run${run}`].join("|");

      if (cache[key]) { results.push({ ...cache[key], cached: true }); continue; }

      // Governor: never let the remaining authorized calls breach the ceiling.
      if (calls >= MAX_CALLS) throw new Error(`call limit ${MAX_CALLS} reached`);
      if (cost + WORST_CASE_PER_CALL > CEILING_USD) {
        throw new Error(`ceiling guard: $${cost.toFixed(4)} + worst case would exceed $${CEILING_USD}`);
      }

      let resp: any = null, transportRetried = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          resp = await client.messages.create({
            // temperature is deprecated for this model; determinism relies on the
            // model default plus a fixed prompt, frames and payload.
            model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, system: SYSTEM,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } },
              { type: "text", text: JSON.stringify(payload) },
            ] }],
          });
          break;
        } catch (e: any) {
          if (attempt === 0) { transportRetried = true; continue; }
          throw new Error(`transport failure after one retry: ${e.message}`);
        }
      }

      calls++;
      const usage = resp.usage;
      const callCost = usage.input_tokens * RATE_IN + usage.output_tokens * RATE_OUT;
      cost += callCost;

      const text = (resp.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      let parsed: any = null, schemaOk = false, schemaReason = "";
      try {
        parsed = JSON.parse(text.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim());
        const v = validate(parsed);
        if (v.ok) schemaOk = true; else schemaReason = v.reason;
      } catch (e: any) { schemaReason = `unparseable: ${e.message}`; }

      if (!schemaOk) schemaFailures++;
      // Fail closed: a malformed judgment is never DIRECT and is never cached as one.
      const shell = schemaOk ? applyShell(c, parsed)
        : { verdict: "IRRELEVANT", reasons: [`SCHEMA FAILURE: ${schemaReason}`] };

      const rec = {
        run, caseId: c.caseId, split: c.split, safetyCritical: c.safetyCritical,
        expected: c.expected.finalVerdict, modelVerdict: schemaOk ? parsed.finalVerdict : null,
        shellVerdict: shell.verdict, shellReasons: shell.reasons,
        confidence: schemaOk ? parsed.confidence : null,
        subject: schemaOk ? parsed.subjectMatch.score : null,
        setting: schemaOk ? parsed.settingMatch.score : null,
        joint: schemaOk ? parsed.jointMatch.satisfied : null,
        brandRisk: schemaOk ? parsed.brandRisk.result : null,
        explanation: schemaOk ? String(parsed.explanation).slice(0, 180) : schemaReason,
        schemaOk, transportRetried,
        usage: { input: usage.input_tokens, output: usage.output_tokens }, costUsd: +callCost.toFixed(6),
        cumulativeUsd: +cost.toFixed(6), model: MODEL,
      };
      results.push(rec);
      if (schemaOk) cache[key] = rec;   // malformed output is never cached
      writeFileSync(CACHE, JSON.stringify(cache, null, 2));

      const mark = shell.verdict === c.expected.finalVerdict ? "✓" : "✗";
      console.log(`${mark} r${run} ${c.caseId.padEnd(34)} exp ${c.expected.finalVerdict.padEnd(10)} got ${shell.verdict.padEnd(10)} conf ${rec.confidence} $${cost.toFixed(4)}`);
    }
  }

  writeFileSync(RESULTS, JSON.stringify({
    model: MODEL, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION,
    shellVersion: SHELL_VERSION, thresholds: { MIN_CONFIDENCE_FOR_DIRECT, MIN_COMPONENT_SCORE },
    benchmark: { file: APPROVED, sha256: sha(readFileSync(APPROVED, "utf8")), metricCases: cases.length },
    calls, totalCostUsd: +cost.toFixed(6), schemaFailures,
    wallClockMs: Date.now() - t0, results,
  }, null, 2));
  console.log(`\ncalls ${calls} | cost $${cost.toFixed(4)} | schema failures ${schemaFailures} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
main().catch((e) => { console.error("BENCHMARK STOPPED:", e.message); process.exitCode = 1; });
