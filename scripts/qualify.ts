/**
 * Phase 6 qualification asset runner.
 *
 *   npx tsx scripts/qualify.ts <assetKey> [--no-upload]
 *   npx tsx scripts/qualify.ts --list
 *
 * Produces ONE asset per invocation so nothing runs concurrently and a failure
 * never cascades. Resumable: narration already generated for an asset is
 * reused at zero credit cost, so a render or upload failure is repaired
 * without re-charging ElevenLabs.
 *
 * Uploads are always private, never scheduled.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { VideoStatus, TopicStatus } from "@prisma/client";
import {
  prisma, disconnect, env,
  runVoiceover, runAssembly, currentTestStage,
  runQa, persistQa, formatQa,
  verifyChannel, CHANNELS, isRealYoutubeId,
  extractSyncAnchors, formatAnchors, findDiagnosticMarkers,
  sceneRecordsFor, creditsChargedFor, generationIdsFor,
  budgetReport, setBudgetLimit, breakerStatus, quarantineJob,
  checkRuntime, charsForRuntime, fmtRuntime, extractFrame,
  runtimeRange, CHARS_PER_SECOND, TITLE_CARD_S,
  sha256File, sha256Manifest, storeApproval, verifyApproved,
  BEAT_MAX_S,
  assessVisualFeasibility, pexelsOnlySource, formatFeasibility,
  guardedUpload, createGoogleYouTubePort, prismaIntentStore,
  reconcileAll, UploadBlockedError, buildYouTubeClient,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, Script } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

type ChannelKey = "ai-doom-scroll" | "wet-circuit";

interface AssetSpec {
  key: string;
  channel: ChannelKey;
  format: "LONGFORM" | "SHORT";
  targetS: number;
  topicTitle: string;
  topicUrl: string;
  /** Research context handed to the scriptwriter. */
  summary: string;
  /** For Shorts: the long-form asset whose narration is reused. */
  derivedFrom?: string;
  /**
   * Set when an asset has been withdrawn from active qualification. Running it
   * is refused; the record and every artifact are preserved.
   */
  withdrawn?: string;
  /**
   * Explicitly authorized by Max to run in the current Phase 6 window.
   *
   * The invariant suite derives its authorized-asset set from this flag, so an
   * asset row appearing for anything NOT marked here is reported as
   * unauthorized work. Authorizing the next asset is a one-line change here
   * rather than an exception buried in the checker.
   */
  phase6Authorized?: boolean;
}

// ── The six Phase 6 assets ────────────────────────────────────────────────
//
// Targets follow each channel's OBSERVED published range (see
// lib/runtimeTargets.ts): AI Doom 5:00-8:00, Wet Circuit 3:30-5:40.
// One per channel sits near the upper end, one near the middle.

export const ASSETS: AssetSpec[] = [
  {
    key: "ai1",
    channel: "ai-doom-scroll",
    format: "LONGFORM",
    targetS: 450, // 7:30 — upper end
    topicTitle: "The AI Chip Shortage Moved From GPUs to Memory",
    topicUrl: "https://qualification.local/ai-doom/hbm-memory-bottleneck",
    summary:
      "The binding constraint on AI accelerators has shifted from GPU dies to high-bandwidth memory (HBM). "
      + "HBM3E and HBM4 stacks are sold out well in advance; SK Hynix, Samsung and Micron are the only suppliers at volume. "
      + "Packaging capacity (CoWoS) is a second bottleneck. Consequences: accelerator prices stay high, smaller labs are "
      + "priced out of training runs, cloud providers ration capacity, and memory vendors capture a growing share of the "
      + "value that used to accrue to chip designers. Concrete, visual subject matter: wafers, memory stacks, cleanrooms, "
      + "packaging lines, data-centre buildouts.",
    withdrawn:
      "VISUAL_SOURCE_INCOMPATIBLE_WITH_CURRENT_LIBRARY — audio, captions and content all PASS, but Pexels "
      + "carries too little distinct HBM / wafer / packaging / semiconductor-production footage to cover the "
      + "runtime. Replaced by ai1r. Script, narration, generation IDs, all V1–V4 renders, scene manifests, "
      + "QA records and hashes are preserved; see scripts/record-hbm-disposition.ts.",
  },
  {
    // Replacement for the withdrawn ai1. Selected by scripts/screen-topics.ts:
    // the only one of three candidates to pass every pre-TTS feasibility check
    // against the current Pexels-only library — 218 accepted unique assets,
    // 3,335 usable seconds for a 351s timeline, 0% predicted fallback cards,
    // five distinct visual categories, largest concept 37%.
    key: "ai1r",
    channel: "ai-doom-scroll",
    format: "LONGFORM",
    // Authorized as the single replacement for the withdrawn ai1.
    phase6Authorized: true,
    targetS: 355, // 5:55 — inside the 5:30–6:15 target and the 5:00–8:00 range
    topicTitle: "The Camera Above the Aisle Is Now Watching You",
    topicUrl: "https://qualification.local/ai-doom/computer-vision-retail-surveillance",
    summary:
      "Computer vision has turned retail and warehouse CCTV from a recording device into an analytics "
      + "system. Shrink detection, queue management, dwell-time tracking, self-checkout monitoring and "
      + "worker productivity measurement now run on the same cameras that used to just record. "
      + "Consequences: consent and regulation questions, false-positive accusations against shoppers, "
      + "and workplace surveillance of staff. Concrete visuals: security cameras, CCTV monitors, "
      + "retail stores, checkout areas, control rooms, object detection overlays, warehouse cameras, "
      + "packing stations.",
  },
  {
    key: "ai2",
    channel: "ai-doom-scroll",
    format: "LONGFORM",
    targetS: 360, // 6:00 — middle
    topicTitle: "Warehouse Robots Stopped Needing a Map",
    topicUrl: "https://qualification.local/ai-doom/warehouse-robots-no-map",
    summary:
      "Warehouse automation has shifted from fixed-infrastructure AGVs following magnetic tape or QR codes to autonomous "
      + "mobile robots that build their own maps with SLAM and vision. Amazon, Symbotic, Locus and Geek+ are deploying "
      + "fleets that reorganise themselves. Consequences: retrofit costs collapse, warehouse leases get shorter, labour "
      + "mix shifts from picking to exception handling, and the software layer becomes the moat rather than the hardware. "
      + "Concrete visuals: mobile robots, conveyor systems, fulfilment centres, lidar sensors, machine vision, pick stations.",
  },
  {
    key: "aishort",
    channel: "ai-doom-scroll",
    format: "SHORT",
    targetS: 50,
    topicTitle: "The AI Chip Shortage Moved From GPUs to Memory",
    topicUrl: "https://qualification.local/ai-doom/hbm-memory-bottleneck",
    summary: "Short derived from the ai1 long-form narration.",
    derivedFrom: "ai1",
  },
  {
    key: "wc1",
    channel: "wet-circuit",
    format: "LONGFORM",
    targetS: 320, // 5:20 — upper end
    topicTitle: "Forward-Facing Sonar Is Changing Tournament Rules",
    topicUrl: "https://qualification.local/wet-circuit/ffs-tournament-rules",
    summary:
      "Forward-facing sonar (Garmin LiveScope, Humminbird MEGA Live, Lowrance ActiveTarget) has become accurate enough "
      + "that tournament organisers are restricting it. Major circuits have introduced limits or bans for some events. "
      + "Technical substance: real-time transducer beam steering, refresh rates, range vs resolution tradeoffs, mounting "
      + "on a trolling motor versus a dedicated pole, power draw, and interference between units. Practical buying advice "
      + "for owners deciding whether to fit it now. Concrete visuals: transducers, sonar displays, trolling motors, boats "
      + "on the water, install shots.",
  },
  {
    key: "wc2",
    channel: "wet-circuit",
    format: "LONGFORM",
    targetS: 270, // 4:30 — middle
    topicTitle: "Lithium House Banks: What Actually Fails",
    topicUrl: "https://qualification.local/wet-circuit/lithium-house-bank-failures",
    summary:
      "LiFePO4 house banks are now standard on cruising boats, but the failure modes are different from AGM. "
      + "What actually fails: BMS low-temperature cutoffs stranding owners in winter, alternator overheating when a "
      + "lithium bank accepts full current indefinitely, DC-DC chargers sized wrongly, bus-bar corrosion, and shore-power "
      + "chargers with no lithium profile. Practical guidance on alternator regulation, temperature sensing, and wiring. "
      + "Concrete visuals: battery banks, wiring and bus bars, alternators, engine bays, electrical panels, boats at dock.",
  },
  {
    key: "wcshort",
    channel: "wet-circuit",
    format: "SHORT",
    targetS: 50,
    topicTitle: "Forward-Facing Sonar Is Changing Tournament Rules",
    topicUrl: "https://qualification.local/wet-circuit/ffs-tournament-rules",
    summary: "Short derived from the wc1 long-form narration.",
    derivedFrom: "wc1",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function repoFor(channel: ChannelKey) {
  const isWc = channel === "wet-circuit";
  return {
    isWc,
    getVideo: (id: string) =>
      isWc ? prisma.wcVideo.findUnique({ where: { id } }) : prisma.video.findUnique({ where: { id } }),
    updateVideo: (id: string, data: Record<string, unknown>) =>
      isWc
        ? prisma.wcVideo.update({ where: { id }, data: data as never })
        : prisma.video.update({ where: { id }, data: data as never }),
    setStatus: (id: string, status: string) =>
      isWc
        ? prisma.wcVideo.update({ where: { id }, data: { status: status as VideoStatus } })
        : prisma.video.update({ where: { id }, data: { status: status as VideoStatus } }),
  };
}

/** Reuse the row for this asset if a previous invocation already made one. */
async function findOrCreateRow(spec: AssetSpec) {
  const repo = repoFor(spec.channel);
  const marker = `[QUAL:${spec.key}]`;

  const topic = repo.isWc
    ? await prisma.wcTopic.upsert({
        where: { url: spec.topicUrl },
        create: { title: spec.topicTitle, url: spec.topicUrl, source: "qualification", summary: `${marker} ${spec.summary}`, score: 1, status: TopicStatus.APPROVED },
        update: {},
      })
    : await prisma.topic.upsert({
        where: { url: spec.topicUrl },
        create: { title: spec.topicTitle, url: spec.topicUrl, source: "qualification", summary: `${marker} ${spec.summary}`, score: 1, status: TopicStatus.APPROVED },
        update: {},
      });

  // Match on the topic, NOT on a marker inside failReason: quarantineJob
  // rewrites failReason, which previously destroyed the marker and caused a
  // second row — and therefore a second, unnecessary ElevenLabs charge — to be
  // created on the next run. Prefer a row that already has narration.
  const candidates = repo.isWc
    ? await prisma.wcVideo.findMany({ where: { topicId: topic.id }, orderBy: { createdAt: "desc" } })
    : await prisma.video.findMany({ where: { topicId: topic.id }, orderBy: { createdAt: "desc" } });
  const existing =
    candidates.find((c) => c.voiceoverPath && c.scriptJson) ?? candidates[0];
  if (existing) return { topic, video: existing, reused: true };

  const video = repo.isWc
    ? await prisma.wcVideo.create({ data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING, runMode: "LIVE", failReason: `${marker} qualification asset` } })
    : await prisma.video.create({ data: { topicId: topic.id, status: VideoStatus.SCRIPT_PENDING, failReason: `${marker} qualification asset` } });
  return { topic, video, reused: false };
}

function scriptChars(s: Script): number {
  return s.segments.reduce((a, x) => a + x.narration.length, 0);
}

/** Reject anything that must never reach a qualification asset. */
function validateScript(s: Script, targetChars: number, channel: ChannelKey): string[] {
  const problems: string[] = [];
  const all = s.segments.map((x) => x.narration).join(" ");

  const markers = findDiagnosticMarkers(all);
  if (markers.length) problems.push(`diagnostic markers: ${markers.join(", ")}`);

  for (const bad of ["as an ai", "i cannot", "i can't write", "lorem ipsum", "placeholder", "TODO", "```"]) {
    if (all.toLowerCase().includes(bad.toLowerCase())) problems.push(`placeholder/refusal text: "${bad}"`);
  }
  for (const meta of ["caption", "render", "this test", "qa ", "diagnostic"]) {
    if (all.toLowerCase().includes(meta)) problems.push(`meta/QA language: "${meta}"`);
  }

  const paras = s.segments.map((x) => x.narration.trim());
  if (new Set(paras).size !== paras.length) problems.push("repeated segment narration");

  // The character band is derived from the stage's RUNTIME range, not a fixed
  // multiplier. A ±45% band let a 7,071-char script through against a 5,736
  // target; at 12.45 chars/s that renders 9:32, well past the 8:00 ceiling.
  const chars = scriptChars(s);
  const range = runtimeRange(channel, "LONGFORM", "QUALIFICATION");
  const minChars = Math.round((range.minS - TITLE_CARD_S) * CHARS_PER_SECOND[channel]);
  const maxChars = Math.round((range.maxS - TITLE_CARD_S) * CHARS_PER_SECOND[channel]);
  if (chars < minChars) problems.push(`${chars} chars renders under ${fmtRuntime(range.minS)} (need ≥ ${minChars})`);
  if (chars > maxChars) problems.push(`${chars} chars renders over ${fmtRuntime(range.maxS)} (need ≤ ${maxChars})`);

  return problems;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--list")) {
    for (const a of ASSETS) {
      console.log(
        `  ${a.key.padEnd(9)} ${a.channel.padEnd(15)} ${a.format.padEnd(9)} target ${fmtRuntime(a.targetS)}  ` +
        `"${a.topicTitle}"${a.withdrawn ? "  [WITHDRAWN]" : ""}`,
      );
    }
    await disconnect();
    return;
  }

  const key = process.argv[2];
  const noUpload = process.argv.includes("--no-upload");
  const spec = ASSETS.find((a) => a.key === key);
  if (!spec) fail(`unknown asset "${key}" — try --list`);
  if (spec.withdrawn) {
    fail(`asset "${key}" is withdrawn from active qualification.\n    ${spec.withdrawn}`);
  }

  const stage = currentTestStage();
  if (stage !== "QUALIFICATION") fail(`TEST_STAGE is ${stage}, expected QUALIFICATION`);

  const tripped = (await breakerStatus()).filter((b) => b.tripped);
  if (tripped.length) fail(`circuit breaker open: ${tripped.map((t) => `${t.channel}=${t.trigger}`).join(", ")}`);

  console.log(`\n═══ PHASE 6 QUALIFICATION — ${spec!.key} — ${spec!.channel} ${spec!.format} ═══`);
  console.log(`  topic  : ${spec!.topicTitle}`);
  console.log(`  target : ${fmtRuntime(spec!.targetS)}`);

  if (spec!.format === "SHORT") {
    await runShort(spec!, noUpload);
    return;
  }
  await runLongform(spec!, noUpload);
}

async function runLongform(spec: AssetSpec, noUpload: boolean) {
  const repo = repoFor(spec.channel);
  const { topic, video, reused } = await findOrCreateRow(spec);
  console.log(`  row    : ${video.id}${reused ? " (reusing existing — narration will be reused)" : ""}`);

  const targetChars = charsForRuntime(spec.channel, spec.targetS);
  console.log(`  chars  : ~${targetChars} needed for ${fmtRuntime(spec.targetS)}`);

  // ── 1. Script ───────────────────────────────────────────────────────
  let script = (video as { scriptJson?: unknown }).scriptJson as Script | undefined;
  if (!script) {
    process.env.TARGET_RUNTIME_SECONDS = String(spec.targetS);
    const config = env();
    const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const ctx = { topic, video } as unknown as PipelineContext;

    const gen = spec.channel === "wet-circuit"
      ? await (await import("../packages/wc-pipeline/src/stages/scriptGenerator")).generateScript(anthropic, ctx)
      : await (await import("../src/stages/scriptGenerator")).generateScript(anthropic, ctx);

    if (gen.error || !gen.script) {
      fail(`script generation failed (${(gen as { failureType?: string }).failureType ?? "unknown"}): ${gen.error}`);
    }
    script = gen.script;
    const problems = validateScript(script!, targetChars, spec.channel);
    if (problems.length) fail(`script rejected before TTS:\n    - ${problems.join("\n    - ")}`);

    await repo.updateVideo(video.id, { scriptJson: script as never, status: VideoStatus.SCRIPT_DONE });
    console.log(`  script : ${script!.segments.length} segments, ${scriptChars(script!)} chars — validated`);
  } else {
    console.log(`  script : reusing stored script (${scriptChars(script)} chars)`);
  }

  // ── 1b. Visual feasibility — BEFORE any ElevenLabs call ─────────────
  //
  // Qualification asset ai1 was narrated, rendered, and only then found to be
  // unillustratable from the configured library: 38.5% of its timeline fell
  // back to cards because Pexels has almost no HBM, wafer or packaging
  // footage. That cost 7,071 credits to discover. The question is now asked
  // while it is still free to answer.
  //
  // Narration already bought is not re-gated — the credits are spent either
  // way, and blocking a resumed render would strand a paid-for asset.
  const alreadyNarrated = Boolean((video as { voiceoverPath?: string }).voiceoverPath);
  if (!alreadyNarrated) {
    const feas = await assessVisualFeasibility(
      {
        channel: spec.channel,
        topicTitle: spec.topicTitle,
        targetRuntimeS: spec.targetS,
        segments: script!.segments.map((s) => ({
          segmentIndex: s.segmentIndex,
          title: s.title,
          narration: s.narration,
          visual_prompt: s.visual_prompt,
        })),
      },
      pexelsOnlySource(env().PEXELS_API_KEY),
    );
    console.log(`\n${formatFeasibility(feas)}\n`);
    await writeFile(
      join(process.cwd(), "output", `feasibility-${spec.key}.json`),
      JSON.stringify(feas, null, 2),
    ).catch(() => {});

    if (!feas.pass) {
      fail(
        `visual feasibility FAILED — no narration purchased, zero credits spent.\n    ${feas.failureReason}`,
      );
    }
    console.log(`  feasibility: PASS — safe to purchase narration`);

    // Pre-TTS-only mode: evaluate a script against the real gate and stop.
    //
    // Off by default and fail-closed — it returns before the voiceover stage,
    // so no credit is reserved, no ElevenLabs call is made, no footage is
    // acquired or rendered, no upload intent is created and YouTube is never
    // contacted. Exists so a replacement script can be judged by the same gate
    // the real run uses without spending anything. Local only; Railway never
    // passes this flag.
    if (process.argv.includes("--pre-tts-only")) {
      console.log(
        `\n  --pre-tts-only: stopping after the feasibility gate. ` +
        `No credits reserved, no narration purchased, no render, no upload.`,
      );
      await disconnect();
      return;
    }
  } else {
    console.log(`  feasibility: skipped — narration already purchased for this row`);
  }

  // ── 2. Narration (idempotent) ───────────────────────────────────────
  const before = await creditsChargedFor(video.id);
  const ctx = { topic, video, script } as unknown as PipelineContext;
  const vo = await runVoiceover(ctx, {
    channel: spec.channel, label: `qual:${spec.key}:voiceover`, testStage: "QUALIFICATION",
    updateVideo: repo.updateVideo, setStatus: repo.setStatus,
  });
  if (!vo.success) fail(`voiceover failed: ${vo.error}`);
  const afterTts = await creditsChargedFor(video.id);
  console.log(`  credits: ${afterTts} total (+${afterTts - before} this run)`);

  // ── 3. Assembly ─────────────────────────────────────────────────────
  const asm = await runAssembly(ctx, {
    channel: spec.channel, label: `qual:${spec.key}:assembly`, testStage: "QUALIFICATION", ...repo,
  });
  if (!asm.success || !asm.data) fail(`assembly failed: ${asm.error}`);
  const out = asm.data;

  // ── 4. QA ───────────────────────────────────────────────────────────
  const qaInput = {
    channel: spec.channel, videoId: video.id, assetKind: "LONGFORM" as const,
    videoPath: out.videoPath, narrationPath: out.narrationPath,
    narrationStartS: out.narrationStartS,
    cues: out.captions.cues, words: out.captions.words,
    expectedWidth: 1920, expectedHeight: 1080, expectedFps: 30,
    testStage: "QUALIFICATION" as const,
  };
  const qa = await runQa(qaInput);
  console.log(`\n${formatQa(qa)}`);

  const rt = checkRuntime(qa.metrics.videoDurationS ?? 0, spec.channel, "LONGFORM", "QUALIFICATION");
  console.log(`\n  runtime: ${rt.detail}`);

  const anchors = extractSyncAnchors(out.captions.words, out.captions.cues);
  console.log("\n── natural synchronisation anchors (derived from the script itself) ──");
  console.log(formatAnchors(anchors));

  console.log("\n── visual relevance ──");
  for (const sc of await sceneRecordsFor(video.id)) {
    console.log(`  scene ${sc.sceneNumber}: [${sc.relevanceVerdict} ${sc.relevanceScore?.toFixed(2)}] "${sc.assetDescription ?? sc.assetSource}"`);
  }

  // Frames for internal inspection.
  const framesDir = join(process.cwd(), "output", video.id, "frames");
  await mkdir(framesDir, { recursive: true });
  const dur = qa.metrics.videoDurationS ?? spec.targetS;
  for (const t of [5, dur * 0.2, dur * 0.4, dur * 0.6, dur * 0.8, dur - 4]) {
    await extractFrame(out.videoPath, t, join(framesDir, `q${t.toFixed(0)}.jpg`)).catch(() => {});
  }

  // Quarantine so monitors never treat a private qualification asset as content.
  await quarantineJob({
    channel: spec.channel, videoId: video.id, table: repo.isWc ? "wc_video" : "Video",
    reason: `Phase 6 qualification asset ${spec.key} — private, never resume/poll/publish`,
    operator: "Max (via Claude Code)", actionSource: "scripts/qualify.ts",
  }).catch(() => {});

  const qaId = await persistQa(
    { ...qaInput, verifiedChannelId: CHANNELS[spec.channel].id },
    qa, { reviewer: "automated+internal-frames; Max manual review PENDING" },
  );

  console.log(`\n  QA record: ${qaId}`);
  console.log(`  video    : ${out.videoPath}`);
  console.log(`  frames   : ${framesDir}`);

  // ── Immutable approval ──────────────────────────────────────────────
  const manifest = out.beats.map((b) => ({
    index: b.index, startS: b.startS, endS: b.endS, durationS: b.durationS,
    assetId: b.assetId, assetDescription: b.assetDescription,
    looped: b.looped, reused: b.reused,
    relevanceScore: b.relevanceScore, concept: b.concept,
    brandDecision: b.brand.brandDecision, decision: b.decision,
  }));
  const fileSha256 = await sha256File(out.videoPath);
  const manifestSha256 = sha256Manifest(manifest);
  await storeApproval({
    videoId: video.id, filePath: out.videoPath, fileSha256, manifestSha256,
    manifest, qaRecordId: qaId, approvedAt: new Date().toISOString(),
  });

  console.log(`\n── visual timeline (${manifest.length} beats) ──`);
  for (const b of manifest) {
    console.log(
      `  ${String(b.index).padStart(2)} ${fmtRuntime(TITLE_CARD_S + b.startS)}–${fmtRuntime(TITLE_CARD_S + b.endS)} ` +
      `(${b.durationS.toFixed(1)}s) ${b.assetId ?? "CARD"} [${b.relevanceScore?.toFixed(2) ?? "-"} ${b.concept}] ` +
      `brand=${b.brandDecision} "${(b.assetDescription ?? "").slice(0, 46)}"`,
    );
  }
  const durs = manifest.map((b) => b.durationS);
  console.log(
    `  beats=${manifest.length} avg=${(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1)}s ` +
    `max=${Math.max(...durs).toFixed(1)}s (cap ${BEAT_MAX_S}s) cards=${manifest.filter((b) => b.decision === "FALLBACK_CARD").length} ` +
    `looped=${manifest.filter((b) => b.looped).length} reused=${manifest.filter((b) => b.reused).length}`,
  );
  console.log(`\n  approved file sha256    : ${fileSha256}`);
  console.log(`  approved manifest sha256: ${manifestSha256}`);

  if (qa.overall !== "PASS") fail("automated QA did not pass — not uploading");
  if (!noUpload) {
    await verifyApproved({ filePath: out.videoPath, fileSha256, manifestSha256, manifest });
    await upload(spec, video.id, out.videoPath, qaId, fileSha256, manifestSha256);
  }

  await disconnect();
}

async function runShort(spec: AssetSpec, noUpload: boolean) {
  fail(
    `Shorts are produced by each channel's shortsGenerator from an existing long-form package. ` +
    `Run the long-form asset "${spec.derivedFrom}" first, then invoke the Short path against it.`,
  );
  void noUpload;
}

/**
 * Upload an ALREADY-APPROVED artifact.
 *
 * This function performs no script generation, no ElevenLabs call, no visual
 * search or selection, no assembly, no caption rendering and no thumbnail
 * work. It sends the exact file whose hash was approved, or it fails closed.
 */
async function upload(
  spec: AssetSpec, videoId: string, videoPath: string, qaId: string,
  fileSha256: string, manifestSha256: string,
) {
  const actual = await sha256File(videoPath);
  if (actual !== fileSha256) {
    fail(`artifact changed since approval — expected ${fileSha256.slice(0, 16)}… got ${actual.slice(0, 16)}…`);
  }
  const repo = repoFor(spec.channel);
  const row = await repo.getVideo(videoId);
  if (isRealYoutubeId(row?.youtubeId)) fail(`already uploaded as ${row!.youtubeId}`);

  await verifyChannel(CHANNELS[spec.channel], `qual:${spec.key}`);

  const port = createGoogleYouTubePort();
  const persistYoutubeId = async (_intent: unknown, id: string) => {
    await repo.updateVideo(videoId, { youtubeId: id });
  };

  // Resolve anything an earlier crash left open BEFORE considering an upload.
  // A null youtubeId is not evidence that YouTube never accepted this asset.
  const pending = await reconcileAll({
    port, store: prismaIntentStore, persistYoutubeId, channel: spec.channel,
  });
  for (const p of pending) {
    console.log(`  reconciled intent ${p.intent.id}: ${p.outcome}`);
  }

  const title = `[PRIVATE QUALIFICATION] ${spec.topicTitle}`.slice(0, 100);
  console.log(`\n  uploading "${title}" …`);

  let youtubeId: string;
  try {
    const result = await guardedUpload(
      {
        channelKey: spec.channel,
        assetKey: spec.key,
        videoId,
        testStage: currentTestStage(),
        format: spec.format,
        filePath: videoPath,
        fileSha256,
        manifestSha256,
        metadata: {
          title,
          description:
            "PRIVATE PHASE 6 QUALIFICATION ASSET — not for publication.\n\n"
            + "Awaiting manual editorial review. This video must remain private.",
          tags: ["qualification", "internal"],
          categoryId: "28",
          privacyStatus: "private",
          publishAt: null,
        },
        expectedDurationS: spec.targetS,
        existingYoutubeId: row?.youtubeId ?? null,
        verifiedChannelId: CHANNELS[spec.channel].id,
        actualFileSha256: actual,
        actualManifestSha256: manifestSha256,
      },
      { port, store: prismaIntentStore, persistYoutubeId },
    );
    youtubeId = result.youtubeId;
    console.log(`  upload outcome: ${result.status} (intent ${result.intent.id})`);
  } catch (err) {
    if (err instanceof UploadBlockedError) {
      fail(`upload blocked [${err.code}]: ${err.message}`);
    }
    throw err;
  }

  const yt = buildYouTubeClient();
  const check = await yt.videos.list({ part: ["status", "snippet"], id: [youtubeId] });
  const item = check.data.items?.[0];
  const privacy = item?.status?.privacyStatus;
  const owner = item?.snippet?.channelId;
  const publishAt = (item?.status as { publishAt?: string } | undefined)?.publishAt ?? null;
  const dupA = await prisma.video.count({ where: { youtubeId } });
  const dupW = await prisma.wcVideo.count({ where: { youtubeId } });

  await prisma.qaRecord.update({
    where: { id: qaId },
    data: { youtubeId, privacyStatus: privacy ?? null, verifiedChannelId: CHANNELS[spec.channel].id },
  });

  console.log(`  youtube  : ${youtubeId}`);
  console.log(`  watch    : https://www.youtube.com/watch?v=${youtubeId}`);
  console.log(`  studio   : https://studio.youtube.com/video/${youtubeId}/edit`);
  console.log(`  channel  : ${owner} ${owner === CHANNELS[spec.channel].id ? "✓" : "✗ MISMATCH"}`);
  console.log(`  privacy  : ${privacy} ${privacy === "private" ? "✓" : "✗"}`);
  console.log(`  publishAt: ${publishAt ?? "none ✓"}`);
  console.log(`  db rows  : ${dupA + dupW} ${dupA + dupW === 1 ? "✓" : "✗"}`);
}

// Only run when invoked directly. scripts/verify-phase6-state.ts imports
// ASSETS to derive the authorized-asset set, and importing must not start a
// qualification run.
if (require.main === module) {
  main().catch(async (e) => {
    console.error("\nQUALIFICATION RUN FAILED:", e);
    await disconnect();
    process.exit(1);
  });
}
