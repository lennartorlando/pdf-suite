import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

export interface PageGeometry {
  width: number;
  rotate: number;
}

interface QpdfPageEntry {
  contents: string;
  object: string;
}

interface QpdfJsonDocument {
  pages: QpdfPageEntry[];
  qpdf: [{ pdfversion: string }, Record<string, { value?: { "/MediaBox"?: number[]; "/Rotate"?: number } }>];
}

function runQpdfJson(path: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("qpdf", ["--json", "--", path], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException & { code?: number })?.code;
      resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof code === "number" ? code : 0 });
    });
  });
}

/** Page geometries in output order: MediaBox width plus explicit /Rotate. */
export async function readOutputGeometries(path: string): Promise<PageGeometry[]> {
  const { stdout } = await runQpdfJson(path);
  const document = JSON.parse(stdout) as QpdfJsonDocument;
  const objects = document.qpdf[1];
  return document.pages.map((page) => {
    const raw = objects[`obj:${page.object}`];
    const mediaBox = raw?.value?.["/MediaBox"] ?? [0, 0, 0, 0];
    return { width: mediaBox[2] ?? 0, rotate: raw?.value?.["/Rotate"] ?? 0 };
  });
}

/** sha256 of a file, proving an input was read but never rewritten. */
export async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** First bytes of a representative output page via `qpdf --json` object text. */
export async function outputPageCount(path: string): Promise<number> {
  const { stdout } = await runQpdfJson(path);
  return (JSON.parse(stdout) as QpdfJsonDocument).pages.length;
}

/**
 * Render-inspect one representative output page without a browser: decompress
 * the page content stream with `qpdf --qdf` output and assert the fixture
 * marker text for that page is present. This catches content regressions
 * that pure page-count checks cannot see.
 */
export async function outputContainsMarker(outputPath: string, marker: string): Promise<boolean> {
  const text = await new Promise<string>((resolve, reject) => {
    execFile("qpdf", ["--qdf", "--object-streams=disable", "--", outputPath, "-"], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer"
    }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException & { code?: number }).code !== 0) {
        reject(error);
        return;
      }
      resolve((stdout as Buffer).toString("latin1"));
    });
  });
  return text.includes(marker);
}

/** Bytes that must not appear in a delivered file (superseded values, removed scripts). */
export async function outputOmitsBytes(outputPath: string, bytes: string): Promise<boolean> {
  const content = await readFile(outputPath);
  return !content.includes(Buffer.from(bytes, "latin1"));
}

interface QpdfAcroformRow {
  object?: string;
  parent?: string | null;
  annotation?: { object?: string; appearancestate?: string };
  fullname?: string;
  value?: unknown;
}

/** qpdf's JSON spellings of a text value: plain, "u:" utf-8 or "b:" hex bytes. */
function decodeValue(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.startsWith("u:")) return value.slice(2);
  if (value.startsWith("b:")) {
    const bytes = Buffer.from(value.slice(2), "hex");
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = Buffer.alloc(bytes.length - 2);
      for (let index = 2; index + 1 < bytes.length; index += 2) {
        swapped[index - 2] = bytes[index + 1];
        swapped[index - 1] = bytes[index];
      }
      return swapped.toString("utf16le");
    }
    return bytes.toString("latin1");
  }
  if (value.startsWith("/")) return value.slice(1);
  return value;
}

async function readAcroformRows(path: string): Promise<QpdfAcroformRow[]> {
  const { stdout } = await runQpdfJson(path);
  const fields = (JSON.parse(stdout) as { acroform?: { fields?: QpdfAcroformRow[] } }).acroform?.fields;
  return Array.isArray(fields) ? fields : [];
}

/**
 * Interactive readback: the current /V value of every widget row of one
 * field, plus each widget's appearance state. Field identity is the field
 * dictionary's object reference (row.parent, or the row's own object for a
 * merged field/widget dictionary).
 */
export async function readFieldRows(
  path: string,
  fieldRef: string
): Promise<{ value: string; appearanceState: string }[]> {
  const rows = await readAcroformRows(path);
  return rows
    .filter((row) => row.parent === fieldRef || row.object === fieldRef)
    .map((row) => {
      const state = row.annotation?.appearancestate ?? "";
      return { value: decodeValue(row.value), appearanceState: state.startsWith("/") ? state.slice(1) : state };
    });
}
