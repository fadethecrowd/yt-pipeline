import Parser from "rss-parser";
const parser = new Parser({ timeout: 10000 });

const tries: Array<[string, string]> = [
  ["anthropic", "https://www.anthropic.com/news/rss.xml"],
  ["anthropic", "https://www.anthropic.com/rss.xml"],
  ["anthropic", "https://anthropic.com/news/rss"],
  ["anthropic", "https://www.anthropic.com/feed.xml"],
  ["deepmind", "https://deepmind.com/blog/feed/basic/"],
  ["deepmind", "https://deepmind.google/discover/blog/rss.xml"],
  ["deepmind", "https://deepmind.google/discover/blog/feed/basic/"],
  ["meta_ai", "https://ai.meta.com/blog/rss.xml"],
  ["meta_ai", "https://ai.meta.com/feed.xml"],
  ["mistral", "https://mistral.ai/news/rss.xml"],
  ["mistral", "https://mistral.ai/news/feed.xml"],
  ["mistral", "https://mistral.ai/feed.xml"],
];

async function main() {
  for (const [name, url] of tries) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": "yt-pipeline-feed-probe/0.1" },
        redirect: "follow",
      });
      if (!res.ok) {
        console.log(`  ✗ ${name.padEnd(10)} HTTP ${res.status}  ${url}`);
        continue;
      }
      const txt = await res.text();
      const feed = await parser.parseString(txt);
      const items = feed.items?.length ?? 0;
      console.log(`  ✓ ${name.padEnd(10)} items=${items.toString().padStart(3)}  ${url}`);
      if (items > 0) console.log(`     sample: "${feed.items![0].title?.slice(0, 60)}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${name.padEnd(10)} ERROR  ${url}`);
      console.log(`     ${msg.slice(0, 80)}`);
    }
  }
}
main();
