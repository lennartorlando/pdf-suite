import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  compressPdf,
  compressionProfiles,
  CompressionError,
  type CompressionProfileName,
  type CompressionSummary
} from "@pdf-compressor/core";
import { LIMITS, RETAINED_OUTPUT_CAPACITY, type JobManager } from "../jobs.js";
import type { SessionStore } from "../session.js";
import { writeJson } from "./edit.js";

export interface CompressRouteContext {
  sessions: SessionStore;
  jobs: JobManager;
  sessionId: string;
}

export function toPublicSummary(summary: CompressionSummary): CompressionSummary {
  return { ...summary, inputPath: "upload.pdf", outputPath: "compressed.pdf" };
}

function sanitizeCompressError(error: unknown): { status: number; code: string } {
  if (error instanceof CompressionError) {
    switch (error.code) {
      case "INPUT_NOT_FOUND":
      case "INPUT_NOT_PDF":
      case "INPUT_ENCRYPTED":
      case "INPUT_HAS_FORM_FIELDS":
        return { status: 422, code: error.code };
      case "ENGINE_UNAVAILABLE":
      case "NATIVE_VERSION_UNSUPPORTED":
        return { status: 503, code: error.code };
      case "JOB_CANCELLED":
        return { status: 499, code: error.code };
      case "JOB_TIMEOUT":
        return { status: 504, code: error.code };
      default:
        return { status: 500, code: "COMPRESSION_FAILED" };
    }
  }
  if (error instanceof Error && (error.message === "BODY_TOO_LARGE" || error.message === "OUTPUT_TOO_LARGE" || error.message === "UPLOAD_ABORTED")) {
    if (error.message === "BODY_TOO_LARGE") return { status: 413, code: error.message };
    if (error.message === "OUTPUT_TOO_LARGE") return { status: 422, code: error.message };
    return { status: 499, code: error.message };
  }
  if (error instanceof Error && error.message === RETAINED_OUTPUT_CAPACITY) {
    return { status: 429, code: RETAINED_OUTPUT_CAPACITY };
  }
  return { status: 500, code: "COMPRESSION_FAILED" };
}

/** Stream a raw PDF body to a private file with a byte cap (no file-sized buffer). */
function streamBodyToFile(req: IncomingMessage, target: string, signal: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const out = createWriteStream(target, { mode: 0o600 });
    let bytes = 0;
    let failed = false;
    const fail = (error: Error): void => {
      if (failed) return;
      failed = true;
      try {
        req.unpipe();
      } catch {
        // Best effort.
      }
      out.destroy();
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      const size = chunk.length;
      bytes += size;
      if (bytes > LIMITS.maxTotalBytes) {
        fail(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once("drain", () => req.resume());
      }
    });
    req.on("end", () => {
      if (!failed) out.end(() => resolve(bytes));
    });
    req.on("aborted", () => fail(new Error("UPLOAD_ABORTED")));
    req.on("error", () => fail(new Error("UPLOAD_ABORTED")));
    out.on("error", () => fail(new Error("UPLOAD_ABORTED")));
    signal.addEventListener("abort", () => fail(new Error("UPLOAD_ABORTED")), { once: true });
  });
}

/**
 * Hardened raw compression route. The caller holds the global native slot
 * and releases it after this handler settles; this handler never releases
 * the slot itself. Shares the request boundary,
 * token, streaming cap, cancellation, and lifecycle rules with page export.
 */
export async function handleCompressRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: CompressRouteContext
): Promise<void> {
  const { jobs } = ctx;
  const profileParam = url.searchParams.get("profile") ?? "balanced";
  if (!(profileParam in compressionProfiles)) {
    writeJson(res, 400, { ok: false, code: "UNSUPPORTED_PROFILE", message: "Unsupported compression profile." });
    return;
  }

  const claimed = Number(req.headers["content-length"]);
  if (Number.isInteger(claimed) && claimed > LIMITS.maxTotalBytes) {
    writeJson(res, 413, { ok: false, code: "BODY_TOO_LARGE", message: "Body exceeds its byte cap." });
    return;
  }
  const expectedIntake = Number.isInteger(claimed) && claimed > 0 ? claimed : LIMITS.maxTotalBytes;

  const { dir: jobDir } = await jobs.newJobDir("compress-");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), jobs.jobTimeoutMs);
  timeout.unref?.();
  const onResClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onResClose);

  try {
    const outcome = await runCompressWork(req, url, ctx, jobDir, controller);
    if (outcome.retainedDir === null) {
      await jobs.removeDir(jobDir);
    }
    writeJson(res, outcome.status, outcome.payload);
  } finally {
    clearTimeout(timeout);
    res.off("close", onResClose);
  }
}

interface CompressOutcome {
  status: number;
  payload: unknown;
  retainedDir: string | null;
}

async function runCompressWork(
  req: IncomingMessage,
  url: URL,
  ctx: CompressRouteContext,
  jobDir: string,
  controller: AbortController
): Promise<CompressOutcome> {
  const { jobs } = ctx;
  const fail = (status: number, code: string, message: string): CompressOutcome => ({
    status,
    payload: { ok: false, code, message },
    retainedDir: null
  });
  const claimed = Number(req.headers["content-length"]);
  const expectedIntake = Number.isInteger(claimed) && claimed > 0 ? claimed : LIMITS.maxTotalBytes;
  try {
    const intake = await jobs.checkCapacity(expectedIntake);
    if (!intake.ok) {
      return fail(507, intake.code, "Insufficient temporary capacity.");
    }
    const inputPath = join(jobDir, "input.pdf");
    const outputPath = join(jobDir, "output.pdf");
    await streamBodyToFile(req, inputPath, controller.signal);
    // Native work is done after this point; release before any file cleanup.
    const profileParam = url.searchParams.get("profile") ?? "balanced";
    const profile = profileParam as CompressionProfileName;
    const summary = await compressPdf({ inputPath, outputPath, profile, signal: controller.signal });
    const outputStat = await stat(outputPath);
    if (outputStat.size > LIMITS.maxOutputBytes) {
      throw new Error("OUTPUT_TOO_LARGE");
    }
    await rm(inputPath, { force: true });
    const retained = await jobs.retainOutput({
      sessionId: ctx.sessionId,
      jobDir,
      outputPath,
      pageCount: 0
    });
    return {
      status: 200,
      payload: {
        ok: true,
        handle: retained.handle,
        downloadUrl: `/api/outputs/${retained.handle}/download`,
        summary: toPublicSummary(summary)
      },
      retainedDir: jobDir
    };
  } catch (error) {
    const mapped = sanitizeCompressError(error);
    // U12: a form-bearing refusal must name the way forward, not just fail.
    const message =
      mapped.code === "UPLOAD_ABORTED"
        ? "Upload was interrupted."
        : mapped.code === "INPUT_HAS_FORM_FIELDS"
          ? "This PDF carries form fields that compression cannot preserve. Burn the field values into the page first, then compress the result."
          : mapped.status === 499
            ? "Compression was cancelled."
            : mapped.status === 504
              ? "Compression exceeded its runtime budget."
              : mapped.status >= 500
                ? "Compression failed."
                : "Compression was rejected.";
    return fail(mapped.status, mapped.code, message);
  }
}
