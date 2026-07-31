import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { prisma } from "./db";

/**
 * Immutable approved-artifact handoff.
 *
 * The previous flow re-ran assembly during the upload invocation, which
 * re-searched and re-selected visuals. The uploaded file was therefore not
 * necessarily the file that was reviewed — it only happened to match. Approval
 * now binds to a specific file hash AND a specific scene manifest, and upload
 * verifies both before sending a single byte.
 */

export interface SceneManifestEntry {
  index: number;
  startS: number;
  endS: number;
  durationS: number;
  assetId: string | null;
  assetDescription: string | null;
  looped: boolean;
  reused: boolean;
  relevanceScore: number | null;
  concept: string | null;
  brandDecision: string;
  decision: string;
}

export interface ApprovedArtifact {
  videoId: string;
  filePath: string;
  fileSha256: string;
  manifestSha256: string;
  manifest: SceneManifestEntry[];
  qaRecordId: string;
  approvedAt: string;
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export function sha256Manifest(m: SceneManifestEntry[]): string {
  return createHash("sha256").update(JSON.stringify(m)).digest("hex");
}

/** Persisted on the QA record so approval and artifact cannot drift apart. */
export async function storeApproval(a: ApprovedArtifact): Promise<void> {
  await prisma.qaRecord.update({
    where: { id: a.qaRecordId },
    data: {
      checks: {
        approvedArtifact: {
          filePath: a.filePath,
          fileSha256: a.fileSha256,
          manifestSha256: a.manifestSha256,
          approvedAt: a.approvedAt,
          manifest: a.manifest,
        },
      } as unknown as object,
    },
  });
}

export class ArtifactMismatchError extends Error {
  constructor(what: string, expected: string, actual: string) {
    super(
      `Approved-artifact ${what} mismatch — refusing to upload. ` +
        `expected ${expected.slice(0, 16)}… actual ${actual.slice(0, 16)}…`,
    );
    this.name = "ArtifactMismatchError";
  }
}

/**
 * Verify an artifact still matches what was approved. Fails closed: any
 * mismatch, or a missing file, aborts the upload.
 */
export async function verifyApproved(
  a: Pick<ApprovedArtifact, "filePath" | "fileSha256" | "manifestSha256" | "manifest">,
): Promise<void> {
  if (!existsSync(a.filePath)) {
    throw new ArtifactMismatchError("file", a.filePath, "<missing>");
  }
  const fileHash = await sha256File(a.filePath);
  if (fileHash !== a.fileSha256) {
    throw new ArtifactMismatchError("file hash", a.fileSha256, fileHash);
  }
  const manifestHash = sha256Manifest(a.manifest);
  if (manifestHash !== a.manifestSha256) {
    throw new ArtifactMismatchError("scene manifest", a.manifestSha256, manifestHash);
  }
}
