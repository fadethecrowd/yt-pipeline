/**
 * Pre-TTS screening of candidate topics.
 *
 *   npx tsx scripts/screen-topics.ts
 *
 * Runs the visual-feasibility gate against each candidate's PRELIMINARY
 * narrative outline, before any script is written and long before any narration
 * is bought. The winner is then scripted in full and re-gated against the final
 * script by scripts/qualify.ts.
 *
 * Selection is on ACCEPTED UNIQUE ASSETS after relevance, duration, resolution,
 * branding and quality rules — never on the raw number of search results. The
 * HBM topic returned plenty of raw Pexels hits; what it lacked was distinct
 * usable seconds.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessVisualFeasibility, pexelsOnlySource, formatFeasibility, prisma, disconnect, env,
} from "@yt-pipeline/pipeline-core";
import type { FeasibilityReport, OutlineSegment } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

export interface Candidate {
  key: string;
  title: string;
  url: string;
  /** Research context handed to the scriptwriter once this topic is chosen. */
  summary: string;
  targetRuntimeS: number;
  outline: OutlineSegment[];
}

/**
 * The three subjects under consideration. Excluded by instruction: HBM memory,
 * semiconductor packaging, wafer fabrication, and the earlier AI data-centre
 * power-demand diagnostic topic.
 *
 * Each outline is a sketch, not a script: enough narrative shape and enough
 * concrete visual intent for the gate to build the same queries assembly would
 * build.
 */
export const CANDIDATES: Candidate[] = [
  {
    key: "robots-no-map",
    title: "Warehouse Robots Stopped Needing a Map",
    url: "https://qualification.local/ai-doom/warehouse-robots-no-map",
    targetRuntimeS: 355,
    summary:
      "Warehouse automation has shifted from fixed-infrastructure AGVs following magnetic tape or QR "
      + "codes to autonomous mobile robots that build their own maps with SLAM, lidar and vision. "
      + "Amazon, Symbotic, Locus and Geek+ are deploying fleets that reorganise themselves. "
      + "Consequences: retrofit costs collapse, warehouse leases get shorter, the labour mix shifts "
      + "from picking to exception handling, and the software layer becomes the moat rather than the "
      + "hardware. Concrete visuals: mobile robots, conveyor systems, fulfilment centres, lidar "
      + "sensors, machine vision, pick stations, forklifts, packing lines.",
    outline: [
      {
        segmentIndex: 0,
        title: "The Tape on the Floor",
        narration:
          "For thirty years an automated warehouse meant a robot following a magnetic strip glued to "
          + "the concrete. The infrastructure was the intelligence. Move the shelves and you rebuilt "
          + "the floor. That constraint is gone.",
        visual_prompt:
          "B-roll of an automated warehouse conveyor system moving boxes. B-roll of a forklift "
          + "operating in a distribution centre aisle.",
      },
      {
        segmentIndex: 1,
        title: "How a Robot Builds Its Own Map",
        narration:
          "Simultaneous localisation and mapping lets a robot construct a map of a space while "
          + "working out where it is inside that map. Lidar sweeps the aisles, cameras read the "
          + "shelving, and the robot navigates a warehouse it has never seen before.",
        visual_prompt:
          "B-roll of a lidar sensor scanning an indoor space. B-roll of an autonomous mobile robot "
          + "navigating a warehouse aisle.",
      },
      {
        segmentIndex: 2,
        title: "The Fleet Reorganises Itself",
        narration:
          "One robot mapping a room is a demo. A hundred robots sharing one map is a warehouse. The "
          + "fleet routes around congestion, reassigns picks, and keeps working when a unit drops out.",
        visual_prompt:
          "B-roll of multiple industrial robots working on an automated production line. B-roll of a "
          + "modern fulfilment centre with packages moving on conveyors.",
      },
      {
        segmentIndex: 3,
        title: "What This Does to the Building",
        narration:
          "When the intelligence moves into the robot, the building stops being special. Retrofit "
          + "costs collapse, leases get shorter, and an operator can stand up capacity in a shell "
          + "warehouse in weeks rather than commissioning a bespoke installation over a year.",
        visual_prompt:
          "B-roll of a large industrial warehouse interior with high storage shelves. B-roll of "
          + "workers at packing stations in a distribution centre.",
      },
      {
        segmentIndex: 4,
        title: "The Job That Is Left",
        narration:
          "The picking job is going. The job that replaces it is exception handling: a human walks to "
          + "the robot that has stopped, works out why, and clears it. Fewer people, higher skill, and "
          + "a control room watching the whole floor.",
        visual_prompt:
          "B-roll of an engineer monitoring screens in a control room. B-roll of a technician working "
          + "on an industrial robot on a factory floor.",
      },
    ],
  },
  {
    key: "humanoids-factory",
    title: "Humanoid Robots Are Walking Into Factories",
    url: "https://qualification.local/ai-doom/humanoids-manufacturing",
    targetRuntimeS: 355,
    summary:
      "Humanoid robots have moved from research demos into pilot deployments on real manufacturing "
      + "floors. Figure, Agility, Apptronik and Tesla are running units in logistics and automotive "
      + "plants. The argument for a human shape is that factories are already built for human bodies. "
      + "The argument against is cost, battery life, safety certification and cycle-time reliability. "
      + "Concrete visuals: humanoid robots, robot arms, automotive assembly lines, factory workers, "
      + "engineers with robots, industrial automation.",
    outline: [
      {
        segmentIndex: 0,
        title: "Why a Human Shape at All",
        narration:
          "A factory is a building shaped around human bodies. Doors, stairs, tote sizes and reach "
          + "distances all assume a person. A humanoid robot is an argument that it is cheaper to "
          + "build a machine that fits the building than to rebuild the building.",
        visual_prompt:
          "B-roll of a humanoid robot standing in a laboratory. B-roll of an automated factory "
          + "assembly line with industrial robots.",
      },
      {
        segmentIndex: 1,
        title: "From Demo Video to Pilot Line",
        narration:
          "The demonstration videos were choreography. What changed is that a handful of these "
          + "machines are now doing repetitive material handling on real pilot lines, measured against "
          + "the same cycle time as the humans beside them.",
        visual_prompt:
          "B-roll of an industrial robot arm moving parts on an assembly line. B-roll of a modern "
          + "automotive manufacturing plant.",
      },
      {
        segmentIndex: 2,
        title: "The Numbers That Decide It",
        narration:
          "Battery life, payload, uptime and safety certification decide whether this is a product or "
          + "a research programme. A machine that runs four hours and needs a cage is not competing "
          + "with a worker who runs a full shift.",
        visual_prompt:
          "B-roll of engineers working with robotics equipment in a laboratory. B-roll of a technician "
          + "inspecting machinery in an industrial facility.",
      },
      {
        segmentIndex: 3,
        title: "What It Actually Replaces",
        narration:
          "The first jobs are the ones nobody wants: moving totes, loading machines, standing in one "
          + "place for eight hours. That is also where the existing automation already works, which is "
          + "the awkward part of the pitch.",
        visual_prompt:
          "B-roll of warehouse workers moving boxes in a distribution centre. B-roll of an automated "
          + "conveyor with packaging process.",
      },
      {
        segmentIndex: 4,
        title: "Who Is Actually Buying",
        narration:
          "Automotive and logistics are writing the cheques, because they already run large automation "
          + "programmes and can absorb a pilot that fails. The question is whether the second order is "
          + "larger than the first.",
        visual_prompt:
          "B-roll of a car manufacturing production line with welding robots. B-roll of a modern "
          + "logistics warehouse with automated systems.",
      },
    ],
  },
  {
    key: "cv-surveillance",
    title: "The Camera Above the Aisle Is Now Watching You",
    url: "https://qualification.local/ai-doom/computer-vision-retail-surveillance",
    targetRuntimeS: 355,
    summary:
      "Computer vision has turned retail and warehouse CCTV from a recording device into an analytics "
      + "system. Shrink detection, queue management, dwell-time tracking, self-checkout monitoring and "
      + "worker productivity measurement now run on the same cameras that used to just record. "
      + "Consequences: consent and regulation questions, false-positive accusations against shoppers, "
      + "and workplace surveillance of staff. Concrete visuals: security cameras, CCTV monitors, "
      + "retail stores, checkout areas, control rooms, facial recognition overlays, warehouse cameras.",
    outline: [
      {
        segmentIndex: 0,
        title: "The Camera Stopped Just Recording",
        narration:
          "The camera above the aisle used to be a recording device you looked at after something went "
          + "wrong. It is now an analytics system that makes a decision about you while you are still "
          + "standing there.",
        visual_prompt:
          "B-roll of a security camera mounted on a ceiling. B-roll of surveillance monitors in a "
          + "control room.",
      },
      {
        segmentIndex: 1,
        title: "What It Is Actually Measuring",
        narration:
          "Dwell time in front of a shelf. Queue length at the checkout. Whether the item that was "
          + "scanned matches the item in the bag. Each of these is a computer vision model watching a "
          + "specific behaviour.",
        visual_prompt:
          "B-roll of a customer at a self checkout in a supermarket. B-roll of shoppers walking "
          + "through a retail store aisle.",
      },
      {
        segmentIndex: 2,
        title: "The False Positive Problem",
        narration:
          "A model that flags theft will flag people who are not stealing. The cost of that error is "
          + "not borne by the retailer. It is borne by the shopper who gets stopped at the door.",
        visual_prompt:
          "B-roll of a computer vision system with object detection on a screen. B-roll of a security "
          + "guard monitoring screens.",
      },
      {
        segmentIndex: 3,
        title: "It Points at the Staff Too",
        narration:
          "The same cameras measure how long a worker takes to pick an item, how often they stop, and "
          + "how their rate compares to the rest of the shift. Productivity surveillance arrived as a "
          + "side effect of loss prevention.",
        visual_prompt:
          "B-roll of warehouse workers scanning packages. B-roll of an employee working at a packing "
          + "station in a distribution centre.",
      },
      {
        segmentIndex: 4,
        title: "The Regulation Is Behind",
        narration:
          "Biometric consent law was written for fingerprints and door access. It is now being applied "
          + "to a camera that identifies a face in a crowd, and the gap between the two is where every "
          + "current lawsuit sits.",
        visual_prompt:
          "B-roll of facial recognition technology scanning faces. B-roll of a city street with "
          + "surveillance cameras.",
      },
    ],
  },
];

/** Topics that must not be reused, and anything already in the library. */
async function duplicateCheck(c: Candidate): Promise<string[]> {
  const problems: string[] = [];
  const banned = [
    "hbm", "high bandwidth memory", "semiconductor packaging", "wafer",
    "data center power", "data centre power", "power demand",
  ];
  const hay = `${c.title} ${c.summary}`.toLowerCase();
  for (const b of banned) {
    // The summary may legitimately mention a excluded term in passing; only the
    // TITLE defines what the video is about.
    if (c.title.toLowerCase().includes(b)) problems.push(`title uses excluded subject "${b}"`);
  }
  void hay;

  const byUrl = await prisma.topic.findUnique({ where: { url: c.url } });
  if (byUrl) {
    const vids = await prisma.video.findMany({ where: { topicId: byUrl.id } });
    const uploaded = vids.filter((v) => v.youtubeId && !v.youtubeId.startsWith("dryrun-"));
    if (uploaded.length) {
      problems.push(`topic URL already produced ${uploaded.length} uploaded video(s)`);
    }
  }

  // Near-duplicate title against everything the channel has ever discovered.
  const words = new Set(
    c.title.toLowerCase().split(/\W+/).filter((w) => w.length > 4),
  );
  const all = await prisma.topic.findMany({ select: { title: true, url: true } });
  for (const t of all) {
    if (t.url === c.url) continue;
    const tw = new Set(t.title.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
    const shared = [...words].filter((w) => tw.has(w));
    if (shared.length >= 3) {
      problems.push(`near-duplicate of existing topic "${t.title}" (shared: ${shared.join(", ")})`);
    }
  }
  return problems;
}

async function main() {
  const config = env();
  const source = pexelsOnlySource(config.PEXELS_API_KEY);
  const results: {
    candidate: Candidate;
    report: FeasibilityReport;
    duplicates: string[];
  }[] = [];

  for (const c of CANDIDATES) {
    console.log(`\n${"═".repeat(78)}`);
    console.log(`CANDIDATE: ${c.title}`);
    console.log("═".repeat(78));

    const duplicates = await duplicateCheck(c);
    const report = await assessVisualFeasibility(
      {
        channel: "ai-doom-scroll",
        topicTitle: c.title,
        targetRuntimeS: c.targetRuntimeS,
        segments: c.outline,
      },
      source,
    );
    console.log(formatFeasibility(report));
    console.log(
      `\n  duplicate check    : ${duplicates.length === 0 ? "CLEAN" : duplicates.join("; ")}`,
    );
    results.push({ candidate: c, report, duplicates });
  }

  // ── Selection ───────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(78)}`);
  console.log("SELECTION");
  console.log("═".repeat(78));
  console.log(
    `${"topic".padEnd(48)} ${"pass".padEnd(6)} ${"accepted".padEnd(9)} ${"needed".padEnd(7)} ${"usable-s".padEnd(9)} cards%`,
  );
  for (const r of results) {
    console.log(
      `${r.candidate.title.slice(0, 47).padEnd(48)} ${(r.report.pass ? "PASS" : "FAIL").padEnd(6)} ` +
      `${String(r.report.uniqueUsableAssets).padEnd(9)} ${String(r.report.requiredPoolWithSafety).padEnd(7)} ` +
      `${String(r.report.totalUsableDurationS).padEnd(9)} ${r.report.estimatedCardPct}%`,
    );
  }

  const eligible = results.filter((r) => r.report.pass && r.duplicates.length === 0);
  // Rank on accepted unique assets — the quantity that actually determines
  // whether a timeline can be filled — with usable duration as the tie-break.
  eligible.sort(
    (a, b) =>
      b.report.uniqueUsableAssets - a.report.uniqueUsableAssets ||
      b.report.totalUsableDurationS - a.report.totalUsableDurationS,
  );

  const winner = eligible[0];
  console.log(
    winner
      ? `\n  SELECTED: ${winner.candidate.title} (key "${winner.candidate.key}")`
      : `\n  NO CANDIDATE PASSED — none of the three topics can be illustrated from the current source library.`,
  );

  await writeFile(
    join(process.cwd(), "output", "topic-screening.json"),
    JSON.stringify(
      results.map((r) => ({
        key: r.candidate.key,
        title: r.candidate.title,
        duplicates: r.duplicates,
        report: r.report,
      })),
      null,
      2,
    ),
  );
  console.log(`  report written: output/topic-screening.json`);
  await disconnect();
}

main().catch(async (e) => {
  console.error("\nSCREENING FAILED:", e);
  await disconnect();
  process.exit(1);
});
