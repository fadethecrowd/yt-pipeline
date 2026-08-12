/**
 * Topic Library — optional curated topic source for both pipelines.
 *
 * Before running the normal RSS/Reddit discovery, the pipeline checks the
 * topic_library table for a PENDING entry matching its channel. If found,
 * returns it and (unless reserveTopic mode) marks it USED.
 *
 * When the library is empty, returns null and normal discovery proceeds.
 *
 * USED means "consumed by a live attempt", NOT "produced a video". The row
 * leaves the pool at SELECTION time, before any later stage can refuse the
 * topic. When this lifecycle was written (2026-04-17) that distinction barely
 * existed: a live run that got as far as selection nearly always produced
 * something. `visualFeasibilityGate` (2026-07-31) then added a common refusal
 * that costs nothing and happens after selection, so USED now also covers
 * topics that were rejected before a single credit was spent.
 *
 * Consuming them anyway is deliberate. Leaving a refused topic PENDING would
 * hand the next run the same highest-priority row, which would be re-scripted
 * (Claude spend) and refused again, and the ordinary runner would spin there
 * instead of reaching the rest of the library. Reclaiming inventory is
 * therefore an operator decision, never an automatic one — see
 * `tests/topic-library-lifecycle.test.ts`, which pins that as the loop guard.
 */
import { prisma } from "./db";

export interface LibraryTopic {
  id: string;
  title: string;
  source: string;
  url: string;
  summary: string | null;
}

export interface LibraryTopicCandidate {
  title: string;
  summary: string | null;
}

/**
 * Fetch the highest-priority PENDING topic for `channel` from the library,
 * skipping any topic whose title+summary matches the optional `isDisallowed`
 * predicate. Disallowed matches are transitioned to ARCHIVED so they won't
 * be re-selected (including under reserveTopic=true dry-run mode).
 *
 * Without this filter the library path bypassed topicDiscovery's
 * NEGATIVE_KEYWORDS — disallowed topics (e.g. kayak content for WC) went
 * straight to script generation. This filter restores the same policy
 * for the library path and makes the rejection permanent per row.
 *
 * @param channel       "ai-doom" | "wet-circuit"
 * @param reserve       If true, leave the selected topic PENDING (dry-run reuse).
 *                      If false (default), mark it USED so it won't be picked again.
 *                      NOTE: disallowed topics are ARCHIVED regardless of `reserve`.
 * @param isDisallowed  Optional per-channel content filter. When it returns true
 *                      for a candidate, the row is archived and the next
 *                      PENDING topic is considered. Defaults to no filter.
 * @returns             A LibraryTopic compatible with FeedItem, or null if
 *                      no PENDING non-disallowed entries exist.
 */
export async function fetchLibraryTopic(
  channel: string,
  reserve = false,
  isDisallowed: (c: LibraryTopicCandidate) => boolean = () => false,
): Promise<LibraryTopic | null> {
  // Iterate PENDING topics in priority order. ARCHIVE any that the
  // per-channel filter rejects; stop at the first clean match.
  const MAX_ATTEMPTS = 50;
  const pending = await prisma.topicLibrary.findMany({
    where: { channel, status: "PENDING" },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: MAX_ATTEMPTS,
  });

  let selected: (typeof pending)[number] | null = null;
  let archivedDisallowed = 0;

  for (const entry of pending) {
    if (isDisallowed({ title: entry.title, summary: entry.summary })) {
      await prisma.topicLibrary.update({
        where: { id: entry.id },
        data: { status: "ARCHIVED" },
      });
      console.log(
        `[topicLibrary] Archived disallowed topic ${entry.id}: "${entry.title}"`,
      );
      archivedDisallowed++;
      continue;
    }
    selected = entry;
    break;
  }

  if (archivedDisallowed > 0) {
    console.log(
      `[topicLibrary] ${archivedDisallowed} disallowed topic(s) archived during this fetch`,
    );
  }

  if (!selected) return null;

  console.log(
    `[topicLibrary] Found library topic for ${channel}: "${selected.title}" (priority=${selected.priority}, id=${selected.id})`,
  );

  if (!reserve) {
    await prisma.topicLibrary.update({
      where: { id: selected.id },
      data: { status: "USED" },
    });
    console.log(`[topicLibrary] Marked ${selected.id} as USED`);
  } else {
    console.log(
      `[topicLibrary] reserveTopic=true — leaving ${selected.id} as PENDING`,
    );
  }

  return {
    id: selected.id,
    title: selected.title,
    source: selected.source ?? "library",
    url: selected.url ?? `library://${selected.id}`,
    summary: selected.summary,
  };
}
