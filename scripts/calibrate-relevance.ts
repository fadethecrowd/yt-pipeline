/**
 * Is the concept taxonomy acting as an accidental relevance filter?
 *
 *   npx tsx scripts/calibrate-relevance.ts [--beats=4] [--cases=all|failed|good]
 *
 * Read-only. Retrieves from Pexels (free) and asks Claude to judge relevance
 * INDEPENDENTLY of the taxonomy, so "is this footage right for this beat" and
 * "can AI_SUBJECTS name it" become two separate measurements that can be
 * cross-tabulated. Buys no narration, renders nothing, uploads nothing, and
 * writes no database row.
 *
 * The question it answers is not "does the gate fail" — we know it does — but
 * whether the assets it is scoring were judged on their merits. `scoreRelevance`
 * awards up to 0.75 for taxonomy evidence and at most 0.39 for agreeing with
 * the prompt and narration, against a 0.25 threshold, so a single taxonomy
 * keyword outweighs any amount of genuine semantic agreement. This measures
 * what that does to real retrieved footage.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  prisma, disconnect, env, createMessage,
  buildSearchQueries, classifyConcept, scoreRelevance, AI_SUBJECTS,
  searchPexelsCandidates,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;
const BEATS = Number(process.argv.find((a) => a.startsWith("--beats="))?.split("=")[1] ?? 4);

export const CASES: { label: string; videoId: string; verdict: string }[] = [
  { label: "rrb0A_piLEM  power/grid", videoId: "cmsdrtafn0002mbdzwpmndnix", verdict: "UPLOADED" },
  { label: "AMrrTvdL2tI  e-waste",    videoId: "cmsexx3n80002mb1gd988zvee", verdict: "UPLOADED" },
  { label: "HBM          chips",      videoId: "cms9970di0002mbti2m9avpui", verdict: "HUMAN-REJECTED" },
  { label: "OCR          documents",  videoId: "cmsql4dco0002p90edn2a4skx", verdict: "REFUSED" },
  { label: "enterprise   business",   videoId: "cmsqmgt4200b4ns0evkpfr1wa", verdict: "REFUSED" },
  { label: "OlmoEarth    geospatial", videoId: "cmsqn4iam0002ld0e3dfv7xx7", verdict: "REFUSED" },
  { label: "sign-lang    accessibility", videoId: "cmsqtbgzm0002li0egizu9vlc", verdict: "REFUSED" },
];

interface Judged {
  description: string;
  truthRelevant: boolean;      // Claude, taxonomy-blind
  taxonomyConcept: string;     // what AI_SUBJECTS can name, before remapping
  scoredConcept: string;       // what scoreRelevance reports
  score: number;
  accepted: boolean;           // survived REJECT_THRESHOLD
}

/** One Claude call per beat: taxonomy-blind relevance judgement. */
async function judge(
  a: Anthropic, narration: string, prompt: string, descriptions: string[],
): Promise<boolean[]> {
  const numbered = descriptions.map((d, i) => `${i}. ${d}`).join("\n");
  const msg = await createMessage(a, {
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system:
      "You judge whether stock footage is a good visual match for a video beat. " +
      "Answer only about whether a viewer would find the footage a sensible, " +
      "on-topic illustration of the narration and the requested shot. Ignore " +
      "production quality. Respond ONLY with a JSON array of booleans, one per " +
      "numbered item, in order.",
    messages: [{
      role: "user",
      content:
        `NARRATION: ${narration.slice(0, 700)}\n\nREQUESTED SHOT: ${prompt.slice(0, 400)}\n\n` +
        `FOOTAGE:\n${numbered}\n\nJSON array of ${descriptions.length} booleans:`,
    }],
  });
  const text = (msg.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
  let raw = text.trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  const arr = JSON.parse(raw) as boolean[];
  return descriptions.map((_, i) => arr[i] === true);
}

const NON_CONCRETE = new Set(["none", "ambiguous", "generic-abstract", "unknown"]);

export interface Confusion {
  relevantClassifiedAccepted: number;
  relevantUnclassifiedRejected: number;
  relevantUnclassifiedAccepted: number;
  relevantMisclassifiedAccepted: number;
  irrelevantClassifiedAccepted: number;
  irrelevantRejected: number;
  relevantTotal: number;
  irrelevantTotal: number;
  noneAmongRelevant: number;
}

export function tabulate(rows: Judged[]): Confusion {
  const c: Confusion = {
    relevantClassifiedAccepted: 0, relevantUnclassifiedRejected: 0,
    relevantUnclassifiedAccepted: 0, relevantMisclassifiedAccepted: 0,
    irrelevantClassifiedAccepted: 0, irrelevantRejected: 0,
    relevantTotal: 0, irrelevantTotal: 0, noneAmongRelevant: 0,
  };
  for (const r of rows) {
    const named = !NON_CONCRETE.has(r.taxonomyConcept);
    if (r.truthRelevant) {
      c.relevantTotal++;
      if (!named) c.noneAmongRelevant++;
      if (r.accepted && named) c.relevantClassifiedAccepted++;
      else if (r.accepted && !named) c.relevantUnclassifiedAccepted++;
      else if (!r.accepted && !named) c.relevantUnclassifiedRejected++;
      else c.relevantMisclassifiedAccepted++; // relevant, named, yet rejected
    } else {
      c.irrelevantTotal++;
      if (r.accepted) c.irrelevantClassifiedAccepted++;
      else c.irrelevantRejected++;
    }
  }
  return c;
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

async function beatsOf(videoId: string): Promise<{ narration: string; prompt: string }[]> {
  const v: any = await (prisma as any).video.findUnique({ where: { id: videoId } });
  const segs = (v?.scriptJson as any)?.segments ?? [];
  if (segs.length) {
    return segs.map((s: any) => ({ narration: s.narration ?? "", prompt: s.visual_prompt ?? "" }));
  }
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON ("prompt") "prompt","narration" FROM scene_record WHERE "videoId"=$1`, videoId);
  return rows.map((r) => ({ narration: r.narration ?? "", prompt: r.prompt ?? "" }));
}

async function main() {
  const a = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  const key = env().PEXELS_API_KEY;
  console.log("RELEVANCE vs TAXONOMY CALIBRATION — read-only, no ElevenLabs spend\n");

  const all: Judged[] = [];
  const perCase: { label: string; verdict: string; rows: Judged[] }[] = [];

  for (const c of CASES) {
    const beats = (await beatsOf(c.videoId)).slice(0, BEATS);
    const rows: Judged[] = [];
    for (const b of beats) {
      const qs = buildSearchQueries(b.prompt, "", CHANNEL).slice(0, 2);
      const seen = new Set<string>();
      const descs: string[] = [];
      for (const q of qs) {
        let cands: any[] = [];
        try { cands = await searchPexelsCandidates(q, key, { perPage: 15 }); } catch { continue; }
        for (const x of cands) {
          const d = (x.description ?? "").trim();
          if (d && !seen.has(d)) { seen.add(d); descs.push(d); }
        }
      }
      if (descs.length < 3) continue;
      const sample = descs.slice(0, 24);
      let truth: boolean[];
      try { truth = await judge(a, b.narration, b.prompt, sample); }
      catch { continue; }
      sample.forEach((d, i) => {
        const sc = scoreRelevance({ channel: CHANNEL as never, narration: b.narration, prompt: b.prompt, description: d });
        rows.push({
          description: d,
          truthRelevant: truth[i] ?? false,
          taxonomyConcept: classifyConcept(d, AI_SUBJECTS).concept,
          scoredConcept: sc.concept,
          score: sc.score,
          accepted: sc.verdict !== "REJECT",
        });
      });
    }
    perCase.push({ label: c.label, verdict: c.verdict, rows });
    all.push(...rows);
    const t = tabulate(rows);
    console.log(`── ${c.label.padEnd(26)} [${c.verdict}] n=${rows.length}`);
    console.log(`   relevant=${t.relevantTotal} of which unnamed=${t.noneAmongRelevant} (${pct(t.noneAmongRelevant, t.relevantTotal)})`);
    console.log(`   FALSE NEGATIVES (relevant, unnamed, rejected): ${t.relevantUnclassifiedRejected} ` +
      `(${pct(t.relevantUnclassifiedRejected, t.relevantTotal)} of relevant)`);
    console.log(`   FALSE POSITIVES (irrelevant, accepted)       : ${t.irrelevantClassifiedAccepted} ` +
      `(${pct(t.irrelevantClassifiedAccepted, t.irrelevantTotal)} of irrelevant)`);
  }

  const T = tabulate(all);
  console.log(`\n${"═".repeat(74)}\nAGGREGATE  n=${all.length}`);
  console.log(`  relevant total                        ${T.relevantTotal}`);
  console.log(`  irrelevant total                      ${T.irrelevantTotal}`);
  console.log(`  relevant + named + accepted           ${T.relevantClassifiedAccepted}`);
  console.log(`  relevant + unnamed + accepted         ${T.relevantUnclassifiedAccepted}`);
  console.log(`  relevant + unnamed + REJECTED         ${T.relevantUnclassifiedRejected}   << false negatives`);
  console.log(`  relevant + named + rejected           ${T.relevantMisclassifiedAccepted}`);
  console.log(`  irrelevant + ACCEPTED                 ${T.irrelevantClassifiedAccepted}   << false positives`);
  console.log(`  irrelevant + rejected                 ${T.irrelevantRejected}`);
  console.log(`  "none" rate among genuinely relevant  ${pct(T.noneAmongRelevant, T.relevantTotal)}`);
  console.log(`  false-negative rate (of relevant)     ${pct(T.relevantUnclassifiedRejected, T.relevantTotal)}`);
  console.log(`  false-positive rate (of irrelevant)   ${pct(T.irrelevantClassifiedAccepted, T.irrelevantTotal)}`);

  // The decisive comparison: acceptance for relevant footage the taxonomy CAN
  // name versus relevant footage it cannot. If naming is doing the work, these
  // two numbers diverge sharply.
  const relNamed = all.filter((r) => r.truthRelevant && !NON_CONCRETE.has(r.taxonomyConcept));
  const relUnnamed = all.filter((r) => r.truthRelevant && NON_CONCRETE.has(r.taxonomyConcept));
  console.log(`\n  acceptance | relevant & NAMED   ${pct(relNamed.filter((r) => r.accepted).length, relNamed.length)} (n=${relNamed.length})`);
  console.log(`  acceptance | relevant & UNNAMED  ${pct(relUnnamed.filter((r) => r.accepted).length, relUnnamed.length)} (n=${relUnnamed.length})`);
  const irrNamed = all.filter((r) => !r.truthRelevant && !NON_CONCRETE.has(r.taxonomyConcept));
  console.log(`  acceptance | IRRELEVANT & named  ${pct(irrNamed.filter((r) => r.accepted).length, irrNamed.length)} (n=${irrNamed.length})`);

  await disconnect();
}

const direct = process.argv[1]?.includes("calibrate-relevance");
if (direct) main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnect());
