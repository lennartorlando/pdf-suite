import { isCompressionError, type CompressionErrorCode } from "@pdf-compressor/core";
import { SchemaError } from "@pdf-compressor/core/schema-error";

export const exitCodes = {
  success: 0,
  validationFailure: 2,
  compressionFailure: 3,
  cancelled: 4,
  usage: 64
} as const;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * One explicit exit class per core error code (KTD17). The Record type makes
 * the table exhaustive at compile time: adding a code to the union without a
 * row here fails typecheck, and the coverage test asserts the same at runtime.
 */
export const exitCodeByErrorCode: Readonly<Record<CompressionErrorCode, number>> = {
  INPUT_NOT_FOUND: exitCodes.validationFailure,
  INPUT_NOT_PDF: exitCodes.validationFailure,
  INPUT_ENCRYPTED: exitCodes.validationFailure,
  INPUT_SIGNED: exitCodes.validationFailure,
  INPUT_XFA: exitCodes.validationFailure,
  INPUT_HAS_ACTIVE_CONTENT: exitCodes.validationFailure,
  INSPECTION_INCOMPLETE: exitCodes.compressionFailure,
  OUTPUT_INVALID: exitCodes.validationFailure,
  OUTPUT_TOO_LARGE: exitCodes.validationFailure,
  TEMP_QUOTA_EXCEEDED: exitCodes.compressionFailure,
  DISK_RESERVE_EXHAUSTED: exitCodes.compressionFailure,
  OUTPUT_PAGE_LIMIT_EXCEEDED: exitCodes.validationFailure,
  OUTPUT_WOULD_OVERWRITE_INPUT: exitCodes.validationFailure,
  OUTPUT_EXISTS: exitCodes.validationFailure,
  MANIFEST_INVALID: exitCodes.validationFailure,
  MANIFEST_DUPLICATE_SOURCE: exitCodes.validationFailure,
  MANIFEST_UNKNOWN_SOURCE: exitCodes.validationFailure,
  MANIFEST_INVALID_PAGE: exitCodes.validationFailure,
  MANIFEST_PAGE_OUT_OF_RANGE: exitCodes.validationFailure,
  MANIFEST_INVALID_ROTATION: exitCodes.validationFailure,
  MANIFEST_EMPTY: exitCodes.validationFailure,
  OCR_OPTIONS_INVALID: exitCodes.validationFailure,
  OCR_LANGUAGE_UNAVAILABLE: exitCodes.validationFailure,
  NATIVE_VERSION_UNSUPPORTED: exitCodes.compressionFailure,
  ENGINE_UNAVAILABLE: exitCodes.compressionFailure,
  ENGINE_FAILED: exitCodes.compressionFailure,
  PUBLISH_FAILED: exitCodes.compressionFailure,
  FILL_CHILD_OUT_OF_MEMORY: exitCodes.compressionFailure,
  FILL_INPUT_TOO_LARGE: exitCodes.validationFailure,
  FILL_PLAN_INCOMPLETE: exitCodes.validationFailure,
  FILL_PLAN_SOURCE_MISMATCH: exitCodes.validationFailure,
  FILL_UNKNOWN_FIELD: exitCodes.validationFailure,
  FILL_NOT_FILLABLE: exitCodes.validationFailure,
  FILL_VALUE_INVALID: exitCodes.validationFailure,
  FILL_APPEARANCE_MISSING: exitCodes.compressionFailure,
  FILL_READBACK_FAILED: exitCodes.compressionFailure,
  FILL_SIGNATURE_FORBIDDEN: exitCodes.validationFailure,
  FILL_RECEIPT_REQUIRED: exitCodes.validationFailure,
  FILL_RECEIPT_INVALID: exitCodes.validationFailure,
  FILL_PLAN_CHANGED: exitCodes.validationFailure,
  FILL_SOURCE_CHANGED: exitCodes.validationFailure,
  FILL_RECEIPT_EXPIRED: exitCodes.validationFailure,
  FILL_RECEIPT_CONSUMED: exitCodes.validationFailure,
  FILL_VERIFY_MISMATCH: exitCodes.validationFailure,
  JOB_CANCELLED: exitCodes.cancelled,
  JOB_TIMEOUT: exitCodes.cancelled
};

export function formatJsonSuccess(summary: object): string {
  return `${JSON.stringify({
    ok: true,
    ...summary
  })}\n`;
}

function schemaErrorJson(error: SchemaError): string {
  return `${JSON.stringify({
    ok: false,
    code: error.code,
    message: error.message
  })}\n`;
}

export function formatJsonError(error: unknown): string {
  if (isCompressionError(error)) {
    return `${JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message
    })}\n`;
  }
  // One shared base for every browser-safe schema (KTD17): plan, inventory
  // and manifest parse failures all surface their own code.
  if (error instanceof SchemaError) return schemaErrorJson(error);
  return `${JSON.stringify({
    ok: false,
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : "Unknown error"
  })}\n`;
}

export function formatJsonUsageError(error: unknown): string {
  return `${JSON.stringify({
    ok: false,
    code: "USAGE",
    message: error instanceof Error ? error.message : "Invalid arguments"
  })}\n`;
}

export function usageErrorResult(error: unknown): CliResult {
  return {
    exitCode: exitCodes.usage,
    stdout: formatJsonUsageError(error),
    stderr: ""
  };
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof SchemaError) return exitCodes.validationFailure;
  if (!isCompressionError(error)) return exitCodes.compressionFailure;
  return exitCodeByErrorCode[error.code];
}
