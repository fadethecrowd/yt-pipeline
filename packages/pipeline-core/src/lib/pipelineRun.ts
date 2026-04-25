/**
 * RunSummary — captures the health of a single runPipeline() invocation
 * and persists one row to the pipeline_run table at the end.
 *
 * Status precedence (highest wins): CRITICAL > FAILED > WARNING > SUCCESS > IDLE.
 * Initial status is SUCCESS; setters only escalate (never demote).
 *
 * Thread of mutation across the pipeline:
 *   - entry point (index.ts) instantiates RunSummary, calls verifyChannel,
 *     records setVerifiedChannel(...) on success or markCritical(...) on
 *     mismatch
 *   - runPipeline(summary) mutates as stages succeed / fail; calls
 *     setVideoId / setYoutubeId / setScheduledAt / setShortsUrl as the
 *     ctx.video record is updated; calls markIdle() on no-work topic
 *     discovery; calls markFailed(stageName, err) on stage exceptions;
 *     runs runMode-aware output verification at the very end
 *   - entry point calls summary.persist() inside finally so even unhandled
 *     throws produce a row
 */
import { prisma } from "./db";

export type PipelineChannel = "ai-doom-scroll" | "wet-circuit";
export type PipelineMode = "LIVE" | "DRY_RUN";
export type PipelineRunStatusValue =
  | "CRITICAL"
  | "FAILED"
  | "WARNING"
  | "SUCCESS"
  | "IDLE";

const PRECEDENCE: Record<PipelineRunStatusValue, number> = {
  CRITICAL: 4,
  FAILED: 3,
  WARNING: 2,
  SUCCESS: 1,
  IDLE: 0,
};

export class RunSummary {
  private readonly channel: PipelineChannel;
  private readonly runMode: PipelineMode;
  private readonly startTime: Date;
  private endTime: Date | null = null;
  private status: PipelineRunStatusValue = "SUCCESS";
  private failedStage: string | null = null;
  private errorMessage: string | null = null;
  private warnings: string[] = [];
  private videoId: string | null = null;
  private youtubeId: string | null = null;
  private scheduledAt: Date | null = null;
  private shortsUrl: string | null = null;
  private verifiedChannelTitle: string | null = null;
  private verifiedChannelId: string | null = null;
  private persisted = false;

  constructor(channel: PipelineChannel, runMode: PipelineMode) {
    this.channel = channel;
    this.runMode = runMode;
    this.startTime = new Date();
  }

  // ── Mutators ────────────────────────────────────────────────────────

  setVerifiedChannel(title: string, id: string): void {
    this.verifiedChannelTitle = title;
    this.verifiedChannelId = id;
  }

  setVideoId(id: string): void {
    this.videoId = id;
  }

  setYoutubeId(id: string | null): void {
    this.youtubeId = id;
  }

  setScheduledAt(d: Date | null): void {
    this.scheduledAt = d;
  }

  setShortsUrl(url: string | null): void {
    this.shortsUrl = url;
  }

  addWarning(msg: string): void {
    this.warnings.push(msg);
    this.escalate("WARNING");
  }

  markFailed(stageName: string, error: unknown): void {
    if (!this.failedStage) {
      this.failedStage = stageName;
      this.errorMessage =
        error instanceof Error ? error.message : String(error);
    }
    this.escalate("FAILED");
  }

  markCritical(reason: string): void {
    if (!this.errorMessage) this.errorMessage = reason;
    this.escalate("CRITICAL");
  }

  markIdle(): void {
    // Only IDLE if nothing has escalated above SUCCESS.
    if (this.status === "SUCCESS") this.status = "IDLE";
  }

  hasVerifiedChannel(): boolean {
    return this.verifiedChannelId !== null;
  }

  getStatus(): PipelineRunStatusValue {
    return this.status;
  }

  // ── Output verification (runMode-aware) ─────────────────────────────

  /**
   * Cross-check final pipeline output against expected artifacts.
   * Each missing item is recorded as a warning and escalates status to
   * WARNING (never higher). Skipped automatically when status is already
   * FAILED or CRITICAL — broken runs don't get re-flagged for missing
   * outputs that are obviously absent because of the failure.
   */
  verifyOutputs(opts: {
    finalStatus?: string | null;          // VideoStatus enum string from DB
    videoYoutubeId?: string | null;
    videoScheduledAt?: Date | null;
    videoShortsUrl?: string | null;
    thumbnailAPath?: string | null;
    assemblyCompleted?: boolean;
  }): void {
    if (this.status === "FAILED" || this.status === "CRITICAL") return;
    if (this.status === "IDLE") return; // no work means no outputs to verify

    if (this.runMode === "DRY_RUN") {
      // Dry-run completion criteria: video reached UPLOADED state with a
      // dryrun-prefixed placeholder youtubeId. No real artifacts expected.
      if (opts.finalStatus !== "UPLOADED") {
        this.addWarning(
          `dryrun: final status is ${opts.finalStatus ?? "(missing)"} — expected UPLOADED`,
        );
      }
      if (
        !opts.videoYoutubeId ||
        !opts.videoYoutubeId.startsWith("dryrun-")
      ) {
        this.addWarning(
          `dryrun: youtubeId is ${opts.videoYoutubeId ?? "(missing)"} — expected dryrun-* placeholder`,
        );
      }
      return;
    }

    // LIVE mode — full output verification.
    if (opts.finalStatus !== "UPLOADED") {
      this.addWarning(
        `live: final status is ${opts.finalStatus ?? "(missing)"} — expected UPLOADED`,
      );
    }
    if (!opts.videoYoutubeId || opts.videoYoutubeId.startsWith("dryrun-")) {
      this.addWarning(
        `live: missing real youtubeId (got "${opts.videoYoutubeId ?? "null"}")`,
      );
    }
    if (!opts.videoScheduledAt) {
      this.addWarning("live: scheduledAt not set — long-form not scheduled");
    }
    if (!opts.thumbnailAPath) {
      this.addWarning("live: thumbnailA path not set on video record");
    }
    if (opts.assemblyCompleted === false) {
      this.addWarning(
        "live: videoAssembly stage did not report success (subtitle generation may have skipped)",
      );
    }
    if (!opts.videoShortsUrl) {
      this.addWarning("live: shortsUrl not set — Short was not generated/uploaded");
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  async persist(): Promise<void> {
    if (this.persisted) return;
    this.persisted = true;
    this.endTime = new Date();
    const durationMs = this.endTime.getTime() - this.startTime.getTime();

    try {
      await prisma.pipelineRun.create({
        data: {
          channel: this.channel,
          runMode: this.runMode,
          status: this.status,
          startTime: this.startTime,
          endTime: this.endTime,
          durationMs,
          failedStage: this.failedStage,
          errorMessage: this.errorMessage,
          warnings: this.warnings as unknown as object,
          videoId: this.videoId,
          youtubeId: this.youtubeId,
          scheduledAt: this.scheduledAt,
          shortsUrl: this.shortsUrl,
          verifiedChannelTitle: this.verifiedChannelTitle,
          verifiedChannelId: this.verifiedChannelId,
        },
      });
      console.log(
        `[runSummary] Persisted: channel=${this.channel} mode=${this.runMode} status=${this.status} duration=${durationMs}ms warnings=${this.warnings.length}`,
      );
    } catch (err) {
      // Never block pipeline shutdown on telemetry write failure.
      console.error(
        `[runSummary] Failed to persist run for ${this.channel}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private escalate(target: PipelineRunStatusValue): void {
    if (PRECEDENCE[target] > PRECEDENCE[this.status]) {
      this.status = target;
    }
  }
}
