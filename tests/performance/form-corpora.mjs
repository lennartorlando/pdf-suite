/**
 * U8 form-filling benchmark corpora (deterministic, generated,
 * redistributable). Fields are merged field/widget dictionaries laid out on
 * a fixed grid so qpdf and pdf.js both enumerate them; every widget carries
 * the print flag so it is visible.
 *
 * - form-100.pdf: 100 text fields across 4 pages (SC5 core fill corpus).
 * - form-200.pdf: 200 fields across 8 pages; every tenth is a checkbox so
 *   page 1 carries both input kinds (SC4 input-latency corpus).
 * - form-8page-2mb.pdf: 8 pages, ~2 MiB of deterministic content padding,
 *   5 fields spread one per page, every second a checkbox (SC3 cold-open
 *   corpus).
 * - scanned-form-icc.pdf: one page painted with a CMYK image through an
 *   embedded ICCBased color profile plus one text field. Rendering it makes
 *   the pinned pdf.js worker compile its qcms WebAssembly module, which the
 *   production content policy must admit from the app's own origin (KTD19).
 *   The embedded profile is the pinned package's own
 *   `iccs/CGATS001Compat-v2-micro.icc`, read at generation time.
 *
 * Regenerate: `node scripts/benchmark-browser.mjs --regen-corpora` or
 * `node scripts/benchmark-form-filling.mjs --regen-corpora`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PERF_DIR = join(ROOT, "tests", "performance");
const ICC_PATH = join(ROOT, "node_modules", "pdfjs-dist", "iccs", "CGATS001Compat-v2-micro.icc");

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const FIELD_COLS = 5;
const FIELD_COL_STEP = 110;
const FIELD_ROW_STEP = 110;
const FIELD_TOP_Y = 700;
const FIELD_WIDTH = 100;
const FIELD_HEIGHT = 24;

/** Widget rectangle for grid index `index` on a page (PDF user space). */
function fieldRect(index) {
  const col = index % FIELD_COLS;
  const row = Math.floor(index / FIELD_COLS) % 5;
  const x = 50 + col * FIELD_COL_STEP;
  const y = FIELD_TOP_Y - row * FIELD_ROW_STEP;
  return [x, y - FIELD_HEIGHT, x + FIELD_WIDTH, y];
}

/** Assemble indirect objects into a minimal valid PDF (latin1, correct xref). */
export function assemblePdf(bodies, rootId) {
  const ordered = [...bodies.entries()].sort((a, b) => a[0] - b[0]);
  const maxId = ordered[ordered.length - 1][0];
  const parts = [Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1")];
  const offsets = new Map();
  let cursor = parts[0].length;
  for (const [id, body] of ordered) {
    offsets.set(id, cursor);
    const chunk = Buffer.isBuffer(body)
      ? body
      : Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, "latin1");
    if (Buffer.isBuffer(body)) {
      const head = Buffer.from(`${id} 0 obj\n`, "latin1");
      const tail = Buffer.from("\nendobj\n", "latin1");
      parts.push(head, body, tail);
      cursor += head.length + body.length + tail.length;
    } else {
      parts.push(chunk);
      cursor += chunk.length;
    }
  }
  const startxref = cursor;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets.get(id);
    xref += offset === undefined ? "0000000000 00000 f \n" : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  return Buffer.concat([
    ...parts,
    Buffer.from(`${xref}trailer\n<< /Size ${maxId + 1} /Root ${rootId} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`, "latin1")
  ]);
}

function streamObject(dict, data) {
  const body = typeof data === "string" ? Buffer.from(data, "latin1") : data;
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`, "latin1"),
    body,
    Buffer.from("\nendstream", "latin1")
  ]);
}

function apStreamObject(ops) {
  return streamObject(
    "/Type /XObject /Subtype /Form /BBox [0 0 15 15] /Resources << >>",
    ops
  );
}

/**
 * Deterministic incompressible padding: LCG-generated comment lines keep the
 * corpus byte-stable while giving page content real bulk.
 */
function paddingBlock(bytes, seed) {
  let state = seed >>> 0;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (Buffer.byteLength(out, "latin1") < bytes) {
    let line = "% ";
    for (let i = 0; i < 76; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      line += alphabet[state % alphabet.length];
    }
    out += `${line}\n`;
  }
  return out;
}

/**
 * A form corpus: `fieldCount` merged field/widget dictionaries spread over
 * `pageCount` pages on a fixed grid. `checkboxEvery > 0` makes every
 * checkboxEvery-th field a /Btn checkbox with on-state "Yes".
 */
export function buildFormPdf({ pageCount, fieldCount, checkboxEvery = 0, padBytesPerPage = 0, label }) {
  const bodies = new Map();
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const fontId = alloc();
  const acroFormId = alloc();
  const pageIds = Array.from({ length: pageCount }, () => alloc());
  const contentIds = Array.from({ length: pageCount }, () => alloc());
  const fieldsPerPage = Math.ceil(fieldCount / pageCount);
  const fieldIds = [];
  const pageAnnots = new Map();
  for (let index = 0; index < fieldCount; index += 1) {
    const pageIndex = Math.min(pageCount - 1, Math.floor(index / fieldsPerPage));
    const fieldId = alloc();
    fieldIds.push(fieldId);
    const list = pageAnnots.get(pageIndex) ?? [];
    list.push(fieldId);
    pageAnnots.set(pageIndex, list);
    const rect = fieldRect(index % fieldsPerPage);
    const name = `field-${String(index + 1).padStart(3, "0")}`;
    if (checkboxEvery > 0 && index % checkboxEvery === 1) {
      const onId = alloc();
      const offId = alloc();
      bodies.set(onId, apStreamObject("3 4 m 7 1 l 13 12 l S"));
      bodies.set(offId, apStreamObject("q Q"));
      bodies.set(
        fieldId,
        `<< /Type /Annot /Subtype /Widget /Rect [${rect.join(" ")}] /P ${pageIds[pageIndex]} 0 R /FT /Btn /T (${name}) /V /Off /AS /Off /F 4 /AP << /N << /Yes ${onId} 0 R /Off ${offId} 0 R >> >> >>`
      );
    } else {
      bodies.set(
        fieldId,
        `<< /Type /Annot /Subtype /Widget /Rect [${rect.join(" ")}] /P ${pageIds[pageIndex]} 0 R /FT /Tx /T (${name}) /V () /F 4 /DA (/Helv 10 Tf 0 g) >>`
      );
    }
  }
  bodies.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /AcroForm ${acroFormId} 0 R >>`);
  bodies.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`
  );
  for (let index = 0; index < pageCount; index += 1) {
    const annots = pageAnnots.get(index);
    bodies.set(
      pageIds[index],
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >>${annots?.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`
    );
    const text = `BT /F1 18 Tf 40 760 Td (${label}-page-${index + 1}) Tj ET`;
    const padding = padBytesPerPage > 0 ? `\n${paddingBlock(padBytesPerPage, index + 1)}` : "";
    bodies.set(contentIds[index], streamObject("", `${text}${padding}`));
  }
  bodies.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  bodies.set(
    acroFormId,
    `<< /Fields [${fieldIds.map((id) => `${id} 0 R`).join(" ")}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${fontId} 0 R >> >> >>`
  );
  return assemblePdf(bodies, catalogId);
}

/**
 * A scanned page: one full-page CMYK image decoded through an embedded
 * ICCBased profile (which makes the pdf.js worker compile qcms_bg.wasm),
 * plus one text field so the fill surface treats it as a form.
 */
export function buildScannedIccPdf() {
  const icc = readFileSync(ICC_PATH);
  const width = 320;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      pixels[at] = x % 256;
      pixels[at + 1] = y % 256;
      pixels[at + 2] = (x + y) % 256;
      pixels[at + 3] = 30;
    }
  }
  const bodies = new Map();
  const catalogId = 1;
  const pagesId = 2;
  const pageId = 3;
  const contentId = 4;
  const imageId = 5;
  const iccId = 6;
  const fontId = 7;
  const acroFormId = 8;
  const fieldId = 9;
  bodies.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /AcroForm ${acroFormId} 0 R >>`);
  bodies.set(pagesId, `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  bodies.set(
    pageId,
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentId} 0 R /Resources << /XObject << /Im0 ${imageId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> /Annots [${fieldId} 0 R] >>`
  );
  bodies.set(
    contentId,
    streamObject("", `q ${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm /Im0 Do Q\nBT /F1 12 Tf 40 40 Td (scanned-icc) Tj ET`)
  );
  bodies.set(
    imageId,
    streamObject(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace [ /ICCBased ${iccId} 0 R ] /BitsPerComponent 8`,
      pixels
    )
  );
  bodies.set(iccId, streamObject(`/N 4 /Alternate /DeviceCMYK`, icc));
  bodies.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  bodies.set(
    acroFormId,
    `<< /Fields [${fieldId} 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${fontId} 0 R >> >> >>`
  );
  bodies.set(
    fieldId,
    `<< /Type /Annot /Subtype /Widget /Rect [80 60 320 84] /P ${pageId} 0 R /FT /Tx /T (scanned-name) /V () /F 4 /DA (/Helv 10 Tf 0 g) >>`
  );
  return assemblePdf(bodies, catalogId);
}

export const FORM_CORPUS_SPECS = [
  ["form-100.pdf", () => buildFormPdf({ pageCount: 4, fieldCount: 100, label: "form-100" })],
  ["form-200.pdf", () => buildFormPdf({ pageCount: 8, fieldCount: 200, checkboxEvery: 10, label: "form-200" })],
  [
    "form-8page-2mb.pdf",
    () =>
      buildFormPdf({
        pageCount: 8,
        fieldCount: 5,
        checkboxEvery: 2,
        padBytesPerPage: 250 * 1024,
        label: "form-8page-2mb"
      })
  ],
  ["scanned-form-icc.pdf", () => buildScannedIccPdf()]
];

export function ensureFormCorpora(regen) {
  mkdirSync(PERF_DIR, { recursive: true });
  const paths = new Map();
  for (const [name, build] of FORM_CORPUS_SPECS) {
    const path = join(PERF_DIR, name);
    if (!existsSync(path) || regen) writeFileSync(path, build());
    paths.set(name, path);
  }
  return paths;
}
