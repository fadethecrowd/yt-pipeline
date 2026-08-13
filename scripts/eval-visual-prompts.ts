/**
 * Offline A/B evaluation of visual_prompt authoring. NO ElevenLabs spend.
 *
 *   npx tsx scripts/eval-visual-prompts.ts --variant=new
 *   npx tsx scripts/eval-visual-prompts.ts --variant=old
 *   npx tsx scripts/eval-visual-prompts.ts --variant=new --feasibility
 *
 * Generates scripts for a fixed corpus with the CURRENT system prompt
 * (`--variant=new`) or the pre-change one (`--variant=old`), then measures how
 * varied and how grounded the resulting visual prompts are.
 *
 * Cost: Claude only, one Sonnet call per topic (~2k output tokens each). It
 * buys no narration, renders nothing and uploads nothing, and it writes no
 * database row — scripts are held in memory and printed.
 *
 * The corpus deliberately mixes topic KINDS, because the failure being
 * investigated is specific to stories with no physical home. A change that
 * helps abstract topics by hurting genuinely industrial ones is not a fix, so
 * both are measured and reported separately.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  env, createMessage, classifyConcept, AI_SUBJECTS,
} from "@yt-pipeline/pipeline-core";
import "dotenv/config";

type Kind = "abstract" | "physical";

/** Topic, and whether the story has a physical home. */
export const CORPUS: { title: string; kind: Kind }[] = [
  // No physical locus — the case that kept concentrating.
  { title: "Building a Fast Multilingual OCR Model with Synthetic Data", kind: "abstract" },
  { title: "From assistance to execution: How enterprises put AI to work", kind: "abstract" },
  { title: "Introducing OlmoEarth embeddings: Custom embedding exports for downstream analysis", kind: "abstract" },
  { title: "A new benchmark shows reasoning models still fail at long-horizon planning", kind: "abstract" },
  { title: "Open-weight models are closing the gap with frontier labs on coding tasks", kind: "abstract" },
  // Genuinely physical — these must NOT get worse.
  { title: "The AI Chip Shortage Moved From GPUs to Memory", kind: "physical" },
  { title: "What Happens to the Servers When the Model Gets Old", kind: "physical" },
  { title: "The Power Bill Nobody Warned You About: AI data centres and the grid", kind: "physical" },
  { title: "Robot arms are finally getting good enough for real warehouses", kind: "physical" },
];

/**
 * The shipped grounding block, kept verbatim as the A/B baseline.
 *
 * It currently MATCHES the live prompt, because the rewrite this harness was
 * built to evaluate was measured and then reverted: on the abstract half of
 * the corpus it reduced average unique settings 5.20 → 3.60 and distinct
 * prompt concepts 4.00 → 3.20, concentrating the OCR script onto `documents`
 * in five of six beats. The harness is kept because it is what produced that
 * verdict, and because the same corpus can judge the next proposal — set this
 * constant to the OLD text whenever a new grounding block is being trialled.
 */
const OLD_GROUNDING = `VISUAL GROUNDING (this decides whether the video can actually be made):
- Every visual_prompt must name a concrete, filmable subject: a physical place,
  object, machine, person, or activity that a camera could record. "Security
  camera mounted above a supermarket aisle" is usable; "data flowing through a
  neural network" is not.
- The subject must be what the narration is literally talking about at that
  moment. Do not illustrate a sentence about shop-floor cameras with an
  engineer at a laptop.
- Prefer the real-world setting where the story physically happens — the shop,
  street, warehouse, vehicle, control room, checkpoint, clinic or factory —
  over anyone's screen.
- Spread the segments across DIFFERENT physical settings. No single kind of
  location or object may carry most of the video; if four segments would all
  be filmed in the same room, rewrite them.`;

// ── Metrics ───────────────────────────────────────────────────────────────

/** Head nouns that name the KIND of place a shot happens in. */
const SETTING_WORDS = [
  "office", "warehouse", "factory", "plant", "laboratory", "lab", "library",
  "hospital", "clinic", "conference", "checkpoint", "datacenter", "data center",
  "server", "mine", "field", "farm", "forest", "street", "store", "shop",
  "substation", "grid", "rooftop", "workshop", "classroom", "home", "kitchen",
  "port", "dock", "railway", "airport", "studio", "archive", "records",
  "control room", "operations center", "smelting", "recycling", "construction",
];

export function settingsOf(prompt: string): string[] {
  const p = prompt.toLowerCase();
  return SETTING_WORDS.filter((w) => p.includes(w));
}

/**
 * How much of the script is spent in one KIND of place.
 *
 * Deliberately measured over the visual prompts, independently of the
 * retrieval taxonomy, so this metric cannot be moved by editing concept lists.
 */
export function promptMetrics(prompts: string[]) {
  const settings = prompts.map(settingsOf);
  const flat = settings.flat();
  const uniqueSettings = new Set(flat);
  const counts = new Map<string, number>();
  for (const s of flat) counts.set(s, (counts.get(s) ?? 0) + 1);
  const topRepeat = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

  // Two prompts "collide" when they name a setting in common.
  let collisions = 0;
  for (let i = 0; i < settings.length; i++) {
    for (let j = i + 1; j < settings.length; j++) {
      if (settings[i].some((s) => settings[j].includes(s))) collisions++;
    }
  }
  const pairs = (prompts.length * (prompts.length - 1)) / 2 || 1;

  const concepts = prompts.map((p) => classifyConcept(p, AI_SUBJECTS).concept);
  const conceptCounts = new Map<string, number>();
  for (const c of concepts) conceptCounts.set(c, (conceptCounts.get(c) ?? 0) + 1);
  const topConcept = [...conceptCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    beats: prompts.length,
    uniqueSettings: uniqueSettings.size,
    namedSettings: flat.length,
    repeatedSettingRate: collisions / pairs,
    topRepeatedSetting: topRepeat ? `${topRepeat[0]}×${topRepeat[1]}` : "—",
    distinctPromptConcepts: new Set(concepts).size,
    topPromptConcept: topConcept ? `${topConcept[0]}×${topConcept[1]}` : "—",
  };
}

// ── Generation ────────────────────────────────────────────────────────────

async function systemFor(variant: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/stages/scriptGenerator.ts", "utf8");
  const m = src.match(/function systemPrompt\(\): string \{ return `([\s\S]*?)`; \}/);
  if (!m) throw new Error("could not read the live system prompt");
  const live = m[1].replace(/\$\{lengthInstruction\(\)\}/, "5-8 minutes");
  if (variant === "new") return live;
  // Swap the grounding block back to its previous text.
  const start = live.indexOf("VISUAL GROUNDING");
  const end = live.indexOf("- Screens, code, terminals");
  if (start < 0 || end < 0) throw new Error("could not locate the grounding block");
  return live.slice(0, start) + OLD_GROUNDING + "\n" + live.slice(end);
}

async function generate(a: Anthropic, system: string, title: string): Promise<string[]> {
  const msg = await createMessage(a, {
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system,
    messages: [{
      role: "user",
      content: `Topic: ${title}\n\nWrite the script as JSON only.`,
    }],
  });
  const text = (msg.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
  let raw = text.trim();
  if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  const parsed = JSON.parse(raw) as { segments?: { visual_prompt?: string }[] };
  return (parsed.segments ?? []).map((s) => s.visual_prompt ?? "").filter(Boolean);
}

async function main() {
  const variant = (process.argv.find((a) => a.startsWith("--variant="))?.split("=")[1] ?? "new");
  const system = await systemFor(variant);
  const a = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });

  console.log(`VISUAL-PROMPT EVALUATION — variant=${variant}`);
  console.log("no ElevenLabs spend; Claude only; nothing is written to the database\n");

  const byKind: Record<Kind, ReturnType<typeof promptMetrics>[]> = { abstract: [], physical: [] };

  for (const t of CORPUS) {
    let prompts: string[] = [];
    try { prompts = await generate(a, system, t.title); }
    catch (e) { console.log(`  !! ${t.title.slice(0, 50)}: ${(e as Error).message}`); continue; }
    if (!prompts.length) { console.log(`  !! ${t.title.slice(0, 50)}: no prompts`); continue; }
    const m = promptMetrics(prompts);
    byKind[t.kind].push(m);
    console.log(`── [${t.kind}] ${t.title.slice(0, 58)}`);
    console.log(`   beats=${m.beats} uniqueSettings=${m.uniqueSettings} ` +
      `repeatRate=${m.repeatedSettingRate.toFixed(2)} topSetting=${m.topRepeatedSetting} ` +
      `promptConcepts=${m.distinctPromptConcepts} topConcept=${m.topPromptConcept}`);
    prompts.forEach((p, i) => console.log(`     [${i}] ${p.slice(0, 104)}`));
  }

  console.log(`\n${"═".repeat(74)}\nSUMMARY (variant=${variant})`);
  for (const kind of ["abstract", "physical"] as Kind[]) {
    const rows = byKind[kind];
    if (!rows.length) continue;
    const avg = (f: (m: typeof rows[number]) => number) =>
      (rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(2);
    console.log(`  ${kind.padEnd(9)} n=${rows.length} ` +
      `avgUniqueSettings=${avg((r) => r.uniqueSettings)} ` +
      `avgRepeatRate=${avg((r) => r.repeatedSettingRate)} ` +
      `avgDistinctPromptConcepts=${avg((r) => r.distinctPromptConcepts)}`);
  }
}

const direct = process.argv[1]?.includes("eval-visual-prompts");
if (direct) main().catch((e) => { console.error(e); process.exitCode = 1; });
