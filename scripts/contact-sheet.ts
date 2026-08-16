/**
 * Render a run's visual plan as a contact sheet, so a human can judge relevance.
 *
 *   npx tsx scripts/contact-sheet.ts --run <runId>
 *   npx tsx scripts/contact-sheet.ts --video <videoId> --out tmp/sheets
 *
 * Feasibility reported this run PASS: 174 usable assets, 0 predicted cards,
 * four concepts. Human review found warehouse shelving, forklifts, wind
 * turbines and farmland sitting over narration about API credit arbitrage. Both
 * are true, which means the numbers are measuring something other than whether
 * the picture matches the sentence.
 *
 * This does not try to settle that. It puts the narration next to the frame it
 * was paired with and gets out of the way.
 *
 * Strictly read-only: one SELECT, no retrieval, no external API, no writes to
 * anything but the output file. LOCAL ONLY.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { prisma, disconnect } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

interface Scene {
  sceneNumber: number; narration: string; startTimeS: number; endTimeS: number;
  prompt: string; assetSource: string; assetId: string | null; assetUrl: string | null;
  localPath: string | null; durationS: number | null; validation: string;
  rejectionReason: string | null; relevanceScore: number | null;
  relevanceVerdict: string | null; assetDescription: string | null;
  relevanceReasons: string[]; renderStatus: string;
}

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The taxonomy label, recovered from the reason strings that recorded it. */
function concept(reasons: string[]): string {
  for (const r of reasons) {
    const m = /subject "([^"]+)"/.exec(r);
    if (m) return m[1]!;
  }
  return "—";
}

/**
 * A thumbnail for the asset.
 *
 * Local render frames are preferred but this run's `tmp/` was cleaned up, so
 * they are gone. Pexels serves a poster image at a deterministic path derived
 * from the asset id; that URL is EMBEDDED, not fetched here — the browser
 * requests it when the sheet is opened, and falls back to a labelled
 * placeholder if it does not resolve. Nothing in this script calls out.
 */
function thumb(s: Scene): string {
  const label = `${esc(s.assetSource)} ${esc(s.assetId ?? "—")}`;
  if (s.localPath && existsSync(s.localPath)) {
    return `<video class="thumb" src="file://${esc(s.localPath)}" muted preload="metadata"></video>`;
  }
  if (s.assetSource === "pexels" && s.assetId) {
    const poster = `https://images.pexels.com/videos/${s.assetId}/free-video-${s.assetId}.jpeg?auto=compress&cs=tinysrgb&w=420`;
    return `<img class="thumb" loading="lazy" src="${esc(poster)}" alt="${label}"
      onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb ph',textContent:'${label} — no frame on disk'}))">`;
  }
  return `<div class="thumb ph">${label}<br><small>no frame on disk</small></div>`;
}

const CSS = `
:root{--bg:#0f1115;--fg:#e6e8eb;--dim:#9aa3ad;--line:#252a31;--warn:#f0b429;--bad:#e5534b;--ok:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header{padding:24px 28px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
h1{margin:0 0 6px;font-size:19px}
.meta{color:var(--dim);font-size:12.5px}
.gap{margin:14px 0 0;padding:10px 12px;border-left:3px solid var(--warn);background:#1a1710;color:#f3d9a0;font-size:12.5px}
.beat{display:grid;grid-template-columns:300px 1fr;gap:22px;padding:22px 28px;border-bottom:1px solid var(--line)}
.beat:nth-child(even){background:#12151a}
.narr{font-size:14.5px}
.idx{color:var(--dim);font-size:12px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px}
.assets{display:flex;flex-wrap:wrap;gap:16px}
.card{width:300px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#161a20}
.card.chosen{border-color:#2f5d3a}
.thumb{width:100%;height:169px;object-fit:cover;display:block;background:#0b0d10}
.ph{display:flex;flex-direction:column;align-items:center;justify-content:center;
color:var(--dim);font-size:12px;text-align:center;padding:8px}
.info{padding:10px 12px;font-size:12.5px}
.desc{color:var(--fg);margin-bottom:6px}
.row{color:var(--dim);display:flex;gap:8px;flex-wrap:wrap}
.tag{border:1px solid var(--line);border-radius:4px;padding:1px 6px}
.score{font-variant-numeric:tabular-nums}
.s-lo{color:var(--bad)}.s-mid{color:var(--warn)}.s-hi{color:var(--ok)}
.reasons{margin:8px 0 0;padding-left:16px;color:var(--dim);font-size:12px}
.flag{display:inline-block;background:#3a1d1b;color:#ffb4ae;border-radius:4px;padding:1px 7px;font-size:11.5px;margin-left:8px}
a{color:#79b8ff}
`;

async function main(): Promise<void> {
  const runId = arg("--run");
  const videoArg = arg("--video");
  if (!runId && !videoArg) {
    console.error("✗ --run <runId> or --video <videoId> is required");
    process.exitCode = 2; return;
  }

  let videoId = videoArg;
  let runLabel = videoArg ?? "";
  if (runId) {
    const run = await prisma.pipelineRun.findUnique({ where: { id: runId } });
    if (!run) { console.error(`✗ no pipeline_run ${runId}`); process.exitCode = 1; return; }
    if (!run.videoId) { console.error(`✗ run ${runId} has no candidate`); process.exitCode = 1; return; }
    videoId = run.videoId;
    runLabel = `run ${runId} · ${run.status}`;
  }

  const scenes = (await (prisma as never as { sceneRecord: { findMany(a: unknown): Promise<Scene[]> } })
    .sceneRecord.findMany({ where: { videoId }, orderBy: { sceneNumber: "asc" } })) as Scene[];
  if (scenes.length === 0) {
    console.error(`✗ no visual plan: candidate ${videoId} has no scene_record rows`);
    process.exitCode = 1; return;
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId! }, include: { topic: { select: { title: true } } } });

  // Group consecutive scenes that share narration — those are one beat filled
  // by several clips.
  const beats: { narration: string; prompt: string; scenes: Scene[] }[] = [];
  for (const s of scenes) {
    const last = beats[beats.length - 1];
    if (last && last.narration === s.narration) last.scenes.push(s);
    else beats.push({ narration: s.narration, prompt: s.prompt, scenes: [s] });
  }

  const cards = scenes.filter((s) => s.assetSource !== "pexels" || !s.assetId);
  const failed = scenes.filter((s) => s.validation !== "PASS");

  const rows = beats.map((b, i) => {
    const start = Math.min(...b.scenes.map((s) => s.startTimeS));
    const end = Math.max(...b.scenes.map((s) => s.endTimeS));
    const assets = b.scenes.map((s) => {
      const sc = s.relevanceScore ?? 0;
      const cls = sc < 0.4 ? "s-lo" : sc < 0.6 ? "s-mid" : "s-hi";
      const flags = [
        s.validation !== "PASS" ? `<span class="flag">${esc(s.validation)}</span>` : "",
        s.assetSource !== "pexels" ? `<span class="flag">FALLBACK CARD</span>` : "",
        s.rejectionReason ? `<span class="flag">${esc(s.rejectionReason)}</span>` : "",
      ].join("");
      return `<div class="card chosen">
        ${thumb(s)}
        <div class="info">
          <div class="desc">${esc(s.assetDescription ?? "(no description recorded)")}${flags}</div>
          <div class="row">
            <span class="tag">${esc(s.assetSource)}</span>
            <span class="tag">${esc(concept(s.relevanceReasons))}</span>
            <span class="tag score ${cls}">${sc.toFixed(2)} ${esc(s.relevanceVerdict ?? "")}</span>
            <span class="tag">scene ${s.sceneNumber}</span>
            <span class="tag">${(s.durationS ?? 0).toFixed(1)}s</span>
          </div>
          <ul class="reasons">${s.relevanceReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
          ${s.assetUrl ? `<div class="row" style="margin-top:6px"><a href="${esc(s.assetUrl)}">source</a></div>` : ""}
        </div>
      </div>`;
    }).join("");
    return `<section class="beat">
      <div>
        <div class="idx">beat ${i + 1} of ${beats.length} · ${tc(start)}–${tc(end)}</div>
        <div class="narr">${esc(b.narration)}</div>
        <div class="idx" style="margin-top:12px">visual prompt</div>
        <div class="row" style="display:block">${esc(b.prompt)}</div>
      </div>
      <div class="assets">${assets}</div>
    </section>`;
  }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Contact sheet — ${esc(video?.topic?.title ?? videoId!)}</title><style>${CSS}</style></head><body>
<header>
  <h1>${esc(video?.topic?.title ?? "(no topic)")}</h1>
  <div class="meta">candidate ${esc(videoId!)} · ${esc(runLabel)} ·
    ${beats.length} beats · ${scenes.length} scenes · ${cards.length} fallback card(s) ·
    ${failed.length} non-PASS</div>
  <div class="gap"><strong>Not persisted for this run:</strong> the retrieval query that returned
  each asset (only the beat's visual prompt was stored), runner-up candidates and their scores
  (only the selected asset per scene is written), and the concept label as its own field — it is
  recovered here from the recorded relevance reasons. Local render frames were listed but the
  run's tmp/ directory has been cleaned, so thumbnails come from the Pexels poster URL derived
  from the asset id and fall back to a placeholder if it does not resolve.</div>
</header>
${rows}
</body></html>`;

  const outDir = arg("--out") ?? "tmp/contact-sheets";
  const outPath = resolve(`${outDir}/${videoId}.html`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`   ${beats.length} beats, ${scenes.length} scenes → ${outPath}`);
  await disconnect();
}

main().catch(async (e) => { console.error(e); await disconnect(); process.exitCode = 1; });
