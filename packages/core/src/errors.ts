/**
 * Every error code the shared core can raise. The CLI exit-code table and the
 * route status mapper are written against this list exhaustively, so a code
 * added here without a mapping fails typecheck and the coverage test (KTD17).
 */
export const COMPRESSION_ERROR_CODES = [
  "INPUT_NOT_FOUND",
  "INPUT_NOT_PDF",
  "INPUT_ENCRYPTED",
  "INPUT_SIGNED",
  "INPUT_XFA",
  "INPUT_HAS_ACTIVE_CONTENT",
  "INSPECTION_INCOMPLETE",
  "OUTPUT_INVALID",
  "OUTPUT_TOO_LARGE",
  "TEMP_QUOTA_EXCEEDED",
  "DISK_RESERVE_EXHAUSTED",
  "OUTPUT_PAGE_LIMIT_EXCEEDED",
  "OUTPUT_WOULD_OVERWRITE_INPUT",
  "OUTPUT_EXISTS",
  "MANIFEST_INVALID",
  "MANIFEST_DUPLICATE_SOURCE",
  "MANIFEST_UNKNOWN_SOURCE",
  "MANIFEST_INVALID_PAGE",
  "MANIFEST_PAGE_OUT_OF_RANGE",
  "MANIFEST_INVALID_ROTATION",
  "MANIFEST_EMPTY",
  "OCR_OPTIONS_INVALID",
  "OCR_LANGUAGE_UNAVAILABLE",
  "NATIVE_VERSION_UNSUPPORTED",
  "ENGINE_UNAVAILABLE",
  "ENGINE_FAILED",
  "PUBLISH_FAILED",
  "FILL_CHILD_OUT_OF_MEMORY",
  "FILL_INPUT_TOO_LARGE",
  "FILL_PLAN_INCOMPLETE",
  "FILL_PLAN_SOURCE_MISMATCH",
  "FILL_UNKNOWN_FIELD",
  "FILL_NOT_FILLABLE",
  "FILL_VALUE_INVALID",
  "FILL_APPEARANCE_MISSING",
  "FILL_READBACK_FAILED",
  "FILL_SIGNATURE_FORBIDDEN",
  "FILL_RECEIPT_REQUIRED",
  "FILL_RECEIPT_INVALID",
  "FILL_PLAN_CHANGED",
  "FILL_SOURCE_CHANGED",
  "FILL_RECEIPT_EXPIRED",
  "FILL_RECEIPT_CONSUMED",
  "FILL_VERIFY_MISMATCH",
  "JOB_CANCELLED",
  "JOB_TIMEOUT"
] as const;

export type CompressionErrorCode = (typeof COMPRESSION_ERROR_CODES)[number];

export class CompressionError extends Error {
  constructor(
    public readonly code: CompressionErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CompressionError";
  }
}

export function isCompressionError(error: unknown): error is CompressionError {
  return error instanceof CompressionError;
}
