import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { CompressionError } from "./errors.js";

export interface PdfValidationResult {
  inputPath: string;
  sizeBytes: number;
}

export interface PdfValidationHashResult extends PdfValidationResult {
  sha256: string;
}

interface PdfInputScan {
  inputPath: string;
  sizeBytes: number;
  encrypted: boolean;
  sha256?: string;
}

async function scanPdfInput(
  inputPath: string,
  outputPath: string | undefined,
  includeHash: boolean
): Promise<PdfInputScan> {
  if (outputPath && inputPath === outputPath) {
    throw new CompressionError(
      "OUTPUT_WOULD_OVERWRITE_INPUT",
      "Output path must be different from the source PDF."
    );
  }

  let fileStat;
  try {
    fileStat = await stat(inputPath);
  } catch {
    throw new CompressionError("INPUT_NOT_FOUND", "Source PDF was not found.", { inputPath });
  }

  if (!fileStat.isFile()) {
    throw new CompressionError("INPUT_NOT_FOUND", "Source PDF path is not a file.", { inputPath });
  }

  const hash = includeHash ? createHash("sha256") : null;
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;
  let scanTail = "";
  let encrypted = false;
  for await (const rawChunk of createReadStream(inputPath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    hash?.update(chunk);
    if (headerBytes < 1024) {
      const slice = chunk.subarray(0, 1024 - headerBytes);
      headerChunks.push(slice);
      headerBytes += slice.length;
    }

    const text = scanTail + chunk.toString("latin1");
    const pattern = /\/Encrypt\b/g;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match.index + match[0].length < text.length) {
        encrypted = true;
        break;
      }
    }
    scanTail = text.slice(-8);
  }

  const header = Buffer.concat(headerChunks, headerBytes).toString("latin1");
  if (!header.includes("%PDF-")) {
    throw new CompressionError("INPUT_NOT_PDF", "Source file is not a supported PDF.");
  }

  return {
    inputPath,
    sizeBytes: fileStat.size,
    encrypted: encrypted || /\/Encrypt\b/.test(scanTail),
    ...(hash ? { sha256: hash.digest("hex") } : {})
  };
}

async function validatePdfInputStream(
  inputPath: string,
  outputPath: string | undefined,
  includeHash: false
): Promise<PdfValidationResult>;
async function validatePdfInputStream(
  inputPath: string,
  outputPath: string | undefined,
  includeHash: true
): Promise<PdfValidationHashResult>;
async function validatePdfInputStream(
  inputPath: string,
  outputPath: string | undefined,
  includeHash: boolean
): Promise<PdfValidationResult | PdfValidationHashResult> {
  const scan = await scanPdfInput(inputPath, outputPath, includeHash);
  if (scan.encrypted) {
    throw new CompressionError("INPUT_ENCRYPTED", "Encrypted PDFs are not supported yet.");
  }
  const { encrypted: _encrypted, ...result } = scan;
  return result;
}

export async function validatePdfInput(inputPath: string, outputPath?: string): Promise<PdfValidationResult> {
  return validatePdfInputStream(inputPath, outputPath, false);
}

/** Validate and hash a source in one streaming pass without retaining file-sized buffers. */
export async function validateAndHashPdfInput(
  inputPath: string,
  outputPath?: string
): Promise<PdfValidationHashResult> {
  return validatePdfInputStream(inputPath, outputPath, true);
}

export interface PdfFillValidationResult extends PdfValidationResult {
  /** True when the source carries an /Encrypt dictionary; see validatePdfFillInput. */
  encrypted: boolean;
}

/**
 * The fill path's input scan (KTD10): a separate function, not a parameter
 * on the shared validator, so a decrypt-allowing option is never one default
 * away from compression, assembly or OCR. It reports encryption instead of
 * rejecting it: the caller runs an empty-password qpdf decryption pass next,
 * and a document needing a real password is refused there. This scan must
 * always run first: it is the only check before qpdf's decryption code
 * touches attacker-controlled bytes in a process that is not sandboxed.
 */
export async function validatePdfFillInput(
  inputPath: string,
  outputPath?: string
): Promise<PdfFillValidationResult> {
  const { inputPath: scannedPath, sizeBytes, encrypted } = await scanPdfInput(inputPath, outputPath, false);
  return { inputPath: scannedPath, sizeBytes, encrypted };
}

interface FileIdentity {
  dev: number;
  ino: number;
  realPath: string;
}

async function identityOf(path: string): Promise<FileIdentity | null> {
  try {
    const [fileStat, canonical] = await Promise.all([stat(path), realpath(path)]);
    if (typeof fileStat.dev !== "number" || typeof fileStat.ino !== "number") return null;
    return { dev: fileStat.dev, ino: fileStat.ino, realPath: canonical };
  } catch {
    return null;
  }
}

/**
 * Reject an existing destination and any destination that aliases a source
 * through a symlink or hard link, before any mutation starts. Canonical
 * file identity (device + inode + real path) is compared, not path strings.
 */
export async function assertFreshDestination(
  destinationPath: string,
  sourcePaths: readonly string[]
): Promise<void> {
  for (const sourcePath of sourcePaths) {
    if (destinationPath === sourcePath) {
      throw new CompressionError(
        "OUTPUT_WOULD_OVERWRITE_INPUT",
        "Output path must be different from every source PDF."
      );
    }
  }

  let destinationStat;
  try {
    destinationStat = await lstat(destinationPath);
  } catch {
    return;
  }
  if (!destinationStat) return;

  const [destinationIdentity, sourceIdentities] = await Promise.all([
    identityOf(destinationPath),
    Promise.all(sourcePaths.map((sourcePath) => identityOf(sourcePath)))
  ]);
  if (destinationIdentity) {
    for (const sourceIdentity of sourceIdentities) {
      if (!sourceIdentity) continue;
      if (
        destinationIdentity.realPath === sourceIdentity.realPath ||
        (destinationIdentity.dev === sourceIdentity.dev && destinationIdentity.ino === sourceIdentity.ino)
      ) {
        throw new CompressionError(
          "OUTPUT_WOULD_OVERWRITE_INPUT",
          "Output path aliases a source PDF and would overwrite it."
        );
      }
    }
  }
  throw new CompressionError("OUTPUT_EXISTS", "Output path already exists.", { outputPath: destinationPath });
}
