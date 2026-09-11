/**
 * Dry-run `fetchArticleBody` against candidate topic URLs.
 *
 * This calls the exact function the pipeline calls, so every refusal it reports
 * — non-2xx, wrong content-type, oversize body, too little prose, timeout — is
 * the reason the pipeline would refuse it too.
 *
 * Two things this has to do that a naive loop does not:
 *
 * 1. PACE THE REQUESTS. Hammering one host makes it throttle, and a throttled
 *    host does not necessarily return 429 — westmarine.com returns its soft 404
 *    with HTTP 200. Verified live: the same URL returned 12,825 chars when
 *    requested alone and a 501-char error page inside a 22-URL burst. Without a
 *    delay the run measures our own rate limiting, not the URLs.
 *
 * 2. DETECT SOFT 404s. `fetchArticleBody` cannot: the page is 200 OK, is
 *    text/html, and its chrome (cookie banner, zip prompt, nav) extracts to
 *    ~500 chars, which clears BODY_MIN_CHARS of 400. So it is returned as a
 *    valid article and the model is handed "The page you're looking for isn't
 *    in sight" as its source document. That is worse than no body at all,
 *    because the no-body path at least tells the prompt to attribute nothing.
 *
 * Usage: npx tsx scripts/verify-topic-urls.ts <candidates.tsv> [--delay-ms=4000]
 * Format per line: Title <TAB> url <TAB> angle    (# comments and blanks ignored)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fetchArticleBody, BODY_MIN_CHARS } from "../packages/pipeline-core/src/lib/articleBody";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const delayMs = Number(args.find((a) => a.startsWith("--delay-ms="))?.split("=")[1] ?? 4000);

/**
 * Phrases that mean "this is an error page wearing a 200".
 * Matched against the first 800 chars, where site chrome and the error live.
 */
const SOFT_404 = [
  /\b404\b/i,
  /page you(?:'|’|&#39;)?re looking for/i,
  /page (?:could ?not|cannot|can't) be found/i,
  /page not found/i,
  /no longer available/i,
];

/** Prose this short is chrome, not an article, whatever the floor says. */
const SUSPECT_CHARS = 1200;

interface Row { title: string; url: string; angle: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!file) {
    console.log("Usage: npx tsx scripts/verify-topic-urls.ts <candidates.tsv> [--delay-ms=4000]");
    process.exit(1);
  }
  const rows: Row[] = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [title, url, ...rest] = l.split("\t").map((s) => s.trim());
      return { title, url, angle: rest.join(" ").trim() };
    });

  console.log(`Checking ${rows.length} URL(s), ${delayMs}ms apart, min prose ${BODY_MIN_CHARS}.\n`);

  const pass: Row[] = [];
  const fail: Array<Row & { why: string }> = [];

  for (const [i, r] of rows.entries()) {
    if (i > 0) await sleep(delayMs);
    const reasons: string[] = [];
    const body = await fetchArticleBody(r.url, { log: (m) => reasons.push(m) });

    if (!body) {
      const why = reasons.join("; ") || "returned null";
      console.log(`FAIL  ${why}\n      ${r.url}`);
      fail.push({ ...r, why });
      continue;
    }

    const head = body.text.slice(0, 800);
    const marker = SOFT_404.find((re) => re.test(head));
    if (marker) {
      const why = `soft 404 — 200 OK but body matches ${marker} (${body.extractedChars} chars)`;
      console.log(`FAIL  ${why}\n      ${r.url}`);
      fail.push({ ...r, why });
      continue;
    }
    if (body.extractedChars < SUSPECT_CHARS) {
      const why = `only ${body.extractedChars} chars — above the ${BODY_MIN_CHARS} floor but too thin to ground a script`;
      console.log(`FAIL  ${why}\n      ${r.url}`);
      fail.push({ ...r, why });
      continue;
    }

    console.log(`PASS  ${String(body.extractedChars).padStart(6)} chars  ${r.url}`);
    pass.push(r);
  }

  console.log(`\n${pass.length} passed, ${fail.length} dropped.`);
  if (pass.length) {
    console.log("\n--- PASSING (tsv, ready to seed) ---");
    for (const r of pass) console.log(`${r.title}\t${r.url}\t${r.angle}`);
  }
  if (fail.length) {
    console.log("\n--- DROPPED ---");
    for (const r of fail) console.log(`${r.url}\n    ${r.why}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
