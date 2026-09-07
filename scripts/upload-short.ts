/**
 * Upload one already-rendered Short to YouTube as PRIVATE. Nothing else.
 *
 *   npx tsx scripts/upload-short.ts --video <candidateId>            # dry run
 *   npx tsx scripts/upload-short.ts --video <candidateId> --yes      # upload
 *
 * Safety properties, all enforced here rather than trusted:
 *  - PRIVATE always. `privacyStatus` comes from `prepareUpload`, which types it
 *    as the literal "private"; it is asserted again before the insert. No
 *    `publishAt` is ever sent, so nothing can be scheduled to publish.
 *  - Channel verified via `prepareUpload` -> `verifyChannel`, which fails closed
 *    and trips the breaker on the wrong channel.
 *  - Double-upload guarded: a parent row that already carries a real shortsUrl
 *    is refused.
 *  - Confirmed after the fact with `confirmUploadState(expectPrivate: true)`.
 *  - The quarantined candidate is refused by id.
 *  - Renders nothing. The MP4 must already exist and is uploaded byte-for-byte.
 *
 * NOTE ON AUTH: this uses pipeline-core's `buildYouTubeClient()` — the single
 * hardened constructor that `verifyChannel` and `confirmUploadState` also use —
 * NOT the private `getYouTubeClient()` inside src/stages/shortsGenerator.ts,
 * which reads YOUTUBE_REFRESH_TOKEN from the environment directly and therefore
 * can authenticate as a different credential than the one just verified.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  prisma, disconnect, prepareUpload, confirmUploadState, isRealYoutubeId,
  buildYouTubeClient, checkTitleFidelity,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

/** Never process this candidate: its long-form is quarantined. */
const QUARANTINED = new Set(["cmsw5jcqb0002mb2kjg7a59vg"]);

interface Plan { title: string; description: string; tags: string[] }

const PLANS: Record<string, Plan> = {
  cmsw31q0v0001mb0ybuc0jvkn: {
    title: "Google Just Let You Erase Its AI Watermark — But One Layer Never Goes Away #Shorts",
    description:
      "Google now lets you strip the visible watermark off images made with its AI tools. "
      + "The catch: an invisible layer stays behind, so the image never actually becomes untraceable.\n\n"
      + "Full video: https://youtu.be/3U0NNID40ek\n\n"
      + "#AI #GoogleAI #Watermark #AITransparency #Shorts",
    tags: ["Google AI watermark", "invisible watermark AI", "AI transparency", "AI content detection", "SynthID", "Shorts"],
  },
  cmsxnntzb000dmb02glblt634: {
    title: "AI Is Already Hacking Critical Infrastructure — And Defenders Might Be Winning #Shorts",
    description:
      "The same AI that debugs your code is being used against critical infrastructure right now — not hypothetically. "
      + "OpenAI's framework, The Defender's Window, argues security teams finally have a real shot at staying ahead.\n\n"
      + "Full video: https://youtu.be/JomCkkxN-AM\n\n"
      + "#AI #Cybersecurity #OpenAI #InfoSec #Shorts",
    tags: ["AI cybersecurity", "OpenAI", "Defenders Window", "AI security", "cyber threats", "Shorts"],
  },
  cmsxrnljw0002mbgexsr5stk5: {
    title: "33% More From the Same GPUs — No New Hardware, Just a Different Order #Shorts",
    description:
      "Same cluster, same chips, same workloads — 33% more out of the hardware, purely by changing the order of operations. "
      + "A team at Dharma-AI published the result.\n\n"
      + "Full video: https://youtu.be/J1Hsexuz0wI\n\n"
      + "#AI #GPU #Infrastructure #MachineLearning #Shorts",
    tags: ["GPU utilization", "GPU scheduling", "enterprise AI infrastructure", "AI compute", "GPU cluster optimization", "Shorts"],
  },
  cmsxtewey0001mb31hgzxzjfj: {
    title: "OpenAI Just Funded 14 Independent Teams — And Shipped No Product #Shorts",
    description:
      "No product launch, no demo. OpenAI funded 14 independent research teams to work out how governments and "
      + "societies should actually handle the AI era.\n\n"
      + "Full video: https://youtu.be/F8OGauPOZJU\n\n"
      + "#OpenAI #AIPolicy #AIGovernance #AI #Shorts",
    tags: ["OpenAI", "AI policy", "AI governance", "AI research funding", "Intelligence Age", "Shorts"],
  },
  cmsxuehvm0006mbjmmwv68ie2: {
    title: "An AI Fixed a Bug and Created One — Then Another AI Walked Out With the Keys #Shorts",
    description:
      "An AI tool built to fix security bugs introduced one instead. Another AI found it autonomously, broke in, "
      + "and walked out with credentials to Snowflake's internal Jira.\n\n"
      + "Full video: https://youtu.be/tp0mx240lI4\n\n"
      + "#AI #Cybersecurity #GitHub #AppSec #Shorts",
    tags: ["AI security", "AI-generated code", "CI/CD security", "credential exfiltration", "AppSec", "Shorts"],
  },
  cmtnc1mlk002qmby29mic5n6p: {
    title: "What Does AI;DR Mean? #Shorts",
    description:
      "AI;DR — \"AI; didn't read\" — is spreading as shorthand for ignoring "
      + "AI-generated text. It started with a single post in August 2026.\n\n"
      + "Full video: https://youtu.be/wWEzzLhRejM\n\n"
      + "#AI #AIDR #AISlop #GenerativeAI #Shorts",
    tags: ["AI;DR", "AI slop", "TL;DR", "artificial intelligence", "AI writing",
           "AI content", "AI at work", "generative AI", "internet slang",
           "AI communication", "Shorts"],
  },
};

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
};

async function main(): Promise<void> {
  const id = arg("--video");
  const commit = process.argv.includes("--yes");
  if (!id) { console.error("✗ --video <candidateId> required"); process.exitCode = 2; return; }
  if (QUARANTINED.has(id)) { console.error(`✗ REFUSED: ${id} is quarantined and must never publish`); process.exitCode = 1; return; }

  const plan = PLANS[id];
  if (!plan) { console.error(`✗ no title/description plan for ${id}`); process.exitCode = 1; return; }

  const shortPath = resolve(`tmp/shorts/${id}/short.mp4`);
  if (!existsSync(shortPath)) { console.error(`✗ no rendered Short at ${shortPath}`); process.exitCode = 1; return; }

  const video = await prisma.video.findUnique({ where: { id }, select: {
    id: true, youtubeId: true, shortsUrl: true, seoTitle: true, updatedAt: true } });
  if (!video) { console.error(`✗ no candidate ${id}`); process.exitCode = 1; return; }
  if (!video.youtubeId) { console.error("✗ parent has no youtubeId"); process.exitCode = 1; return; }

  console.log(`\n  candidate     : ${id}`);
  console.log(`  parent        : ${video.youtubeId}`);
  console.log(`  file          : ${shortPath} (${(statSync(shortPath).size / 1048576).toFixed(1)} MB)`);
  console.log(`  ROW BEFORE    : shortsUrl=${video.shortsUrl ?? "null"}  updatedAt=${video.updatedAt.toISOString()}`);
  console.log(`\n  title         : ${plan.title}  [${plan.title.length} chars]`);
  console.log(`  description   :\n${plan.description.split("\n").map(l => "      " + l).join("\n")}`);

  // The double-upload guard, on the Short's own id stored in shortsUrl.
  const existingShortId = video.shortsUrl?.split("/").pop() ?? null;
  if (isRealYoutubeId(existingShortId)) {
    console.error(`\n✗ REFUSED: a Short already exists for this candidate (${video.shortsUrl})`);
    process.exitCode = 1; return;
  }

  const decision = await prepareUpload({
    channelKey: "ai-doom-scroll",
    serviceLabel: "shorts-backfill",
    existingYoutubeId: existingShortId,
    scheduledSlot: null,               // never scheduled; the human publishes
  });
  console.log(`\n  channel verified: ${decision.verifiedChannelId}`);
  console.log(`  privacyStatus   : ${decision.privacyStatus}`);
  console.log(`  publishAt       : ${decision.publishAt === null ? "null (nothing scheduled)" : String(decision.publishAt)}`);
  if (decision.alreadyUploaded) { console.error("✗ REFUSED by prepareUpload: already uploaded"); process.exitCode = 1; return; }

  // Belt and braces: refuse anything that is not exactly a private, unscheduled upload.
  if (decision.privacyStatus !== "private") { console.error("✗ ABORT: privacyStatus is not private"); process.exitCode = 1; return; }
  if (decision.publishAt !== null) { console.error("✗ ABORT: a publishAt was computed; refusing to schedule"); process.exitCode = 1; return; }

  if (!commit) { console.log("\n  DRY RUN — pass --yes to upload. Nothing sent.\n"); await disconnect(); return; }

  const youtube = buildYouTubeClient();
  console.log("\n  uploading (private)…");
  const res = await youtube.videos.insert({
    part: ["snippet", "status"],   // insert accepts only writable parts
    requestBody: {
      snippet: {
        title: plan.title.slice(0, 100),
        description: plan.description,
        tags: plan.tags,
        categoryId: "28",
      },
      status: {
        privacyStatus: decision.privacyStatus,   // "private"
        selfDeclaredMadeForKids: false,
        // no publishAt: nothing is ever scheduled by this script
      },
    },
    media: { body: createReadStream(shortPath) },
  });

  const shortId = res.data.id;
  if (!shortId) {
    console.error("✗ YouTube accepted the upload but returned no id — NOT writing shortsUrl. Reconcile by hand.");
    process.exitCode = 1; return;
  }
  console.log(`  returned id     : ${shortId}`);
  console.log(`  api privacy     : ${res.data.status?.privacyStatus}`);
  console.log(`  api uploadStatus: ${res.data.status?.uploadStatus}`);

  // processingDetails is read-only: fetch it back rather than requesting it on insert.
  const back = await youtube.videos.list({
    part: ["snippet", "status", "processingDetails"], id: [shortId],
  });
  const got = back.data.items?.[0];
  console.log(`  processingStatus: ${got?.processingDetails?.processingStatus}`);
  console.log(`  api title       : ${got?.snippet?.title}`);
  console.log(`  api channelId   : ${got?.snippet?.channelId}`);
  console.log(`  api description :\n${(got?.snippet?.description ?? "").split("\n").map(l => "      " + l).join("\n")}`);

  const confirmed = await confirmUploadState({
    channelKey: "ai-doom-scroll",
    serviceLabel: "shorts-backfill",
    youtubeId: shortId,
    expectPrivate: true,
    videoId: id,
  });

  if (confirmed.privacyStatus !== "private") {
    console.error(`✗ ABORT: confirmed privacy is ${confirmed.privacyStatus}, not private — NOT writing shortsUrl`);
    process.exitCode = 1; return;
  }

  const shortsUrl = `https://youtube.com/shorts/${shortId}`;
  const after = await prisma.video.update({ where: { id }, data: { shortsUrl },
    select: { id: true, shortsUrl: true, updatedAt: true, youtubeId: true } });
  console.log(`\n  ROW AFTER     : shortsUrl=${after.shortsUrl}  updatedAt=${after.updatedAt.toISOString()}`);
  console.log(`\n  ✓ PRIVATE. Not published. The human publishes manually.\n`);
  await disconnect();
}

main().catch(async (e) => { console.error(e); await disconnect(); process.exitCode = 1; });
