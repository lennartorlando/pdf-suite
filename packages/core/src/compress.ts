import { copyFile, rename, stat } from "node:fs/promises";
import { basename } from "node:path";
import { CompressionError } from "./errors.js";
import { getCompressionProfile, type CompressionProfileName } from "./profiles.js";
import { createTempWorkspace } from "./temp-workspace.js";
import { validatePdfInput } from "./validation.js";
import { qpdfEngine } from "./engines/qpdf.js";
import { ghostscriptEngine } from "./engines/ghostscript.js";
import {
  assertAdmissibleFor,
  defaultNativeRunner,
  inspectPdfSource,
  type NativeCallOptions,
  type NativeRunner
} from "./engines/qpdf-pages.js";
import type { CompressionEngine } from "./engines/types.js";

export interface CompressionOptions {
  inputPath: string;
  outputPath: string;
  profile: CompressionProfileName;
  signal?: AbortSignal;
  /** Bound on each native inspection call. */
  timeoutMs?: number;
  /** Injectable native runner (tests simulate a missing qpdf). */
  run?: NativeRunner;
  engines?: CompressionEngine[];
}

export interface CompressionSummary {
  status: "success" | "no_gain";
  inputPath: string;
  outputPath: string;
  profile: CompressionProfileName;
  originalBytes: number;
  outputBytes: number;
  reductionBytes: number;
  reductionPercent: number;
  outputSmaller: boolean;
  engine: string;
  warnings: string[];
}

const defaultEngines = [ghostscriptEngine, qpdfEngine];

export async function compressPdf(options: CompressionOptions): Promise<CompressionSummary> {
  if (options.signal?.aborted) {
    throw new CompressionError("JOB_CANCELLED", "Compression job was cancelled.");
  }

  const validation = await validatePdfInput(options.inputPath, options.outputPath);

  // KTD9/R21: compression now inspects through qpdf, which it never did
  // before, and refuses a document carrying form fields — the smaller-wins
  // comparison is not value-preserving between form-bearing candidates.
  // That makes qpdf a required dependency: a missing qpdf surfaces as
  // ENGINE_UNAVAILABLE and an unreadable object graph as
  // INSPECTION_INCOMPLETE rather than silently degrading.
  const calls: NativeCallOptions = {
    run: options.run ?? defaultNativeRunner,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  };
  const inspection = await inspectPdfSource(options.inputPath, calls);
  assertAdmissibleFor(inspection, "compress", {
    label: "Source PDF",
    details: { inputPath: options.inputPath }
  });
  if (inspection.compatWarnings.includes("forms")) {
    throw new CompressionError(
      "INPUT_HAS_FORM_FIELDS",
      "Source PDF carries form fields that compression cannot preserve; burn the values into page content first, then compress.",
      { inputPath: options.inputPath }
    );
  }

  const profile = getCompressionProfile(options.profile);
  const engines = options.engines ?? defaultEngines;
  const engine = engines.find((candidate) => candidate.supports(profile));

  if (!engine) {
    throw new CompressionError("ENGINE_UNAVAILABLE", `No compression engine supports ${profile.name}.`);
  }

  const workspace = await createTempWorkspace();
  const candidatePath = workspace.file(`compressed-${basename(options.inputPath)}`);

  try {
    const result = await engine.compress(options.inputPath, candidatePath, profile, options.signal);

    if (options.signal?.aborted) {
      throw new CompressionError("JOB_CANCELLED", "Compression job was cancelled.");
    }

    const outputStat = await stat(candidatePath);
    await copyFile(candidatePath, options.outputPath);
    const finalStat = await stat(options.outputPath);
    const reductionBytes = validation.sizeBytes - finalStat.size;
    const reductionPercent = validation.sizeBytes === 0
      ? 0
      : Number(((reductionBytes / validation.sizeBytes) * 100).toFixed(2));

    return {
      status: reductionBytes > 0 ? "success" : "no_gain",
      inputPath: options.inputPath,
      outputPath: options.outputPath,
      profile: profile.name,
      originalBytes: validation.sizeBytes,
      outputBytes: outputStat.size,
      reductionBytes,
      reductionPercent,
      outputSmaller: reductionBytes > 0,
      engine: result.engine,
      warnings: [...inspection.warnings, ...result.warnings]
    };
  } catch (error) {
    await rmOutputIfCancelled(options.outputPath, error);
    throw error;
  } finally {
    await workspace.cleanup();
  }
}

async function rmOutputIfCancelled(outputPath: string, error: unknown): Promise<void> {
  if (error instanceof CompressionError && error.code === "JOB_CANCELLED") {
    const { rm } = await import("node:fs/promises");
    await rm(outputPath, { force: true });
  }
}

export async function atomicMove(sourcePath: string, outputPath: string): Promise<void> {
  await rename(sourcePath, outputPath);
}
