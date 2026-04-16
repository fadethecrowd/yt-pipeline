/**
 * Probe candidate AI lab RSS feeds — verify each returns parseable RSS
 * with at least one item before wiring into topicDiscovery.ts.
 */
import Parser from "rss-parser";

const CANDIDATES = [
  { name: "openai_blog",      url: "https://openai.com/blog/rss.xml" },
  { name: "anthropic_news",   url: "https://www.anthropic.com/news/rss" },
  { name: "deepmind_blog",    url: "https://deepmind.google/blog/rss/" },
  { name: "meta_ai",          url: "https://ai.meta.com/blog/rss/" },
  { name: "huggingface_blog", url: "https://huggingface.co/blog/feed.xml" },
  { name: "mistral_news",     url: "https://mistral.ai/news/rss/" },
];

const parser = new Parser({ timeout: 15000 });

async function probe(name: string, url: string) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "yt-pipeline-feed-probe/0.1" },
      redirect: "follow",
    });
    if (!res.ok) {
      return { name, url, ok: false, items: 0, reason: `HTTP ${res.status}` };
    }
    const finalUrl = res.url;
    const feed = await parser.parseString(await res.text());
    const items = feed.items?.length ?? 0;
    const sampleTitle = feed.items?.[0]?.title?.slice(0, 70) ?? "(no items)";
    return { name, url, finalUrl, ok: items > 0, items, sampleTitle };
  } catch (err) {
    return { name, url, ok: false, items: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

(async () => {
  console.log("Probing AI lab RSS candidates…\n");
  for (const c of CANDIDATES) {
    const r = await probe(c.name, c.url);
    if (r.ok) {
      console.log(`✓ ${r.name.padEnd(20)} items=${r.items.toString().padStart(3)}  ${r.url}`);
      if ((r as any).finalUrl && (r as any).finalUrl !== r.url) {
        console.log(`    redirected -> ${(r as any).finalUrl}`);
      }
      if ((r as any).sampleTitle) console.log(`    sample: "${(r as any).sampleTitle}"`);
    } else {
      console.log(`✗ ${r.name.padEnd(20)} FAILED  ${r.url}`);
      console.log(`    reason: ${(r as any).reason}`);
    }
  }
})();
