/**
 * Parent side of the bounded PDF.js fill child (KTD2, R28).
 *
 * `runFillChild` expresses the renderer through the existing native-runner
 * seam, so the minimal environment, closed stdin, private working directory,
 * timeout and process-group termination all come from `runProcess`. No
 * document bytes cross a pipe: the child receives paths and budgets as
 * arguments and reports through a bounded structured outcome file.
 *
 * Two containment details are deliberate:
 * - The child entry resolves relative to this module (`import.meta.url`), so
 *   it works identically from the source layout (`.ts` beside this file,
 *   executed under Node type stripping) and the built layout (`.js` in
 *   `dist/engines/`). `process.cwd()` is never consulted.
 * - The heap cap travels as a `--max-old-space-size` argument, not an
 *   environment variable: `minimalProcessEnv` drops `NODE_OPTIONS`, so the
 *   variable form would silently not apply. A child killed by the cap prints
 *   V8's heap-limit signature to stderr and surfaces here as
 *   FILL_CHILD_OUT_OF_MEMORY rather than a generic ENGINE_FAILED.
 */
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CompressionError, isCompressionError } from "../errors.js";
import { defaultNativeRunner, type NativeCallOptions } from "./qpdf-pages.js";

/** Fill child heap cap, per the plan's initial safety limits. */
export const FILL_CHILD_HEAP_SIZE_MB = 512;
/** Fill child wall-clock budget, per the plan's initial safety limits. */
export const FILL_CHILD_TIMEOUT_MS = 60_000;

const FILL_CHILD_MAX_STDOUT_BYTES = 64 * 1024;
const FILL_CHILD_MAX_OUTCOME_BYTES = 16 * 1024;

const HEAP_LIMIT_PATTERN = /heap limit|heap out of memory/i;

export interface FillChildRequest {
  /** Absolute path of the admitted source PDF; never written by the child. */
  sourcePath: string;
  /** Absolute path of the plan file the child applies. */
  planPath: string;
  /** The only path the child may write PDF bytes to. */
  candidatePath: string;
  /** Path of the bounded structured outcome file. */
  outcomePath: string;
  /** Private job directory: the child's working directory and scratch space. */
  workspacePath: string;
  /** Refusal budget applied to the produced bytes before any write. */
  maxOutputBytes: number;
}

export interface FillChildOutcome {
  status: "filled";
  bytes: number;
}

/**
 * Absolute path of the child entry beside this module. In the source layout
 * the sibling is the `.ts` file (Node runs it with type stripping); in the
 * built layout it is the compiled `.js`. Exported for the layout tests.
 */
export function fillChildEntryPath(moduleUrl: string = import.meta.url): string {
  const extension = fileURLToPath(moduleUrl).endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./pdfjs-fill-child${extension}`, moduleUrl));
}

function isHeapLimitFailure(error: CompressionError): boolean {
  const stderr = error.details?.["stderr"];
  return typeof stderr === "string" && HEAP_LIMIT_PATTERN.test(stderr);
}

async function readOutcome(request: FillChildRequest): Promise<FillChildOutcome> {
  let raw: string;
  try {
    const info = await stat(request.outcomePath);
    if (info.size > FILL_CHILD_MAX_OUTCOME_BYTES) {
      throw new CompressionError("ENGINE_FAILED", "The fill child wrote an oversized outcome file.", {
        outcomePath: request.outcomePath,
        outcomeBytes: info.size
      });
    }
    raw = await readFile(request.outcomePath, "utf8");
  } catch (error) {
    if (isCompressionError(error)) throw error;
    throw new CompressionError("ENGINE_FAILED", "The fill child exited without writing an outcome file.", {
      outcomePath: request.outcomePath
    });
  }
  let outcome: unknown;
  try {
    outcome = JSON.parse(raw);
  } catch {
    throw new CompressionError("ENGINE_FAILED", "The fill child wrote a malformed outcome file.", {
      outcomePath: request.outcomePath
    });
  }
  const record = outcome as { status?: unknown; bytes?: unknown; code?: unknown; message?: unknown };
  if (record.status === "filled" && typeof record.bytes === "number") {
    try {
      await stat(request.candidatePath);
    } catch {
      throw new CompressionError("ENGINE_FAILED", "The fill child reported success but wrote no candidate.", {
        candidatePath: request.candidatePath
      });
    }
    return { status: "filled", bytes: record.bytes };
  }
  if (record.status === "refused" && record.code === "OUTPUT_TOO_LARGE") {
    throw new CompressionError(
      "OUTPUT_TOO_LARGE",
      `The fill child refused to write: the produced document exceeds the ${request.maxOutputBytes} byte budget.`,
      { candidatePath: request.candidatePath, maxOutputBytes: request.maxOutputBytes }
    );
  }
  const message =
    typeof record.message === "string" ? record.message : `outcome status ${String(record.status)}`;
  throw new CompressionError("ENGINE_FAILED", `The fill child failed: ${message}`, {
    outcomePath: request.outcomePath
  });
}

/**
 * Run the fill child against paths in a private workspace. Resolves with the
 * produced byte count, or rejects with OUTPUT_TOO_LARGE / JOB_CANCELLED /
 * JOB_TIMEOUT / FILL_CHILD_OUT_OF_MEMORY / ENGINE_FAILED.
 */
export async function runFillChild(
  request: FillChildRequest,
  options: NativeCallOptions & { heapSizeMb?: number } = {}
): Promise<FillChildOutcome> {
  const run = options.run ?? defaultNativeRunner;
  const heapSizeMb = options.heapSizeMb ?? FILL_CHILD_HEAP_SIZE_MB;
  const args = [
    `--max-old-space-size=${heapSizeMb}`,
    fillChildEntryPath(),
    `--source=${request.sourcePath}`,
    `--plan=${request.planPath}`,
    `--candidate=${request.candidatePath}`,
    `--outcome=${request.outcomePath}`,
    `--max-bytes=${request.maxOutputBytes}`
  ];
  try {
    await run(process.execPath, args, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? FILL_CHILD_TIMEOUT_MS,
      cwd: request.workspacePath,
      tempDir: request.workspacePath,
      maxStdoutBytes: FILL_CHILD_MAX_STDOUT_BYTES
    });
  } catch (error) {
    if (isCompressionError(error) && error.code === "ENGINE_FAILED" && isHeapLimitFailure(error)) {
      throw new CompressionError(
        "FILL_CHILD_OUT_OF_MEMORY",
        `The fill child exceeded its ${heapSizeMb} MiB heap cap.`,
        { heapSizeMb }
      );
    }
    throw error;
  }
  return readOutcome(request);
}
