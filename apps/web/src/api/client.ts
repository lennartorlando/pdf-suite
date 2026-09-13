import type { CompressionProfileName } from "../profiles.js";
import type { PageManifest } from "@pdf-compressor/core/page-manifest";
import type { OcrLanguage, OcrMetadata, OcrOptions } from "@pdf-compressor/core/ocr-contract";
import type { FormInventory } from "@pdf-compressor/core/form-inventory";
import { serializeFormPlan, type FormPlan } from "@pdf-compressor/core/form-plan";

export type { OcrLanguage, OcrMetadata } from "@pdf-compressor/core/ocr-contract";

export interface CompressionResponse {
  ok: boolean;
  jobId?: string;
  handle?: string;
  downloadUrl?: string;
  summary?: {
    status: "success" | "no_gain";
    inputPath: string;
    outputPath: string;
    profile: CompressionProfileName;
    originalBytes: number;
    outputBytes: number;
    reductionBytes: number;
    reductionPercent: number;
    outputSmaller: boolean;
    engine: string;
    warnings: string[];
  };
  code?: string;
  message?: string;
}

export function downloadUrl(path: string): string {
  return path;
}

const LAUNCH_TOKEN_HEADER = "x-launch-token";
const TOKEN_SKEW_MS = 30_000;

interface LaunchPayload {
  ok: boolean;
  token?: string;
  expiresInMs?: number;
  code?: string;
  message?: string;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightLaunch: Promise<string> | null = null;

/** Test-only reset for the module-level session cache. */
export function resetAuthStateForTests(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  inflightLaunch = null;
}

function tokenValid(): boolean {
  return cachedToken !== null && Date.now() + TOKEN_SKEW_MS < tokenExpiresAt;
}

async function launchSession(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/session/launch", {
    method: "POST",
    credentials: "include",
    signal
  });
  const payload = (await response.json()) as LaunchPayload;
  if (!response.ok || !payload.ok || typeof payload.token !== "string") {
    throw new Error(payload.message ?? "The local session could not be started.");
  }
  cachedToken = payload.token;
  tokenExpiresAt = Date.now() + (payload.expiresInMs ?? 5 * 60 * 1000);
  return cachedToken;
}

/** Obtain (or reuse) the short-lived launch token bound to this session. */
export function ensureLaunchToken(signal?: AbortSignal): Promise<string> {
  if (tokenValid() && cachedToken) return Promise.resolve(cachedToken);
  if (!inflightLaunch) {
    inflightLaunch = launchSession(signal).finally(() => {
      inflightLaunch = null;
    });
  }
  return inflightLaunch;
}

export interface AuthedRequestInit extends RequestInit {
  /** Set false only to probe the launch boundary itself. */
  refreshToken?: boolean;
}

/**
 * Same-origin loopback request carrying the session cookie plus the launch
 * token. A stale-token rejection refreshes the token once and retries.
 */
export async function authedFetch(input: string, init: AuthedRequestInit = {}): Promise<Response> {
  const { refreshToken = true, ...requestInit } = init;
  const token = await ensureLaunchToken(requestInit.signal ?? undefined);
  const headers = new Headers(requestInit.headers);
  headers.set(LAUNCH_TOKEN_HEADER, token);
  const response = await fetch(input, { ...requestInit, headers, credentials: "include" });
  if (response.status === 401 && refreshToken) {
    cachedToken = null;
    const retryToken = await ensureLaunchToken(requestInit.signal ?? undefined);
    const retryHeaders = new Headers(requestInit.headers);
    retryHeaders.set(LAUNCH_TOKEN_HEADER, retryToken);
    return fetch(input, { ...requestInit, headers: retryHeaders, credentials: "include" });
  }
  return response;
}

export interface CapabilityStatus {
  available: boolean;
  version: string | null;
}

export interface Capabilities {
  qpdf: CapabilityStatus;
  ghostscript: CapabilityStatus;
  ocrmypdf: CapabilityStatus;
  tesseract: CapabilityStatus & { languages: string[] };
}

export async function getCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  const response = await authedFetch("/api/capabilities", { signal });
  const payload = (await response.json()) as { ok: boolean; capabilities?: Capabilities; message?: string };
  if (!response.ok || !payload.ok || !payload.capabilities) {
    throw new Error(payload.message ?? "Capabilities are unavailable.");
  }
  return payload.capabilities;
}

export async function compressFile(
  file: File,
  profile: CompressionProfileName,
  signal?: AbortSignal
): Promise<CompressionResponse> {
  const response = await authedFetch(`/api/compress?profile=${encodeURIComponent(profile)}`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-filename": file.name
    },
    body: await file.arrayBuffer(),
    signal
  });
  return response.json() as Promise<CompressionResponse>;
}

export type ExportCompression = CompressionProfileName | "none";

export interface ExportPagesInput {
  manifest: PageManifest;
  /** Source files in distinct-manifest-source order; each streams once. */
  files: File[];
  compression: ExportCompression;
  ocr: Required<OcrOptions> | null;
  signal?: AbortSignal;
}

export interface ExportPagesResult {
  ok: boolean;
  handle?: string;
  downloadUrl?: string;
  status?: string;
  pageCount?: number;
  outputBytes?: number;
  engine?: string;
  warnings?: string[];
  compatWarnings?: string[];
  ocr?: OcrMetadata;
  code?: string;
  message?: string;
}

/** Stream every selected source exactly once plus one manifest field. */
export async function exportPages(input: ExportPagesInput): Promise<ExportPagesResult> {
  const form = new FormData();
  // Plain string field: the server accepts exactly one bounded manifest field
  // plus generated source file parts. A Blob here would parse as a file.
  form.append("manifest", JSON.stringify(input.manifest));
  for (const file of input.files) {
    form.append("source", file, "source.pdf");
  }
  const compression = input.compression === "none" ? "none" : input.compression;
  const query = new URLSearchParams({ compression });
  if (input.ocr === null) {
    query.set("ocr", "off");
  } else {
    query.set("ocr", input.ocr.languages.join("+"));
    query.set("ocrAutoRotate", String(input.ocr.autoRotate));
  }
  const response = await authedFetch(`/api/pages/export?${query.toString()}`, {
    method: "POST",
    body: form,
    signal: input.signal
  });
  return response.json() as Promise<ExportPagesResult>;
}

/** Authenticated one-time download; the server consumes it on completion. */
export async function downloadOutput(downloadPath: string, signal?: AbortSignal): Promise<Blob> {
  const response = await authedFetch(downloadPath, { signal });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "The export download failed.");
  }
  return response.blob();
}

/** Explicitly discard a retained output without downloading it. */
export async function discardOutput(handle: string, signal?: AbortSignal): Promise<void> {
  await authedFetch(`/api/outputs/${encodeURIComponent(handle)}`, { method: "DELETE", signal });
}

export interface FormInventoryResponse {
  ok: boolean;
  inventory?: FormInventory;
  pageCount?: number;
  warnings?: string[];
  removedRestrictions?: string[];
  removedUsageRights?: boolean;
  code?: string;
  message?: string;
}

/** Server-authoritative field inventory (KTD6), with current values revealed. */
export async function inventoryForm(file: File, signal?: AbortSignal): Promise<FormInventoryResponse> {
  const form = new FormData();
  form.append("source", file, "source.pdf");
  const response = await authedFetch("/api/forms/inventory?reveal=values", {
    method: "POST",
    body: form,
    signal
  });
  return response.json() as Promise<FormInventoryResponse>;
}

export interface FillFormResult {
  ok: boolean;
  handle?: string;
  downloadUrl?: string;
  pageCount?: number;
  outputBytes?: number;
  burnedIn?: boolean;
  fieldsWritten?: number;
  placementsWritten?: number;
  computedFields?: number;
  removedRestrictions?: string[];
  removedUsageRights?: boolean;
  sourceHash?: string;
  warnings?: string[];
  compatWarnings?: string[];
  code?: string;
  message?: string;
}

/**
 * Busy-retry delays for a native-slot 429. The slot is released when the
 * in-flight job settles, so short bounded waits are enough; the plan's nonce
 * makes a retried upload idempotent (KTD18), and the same FormData replays
 * the authentication retry inside `authedFetch` for free.
 */
const FILL_BUSY_DELAYS_MS = [400, 1200];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One source plus one serialized plan; the server produces the output. */
export async function fillForm(file: File, plan: FormPlan, signal?: AbortSignal): Promise<FillFormResult> {
  const form = new FormData();
  // Plain string field: a Blob would parse as a file part and be refused.
  form.append("plan", serializeFormPlan(plan));
  form.append("source", file, "source.pdf");
  for (let attempt = 0; ; attempt += 1) {
    const response = await authedFetch("/api/forms/fill", { method: "POST", body: form, signal });
    if (response.status !== 429 || attempt >= FILL_BUSY_DELAYS_MS.length) {
      return response.json() as Promise<FillFormResult>;
    }
    await sleep(FILL_BUSY_DELAYS_MS[attempt], signal);
  }
}
