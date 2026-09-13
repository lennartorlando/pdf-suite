export { compressPdf, type CompressionOptions, type CompressionSummary } from "./compress.js";
export { CompressionError, isCompressionError, COMPRESSION_ERROR_CODES, type CompressionErrorCode } from "./errors.js";
export {
  ocrPdf,
  normalizeOcrOptions,
  SUPPORTED_OCR_LANGUAGES,
  DEFAULT_OCR_TIMEOUT_MS,
  type OcrLanguage,
  type OcrOptions,
  type OcrPdfOptions,
  type OcrSummary,
  type OcrMetadata
} from "./ocr.js";
export { compressionProfiles, getCompressionProfile, type CompressionProfileName, type CompressionProfile } from "./profiles.js";
export { createTempWorkspace, type TempWorkspace } from "./temp-workspace.js";
export {
  validatePdfInput,
  validatePdfFillInput,
  assertFreshDestination,
  type PdfValidationResult,
  type PdfFillValidationResult
} from "./validation.js";
export type { CompressionEngine, EngineResult } from "./engines/types.js";
export {
  assemblePages,
  inspectSources,
  normalizeBindings,
  MAX_OUTPUT_PAGES,
  DEFAULT_EXPORT_TIMEOUT_MS,
  type PageSourceBinding,
  type AssemblePagesOptions,
  type AssemblySummary,
  type InspectSourcesOptions
} from "./pages.js";
export {
  QPDF_FEATURE_FLOOR,
  QPDF_SECURITY_FLOOR,
  GHOSTSCRIPT_SECURITY_FLOOR,
  OCRMY_PDF_FEATURE_FLOOR,
} from "./native-floors.js";
export {
  ocrMyPdfArgs,
  getOcrMyPdfVersion,
  getTesseractVersion,
  getTesseractLanguages,
  inspectOcrCapabilities
} from "./engines/ocrmypdf.js";
export {
  NATIVE_PARSER_RISK_NOTE,
  parseVersionTuple,
  compareVersionTuples,
  assertNativeFloor,
  getQpdfVersion,
  getGhostscriptVersion,
  defaultNativeRunner,
  classifyQpdfJson,
  isAdmissibleFor,
  CLASSIFIER_NODE_BUDGET,
  inspectPdfSource,
  admitFillSource,
  runQpdfAssemblyMutation,
  validatePdfArtifact,
  publishNoClobber,
  type ActiveContentFinding,
  type ActiveContentScope,
  type AdmissionOperation,
  type CompatWarningKind,
  type PdfInspection,
  type NativeRunner,
  type PageGroup,
  type AssemblyMutation,
  type NativeCallOptions,
  type FillAdmission
} from "./engines/qpdf-pages.js";
export { ghostscriptArgs } from "./engines/ghostscript.js";
export {
  fillForm,
  inventoryFormFields,
  checkFormPlan,
  verifyFormFill,
  FILL_MAX_SOURCE_BYTES,
  FILL_MAX_OUTPUT_BYTES,
  FILL_MAX_PLAN_BYTES,
  type FillFormOptions,
  type FillSummary,
  type InspectFormOptions,
  type FormInventoryResult,
  type FormPlanCheck,
  type FormPlanOutstandingEntry,
  type FormVerification,
  type FormFieldVerification,
  type FormPlacementVerification
} from "./forms.js";
