/**
 * Browser-safe OCR wire contract (no Node imports).
 *
 * The option and metadata shapes shared by the core OCR operation, the
 * loopback export route and the web client. `ocr.ts` owns the Node-coupled
 * operation and re-exports these so the core root surface is unchanged;
 * browser code imports this subpath (`@pdf-compressor/core/ocr-contract`)
 * directly so no type-only root import is ever needed.
 */
export const SUPPORTED_OCR_LANGUAGES = ["deu", "eng"] as const;
export type OcrLanguage = (typeof SUPPORTED_OCR_LANGUAGES)[number];

export interface OcrOptions {
  languages: readonly OcrLanguage[];
  autoRotate?: boolean;
}

export interface OcrMetadata {
  engine: "ocrmypdf";
  version: string;
  tesseractVersion: string;
  languages: OcrLanguage[];
  autoRotate: boolean;
}
