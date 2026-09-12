import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { VideoStatus } from "@prisma/client";
import {
  prisma, env, createMessage, selectFaithfulTitle, checkMetadataClaim,
  findPlaceholders, stripPlaceholders, screenDisallowed, dropDisallowed,
} from "@yt-pipeline/pipeline-core";
import type { PipelineContext, SEOMetadata, StageResult } from "@yt-pipeline/pipeline-core";
import { WC_LIBRARY_DISALLOWED } from "./topicDiscovery";

const execFile = promisify(execFileCb);
const FFPROBE = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

// ── Pillar type ─────────────────────────────────────────────────────────────

type Pillar = "RANKED_LIST" | "HEAD_TO_HEAD" | "NEW_OWNER" | "NEW_DROP";

// ── Audio helpers ───────────────────────────────────────────────────────────

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFile(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ]);
  return parseFloat(stdout.trim());
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

const thumbnailTextSchema = z.object({
  headline: z.string().max(30),
  subtext: z.string().max(30),
  badge: z.string().max(20).optional(),
});

const seoSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().min(300),
  tags: z.array(z.string()).min(15).max(25),
  chapters: z.array(
    z.object({
      time: z.string().regex(/^\d+:\d{2}$/),
      label: z.string().min(1),
    }),
  ).min(2),
  thumbnailText: thumbnailTextSchema,
});

const titleCandidateSchema = z.array(
  z.object({ title: z.string(), rationale: z.string() }),
).min(3);

const titleScoreSchema = z.array(
  z.object({
    title: z.string(),
    scores: z.object({
      curiosity_gap: z.number(),
      specificity: z.number(),
      search_intent_match: z.number(),
      urgency: z.number(),
    }),
    total: z.number(),
  }),
);

const titleRewriteSchema = z.array(
  z.object({
    title: z.string(),
    type: z.enum(["refined", "wildcard"]),
    reasoning: z.string(),
  }),
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitize tags for YouTube API compliance.
 * - Strip whitespace, remove special chars (<, >, &, quotes)
 * - Truncate individual tags to 100 chars
 * - Cap total character count at 500
 */
function sanitizeTags(tags: string[]): string[] {
  const cleaned = tags
    .map((t) => t.trim().replace(/[<>&"']/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, 100));

  const result: string[] = [];
  let totalChars = 0;
  for (const tag of cleaned) {
    if (totalChars + tag.length > 500) break;
    result.push(tag);
    totalChars += tag.length;
  }
  return result;
}

function parseJSON(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(raw);
}

async function callClaude(
  anthropic: Anthropic,
  system: string,
  userPrompt: string,
  maxTokens = 2048,
): Promise<string> {
  const message = await createMessage(anthropic, {
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text in Claude response");
  }
  return textBlock.text;
}

function extractPillar(topic: PipelineContext["topic"]): Pillar {
  const summary = topic.summary ?? "";
  const match = summary.match(/^\[(RANKED_LIST|HEAD_TO_HEAD|NEW_OWNER|NEW_DROP)\]/);
  if (match) return match[1] as Pillar;

  const text = `${topic.title} ${summary}`.toLowerCase();
  if (/top \d|best \d|\d+ best|roundup/.test(text)) return "RANKED_LIST";
  if (/\bvs\b|versus|compared|comparison/.test(text)) return "HEAD_TO_HEAD";
  if (/new|launch|release|announce|first look/.test(text)) return "NEW_DROP";
  return "NEW_OWNER";
}

// ── Pillar-specific title formulas ──────────────────────────────────────────

const TITLE_FORMULAS: Record<Pillar, string> = {
  RANKED_LIST: `Title formulas for RANKED LIST:
- "Top [N] [Product Category] for [Year]"
- "Best [Product] Under $[Price] ([Year])"
- "[N] [Products] That Are Actually Worth It ([Year])"
Include the year where relevant. Include specific product categories and price points from the script.`,

  HEAD_TO_HEAD: `Title formulas for HEAD TO HEAD:
- "[Brand A] vs [Brand B]: Which One Should You Buy?"
- "[Model A] vs [Model B] — Clear Winner"
- "I Tested [Brand A] and [Brand B] — Here's the Truth"
Use actual brand/model names from the script. Make clear a verdict exists.`,

  NEW_OWNER: `Title formulas for NEW OWNER (explainer):
- "[Question format] — [Plain answer or promise]"
- "What Every New Boat Owner Needs to Know About [Topic]"
- "[Topic] Explained in [N] Minutes"
Frame as a question a beginner would search for. Answer or promise in the subtitle.`,

  NEW_DROP: `Title formulas for NEW DROP (product announcement):
- "[Brand] Just Released [Product] — Here's What Changed"
- "The New [Product] Changes Everything (Or Does It?)"
- "[Brand]'s New [Product]: Worth the Upgrade?"
Use the actual brand and product name. Focus on what changed, not hype.`,
};

// ── Title generation (3-round loop) ─────────────────────────────────────────

interface TitleResult {
  primary: string;
  primaryScore: number;
  variantB: string;
  variantC: string;
}

async function generateTitles(
  anthropic: Anthropic,
  topicTitle: string,
  scriptSummary: string,
  pillar: Pillar,
  /**
   * The FULL narration, for the fidelity check — not `scriptSummary`, which is
   * the hook plus segment titles and contains none of the disclaimers a title
   * can contradict. "None of them are bad" and "that video is coming" both
   * live in segment narration only.
   */
  evidence: string,
): Promise<TitleResult> {
  // Round 1 — generate candidates using pillar formula
  console.log("[wc:seoGenerator] Title round 1: generating candidates...");
  const round1Raw = await callClaude(
    anthropic,
    `You are a YouTube title expert for "Wet Circuit", a marine electronics channel.`,
    `Generate 5 YouTube title candidates for this script.

Topic: ${topicTitle}
Script summary: ${scriptSummary}

${TITLE_FORMULAS[pillar]}

HARD RULES:
- 60 characters max per title
- No clickbait that doesn't deliver
- No ALL CAPS words
- No emoji
- Be specific — use product names, brands, and model numbers from the script when available

Return ONLY a JSON array: [{"title": "...", "rationale": "..."}]`,
    1024,
  );

  const candidates = titleCandidateSchema.parse(parseJSON(round1Raw));
  console.log(`[wc:seoGenerator] Round 1: ${candidates.length} candidates`);
  for (const c of candidates) {
    console.log(`[wc:seoGenerator]   "${c.title}"`);
  }

  // Round 2 — score
  console.log("[wc:seoGenerator] Title round 2: scoring...");
  const round2Raw = await callClaude(
    anthropic,
    "You are a YouTube title analyst for marine/boating content. Score titles objectively.",
    `Score each title from 1-10 on these dimensions:
- curiosity_gap: Does it make a boater want to click?
- specificity: Does it name specific products, brands, or numbers?
- search_intent_match: Would someone searching for this topic find this title?
- urgency: Does it feel timely or important to watch now?

Return ONLY JSON: [{"title": "...", "scores": {"curiosity_gap": N, "specificity": N, "search_intent_match": N, "urgency": N}, "total": N}]

Titles to score:
${JSON.stringify(candidates.map((c) => c.title))}`,
    1024,
  );

  const scored = titleScoreSchema.parse(parseJSON(round2Raw));
  scored.sort((a, b) => b.total - a.total);
  console.log("[wc:seoGenerator] Round 2 scores:");
  for (const s of scored) {
    console.log(`[wc:seoGenerator]   ${s.total}/40 "${s.title}"`);
  }

  const top2 = scored.slice(0, 2);

  // Round 3 — rewrite top 2 + wildcard
  console.log("[wc:seoGenerator] Title round 3: rewriting top 2 + wildcard...");
  const round3Raw = await callClaude(
    anthropic,
    "You are a YouTube CTR optimization expert for marine electronics content.",
    `Rewrite these 2 titles to maximize CTR for a marine electronics audience.
Apply: stronger verbs, cut filler, front-load the hook. Stay under 60 characters.
Also generate 1 wildcard title that breaks the pattern entirely.
No ALL CAPS. No emoji.

Return ONLY JSON: [{"title": "...", "type": "refined" | "wildcard", "reasoning": "..."}]

Titles to rewrite:
1. "${top2[0].title}" (score: ${top2[0].total}/40)
2. "${top2[1].title}" (score: ${top2[1].total}/40)

Topic: ${topicTitle}`,
    1024,
  );

  const rewritten = titleRewriteSchema.parse(parseJSON(round3Raw));
  const refined = rewritten.filter((r) => r.type === "refined");
  const wildcard = rewritten.find((r) => r.type === "wildcard");

  console.log("[wc:seoGenerator] Round 3 results:");
  for (const r of rewritten) {
    console.log(`[wc:seoGenerator]   [${r.type}] "${r.title}" — ${r.reasoning}`);
  }

  // A title may not assert what the script disclaims. Round 3 optimises purely
  // for CTR and will happily turn a script that refuses to pick a winner into
  // "Which One Wins?" — so every candidate is checked against the narration and
  // the first supported one wins. AI Doom's seoGenerator has done this since
  // the credit-resale run; Wet Circuit's was a near-clone that never picked it
  // up, which is why "ALL THREE TESTED" had nothing standing in its way.
  // The topic-derived baseline is the fallback: it asserts nothing the script
  // does not.
  const ranked = [
    ...refined.map((r) => r.title),
    ...(wildcard ? [wildcard.title] : []),
    ...scored.map((s) => s.title),
  ];
  const faithful = selectFaithfulTitle(ranked, `${topicTitle}\n${evidence}`, topicTitle);
  for (const d of faithful.disqualified) {
    console.log(`[wc:seoGenerator]   DISQUALIFIED "${d.title}" — ${d.reason}`);
  }
  if (faithful.usedBaseline) {
    console.log(`[wc:seoGenerator] no candidate was supported by the script — using the topic baseline`);
  }

  // Variants are A/B alternates for the same video and get the same treatment;
  // an unsupported variant is dropped back to the winner rather than shipped.
  const supported = (t: string | undefined, fallback: string): string =>
    t && checkMetadataClaim(t, evidence).ok ? t : fallback;

  const primary = faithful.title;
  const variantB = supported(refined[1]?.title ?? refined[0]?.title, primary);
  const variantC = supported(wildcard?.title, primary);

  return {
    primary,
    primaryScore: top2[0].total,
    variantB,
    variantC,
  };
}

// ── Description / tags / chapters / thumbnail text prompt ───────────────────

const SEO_SYSTEM_PROMPT = `You are a YouTube SEO expert for "Wet Circuit", a marine electronics channel.
Given a topic, script, pre-selected title, and content pillar, generate the remaining metadata.

DESCRIPTION REQUIREMENTS (300-500 words):
1. First 2 sentences: What the video covers and why it matters. These show in search preview — make them count. Write them for a boater who is deciding whether to click.
2. Blank line, then "GEAR MENTIONED IN THIS VIDEO:" section. List ONLY products actually named in the script, one per line, as a bare product name:
   - Tinned Marine-Grade Wire (14 AWG)
   NEVER emit a bracketed placeholder, template token, or fake URL of any kind —
   no "[AFFILIATE_LINK_placeholder]", no "[link]", no "coming soon". Affiliate
   links are attached later by a human; a line with just the product name is
   correct and complete. If the script names no products, write exactly:
   "No specific products were mentioned in this video." and nothing else.
3. Blank line, then "TIMESTAMPS:" section using the exact chapter timestamps provided.
4. Blank line, then: "New videos every Monday, Wednesday, and Friday."
5. Blank line, then: "Marine electronics, decoded. — Wet Circuit"
6. Blank line, then 5-8 relevant hashtags from this pool (pick what fits):
   #marineelectronics #fishing #boating #fishfinder #chartplotter #boatelectronics #garmin #humminbird #lowrance #simrad #trollingmotor #autopilot #vhf #radar #ais #nmea2000

TAG REQUIREMENTS (15-20 tags):
Mix these four categories:
- Exact match: specific product names and model numbers mentioned in the script
- Broad: "marine electronics", "boat electronics", "marine electronics explained"
- Brand: Garmin, Humminbird, Lowrance, Simrad, Raymarine, Furuno — only brands relevant to this video
- Audience: "boat electronics", "fishing electronics", "boating tips", "new boat owner"

SUBJECTS THIS CHANNEL DOES NOT COVER — never appear in a tag, hashtag, chapter
label or description: kayaks, canoes, paddleboards/SUP, personal watercraft/PWC,
jet skis, WaveRunners, Sea-Doos. Powerboat helm electronics only.

CLAIMS YOU MAY NOT MAKE. The script is the only evidence you have:
- Do NOT use "tested", "proven", "we tested", "hands-on" or "test results"
  unless the script describes testing that was ALREADY DONE. A script promising
  a future comparison ("that video is coming", "subscribe and you'll see it")
  is proof no test happened — do not tag it "boat electronics review" either.
- Do NOT declare a single winner if the script declines to ("none of them are
  bad", "neither is better", "it depends"). Mirror the script's stance.
- Do NOT claim anything is deadly, fatal or kills unless the script says so.

THUMBNAIL TEXT (for overlay graphics):
- headline: Main text, 5 words max, e.g. "TOP 5 PICKS"
- subtext: Supporting text, 5 words max, e.g. "Under $500"
- badge: Optional corner badge, 3 words max, e.g. "2026 Guide" (omit if not applicable)

CHAPTER REQUIREMENTS:
- Use the exact timestamps provided. First chapter MUST start at 0:00.

Respond ONLY with valid JSON:
{
  "title": "The pre-selected title (copy it exactly)",
  "description": "Full description...",
  "tags": ["tag1", "tag2", ...],
  "chapters": [{"time": "0:00", "label": "Introduction"}, ...],
  "thumbnailText": {"headline": "...", "subtext": "...", "badge": "..."}
}`;

// ── Stage entry point ───────────────────────────────────────────────────────

/**
 * Stage 7: Generate SEO-optimized title, description, tags, chapters,
 * and thumbnail text suggestions for Wet Circuit videos.
 *
 * Title generation uses a 3-round loop (generate → score → rewrite)
 * with pillar-specific title formulas.
 */
export async function seoGenerator(
  ctx: PipelineContext,
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.script) {
    return { success: false, error: "No script in context", durationMs: Date.now() - start };
  }

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.SEO_PENDING },
  });

  const config = env();
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const pillar = extractPillar(ctx.topic);

  // ── Title generation (3-round loop) ────────────────────────────────────
  const scriptSummary = ctx.script.hook + " " +
    ctx.script.segments.map((s) => s.title).join(". ");

  // Everything the narrator actually says, which is what a claim is judged
  // against. The summary above is for prompting; this is for verification.
  const narration = [
    ctx.script.hook,
    ...ctx.script.segments.map((s) => s.narration),
    ctx.script.cta,
  ].join("\n");

  const titles = await generateTitles(anthropic, ctx.topic.title, scriptSummary, pillar, narration);

  console.log(`[wc:seoGenerator] Pillar: ${pillar}`);
  console.log(`[wc:seoGenerator] Selected title: "${titles.primary}"`);
  console.log(`[wc:seoGenerator] Variant B: "${titles.variantB}"`);
  console.log(`[wc:seoGenerator] Variant C (wildcard): "${titles.variantC}"`);

  // ── Chapter timestamps from audio ──────────────────────────────────────
  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  const chapterHints: string[] = ["0:00 — Introduction (title card)"];
  let offset = 4; // title card duration
  for (const seg of ctx.script.segments) {
    const mp3Path = join(audioDir, `segment-${seg.segmentIndex}.mp3`);
    let dur: number;
    try {
      dur = await probeDuration(mp3Path);
    } catch {
      dur = seg.duration_seconds; // fallback to estimate
    }
    chapterHints.push(`${formatTimestamp(offset)} — ${seg.title}`);
    offset += dur;
  }

  console.log(`[wc:seoGenerator] Chapter timestamps:`);
  for (const c of chapterHints) console.log(`  ${c}`);

  // ── Generate description, tags, chapters, thumbnail text ───────────────
  const userPrompt = `Title (use this exactly): ${titles.primary}
Content pillar: ${pillar}

Topic: ${ctx.topic.title}
Source: ${ctx.topic.url}

Chapter timestamps (use these exactly):
${chapterHints.join("\n")}

Full script:
${JSON.stringify(ctx.script, null, 2)}`;

  console.log(`[wc:seoGenerator] Generating description, tags, chapters, thumbnail text...`);

  const seoRaw = await callClaude(anthropic, SEO_SYSTEM_PROMPT, userPrompt);

  let parsed: unknown;
  try {
    parsed = parseJSON(seoRaw);
  } catch {
    return {
      success: false,
      error: `Invalid JSON from Claude: ${seoRaw.slice(0, 200)}`,
      durationMs: Date.now() - start,
    };
  }

  const validation = seoSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      success: false,
      error: `SEO validation failed: ${issues}`,
      durationMs: Date.now() - start,
    };
  }

  const { thumbnailText, ...seoFields } = validation.data;

  // Override the title with our 3-round winner
  const seo: SEOMetadata = { ...seoFields, title: titles.primary };
  seo.tags = sanitizeTags(seo.tags);

  // ── Post-generation guards ─────────────────────────────────────────────
  // The prompt above now forbids all three of these. A prompt is not a
  // guarantee, and a published description cannot be quietly revised, so each
  // is also enforced on the output.

  // 1. Unresolved template scaffolding. 33 literal [AFFILIATE_LINK_placeholder]
  //    strings shipped across 8 of 10 descriptions in the 2026-09-11 batch.
  const leaked = findPlaceholders(seo.description);
  if (leaked.length > 0) {
    console.log(`[wc:seoGenerator] stripping ${leaked.length} unresolved placeholder(s): ${leaked.join(", ")}`);
    seo.description = stripPlaceholders(seo.description);
  }

  // 2. Subjects the channel does not cover. The seed gate screens the topic;
  //    this screens what the model then wrote. Tags and hashtags are dropped
  //    silently (they are a list, losing one costs nothing); a chapter label or
  //    description hit fails the stage, because rewriting prose here would be
  //    guesswork and the retry is cheap.
  const droppedTags = seo.tags.length;
  seo.tags = dropDisallowed(seo.tags, WC_LIBRARY_DISALLOWED);
  if (seo.tags.length !== droppedTags) {
    console.log(`[wc:seoGenerator] dropped ${droppedTags - seo.tags.length} disallowed-subject tag(s)`);
  }
  seo.description = seo.description
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#")
      ? dropDisallowed(line.split(/\s+/), WC_LIBRARY_DISALLOWED).join(" ")
      : line))
    .join("\n");

  const disallowed = screenDisallowed(
    {
      title: seo.title,
      description: seo.description,
      chapters: seo.chapters.map((c) => c.label),
    },
    WC_LIBRARY_DISALLOWED,
  );
  if (disallowed.length > 0) {
    return {
      success: false,
      error: `disallowed subject in generated metadata: ${
        disallowed.map((h) => `${h.field} "${h.value}" matches ${h.pattern}`).join("; ")
      }`,
      durationMs: Date.now() - start,
    };
  }

  // 3. Claims the narration disclaims — a "tested" badge on a script that
  //    promises the test, a winner the script declines to name, a lethal
  //    consequence it never asserts.
  //    The description is long prose and gets only the two classes that cannot
  //    occur innocently in it: a "tested" assertion and a lethal consequence.
  //    "the most common mistake" and "the wrong mount" are ordinary copy and
  //    must not fail a stage. Short fields get all three classes.
  const claimChecks: Array<readonly [string, string, Parameters<typeof checkMetadataClaim>[2]]> = [
    ["description", seo.description, ["performed", "fatal"]],
    ...seo.chapters.map((c) =>
      [`chapter "${c.time}"`, c.label, undefined] as const),
  ];
  for (const [field, value, kinds] of claimChecks) {
    const claim = kinds ? checkMetadataClaim(value, narration, kinds)
      : checkMetadataClaim(value, narration);
    if (!claim.ok) {
      return {
        success: false,
        error: `${field} makes a claim the script does not support — ${claim.reason}`,
        durationMs: Date.now() - start,
      };
    }
  }

  const unearnedTags = seo.tags.filter((t) => !checkMetadataClaim(t, narration).ok);
  if (unearnedTags.length > 0) {
    console.log(`[wc:seoGenerator] dropping ${unearnedTags.length} unearned tag(s): ${unearnedTags.join(", ")}`);
    seo.tags = seo.tags.filter((t) => checkMetadataClaim(t, narration).ok);
  }

  console.log(`[wc:seoGenerator] Title: ${seo.title}`);
  console.log(`[wc:seoGenerator] Description: ${seo.description.length} chars`);
  console.log(`[wc:seoGenerator] Tags (${seo.tags.length}): ${seo.tags.join(", ")}`);
  console.log(`[wc:seoGenerator] Chapters: ${seo.chapters.length}`);
  console.log(`[wc:seoGenerator] Thumbnail headline: "${thumbnailText.headline}"`);
  console.log(`[wc:seoGenerator] Thumbnail subtext: "${thumbnailText.subtext}"`);
  if (thumbnailText.badge) {
    console.log(`[wc:seoGenerator] Thumbnail badge: "${thumbnailText.badge}"`);
  }

  await prisma.wcVideo.update({
    where: { id: ctx.video.id },
    data: {
      seoTitle: seo.title,
      titleVariantB: titles.variantB,
      titleVariantC: titles.variantC,
      seoDescription: seo.description,
      seoTags: seo.tags,
      seoChapters: seo.chapters as any,
      status: VideoStatus.SEO_DONE,
    },
  });

  ctx.seo = seo;

  return {
    success: true,
    data: { seo, thumbnailText },
    durationMs: Date.now() - start,
  };
}
