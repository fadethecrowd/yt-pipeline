import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  fetchArticleBody, htmlToText, BODY_MAX_CHARS, BODY_MIN_CHARS, BODY_MAX_BYTES,
} from "../packages/pipeline-core/src/lib/articleBody";
import { sourceMaterialBlock } from "../src/stages/scriptGenerator";
import { checkTitleFidelity, selectFaithfulTitle } from "../packages/pipeline-core/src/lib/titleFidelity";

/**
 * A model cannot know what a document says without reading it.
 *
 * Run c28dd19c was given a headline, a URL and two sentences of RSS snippet,
 * and produced eleven claims attributed to the report — five numbered
 * recommendations and "OpenAI defines it as a limited period of time…". Nothing
 * was invented in the sense the anchor rules police: no fake company, no fake
 * number, no fake quote. The words were put in a real entity's mouth instead.
 *
 * So the fix is to fetch the article, and — because fetching is allowed to fail,
 * and openai.com answers this pipeline with HTTP 403 — to say plainly in the
 * prompt when it did.
 */

const TOPIC = {
  title: "The Defender’s Window",
  url: "https://openai.com/index/the-defenders-window",
  summary: "AI is reshaping cybersecurity for attackers and defenders alike.",
};

describe("fetching is bounded and fails soft", () => {
  const ok = (html: string, type = "text/html") =>
    async () => new Response(html, { status: 200, headers: { "content-type": type } });

  test("every failure mode returns null and none of them throw", async () => {
    const cases: [string, Parameters<typeof fetchArticleBody>[1] & { url?: string }][] = [
      ["malformed url", { url: "not a url" } as never],
      ["file scheme", { url: "file:///etc/passwd" } as never],
      ["connection refused", { fetch: async () => { throw new Error("ECONNREFUSED"); } }],
      ["timeout", { fetch: async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; } }],
      ["403 paywall", { fetch: async () => new Response("", { status: 403 }) }],
      ["500", { fetch: async () => new Response("", { status: 500 }) }],
      ["a PDF", { fetch: ok("%PDF-1.7", "application/pdf") }],
      ["cookie wall", { fetch: ok("<html><body><p>Enable cookies</p></body></html>") }],
    ];
    for (const [label, c] of cases) {
      const url = (c as { url?: string }).url ?? TOPIC.url;
      const r = await fetchArticleBody(url, { ...c, log: () => {} });
      assert.equal(r, null, label);
    }
  });

  test("openai.com's real answer to this pipeline is 403, so the null path is the live path", async () => {
    const r = await fetchArticleBody(TOPIC.url, {
      fetch: async () => new Response("", { status: 403 }), log: () => {},
    });
    assert.equal(r, null);
  });

  test("an oversized response is abandoned, not buffered", async () => {
    const r = await fetchArticleBody(TOPIC.url, {
      fetch: async () => new Response("x", {
        status: 200,
        headers: { "content-type": "text/html", "content-length": String(BODY_MAX_BYTES * 4) },
      }),
      log: () => {},
    });
    assert.equal(r, null);
  });

  test("prose is extracted and capped", async () => {
    const long = `<html><body><p>${"sentence about defenders. ".repeat(600)}</p></body></html>`;
    const r = await fetchArticleBody(TOPIC.url, { fetch: async () => new Response(long, {
      status: 200, headers: { "content-type": "text/html" } }), log: () => {} });
    assert.ok(r);
    assert.equal(r!.text.length, BODY_MAX_CHARS);
    assert.equal(r!.truncated, true);
    assert.ok(r!.extractedChars > BODY_MAX_CHARS);
  });

  test("markup, scripts and chrome never reach the model", () => {
    const t = htmlToText(
      `<html><head><style>p{color:red}</style><script>alert(1)</script></head>`
      + `<body><nav>Menu</nav><article><p>Defenders sit inside networks &mdash; attackers do not.</p>`
      + `</article><footer>&copy; 2026</footer></body></html>`,
    );
    for (const forbidden of ["<p>", "color:red", "alert(1)", "Menu"]) {
      assert.ok(!t.includes(forbidden), `"${forbidden}" survived extraction`);
    }
    assert.ok(t.includes("Defenders sit inside networks — attackers do not."),
      "prose and its entities must survive");
  });

  test("a body under the floor is treated as no body at all", async () => {
    const r = await fetchArticleBody(TOPIC.url, {
      fetch: async () => new Response(`<p>${"x".repeat(BODY_MIN_CHARS - 50)}</p>`, {
        status: 200, headers: { "content-type": "text/html" } }),
      log: () => {},
    });
    assert.equal(r, null);
  });
});

describe("the prompt tells the model what it may claim", () => {
  test("with no body, attribution is closed off explicitly", () => {
    const block = sourceMaterialBlock(TOPIC, null);
    assert.match(block, /NO ARTICLE TEXT IS AVAILABLE/);
    assert.match(block, /you have NOT read the source document/);
    assert.match(block, /Do NOT state what the document says, defines, argues, recommends/);
    assert.match(block, /no numbered\s+recommendations presented as its own/);
    // …while still allowing the honest parts.
    assert.match(block, /You MAY say the document exists/);
    assert.match(block, /You MAY discuss the subject area in your own voice/);
    assert.ok(block.includes(TOPIC.title) && block.includes(TOPIC.url));
  });

  test("with a body, the text is supplied and bounded by it", () => {
    const block = sourceMaterialBlock(TOPIC, "We call the resulting period the defender's window.");
    assert.match(block, /ARTICLE TEXT/);
    assert.match(block, /everything you attribute to\nit must appear below/);
    assert.ok(block.includes("We call the resulting period the defender's window."));
    assert.ok(!block.includes("NO ARTICLE TEXT IS AVAILABLE"));
  });

  test("the standing rule against attributing invented content is present", () => {
    const src = readFileSync("src/stages/scriptGenerator.ts", "utf8");
    assert.match(src, /ATTRIBUTING INVENTED CONTENT TO A REAL ENTITY IS ALSO FABRICATION/);
    assert.match(src, /does NOT license you to describe what it said,\n  defined, recommended, argued/);
  });
});

describe("titles may not invent a duration either", () => {
  const SCRIPT = "The Defender's Window is a limited period where defenders can outpace "
    + "attackers. The advantage is not permanent and the gap will narrow.";

  test("c28dd19c's wildcard is now disqualified", () => {
    const r = checkTitleFidelity("The 18-Month Window to Stop AI Hackers Forever Is Already Closing", SCRIPT);
    assert.equal(r.ok, false);
    assert.ok(r.unsupported.some((u) => u.includes("18-Month")), JSON.stringify(r));
  });

  test("the same title passes when the script actually says it", () => {
    const r = checkTitleFidelity(
      "The 18-Month Window to Stop AI Hackers Forever Is Already Closing",
      `${SCRIPT} OpenAI says the window lasts roughly 18 months.`);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("durations, counts and multiples are all covered", () => {
    for (const t of ["You Have 72 Hours", "Three Years to Fix This", "Hundreds of Firms Breached",
                     "A 10x Jump in Attacks", "Breaches Up 40% This Year"]) {
      assert.equal(checkTitleFidelity(t, SCRIPT).ok, false, `"${t}" should be unsupported`);
    }
  });

  test("vague time language is not a quantity and still passes", () => {
    // "for the first time in decades" is ordinary prose, not a claim of fact.
    assert.equal(checkTitleFidelity("For the First Time in Decades, Defenders Win", SCRIPT).ok, true);
    assert.equal(checkTitleFidelity("Defenders Finally Have the Edge", SCRIPT).ok, true);
  });

  test("selection falls through to a supported candidate", () => {
    const s = selectFaithfulTitle(
      ["The 18-Month Window to Stop AI Hackers Forever Is Already Closing",
       "Defenders Finally Have the Edge Over AI Hackers"],
      SCRIPT, "The Defender's Window");
    assert.equal(s.title, "Defenders Finally Have the Edge Over AI Hackers");
    assert.equal(s.disqualified.length, 1);
  });
});
