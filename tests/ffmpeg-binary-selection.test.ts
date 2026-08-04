import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG, FFPROBE, hasDrawtext } from "../packages/pipeline-core/src/lib/ffmpeg";

const execFile = promisify(execFileCb);

/**
 * Which ffmpeg the pipeline actually runs.
 *
 * Homebrew's plain `ffmpeg` bottle is built without libass, libfreetype or
 * fontconfig. Every clip cut fine on it and then the render died on the first
 * title card — `No such filter: 'drawtext'` — and would have died again on
 * `subtitles=` when burning captions. The keg-only `ffmpeg-full` formula has
 * all three and installs alongside rather than replacing the slim build, so
 * the resolver prefers it when present.
 *
 * PATH is deliberately not consulted: the shell that launches a worker is not
 * the shell a developer tested in.
 */

const FULL_FFMPEG = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FULL_FFPROBE = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

describe("binary selection", () => {
  test("ffmpeg-full is preferred when installed, bare ffmpeg otherwise", () => {
    if (existsSync(FULL_FFMPEG)) {
      assert.equal(FFMPEG, FULL_FFMPEG, "ffmpeg-full is installed but not selected");
    } else {
      assert.equal(FFMPEG, "ffmpeg", "no full build present, so PATH lookup is correct");
    }
  });

  test("ffprobe follows the same rule", () => {
    assert.equal(FFPROBE, existsSync(FULL_FFPROBE) ? FULL_FFPROBE : "ffprobe");
  });

  test("selection never depends on PATH", () => {
    // An absolute path, or the bare name that lets execFile resolve it — never
    // something spliced together from process.env.PATH.
    assert.ok(FFMPEG === "ffmpeg" || FFMPEG.startsWith("/"), FFMPEG);
    assert.ok(!FFMPEG.includes(":"), "a PATH-like value would contain separators");
  });
});

describe("the selected binary can render text", () => {
  const skip = !existsSync(FULL_FFMPEG) ? "ffmpeg-full not installed on this machine" : false;

  test("drawtext is detected", { skip }, async () => {
    assert.equal(await hasDrawtext(), true);
  });

  test("subtitles, ass and drawtext filters all exist", { skip }, async () => {
    const { stdout } = await execFile(FFMPEG, ["-hide_banner", "-filters"], { maxBuffer: 1 << 24 });
    for (const f of ["subtitles", "ass", "drawtext"]) {
      assert.match(stdout, new RegExp(`\\s${f}\\s`), `${f} filter missing — captions or cards would fail`);
    }
  });

  test("it was built with the libraries those filters need", { skip }, async () => {
    const { stdout } = await execFile(FFMPEG, ["-hide_banner", "-version"], { maxBuffer: 1 << 24 });
    for (const lib of ["libass", "libfreetype", "libfontconfig"]) {
      assert.match(stdout, new RegExp(`enable-${lib}\\b`), `built without ${lib}`);
    }
  });
});
