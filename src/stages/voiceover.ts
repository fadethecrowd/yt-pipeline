import { VideoStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import type { PipelineContext, StageResult, VoiceoverResult } from "../types";

/**
 * Stage 4: Use ElevenLabs API to generate MP3 per script segment.
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

  // TODO: For each segment, call ElevenLabs TTS API
  // const voiceId = env().ELEVENLABS_VOICE_ID;
  // const apiKey = env().ELEVENLABS_API_KEY;
  //
  // for (const segment of ctx.script.segments) {
  //   const response = await fetch(
  //     `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
  //     {
  //       method: "POST",
  //       headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
  //       body: JSON.stringify({
  //         text: segment.text,
  //         model_id: "eleven_multilingual_v2",
  //         voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  //       }),
  //     }
  //   );
  //   // Save MP3 buffer to storage, collect URL
  // }

  const results: VoiceoverResult[] = []; // placeholder

  const urls = results.map((r) => r.url);

  await prisma.video.update({
    where: { id: ctx.video.id },
    data: {
      voiceoverUrls: urls,
      status: VideoStatus.VOICEOVER_DONE,
    },
  });

  ctx.voiceoverUrls = urls;

  return { success: true, data: results, durationMs: Date.now() - start };
}
