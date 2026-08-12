/**
 * Replay the visual-feasibility gate against durable scripts. NO SPEND.
 *
 *   npx tsx scripts/replay-feasibility.ts [videoId ...]
 *
 * Read-only: it reads `scriptJson`, runs the SAME `assessVisualFeasibility` the
 * gate runs, and prints the verdict. It writes no row, buys no narration,
 * renders nothing and uploads nothing — the gate's own `fail()` path, which is
 * the only thing that mutates a candidate, is not reached because this calls
 * the assessment directly.
 *
 * It exists so a change to retrieval, classification or selection can be
 * judged against the real refused candidates AND against the videos that were
 * actually published, instead of against an argument.
 */
import {
  prisma, disconnect, assessVisualFeasibility, pexelsOnlySource, env,
  buildSpokenUnits, spokenCharacterCount, spokenOutlineSegments,
  CHARS_PER_SECOND, TITLE_CARD_S,
} from "@yt-pipeline/pipeline-core";
import type { Script } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

const CHANNEL = "ai-doom-scroll" as const;

const DEFAULTS = [
  ["FAIL-1 OCR            (was factory 50%)", "cmsql4dco0002p90edn2a4skx"],
  ["FAIL-2 enterprise     (was factory 52%)", "cmsqmgt4200b4ns0evkpfr1wa"],
  ["OK-2   AMrrTvdL2tI    (published 39.1%)", "cmsexx3n80002mb1gd988zvee"],
  ["HBM    uVQ-vcJHWNk    (human-rejected)",  "cms9970di0002mbti2m9avpui"],
];

async function one(label: string, videoId: string) {
  const v: any = await (prisma as any).video.findUnique({
    where: { id: videoId }, include: { topic: true },
  });
  const script = v?.scriptJson as Script | undefined;
  if (!script?.segments?.length) { console.log(`\n${label}: no durable script`); return; }

  const submitChars = spokenCharacterCount(buildSpokenUnits(script));
  const videoS = submitChars / CHARS_PER_SECOND[CHANNEL] + TITLE_CARD_S;

  const report = await assessVisualFeasibility(
    {
      channel: CHANNEL,
      topicTitle: v.topic?.title ?? "",
      targetRuntimeS: Math.round(videoS),
      segments: spokenOutlineSegments(script).map((s) => ({
        segmentIndex: s.segmentIndex,
        title: s.title,
        narration: s.narration,
        visual_prompt: s.visual_prompt,
      })),
    },
    pexelsOnlySource(env().PEXELS_API_KEY),
  );

  const dom = report.conceptBreakdown[0];
  console.log(`\n${"─".repeat(74)}\n${label}  "${(v.topic?.title ?? "").slice(0, 44)}"`);
  console.log(`  concepts : ${report.conceptBreakdown
    .map((c) => `${c.concept}=${(c.share * 100).toFixed(1)}%`).join(" ")}`);
  console.log(`  dominant : ${dom?.concept} ${((dom?.share ?? 0) * 100).toFixed(1)}%  (cap 40%)`);
  console.log(`  cards    : ${report.estimatedCardPct.toFixed(1)}%  distinct concepts: ${report.distinctConcepts}`);
  for (const c of report.checks) if (!c.ok) console.log(`  ✗ ${c.name}: ${c.detail}`);
  console.log(`  VERDICT  : ${report.pass ? "PASS" : "FAIL"}${report.pass ? "" : ` — ${report.failureReason}`}`);
  return report;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets: [string, string][] = args.length
    ? args.map((id) => [id, id] as [string, string])
    : (DEFAULTS as [string, string][]);
  console.log("FEASIBILITY REPLAY — read-only, no narration/render/upload");
  for (const [label, id] of targets) await one(label, id);
  await disconnect();
}

const direct = process.argv[1]?.includes("replay-feasibility");
if (direct) main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnect());
