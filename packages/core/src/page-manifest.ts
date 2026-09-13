/**
 * Browser-safe, transport-neutral page-manifest contract.
 *
 * This module is intentionally dependency-free: no Node.js imports, no
 * filesystem access, no child processes. It is published as the
 * `@pdf-compressor/core/page-manifest` subpath so browser code never needs
 * to import the Node-coupled core root. Server-side inspection remains
 * authoritative for page counts; these helpers only shape immutable browser
 * state and derive export snapshots.
 */

import { SchemaError } from "./schema-error.js";

export const PAGE_MANIFEST_VERSION = 1 as const;

/** Clockwise relative rotation in degrees. 0 means "keep source rotation". */
export type PageRotation = 0 | 90 | 180 | 270;

export const PAGE_ROTATIONS: readonly PageRotation[] = [0, 90, 180, 270];

/** Maximum source-id length in characters (matches the server part cap). */
export const MAX_SOURCE_ID_LENGTH = 64;

/**
 * Opaque invocation-local source reference. Browser `File` objects,
 * server temp paths, and CLI paths stay in adapter-owned bindings and never
 * enter the manifest. Selection, focus, and viewport state are browser-only.
 */
export interface ManifestPage {
  readonly sourceId: string;
  /** One-based page number within the referenced source. */
  readonly page: number;
  /** Relative clockwise rotation. Defaults to 0 when omitted. */
  readonly rotate?: PageRotation;
}

export interface PageManifest {
  readonly version: typeof PAGE_MANIFEST_VERSION;
  readonly pages: readonly ManifestPage[];
}

export const PAGE_MANIFEST_ERROR_CODES = [
  "MANIFEST_INVALID",
  "MANIFEST_INVALID_SOURCE_ID",
  "MANIFEST_INVALID_PAGE_NUMBER",
  "MANIFEST_INVALID_ROTATION",
  "MANIFEST_INVALID_INDEX"
] as const;

export type PageManifestErrorCode = (typeof PAGE_MANIFEST_ERROR_CODES)[number];

export class PageManifestError extends SchemaError<PageManifestErrorCode> {
  constructor(code: PageManifestErrorCode, message: string) {
    super(code, message);
    this.name = "PageManifestError";
  }
}

/** Printable ASCII without whitespace or "=", 1..64 chars (opaque local handle). */
const SOURCE_ID_PATTERN = /^[\x21-\x3C\x3E-\x7E]+$/;
const PAGE_ENTRY_KEY_LIST = ["sourceId", "page", "rotate"] as const satisfies readonly (keyof ManifestPage)[];
const PAGE_ENTRY_KEYS: ReadonlySet<string> = new Set(PAGE_ENTRY_KEY_LIST);

export function isValidSourceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SOURCE_ID_LENGTH &&
    SOURCE_ID_PATTERN.test(value)
  );
}

function assertSourceId(sourceId: string): void {
  if (!isValidSourceId(sourceId)) {
    throw new PageManifestError(
      "MANIFEST_INVALID_SOURCE_ID",
      `Invalid sourceId: must be 1-${MAX_SOURCE_ID_LENGTH} printable ASCII characters without whitespace or "=".`
    );
  }
}

function assertPageNumber(page: number): void {
  if (!Number.isInteger(page) || page < 1) {
    throw new PageManifestError(
      "MANIFEST_INVALID_PAGE_NUMBER",
      `Invalid page number ${String(page)}: must be an integer >= 1.`
    );
  }
}

function assertRotation(rotate: PageRotation): void {
  if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
    throw new PageManifestError(
      "MANIFEST_INVALID_ROTATION",
      `Invalid rotation ${String(rotate)}: must be one of 0, 90, 180, 270.`
    );
  }
}

function freezePage(entry: ManifestPage): ManifestPage {
  return Object.freeze({
    sourceId: entry.sourceId,
    page: entry.page,
    rotate: entry.rotate ?? 0
  });
}

/**
 * Parse an unknown transport value into a validated immutable manifest.
 * Closed schema: unknown fields are rejected, depth is bounded by construction.
 */
export function parsePageManifest(value: unknown): PageManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PageManifestError("MANIFEST_INVALID", "Manifest must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || record["version"] !== PAGE_MANIFEST_VERSION || !Array.isArray(record["pages"])) {
    throw new PageManifestError(
      "MANIFEST_INVALID",
      "Manifest must be exactly { version: 1, pages: [...] }."
    );
  }
  const pages = record["pages"] as unknown[];
  const frozen = pages.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new PageManifestError("MANIFEST_INVALID", "Each manifest page must be an object.");
    }
    const candidate = entry as Record<string, unknown>;
    const entryKeys = Object.keys(candidate);
    if (
      entryKeys.length < 2 ||
      entryKeys.length > 3 ||
      entryKeys.some((key) => !PAGE_ENTRY_KEYS.has(key)) ||
      !entryKeys.includes("sourceId") ||
      !entryKeys.includes("page") ||
      (entryKeys.length === 3 && !entryKeys.includes("rotate"))
    ) {
      throw new PageManifestError(
        "MANIFEST_INVALID",
        "Each manifest page must be exactly { sourceId, page, rotate? }."
      );
    }
    if (typeof candidate["sourceId"] !== "string") {
      throw new PageManifestError("MANIFEST_INVALID_SOURCE_ID", "Manifest page sourceId must be a string.");
    }
    assertSourceId(candidate["sourceId"]);
    if (typeof candidate["page"] !== "number") {
      throw new PageManifestError("MANIFEST_INVALID_PAGE_NUMBER", "Manifest page number must be a number.");
    }
    assertPageNumber(candidate["page"]);
    const rotate = candidate["rotate"] ?? 0;
    if (typeof rotate !== "number") {
      throw new PageManifestError("MANIFEST_INVALID_ROTATION", "Manifest rotation must be a number.");
    }
    assertRotation(rotate as PageRotation);
    return freezePage({ sourceId: candidate["sourceId"], page: candidate["page"], rotate: rotate as PageRotation });
  });
  return Object.freeze({ version: PAGE_MANIFEST_VERSION, pages: Object.freeze(frozen) });
}

/** Build an immutable manifest from entries (validates shape eagerly). */
export function createManifest(entries: readonly ManifestPage[]): PageManifest {
  return parsePageManifest({ version: PAGE_MANIFEST_VERSION, pages: [...entries] });
}

/** Append every page of a newly added source (1..pageCount) to the manifest. */
export function appendSourcePages(
  manifest: PageManifest,
  sourceId: string,
  pageCount: number
): PageManifest {
  assertSourceId(sourceId);
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new PageManifestError(
      "MANIFEST_INVALID_PAGE_NUMBER",
      `Invalid pageCount ${String(pageCount)}: must be an integer >= 1.`
    );
  }
  const appended: ManifestPage[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    appended.push({ sourceId, page, rotate: 0 });
  }
  return createManifest([...manifest.pages, ...appended]);
}

function assertIndex(manifest: PageManifest, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= manifest.pages.length) {
    throw new PageManifestError(
      "MANIFEST_INVALID_INDEX",
      `Invalid manifest index ${String(index)} for ${manifest.pages.length} pages.`
    );
  }
}

/** Move the entry at fromIndex to toIndex (insertion position), immutably. */
export function movePage(manifest: PageManifest, fromIndex: number, toIndex: number): PageManifest {
  assertIndex(manifest, fromIndex);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= manifest.pages.length) {
    throw new PageManifestError(
      "MANIFEST_INVALID_INDEX",
      `Invalid manifest index ${String(toIndex)} for ${manifest.pages.length} pages.`
    );
  }
  if (fromIndex === toIndex) return manifest;
  const next = [...manifest.pages];
  const [entry] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, entry);
  return createManifest(next);
}

/** Add a relative clockwise rotation to one entry (mod 360), immutably. */
export function rotatePage(manifest: PageManifest, index: number, delta: PageRotation): PageManifest {
  assertIndex(manifest, index);
  assertRotation(delta);
  const current = manifest.pages[index];
  const next = ((current.rotate ?? 0) + delta) % 360;
  const entries = manifest.pages.map((entry, position) =>
    position === index ? { ...entry, rotate: next as PageRotation } : { ...entry }
  );
  return createManifest(entries);
}

/** Remove entries at the given indexes, immutably. Order of indexes is irrelevant. */
export function removePages(manifest: PageManifest, indexes: readonly number[]): PageManifest {
  const unique = new Set(indexes);
  for (const index of unique) assertIndex(manifest, index);
  const entries = manifest.pages.filter((_, position) => !unique.has(position));
  return createManifest(entries);
}

/**
 * Derive a separate immutable manifest from selected positions (in the given
 * order) without changing the workspace manifest. Used by "Export selection".
 */
export function deriveSelection(manifest: PageManifest, indexes: readonly number[]): PageManifest {
  if (indexes.length === 0) {
    return createManifest([]);
  }
  const seen = new Set<number>();
  for (const index of indexes) {
    assertIndex(manifest, index);
    if (seen.has(index)) {
      throw new PageManifestError("MANIFEST_INVALID_INDEX", `Duplicate selection index ${String(index)}.`);
    }
    seen.add(index);
  }
  return createManifest(indexes.map((index) => ({ ...manifest.pages[index] })));
}
