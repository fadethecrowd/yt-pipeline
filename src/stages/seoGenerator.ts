import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import type { PipelineContext, SEOMetadata, StageResult } from "../types";

/**
 * Stage 6: Use Claude API to generate title, description, tags, chapters.
 */
export async function seoGenerator(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.script) {
    return { success: false, error: "No script in context", durationMs: Date.now() - start };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.SEO_PENDING },
  });

  // TODO: Initialize Anthropic client
  // const anthropic = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });

  // TODO: Build SEO generation prompt
  // const prompt = `Generate YouTube SEO metadata for this script:
  //   - Title (max 100 chars, attention-grabbing)
  //   - Description (2000 chars, keyword-rich, with timestamps)
  //   - Tags (15-30 relevant tags)
  //   - Chapters (timestamps matching segments)
  //   Return JSON: { title, description, tags: string[], chapters: [{time, label}] }`;

  const seo: SEOMetadata = {
    title: "TODO",
    description: "TODO",
    tags: [],
    chapters: [],
  };

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      seoTitle: seo.title,
      seoDescription: seo.description,
      seoTags: seo.tags,
      seoChapters: seo.chapters as any,
      status: VideoStatus.SEO_DONE,
    },
  });

  ctx.seo = seo;

  return { success: true, data: seo, durationMs: Date.now() - start };
}
