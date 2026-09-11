/**
 * Seed SOURCED evergreen NEW_OWNER topics into topic_library for wet-circuit.
 *
 * The difference from the older url-less seeding: every row here carries a real
 * http(s) URL. topicLibrary.fetchLibraryTopic returns `selected.url ?? "library://<id>"`,
 * so a row with a NULL url is handed to the pipeline under the synthetic
 * `library:` scheme, which fetchArticleBody refuses as a non-http scheme. The
 * script is then written with no source document at all — the "source body
 * unavailable — attribution to the document is disallowed" path. That fired on
 * 11 of 11 topics in the 2026-09-11 batch. Nothing in the pipeline needed to
 * change to fix it; the url column just had to be populated.
 *
 * This script therefore REFUSES a row without an http(s) URL rather than
 * quietly seeding one that will fall back to `library:`.
 *
 * It does NOT verify that the URL fetches — run scripts/verify-topic-urls.ts
 * first and feed it the PASSING block. Verification needs pacing and soft-404
 * detection, which belong in that tool, not here.
 *
 * Usage:
 *   npx tsx scripts/seed-wc-library-sourced.ts <topics.tsv> [--priority=60]
 *   npx tsx scripts/seed-wc-library-sourced.ts <topics.tsv> --apply
 *
 * TSV per line: Title <TAB> https://... <TAB> angle for the writer
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const file = args.find((a) => !a.startsWith("--"));
const basePriority = Number(args.find((a) => a.startsWith("--priority="))?.split("=")[1] ?? 60);

/** Copy of WC_LIBRARY_DISALLOWED in packages/wc-pipeline/src/stages/topicDiscovery.ts. */
const DISALLOWED: RegExp[] = [
  /\bkayak/i, /\bcanoe/i, /\bpaddle\s*board/i, /\bpaddleboard/i, /\bSUP\b/, /\bPWC\b/,
  /\bjet\s*ski/i, /\bjetski/i, /\bpersonal\s+watercraft/i, /\bwaverunner/i, /\bseadoo/i,
  /\bsea[- ]?doo/i,
];

async function main() {
  if (!file) {
    console.log("Usage: npx tsx scripts/seed-wc-library-sourced.ts <topics.tsv> [--priority=60] [--apply]");
    process.exit(1);
  }

  const lines = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const existingTitles = new Set(
    [
      ...(await prisma.topicLibrary.findMany({ where: { channel: "wet-circuit" }, select: { title: true } })),
      ...(await prisma.wcTopic.findMany({ select: { title: true } })),
    ].map((r) => r.title.toLowerCase()),
  );
  const existingUrls = new Set(
    [
      ...(await prisma.topicLibrary.findMany({ where: { channel: "wet-circuit" }, select: { url: true } })).map((r) => r.url),
      ...(await prisma.wcTopic.findMany({ select: { url: true } })).map((r) => r.url),
    ].filter((u): u is string => Boolean(u)),
  );

  const rows: { title: string; url: string; summary: string; priority: number }[] = [];
  const refused: string[] = [];

  for (const line of lines) {
    const [rawTitle, rawUrl, ...rest] = line.split("\t").map((s) => s.trim());
    const title = rawTitle ?? "";
    const url = rawUrl ?? "";
    const angle = rest.join(" ").trim();
    const summary = `[NEW_OWNER] ${angle || "Evergreen explainer for new boat owners."}`;

    let scheme = "";
    try { scheme = new URL(url).protocol; } catch { scheme = ""; }

    if (!url) {
      refused.push(`no URL — would seed as library: scheme: "${title}"`);
    } else if (scheme !== "http:" && scheme !== "https:") {
      refused.push(`non-http scheme (${scheme || "unparseable"}): "${title}"`);
    } else if (DISALLOWED.some((re) => re.test(`${title} ${summary}`))) {
      refused.push(`disallowed (would be auto-archived): "${title}"`);
    } else if (existingTitles.has(title.toLowerCase())) {
      refused.push(`duplicate title: "${title}"`);
    } else if (existingUrls.has(url)) {
      refused.push(`duplicate url: ${url}`);
    } else {
      existingTitles.add(title.toLowerCase());
      existingUrls.add(url);
      rows.push({ title, url, summary, priority: basePriority - rows.length });
    }
  }

  for (const r of rows) console.log(`  p${r.priority}  ${r.title}\n         ${r.url}`);
  for (const r of refused) console.log(`  x ${r}`);
  console.log(`\n${rows.length} to insert, ${refused.length} refused.`);

  if (!APPLY) {
    console.log("Dry run. Re-run with --apply to insert.");
    return;
  }

  const res = await prisma.topicLibrary.createMany({
    data: rows.map((r) => ({
      channel: "wet-circuit",
      source: "manual",
      status: "PENDING" as const,
      ...r,
    })),
  });
  console.log(`Inserted ${res.count} PENDING wet-circuit library topics, all with http(s) URLs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
