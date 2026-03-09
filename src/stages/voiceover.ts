import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config";
import type { PipelineContext, StageResult, VoiceoverResult } from "../types";

/**
 * Stage 4: Use ElevenLabs API to generate MP3 per script segment,
 * save locally, concatenate into a single final.mp3.
 */
export async function voiceover(
  ctx: PipelineContext
): Promise<StageResult> {
  const start = Date.now();

  if (!ctx.script || ctx.script.segments.length === 0) {
    return { success: false, error: "No script segments", durationMs: Date.now() - start };
  }

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: { status: VideoStatus.VOICEOVER_PENDING },
  });

  const config = env();
  const voiceId = config.ELEVENLABS_VOICE_ID;
  const apiKey = config.ELEVENLABS_API_KEY;

  // Create output directory
  const audioDir = join(process.cwd(), "audio", ctx.video.id);
  await mkdir(audioDir, { recursive: true });

  const results: VoiceoverResult[] = [];
  const segmentPaths: string[] = [];

  for (const segment of ctx.script.segments) {
    const segIdx = segment.segmentIndex;
    console.log(`[voiceover] Generating TTS for segment ${segIdx}: "${segment.title}"...`);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: segment.narration,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return {
        success: false,
        error: `ElevenLabs API error (segment ${segIdx}): ${response.status} ${errText}`,
        durationMs: Date.now() - start,
      };
    }

    const mp3Buffer = Buffer.from(await response.arrayBuffer());
    const segmentPath = join(audioDir, `segment-${segIdx}.mp3`);
    await writeFile(segmentPath, mp3Buffer);

    console.log(`[voiceover] Saved ${segmentPath} (${mp3Buffer.length} bytes)`);

    segmentPaths.push(segmentPath);
    results.push({
      segmentIndex: segIdx,
      url: segmentPath,
      durationMs: Date.now() - start,
    });
  }

  // Concatenate all segment MP3s into a single final.mp3
  const finalPath = join(audioDir, "final.mp3");
  const chunks: Buffer[] = [];
  for (const p of segmentPaths) {
    chunks.push(await readFile(p));
  }
  await writeFile(finalPath, Buffer.concat(chunks));
  console.log(`[voiceover] Concatenated ${segmentPaths.length} segments → ${finalPath}`);

  // Persist to DB
  const urls = segmentPaths;
  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      voiceoverUrls: urls,
      voiceoverPath: finalPath,
      status: VideoStatus.VOICEOVER_DONE,
    },
  });

  ctx.voiceoverUrls = urls;

  return { success: true, data: results, durationMs: Date.now() - start };
}
