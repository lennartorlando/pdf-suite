import { randomUUID } from "node:crypto";
import { copyFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CompressionError } from "./errors.js";
import {
  inspectPdfSource,
  publishNoClobber,
  validatePdfArtifact,
  type NativeCallOptions,
  type NativeRunner,
  type PdfInspection,
  defaultNativeRunner
} from "./engines/qpdf-pages.js";
import { runOcrMyPdf, type OcrMyPdfResult } from "./engines/ocrmypdf.js";
import { createTempWorkspace } from "./temp-workspace.js";
import { withOutputLimit } from "./output-limit.js";
import { assertFreshDestination, validatePdfInput } from "./validation.js";

export const SUPPORTED_OCR_LANGUAGES = ["deu", "eng"] as const;
export type OcrLanguage = (typeof SUPPORTED_OCR_LANGUAGES)[number];
export const DEFAULT_OCR_TIMEOUT_MS = 300_000;

export interface OcrOptions {
  languages: readonly OcrLanguage[];
  autoRotate?: boolean;
}

export interface OcrPdfOptions extends OcrOptions {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Parent for private OCR scratch files, normally a server-owned job directory. */
  workspaceParent?: string;
  /** Live aggregate quota/free-space check invoked while native work runs. */
  resourceCheck?: (additionalBytes?: number) => Promise<void>;
  run?: NativeRunner;
}

export interface OcrSummary extends OcrMetadata {
  status: "success";
  inputPath: string;
  outputPath: string;
  pageCount: number;
  outputBytes: number;
  qpdfVersion: string;
  warnings: string[];
  compatWarnings: PdfInspection["compatWarnings"];
}

export interface OcrMetadata {
  engine: "ocrmypdf";
  version: string;
  tesseractVersion: string;
  languages: OcrLanguage[];
  autoRotate: boolean;
}

export function normalizeOcrOptions(options: OcrOptions): Required<OcrOptions> {
  if (!options || !Array.isArray(options.languages) || options.languages.length === 0) {
    throw new CompressionError("OCR_OPTIONS_INVALID", "OCR needs at least one language.");
  }
  const supported = new Set<string>(SUPPORTED_OCR_LANGUAGES);
  const languages = [...new Set(options.languages)];
  if (languages.some((language) => !supported.has(language))) {
    throw new CompressionError(
      "OCR_OPTIONS_INVALID",
      `OCR languages must be one or more of: ${SUPPORTED_OCR_LANGUAGES.join(", ")}.`,
      { languages }
    );
  }
  if (options.autoRotate !== undefined && typeof options.autoRotate !== "boolean") {
    throw new CompressionError("OCR_OPTIONS_INVALID", "OCR automatic rotation must be a boolean.");
  }
  return { languages, autoRotate: options.autoRotate ?? false };
}

function outputTooLarge(path: string, maxOutputBytes: number): CompressionError {
  return new CompressionError("OUTPUT_TOO_LARGE", `OCR output exceeded the ${maxOutputBytes} byte cap.`, {
    outputPath: path,
    maxOutputBytes
  });
}

export function ocrMetadata(
  result: OcrMyPdfResult,
  options: Required<OcrOptions>
): OcrMetadata {
  return {
    engine: "ocrmypdf",
    version: result.version,
    tesseractVersion: result.tesseractVersion,
    languages: [...options.languages],
    autoRotate: options.autoRotate
  };
}

/** OCR one PDF locally, validate the candidate with qpdf, then publish without clobbering. */
export async function ocrPdf(options: OcrPdfOptions): Promise<OcrSummary> {
  if (options.signal?.aborted) {
    throw new CompressionError("JOB_CANCELLED", "OCR was cancelled before it started.");
  }
  const normalized = normalizeOcrOptions(options);
  await assertFreshDestination(options.outputPath, [options.inputPath]);
  await validatePdfInput(options.inputPath);

  const calls: NativeCallOptions = {
    run: options.run ?? defaultNativeRunner,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS
  };
  const inspection = await inspectPdfSource(options.inputPath, calls);
  if (inspection.encrypted) {
    throw new CompressionError("INPUT_ENCRYPTED", "Source PDF is encrypted.", {
      inputPath: options.inputPath
    });
  }
  if (inspection.signed) {
    throw new CompressionError("INPUT_SIGNED", "Source PDF carries a digital signature.", {
      inputPath: options.inputPath
    });
  }
  if (inspection.activeContent.length > 0) {
    throw new CompressionError("INPUT_HAS_ACTIVE_CONTENT", "Source PDF contains blocked active content.", {
      inputPath: options.inputPath,
      activeContent: inspection.activeContent
    });
  }

  const workspace = await createTempWorkspace("pdf-ocr-", options.workspaceParent);
  const stagingPath = join(dirname(options.outputPath), `.pdf-ocr-staging-${randomUUID()}.pdf`);
  try {
    const candidatePath = workspace.file(`ocr-${randomUUID()}.pdf`);
    const result = await withOutputLimit(
      candidatePath,
      calls,
      options.maxOutputBytes,
      outputTooLarge,
      (limitedCalls) =>
        runOcrMyPdf(options.inputPath, candidatePath, normalized, {
          ...limitedCalls,
          workspacePath: workspace.path
        }),
      options.resourceCheck
    );
    const finalInspection = await validatePdfArtifact(candidatePath, inspection.pageCount, calls);
    try {
      await options.resourceCheck?.((await stat(candidatePath)).size);
      await copyFile(candidatePath, stagingPath);
      await options.resourceCheck?.(0);
      await publishNoClobber(stagingPath, options.outputPath);
    } finally {
      await rm(stagingPath, { force: true });
    }
    const outputStat = await stat(options.outputPath);
    return {
      status: "success",
      inputPath: options.inputPath,
      outputPath: options.outputPath,
      pageCount: inspection.pageCount,
      outputBytes: outputStat.size,
      qpdfVersion: inspection.qpdfVersion,
      ...ocrMetadata(result, normalized),
      warnings: [...inspection.warnings, ...result.warnings, ...finalInspection.warnings],
      compatWarnings: inspection.compatWarnings
    };
  } finally {
    await workspace.cleanup();
  }
}
