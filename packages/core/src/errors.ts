export type CompressionErrorCode =
  | "INPUT_NOT_FOUND"
  | "INPUT_NOT_PDF"
  | "INPUT_ENCRYPTED"
  | "INPUT_SIGNED"
  | "INPUT_XFA"
  | "INPUT_HAS_ACTIVE_CONTENT"
  | "INSPECTION_INCOMPLETE"
  | "OUTPUT_INVALID"
  | "OUTPUT_TOO_LARGE"
  | "TEMP_QUOTA_EXCEEDED"
  | "DISK_RESERVE_EXHAUSTED"
  | "OUTPUT_PAGE_LIMIT_EXCEEDED"
  | "OUTPUT_WOULD_OVERWRITE_INPUT"
  | "OUTPUT_EXISTS"
  | "MANIFEST_INVALID"
  | "MANIFEST_DUPLICATE_SOURCE"
  | "MANIFEST_UNKNOWN_SOURCE"
  | "MANIFEST_INVALID_PAGE"
  | "MANIFEST_PAGE_OUT_OF_RANGE"
  | "MANIFEST_INVALID_ROTATION"
  | "MANIFEST_EMPTY"
  | "OCR_OPTIONS_INVALID"
  | "OCR_LANGUAGE_UNAVAILABLE"
  | "NATIVE_VERSION_UNSUPPORTED"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_FAILED"
  | "PUBLISH_FAILED"
  | "FILL_CHILD_OUT_OF_MEMORY"
  | "JOB_CANCELLED"
  | "JOB_TIMEOUT";

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
