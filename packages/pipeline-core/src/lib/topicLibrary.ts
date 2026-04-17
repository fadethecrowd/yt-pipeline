/**
 * Topic Library — optional curated topic source for both pipelines.
 *
 * Before running the normal RSS/Reddit discovery, the pipeline checks the
 * topic_library table for a PENDING entry matching its channel. If found,
 * returns it and (unless reserveTopic mode) marks it USED.
 *
 * When the library is empty, returns null and normal discovery proceeds.
 */
import { prisma } from "./db";

export interface LibraryTopic {
  id: string;
  title: string;
  source: string;
  url: string;
  summary: string | null;
}

/**
 * Fetch the highest-priority PENDING topic for `channel` from the library.
 *
 * @param channel  "ai-doom" | "wet-circuit"
 * @param reserve  If true, leave the topic PENDING (dry-run reuse).
 *                 If false (default), mark it USED so it won't be picked again.
 * @returns        A LibraryTopic compatible with the pipeline's FeedItem shape,
 *                 or null if no PENDING entries exist.
 */
export async function fetchLibraryTopic(
  channel: string,
  reserve = false,
): Promise<LibraryTopic | null> {
  const entry = await prisma.topicLibrary.findFirst({
    where: { channel, status: "PENDING" },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });

  if (!entry) return null;

  console.log(
    `[topicLibrary] Found library topic for ${channel}: "${entry.title}" (priority=${entry.priority}, id=${entry.id})`,
  );

  if (!reserve) {
    await prisma.topicLibrary.update({
      where: { id: entry.id },
      data: { status: "USED" },
    });
    console.log(`[topicLibrary] Marked ${entry.id} as USED`);
  } else {
    console.log(`[topicLibrary] reserveTopic=true — leaving ${entry.id} as PENDING`);
  }

  return {
    id: entry.id,
    title: entry.title,
    source: entry.source ?? "library",
    url: entry.url ?? `library://${entry.id}`,
    summary: entry.summary,
  };
}
