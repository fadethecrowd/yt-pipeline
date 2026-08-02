import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSearchQueries } from "../packages/pipeline-core/src/lib/visualRelevance";

/**
 * Query construction for the acquisition path.
 *
 * A warehouse-robot candidate was acquired with 15 queries across 19 beats and
 * the word "robot" appeared in none of them. An independent review rejected 31
 * of 33 proposed fragments; zero visibly showed a warehouse robot.
 *
 * Three defects produced that, each pinned below:
 *
 *  1. Queries took the first four surviving words of the prompt. "Wide shot of
 *     a warehouse interior where autonomous mobile robots are lifting shelves"
 *     became "wide warehouse interior where" — the subject sits past the
 *     truncation point.
 *  2. The segment title was searched verbatim. "The fleet software is the hard
 *     part" is a sentence, and a stock library answers it with motorcycles,
 *     breweries, harbours and abandoned buildings.
 *  3. A canonical concept query was appended on any classification. "warehouse
 *     control room where operators monitor screens" classifies as surveillance
 *     on the phrase "control room", so "security camera surveillance" was
 *     issued — CCTV and traffic-control footage entering a warehouse video.
 */

const q = (prompt: string, title = "") => buildSearchQueries(prompt, title, "ai-doom-scroll");
const joined = (prompt: string, title = "") => q(prompt, title).join(" || ");

describe("the subject reaches the query wherever it sits in the sentence", () => {
  test("robots named late in the prompt still drive the search", () => {
    const out = joined(
      "Wide shot of a warehouse interior where autonomous mobile robots are lifting and transporting shelves",
      "Carrying Shelves to the Worker");
    assert.match(out, /robot/, `no robot anchor in: ${out}`);
  });

  test("the exact failing prompt no longer yields a subject-free query set", () => {
    for (const p of [
      "Wide shot of a warehouse interior where autonomous mobile robots are lifting and transporting shelves",
      "Ground-level shot inside a fulfilment warehouse showing workers walking through aisles while robots pass",
    ]) {
      const out = q(p);
      assert.ok(out.some((x) => /robot|warehouse|fulfilment/.test(x)),
        `no subject anchor: ${JSON.stringify(out)}`);
    }
  });

  test("relative pronouns never occupy a query slot", () => {
    const out = joined("Wide shot of a warehouse interior where robots move shelves");
    for (const w of ["where", "which", "that", "whose"]) {
      assert.ok(!out.split(/\W+/).includes(w), `"${w}" survived into: ${out}`);
    }
  });
});

describe("prose titles are not searched", () => {
  for (const title of [
    "The Fleet Software Is the Hard Part",
    "From Painted Lines to Onboard Sensing",
    "Navigating Around People Without Stopping Everything",
    "What Changes for the Workers Left on the Floor",
  ]) {
    test(`"${title}" is never issued verbatim`, () => {
      const out = q("Wide shot of a warehouse aisle with robots", title);
      assert.ok(!out.includes(title.toLowerCase()),
        `title searched verbatim: ${JSON.stringify(out)}`);
    });
  }

  test("a title contributes only when it names a subject", () => {
    const out = q("Wide shot of a warehouse aisle", "What Changes for the Workers Left on the Floor");
    for (const junk of ["workers what for floor", "what for floor"]) {
      assert.ok(!out.includes(junk), `word salad emitted: ${JSON.stringify(out)}`);
    }
  });
});

describe("no cross-domain canonical contamination", () => {
  test("a warehouse control room does not pull in CCTV queries", () => {
    const out = joined(
      "Shot of a warehouse control room where operators monitor multiple large screens displaying robot fleet routes",
      "The Fleet Software Is the Hard Part");
    assert.ok(!out.includes("security camera surveillance"),
      `surveillance canonical leaked into a warehouse beat: ${out}`);
  });

  test("a genuine surveillance prompt still gets its canonical query", () => {
    const out = joined("Supermarket aisle with a dome security camera mounted above the shelving");
    assert.match(out, /security|camera|surveillance/);
  });

  test("an ambiguous classification injects no canonical query", () => {
    // Nothing in this prompt clearly belongs to one AI_SUBJECTS concept.
    const out = q("Close-up of a warehouse floor showing painted yellow guide lines");
    for (const canon of ["security camera surveillance", "programmer code screen",
                         "data center server room", "industrial robot arm"]) {
      assert.ok(!out.includes(canon), `canonical "${canon}" injected: ${JSON.stringify(out)}`);
    }
  });
});

describe("the rejected allocation's query set could not recur", () => {
  test("the five failing segment prompts now all produce a subject anchor", () => {
    const prompts = [
      ["Close-up shot of a warehouse floor showing painted yellow guide lines and old magnetic tape", "From Painted Lines to Onboard Sensing"],
      ["Wide shot of a warehouse interior where autonomous mobile robots are lifting and transporting shelves", "Carrying Shelves to the Worker"],
      ["Ground-level shot inside a fulfilment warehouse showing workers walking through aisles", "Navigating Around People Without Stopping Everything"],
      ["Shot of a warehouse control room where operators monitor multiple large screens", "The Fleet Software Is the Hard Part"],
      ["Wide shot of a warehouse loading bay where workers in high-visibility vests manage incoming pallets", "What Changes for the Workers Left on the Floor"],
    ] as const;
    for (const [p, t] of prompts) {
      const out = q(p, t);
      assert.ok(out.some((x) => /warehouse|robot|fulfilment|worker|loading|pallet/.test(x)),
        `no concrete anchor for "${t}": ${JSON.stringify(out)}`);
      assert.ok(!out.includes(t.toLowerCase()), `title verbatim for "${t}"`);
    }
  });
});
