/**
 * Fetch the text of the article a topic points at.
 *
 * Topics come from RSS. `topicDiscovery` keeps `item.contentSnippet` capped at
 * 500 characters and nothing anywhere fetches the article itself, so the script
 * generator has only ever seen a title, a URL and up to two sentences.
 *
 * Run c28dd19c showed what that costs. From "The Defender's Window", a URL, and
 * a 2-sentence summary, the model produced eleven claims attributed to the
 * report — five numbered recommendations and a definition, "OpenAI defines it
 * as a limited period of time…", none of which is in the material. No entity
 * was invented and no figure was; the words were put in a named entity's mouth
 * instead. A prompt rule cannot fix that, because a model cannot know what a
 * document says without reading it. So it reads it.
 *
 * Strictly best-effort. A publisher that blocks us, a slow host, a paywall or a
 * page with no prose all end the same way: `null`, and the run continues with
 * the prompt told to attribute nothing.
 */

/** One attempt, this long. Blocking a production run on a blog is not worth it. */
export const BODY_FETCH_TIMEOUT_MS = 8000;
/** Stop reading the response past this. Guards against huge or endless pages. */
export const BODY_MAX_BYTES = 512 * 1024;
/**
 * Characters of extracted prose handed to the model.
 *
 * Sized to inform without crowding the budget: the length contract is unchanged
 * and the model still has to write to it, so the body is context, not material
 * to be reproduced.
 */
export const BODY_MAX_CHARS = 6000;
/** Below this there is no usable article — a cookie wall, a stub, a redirect. */
export const BODY_MIN_CHARS = 400;

export interface ArticleBody {
  text: string;
  /** Characters of prose extracted before truncation. */
  extractedChars: number;
  truncated: boolean;
}

/** Elements whose contents are never prose. */
const STRIP_BLOCKS = /<(script|style|noscript|svg|head|nav|footer|header|form|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * HTML to plain text.
 *
 * Deliberately a tag stripper rather than a parser dependency: the goal is
 * enough prose for the model to ground a claim in, not faithful extraction, and
 * a new runtime dependency on the production path costs more than it returns.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(STRIP_BLOCKS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Keep paragraph and heading boundaries so sentences do not run together.
    .replace(/<\/(p|div|h[1-6]|li|section|article|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…",
  };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] ?? m);
}

/**
 * Best-effort article text for `url`. Never throws, never retries.
 *
 * @param deps injectable fetch, so the failure path can be exercised in tests
 *             without a network.
 */
export async function fetchArticleBody(
  url: string,
  deps: { fetch?: typeof fetch; log?: (m: string) => void } = {},
): Promise<ArticleBody | null> {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log(`[articleBody] not a URL: ${url}`);
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    log(`[articleBody] refusing non-http scheme: ${parsed.protocol}`);
    return null;
  }

  try {
    const res = await doFetch(parsed.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(BODY_FETCH_TIMEOUT_MS),
      headers: {
        // Identify honestly. A publisher that does not want this can refuse it,
        // and refusal is a supported outcome.
        "user-agent": "yt-pipeline/1.0 (+article summarisation; contact via repo)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) { log(`[articleBody] HTTP ${res.status} for ${parsed.host}`); return null; }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|xhtml|text\/plain/i.test(type)) {
      log(`[articleBody] not HTML (${type || "no content-type"})`);
      return null;
    }

    const raw = await readCapped(res, BODY_MAX_BYTES);
    if (raw === null) { log(`[articleBody] response exceeded ${BODY_MAX_BYTES} bytes`); return null; }

    const text = htmlToText(raw);
    if (text.length < BODY_MIN_CHARS) {
      log(`[articleBody] only ${text.length} chars of prose — treating as unusable`);
      return null;
    }
    const truncated = text.length > BODY_MAX_CHARS;
    return {
      text: truncated ? text.slice(0, BODY_MAX_CHARS) : text,
      extractedChars: text.length,
      truncated,
    };
  } catch (e) {
    log(`[articleBody] fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Read the body, abandoning it if it goes past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  if (!res.body) return (await res.text()).slice(0, maxBytes);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}
