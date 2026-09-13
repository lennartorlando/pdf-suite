import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  Busboy,
  type BusboyFileStream,
  type BusboyHeaders,
  type BusboyInstance
} from "@fastify/busboy";
import { LIMITS } from "./jobs.js";

export type MultipartFailureCode =
  | "NOT_MULTIPART"
  | "MISSING_MANIFEST"
  | "MANIFEST_TOO_LARGE"
  | "MANIFEST_INVALID"
  | "DUPLICATE_MANIFEST"
  | "MISSING_PLAN"
  | "PLAN_TOO_LARGE"
  | "DUPLICATE_PLAN"
  | "MISSING_SOURCE"
  | "UNKNOWN_PART"
  | "DUPLICATE_PART"
  | "TOO_MANY_PARTS"
  | "TOO_MANY_SOURCES"
  | "TOO_MANY_HEADERS"
  | "SOURCE_TOO_LARGE"
  | "TOTAL_TOO_LARGE"
  | "UPLOAD_ABORTED";

export class MultipartError extends Error {
  readonly status: number;
  constructor(
    readonly code: MultipartFailureCode,
    message: string,
    status = 400
  ) {
    super(message);
    this.name = "MultipartError";
    this.status = status;
  }
}

export interface StreamedUpload {
  /** Bounded manifest field bytes (never a file-sized buffer). */
  manifestRaw: string;
  /** Server-generated private paths, one per source part, in arrival order. */
  sourcePaths: string[];
  sourceBytes: number[];
  /** Aggregate of manifest field bytes plus all source bytes. */
  totalBytes: number;
}

export interface StreamedFillUpload {
  /** Bounded plan field bytes, digested verbatim for idempotency (KTD18). */
  planRaw: string;
  /** Server-generated private path of the single source part. */
  sourcePath: string;
  sourceBytes: number;
  /** Aggregate of plan field bytes plus source bytes. */
  totalBytes: number;
}

export interface StreamedSourceUpload {
  /** Server-generated private path of the single source part. */
  sourcePath: string;
  sourceBytes: number;
  totalBytes: number;
}

/** One bounded field in a closed multipart contract. */
interface MultipartFieldSpec {
  name: string;
  maxBytes: number;
  required: boolean;
  missingCode: MultipartFailureCode;
  duplicateCode: MultipartFailureCode;
  tooLargeCode: MultipartFailureCode;
}

/** The fixed shape of one multipart intake: named fields plus `source` files. */
interface MultipartContract {
  fields: readonly MultipartFieldSpec[];
  fileField: string;
  minFiles: number;
  maxFiles: number;
  maxFileBytes: number;
  missingFileCode: MultipartFailureCode;
  maxParts: number;
  /**
   * Parts busboy admits beyond `maxParts` so a kind-specific cap can name the
   * real violation (a second fill source reports TOO_MANY_SOURCES, not the
   * generic parts code). Zero keeps the parts cap as the outer boundary.
   */
  partsProbe: number;
  maxTotalBytes: number;
}

interface ContractUpload {
  fields: Map<string, string>;
  sourcePaths: string[];
  sourceBytes: number[];
  totalBytes: number;
}

const EXPORT_CONTRACT: MultipartContract = {
  fields: [
    {
      name: "manifest",
      maxBytes: LIMITS.maxManifestBytes,
      required: true,
      missingCode: "MISSING_MANIFEST",
      duplicateCode: "DUPLICATE_MANIFEST",
      tooLargeCode: "MANIFEST_TOO_LARGE"
    }
  ],
  fileField: "source",
  minFiles: 0,
  maxFiles: LIMITS.maxSources,
  maxFileBytes: LIMITS.maxSourceBytes,
  missingFileCode: "MISSING_SOURCE",
  maxParts: LIMITS.maxParts,
  partsProbe: 0,
  maxTotalBytes: LIMITS.maxTotalBytes
};

const FILL_CONTRACT: MultipartContract = {
  fields: [
    {
      name: "plan",
      maxBytes: LIMITS.maxFillPlanBytes,
      required: true,
      missingCode: "MISSING_PLAN",
      duplicateCode: "DUPLICATE_PLAN",
      tooLargeCode: "PLAN_TOO_LARGE"
    }
  ],
  fileField: "source",
  minFiles: 1,
  maxFiles: 1,
  maxFileBytes: LIMITS.maxFillSourceBytes,
  missingFileCode: "MISSING_SOURCE",
  maxParts: LIMITS.maxFillParts,
  partsProbe: 1,
  maxTotalBytes: LIMITS.maxFillTotalBytes
};

const SOURCE_CONTRACT: MultipartContract = {
  fields: [],
  fileField: "source",
  minFiles: 1,
  maxFiles: 1,
  maxFileBytes: LIMITS.maxFillSourceBytes,
  missingFileCode: "MISSING_SOURCE",
  maxParts: 1,
  partsProbe: 1,
  maxTotalBytes: LIMITS.maxFillSourceBytes
};

/**
 * Stream one closed multipart contract into a private per-job directory.
 * Each source is written once to a server-generated name; client filenames
 * are never persisted. Fields stay bounded values, never file buffers, and
 * every byte counts toward the contract's aggregate cap.
 */
function streamContractMultipart(
  req: IncomingMessage,
  jobDir: string,
  contract: MultipartContract,
  signal?: AbortSignal
): Promise<ContractUpload> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.includes("multipart/form-data")) {
    return Promise.reject(new MultipartError("NOT_MULTIPART", "This route requires multipart form data.", 415));
  }

  return new Promise<ContractUpload>((resolve, reject) => {
    let busboy: BusboyInstance;
    let settled = false;
    const writtenPaths: string[] = [];
    const cleanup = (): Promise<void> =>
      Promise.all(writtenPaths.map((path) => rm(path, { force: true }).catch(() => undefined))).then(() => undefined);

    const fail = (error: MultipartError): void => {
      if (settled) return;
      settled = true;
      try {
        req.unpipe(busboy);
      } catch {
        // Best effort: the parser may already be torn down.
      }
      void cleanup().finally(() => reject(error));
    };

    const succeed = (upload: ContractUpload): void => {
      if (settled) return;
      settled = true;
      resolve(upload);
    };

    try {
      const headers: BusboyHeaders = { ...req.headers, "content-type": contentType };
      busboy = new Busboy({
        headers,
        limits: {
          fieldNameSize: 128,
          fieldSize: Math.max(0, ...contract.fields.map((field) => field.maxBytes)) + 1,
          fields: contract.fields.length + 1,
          files: contract.maxFiles,
          parts: contract.maxParts + contract.partsProbe,
          headerPairs: LIMITS.maxHeaderPairs
        }
      });
    } catch {
      reject(new MultipartError("NOT_MULTIPART", "This route requires multipart form data.", 415));
      return;
    }

    if (signal?.aborted) {
      fail(new MultipartError("UPLOAD_ABORTED", "Upload was cancelled.", 499));
      return;
    }

    const fieldValues = new Map<string, string>();
    const fieldCounts = new Map<string, number>();
    const sourcePaths: string[] = [];
    const sourceBytes: number[] = [];
    let totalBytes = 0;
    let partCount = 0;
    let sourceIndex = 0;
    const pendingWrites: Promise<void>[] = [];

    const onAbort = (): void => fail(new MultipartError("UPLOAD_ABORTED", "Upload was cancelled.", 499));
    signal?.addEventListener("abort", onAbort, { once: true });

    const finishSweep = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    busboy.on("field", (fieldname, value, _truncated, valueTruncated) => {
      partCount += 1;
      if (partCount > contract.maxParts) {
        fail(new MultipartError("TOO_MANY_PARTS", "Too many multipart sections.", 413));
        return;
      }
      const spec = contract.fields.find((field) => field.name === fieldname);
      if (!spec) {
        fail(new MultipartError("UNKNOWN_PART", "Unknown multipart field.", 400));
        return;
      }
      const count = (fieldCounts.get(fieldname) ?? 0) + 1;
      fieldCounts.set(fieldname, count);
      if (count > 1) {
        fail(new MultipartError(spec.duplicateCode, `Only one ${spec.name} is accepted.`, 400));
        return;
      }
      if (valueTruncated || Buffer.byteLength(value, "utf8") > spec.maxBytes) {
        fail(new MultipartError(spec.tooLargeCode, `${spec.name} exceeds its byte cap.`, 413));
        return;
      }
      // The aggregate cap covers field bytes as well as source bytes.
      totalBytes += Buffer.byteLength(value, "utf8");
      if (totalBytes > contract.maxTotalBytes) {
        fail(new MultipartError("TOTAL_TOO_LARGE", "Upload exceeds its total byte cap.", 413));
        return;
      }
      fieldValues.set(fieldname, value);
    });

    busboy.on("file", (fieldname, stream: BusboyFileStream) => {
      partCount += 1;
      if (partCount > contract.maxParts) {
        stream.resume();
        fail(new MultipartError("TOO_MANY_PARTS", "Too many multipart sections.", 413));
        return;
      }
      if (fieldname !== contract.fileField) {
        stream.resume();
        fail(new MultipartError("UNKNOWN_PART", "Unknown multipart file part.", 400));
        return;
      }
      if (sourceIndex >= contract.maxFiles) {
        stream.resume();
        fail(new MultipartError("TOO_MANY_SOURCES", "Too many source files.", 413));
        return;
      }
      const slot = sourceIndex;
      sourceIndex += 1;
      const target = join(jobDir, `source-${slot}.pdf`);
      writtenPaths.push(target);
      sourcePaths.push(target);
      sourceBytes.push(0);
      const out = createWriteStream(target, { mode: 0o600 });
      let fileBytes = 0;
      let fileFailed = false;
      const writeDone = new Promise<void>((resolveWrite, rejectWrite) => {
        stream.on("data", (chunk: Buffer) => {
          const size = chunk.length;
          fileBytes += size;
          totalBytes += size;
          if (fileBytes > contract.maxFileBytes) {
            fileFailed = true;
            fail(new MultipartError("SOURCE_TOO_LARGE", "A source exceeds its byte cap.", 413));
            stream.destroy();
            out.destroy();
            rejectWrite(new Error("source too large"));
            return;
          }
          if (totalBytes > contract.maxTotalBytes) {
            fileFailed = true;
            fail(new MultipartError("TOTAL_TOO_LARGE", "Upload exceeds its total byte cap.", 413));
            stream.destroy();
            out.destroy();
            rejectWrite(new Error("total too large"));
            return;
          }
          sourceBytes[slot] = fileBytes;
          if (!out.write(chunk)) {
            stream.pause();
            out.once("drain", () => stream.resume());
          }
        });
        stream.on("limit", () => {
          fileFailed = true;
          fail(new MultipartError("SOURCE_TOO_LARGE", "A source exceeds its byte cap.", 413));
          out.destroy();
          rejectWrite(new Error("source too large"));
        });
        stream.on("end", () => {
          if (fileFailed) return;
          if (stream.truncated) {
            fileFailed = true;
            fail(new MultipartError("SOURCE_TOO_LARGE", "A source exceeds its byte cap.", 413));
            out.destroy();
            rejectWrite(new Error("source too large"));
            return;
          }
          out.end(() => resolveWrite());
        });
        stream.on("error", () => {
          fileFailed = true;
          out.destroy();
          fail(new MultipartError("UPLOAD_ABORTED", "A source stream failed.", 499));
          rejectWrite(new Error("source stream failed"));
        });
        out.on("error", () => {
          fileFailed = true;
          stream.destroy();
          fail(new MultipartError("UPLOAD_ABORTED", "A source could not be stored.", 499));
          rejectWrite(new Error("source write failed"));
        });
      });
      pendingWrites.push(writeDone);
      // Observe teardown rejections even when the parser never reaches
      // `finish` after an unpipe, so a capped upload cannot surface an
      // unhandled rejection. The `finish` handler still settles the outcome.
      writeDone.catch(() => undefined);
    });

    busboy.on("partsLimit", () => {
      fail(new MultipartError("TOO_MANY_PARTS", "Too many multipart sections.", 413));
    });

    busboy.on("filesLimit", () => {
      fail(new MultipartError("TOO_MANY_SOURCES", "Too many source files.", 413));
    });

    busboy.on("fieldsLimit", () => {
      fail(new MultipartError(contract.fields[0]?.duplicateCode ?? "UNKNOWN_PART", "Too many multipart fields.", 400));
    });

    busboy.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (/header/i.test(message)) {
        fail(new MultipartError("TOO_MANY_HEADERS", "Too many multipart headers.", 413));
        return;
      }
      fail(new MultipartError("UPLOAD_ABORTED", "Upload could not be parsed.", 400));
    });

    busboy.on("finish", () => {
      if (settled) return;
      for (const spec of contract.fields) {
        if (spec.required && !fieldValues.has(spec.name)) {
          fail(new MultipartError(spec.missingCode, `This route requires exactly one ${spec.name}.`, 400));
          return;
        }
      }
      if (sourcePaths.length < contract.minFiles) {
        fail(new MultipartError(contract.missingFileCode, "This route requires exactly one source.", 400));
        return;
      }
      void Promise.allSettled(pendingWrites).then((outcomes) => {
        finishSweep();
        if (settled) return;
        if (outcomes.some((outcome) => outcome.status === "rejected")) {
          fail(new MultipartError("UPLOAD_ABORTED", "A source could not be stored.", 499));
          return;
        }
        succeed({ fields: fieldValues, sourcePaths, sourceBytes, totalBytes });
      });
    });

    req.on("aborted", () => fail(new MultipartError("UPLOAD_ABORTED", "Client disconnected during upload.", 499)));
    req.on("error", () => fail(new MultipartError("UPLOAD_ABORTED", "Upload transport failed.", 499)));
    req.pipe(busboy);
  });
}

/**
 * Stream exactly one bounded manifest field plus generated source parts
 * into a private per-job directory. Each source is written once to a
 * server-generated name; client filenames are never persisted. No
 * file-sized JavaScript buffer is retained.
 */
export async function streamExportMultipart(
  req: IncomingMessage,
  jobDir: string,
  signal?: AbortSignal
): Promise<StreamedUpload> {
  const upload = await streamContractMultipart(req, jobDir, EXPORT_CONTRACT, signal);
  return {
    manifestRaw: upload.fields.get("manifest") ?? "",
    sourcePaths: upload.sourcePaths,
    sourceBytes: upload.sourceBytes,
    totalBytes: upload.totalBytes
  };
}

/**
 * Stream the fill contract: exactly one bounded `plan` field plus exactly
 * one `source` file part (KTD12 — the browser sends values, not bytes).
 */
export async function streamFillMultipart(
  req: IncomingMessage,
  jobDir: string,
  signal?: AbortSignal
): Promise<StreamedFillUpload> {
  const upload = await streamContractMultipart(req, jobDir, FILL_CONTRACT, signal);
  return {
    planRaw: upload.fields.get("plan") ?? "",
    sourcePath: upload.sourcePaths[0],
    sourceBytes: upload.sourceBytes[0],
    totalBytes: upload.totalBytes
  };
}

/** Stream the inventory contract: exactly one `source` file part, no fields. */
export async function streamSourceUpload(
  req: IncomingMessage,
  jobDir: string,
  signal?: AbortSignal
): Promise<StreamedSourceUpload> {
  const upload = await streamContractMultipart(req, jobDir, SOURCE_CONTRACT, signal);
  return {
    sourcePath: upload.sourcePaths[0],
    sourceBytes: upload.sourceBytes[0],
    totalBytes: upload.totalBytes
  };
}

/**
 * Bounded JSON depth check for the closed-schema manifest (primitives are
 * depth 0; each array/object level adds one).
 */
export function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let deepest = 0;
    for (const entry of value) deepest = Math.max(deepest, jsonDepth(entry));
    return deepest + 1;
  }
  if (typeof value === "object" && value !== null) {
    let deepest = 0;
    for (const key of Object.keys(value)) {
      deepest = Math.max(deepest, jsonDepth((value as Record<string, unknown>)[key]));
    }
    return deepest + 1;
  }
  return 0;
}

export function assertManifestDepth(value: unknown): void {
  if (jsonDepth(value) > LIMITS.maxJsonDepth) {
    throw new MultipartError("MANIFEST_INVALID", "Manifest exceeds its JSON depth cap.", 400);
  }
}
