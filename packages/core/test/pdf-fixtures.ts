import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Deterministic in-test PDF fixture builder. Generates minimal valid PDFs
 * with correct cross-reference tables so `qpdf --json` exits 0 without
 * warnings, unless a feature under test intentionally adds findings.
 * No binary fixtures are committed; tests materialize these into temp dirs.
 */

export interface FixturePage {
  /** Distinct MediaBox width per page so order survives assembly checks. */
  width?: number;
  label?: string;
}

export interface FixtureFeatures {
  bookmarks?: boolean;
  formTextField?: boolean;
  /** The text field's starting /V value. */
  formPrefilledText?: string;
  /** Text field marked read-only (/Ff 1). */
  formReadOnly?: boolean;
  /** Text field with /MaxLen 5. */
  formMaxLen?: boolean;
  /** Text field carrying a /TU tooltip. */
  formTooltip?: string;
  /** Text field with the password flag. */
  formPassword?: boolean;
  /** The text field's widget is flagged hidden+no-view. */
  formHiddenWidget?: boolean;
  /** The text field carries /AA format/validate/calculate scripts and a /A SubmitForm action. */
  formFieldScripts?: boolean;
  /** /Btn checkbox with on-state "Ja" (non-standard name) and its own appearances. */
  formCheckbox?: boolean;
  /** /Btn radio group with two widgets (pages 1 and 2 when present), states A/B/Off. */
  formRadio?: boolean;
  /** /Ch combobox with three options. */
  formChoice?: boolean;
  /** Text field owning one widget per page. */
  formSpanPages?: boolean;
  /** Terminal field and widget merged into one dictionary (no /Parent). */
  formMergedField?: boolean;
  signatureField?: boolean;
  pageLabels?: boolean;
  tags?: boolean;
  javascript?: boolean;
  openAction?: boolean;
  additionalActions?: boolean;
  launchAction?: boolean;
  submitForm?: boolean;
  importData?: boolean;
  richMedia?: boolean;
  embeddedFiles?: boolean;
  /** /Link annotation with a /A URI action in the page's annotation array. */
  remoteLinkAction?: boolean;
  /** /OpenAction GoTo action chaining via /Next to a /Launch action. */
  chainedLaunchAction?: boolean;
  /** One URI action object referenced by both the catalog /OpenAction and the widget's /A (needs formTextField). */
  sharedCatalogAction?: boolean;
  /** Field hierarchy whose non-terminal parent carries an /AA script action. */
  nonTerminalFieldAction?: boolean;
  /** Widget annotation carrying an /AA format script action (needs formTextField). */
  widgetFieldAction?: boolean;
  /** Widget /AA action chaining via /Next to a /Launch action (needs formTextField). */
  widgetChainedLaunch?: boolean;
  /** The AcroForm dictionary itself carries an /AA script action (needs formTextField). */
  formDictAction?: boolean;
  /** /OpenAction GoTo and /Launch actions pointing at each other through /Next. */
  cyclicActions?: boolean;
  /** /FT /Sig field carrying no value: an empty signature widget. */
  emptySignatureField?: boolean;
  /** Catalog /Perms /UR3 usage-rights signature (Reader extensions). */
  usageRights?: boolean;
  /** Catalog /Perms /DocMDP document-modification permission signature. */
  docMdpSignature?: boolean;
  /** AcroForm /NeedAppearances true (needs a field-bearing feature). */
  needAppearances?: boolean;
  /** Static XFA: AcroForm /XFA packets without a datasets stream. */
  xfaStatic?: boolean;
  /** Static XFA whose /XFA packets include a datasets stream. */
  xfaStaticWithDatasets?: boolean;
  /** Dynamic-style XFA: /XFA packets and no interactive fields. */
  xfaDynamic?: boolean;
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildTestPdf(pages: FixturePage[], features: FixtureFeatures = {}): Buffer {
  const bodies = new Map<number, string>();
  let nextId = 1;
  const catalogId = nextId++;
  const pagesId = nextId++;
  const pageIds: number[] = [];
  for (let index = 0; index < pages.length; index += 1) pageIds.push(nextId++);
  const contentIds: number[] = [];
  for (let index = 0; index < pages.length; index += 1) contentIds.push(nextId++);
  const fontId = nextId++;

  const catalogExtras: string[] = [];
  const pageExtras = new Map<number, string[]>();
  const pageAnnots = new Map<number, number[]>();
  const addPageAnnot = (pageIndex: number, annotId: number): void => {
    const list = pageAnnots.get(pageIndex) ?? [];
    list.push(annotId);
    pageAnnots.set(pageIndex, list);
  };
  const extra = (text: string): number => {
    const id = nextId++;
    bodies.set(id, text);
    return id;
  };

  if (features.javascript || features.openAction) {
    const jsAction = extra("<< /S /JavaScript /JS (app.alert('fixture')) >>");
    catalogExtras.push(`/OpenAction ${jsAction} 0 R`);
    const nameAction = extra("<< /S /JavaScript /JS (fixture) >>");
    catalogExtras.push(`/Names << /JavaScript << /Names [(fixture) ${nameAction} 0 R] >> >>`);
  }
  if (features.launchAction) {
    const launch = extra("<< /S /Launch /Win << /P (fixture) >> >>");
    catalogExtras.push(`/OpenAction ${launch} 0 R`);
  }
  if (features.submitForm) {
    const submit = extra("<< /S /SubmitForm /F (https://localhost/fixture) >>");
    catalogExtras.push(`/OpenAction ${submit} 0 R`);
  }
  if (features.importData) {
    const importAction = extra("<< /S /ImportData /F (fixture.fdf) >>");
    catalogExtras.push(`/OpenAction ${importAction} 0 R`);
  }
  if (features.additionalActions) {
    const aaAction = extra("<< /S /JavaScript /JS (fixture) >>");
    const list = pageExtras.get(0) ?? [];
    list.push(`/AA << /O ${aaAction} 0 R >>`);
    pageExtras.set(0, list);
  }
  if (features.remoteLinkAction) {
    const uri = extra("<< /S /URI /URI (https://example.invalid/remote) >>");
    const link = extra(`<< /Type /Annot /Subtype /Link /Rect [10 10 60 30] /A ${uri} 0 R >>`);
    addPageAnnot(0, link);
  }
  if (features.chainedLaunchAction) {
    const launch = extra("<< /S /Launch /Win << /P (fixture) >> >>");
    const first = extra(`<< /S /GoTo /D [${pageIds[0]} 0 R /Fit] /Next ${launch} 0 R >>`);
    catalogExtras.push(`/OpenAction ${first} 0 R`);
  }
  if (features.cyclicActions) {
    const firstId = nextId++;
    const secondId = nextId++;
    bodies.set(firstId, `<< /S /GoTo /D [${pageIds[0]} 0 R /Fit] /Next ${secondId} 0 R >>`);
    bodies.set(secondId, `<< /S /Launch /Win << /P (fixture) >> /Next ${firstId} 0 R >>`);
    catalogExtras.push(`/OpenAction ${firstId} 0 R`);
  }
  if (features.richMedia) {
    const richContent = extra("<< /Type /RichMediaContent >>");
    const annot = extra(
      `<< /Type /Annot /Subtype /RichMedia /Rect [0 0 10 10] /RichMediaContent ${richContent} 0 R >>`
    );
    addPageAnnot(0, annot);
  }
  if (features.embeddedFiles) {
    const streamText = "fixture-attachment";
    const embeddedStream = extra(
      `<< /Length ${streamText.length} >>\nstream\n${streamText}\nendstream`
    );
    const filespec = extra(
      `<< /Type /Filespec /F (fixture.txt) /EF << /F ${embeddedStream} 0 R >> >>`
    );
    catalogExtras.push(`/Names << /EmbeddedFiles << /Names [(fixture.txt) ${filespec} 0 R] >> >>`);
  }
  if (features.bookmarks) {
    const item = nextId++;
    const outlines = nextId++;
    bodies.set(
      item,
      `<< /Title (Fixture chapter) /Parent ${outlines} 0 R /Dest [${pageIds[0]} 0 R /Fit] >>`
    );
    bodies.set(
      outlines,
      `<< /Type /Outlines /First ${item} 0 R /Last ${item} 0 R /Count 1 >>`
    );
    catalogExtras.push(`/Outlines ${outlines} 0 R`);
  }
  const wantsFields =
    features.formTextField ||
    features.signatureField ||
    features.emptySignatureField ||
    features.xfaStatic ||
    features.xfaStaticWithDatasets ||
    features.formCheckbox ||
    features.formRadio ||
    features.formChoice ||
    features.formSpanPages ||
    features.formMergedField;
  if (wantsFields || features.xfaDynamic) {
    const form = nextId++;
    const fieldIds: number[] = [];
    const formExtras: string[] = [];
    const apStream = (ops: string): number =>
      extra(
        `<< /Type /XObject /Subtype /Form /BBox [0 0 15 15] /Resources << >> /Length ${ops.length} >>\nstream\n${ops}\nendstream`
      );
    const addField = (
      body: (widget: number) => string,
      widgetExtras: string[] = [],
      pageIndex = 0,
    ): void => {
      const widget = nextId++;
      const field = nextId++;
      fieldIds.push(field);
      addPageAnnot(pageIndex, widget);
      bodies.set(field, body(widget));
      bodies.set(
        widget,
        `<< /Type /Annot /Subtype /Widget /Rect [100 100 200 120] /P ${pageIds[pageIndex]} 0 R /Parent ${field} 0 R${widgetExtras.length ? ` ${widgetExtras.join(" ")}` : ""} >>`
      );
    };
    if (features.formTextField || features.xfaStatic || features.xfaStaticWithDatasets) {
      const widgetExtras: string[] = [];
      if (features.widgetFieldAction) {
        const format = extra("<< /S /JavaScript /JS (fixture-format) >>");
        widgetExtras.push(`/AA << /F ${format} 0 R >>`);
      }
      if (features.widgetChainedLaunch) {
        const launch = extra("<< /S /Launch /Win << /P (fixture) >> >>");
        const first = extra(`<< /S /GoTo /D [${pageIds[0]} 0 R /Fit] /Next ${launch} 0 R >>`);
        widgetExtras.push(`/AA << /O ${first} 0 R >>`);
      }
      if (features.sharedCatalogAction) {
        const shared = extra("<< /S /URI /URI (https://example.invalid/shared) >>");
        catalogExtras.push(`/OpenAction ${shared} 0 R`);
        widgetExtras.push(`/A ${shared} 0 R`);
      }
      if (features.formHiddenWidget) widgetExtras.push("/F 34");
      const fieldExtras: string[] = [];
      const fieldFlags = (features.formReadOnly ? 1 : 0) | (features.formPassword ? 8192 : 0);
      if (fieldFlags !== 0) fieldExtras.push(`/Ff ${fieldFlags}`);
      if (features.formMaxLen) fieldExtras.push("/MaxLen 5");
      if (features.formTooltip) {
        fieldExtras.push(`/TU (${escapePdfText(features.formTooltip)})`);
      }
      if (features.formFieldScripts) {
        const fmt = extra("<< /S /JavaScript /JS (fixture-format) >>");
        const val = extra("<< /S /JavaScript /JS (fixture-validate) >>");
        const calc = extra("<< /S /JavaScript /JS (fixture-calc) >>");
        const submit = extra("<< /S /SubmitForm /F (https://localhost/fixture) >>");
        fieldExtras.push(`/AA << /F ${fmt} 0 R /V ${val} 0 R /C ${calc} 0 R >> /A ${submit} 0 R`);
      }
      const value =
        features.formPrefilledText !== undefined ? escapePdfText(features.formPrefilledText) : "";
      addField(
        (widget) =>
          `<< /FT /Tx /T (fixture-name) /V (${value}) /Kids [${widget} 0 R]${fieldExtras.length ? ` ${fieldExtras.join(" ")}` : ""} >>`,
        widgetExtras,
      );
    }
    if (features.formCheckbox) {
      const on = apStream("3 4 m 7 1 l 13 12 l S");
      const off = apStream("q Q");
      addField(
        (widget) => `<< /FT /Btn /T (fixture-check) /V /Off /Kids [${widget} 0 R] >>`,
        [`/AS /Off`, `/AP << /N << /Ja ${on} 0 R /Off ${off} 0 R >> >>`],
      );
    }
    if (features.formRadio) {
      const apA = apStream("4 4 m 11 4 l 7 11 l h S");
      const apB = apStream("7 7 3 0 0 360 arc S");
      const apOff = apStream("q Q");
      const w1 = nextId++;
      const w2 = nextId++;
      const field = nextId++;
      fieldIds.push(field);
      bodies.set(
        field,
        `<< /FT /Btn /T (fixture-radio) /V /B /Kids [${w1} 0 R ${w2} 0 R] /Ff 49152 >>`
      );
      const secondPage = Math.min(1, pageIds.length - 1);
      bodies.set(
        w1,
        `<< /Type /Annot /Subtype /Widget /Rect [100 200 115 215] /P ${pageIds[0]} 0 R /Parent ${field} 0 R /AS /Off /AP << /N << /A ${apA} 0 R /Off ${apOff} 0 R >> >> >>`
      );
      bodies.set(
        w2,
        `<< /Type /Annot /Subtype /Widget /Rect [120 200 135 215] /P ${pageIds[secondPage]} 0 R /Parent ${field} 0 R /AS /B /AP << /N << /B ${apB} 0 R /Off ${apOff} 0 R >> >> >>`
      );
      addPageAnnot(0, w1);
      addPageAnnot(secondPage, w2);
    }
    if (features.formChoice) {
      addField(
        (widget) =>
          `<< /FT /Ch /T (fixture-choice) /Opt [(alpha) (beta) (gamma)] /V (alpha) /Ff 131072 /Kids [${widget} 0 R] >>`
      );
    }
    if (features.formSpanPages) {
      const field = nextId++;
      const ids = pageIds.map(() => nextId++);
      fieldIds.push(field);
      bodies.set(
        field,
        `<< /FT /Tx /T (fixture-span) /V () /Kids [${ids.map((id) => `${id} 0 R`).join(" ")}] >>`
      );
      ids.forEach((id, index) => {
        bodies.set(
          id,
          `<< /Type /Annot /Subtype /Widget /Rect [100 300 200 320] /P ${pageIds[index]} 0 R /Parent ${field} 0 R >>`
        );
        addPageAnnot(index, id);
      });
    }
    if (features.formMergedField) {
      const merged = nextId++;
      fieldIds.push(merged);
      bodies.set(
        merged,
        `<< /Type /Annot /Subtype /Widget /Rect [100 400 200 420] /P ${pageIds[0]} 0 R /FT /Tx /T (fixture-merged) /V () /F 4 >>`
      );
      addPageAnnot(0, merged);
    }
    if (features.signatureField) {
      addField((widget) => {
        const sigValue = extra("<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 100 200 300] >>");
        return `<< /FT /Sig /T (fixture-sig) /V ${sigValue} 0 R /Kids [${widget} 0 R] >>`;
      });
    }
    if (features.emptySignatureField) {
      addField((widget) => `<< /FT /Sig /T (fixture-empty-sig) /Kids [${widget} 0 R] >>`);
    }
    if (features.formDictAction) {
      const action = extra("<< /S /JavaScript /JS (fixture-form-dict) >>");
      formExtras.push(`/AA << /O ${action} 0 R >>`);
    }
    if (features.needAppearances) {
      formExtras.push("/NeedAppearances true");
    }
    if (features.xfaStatic || features.xfaStaticWithDatasets || features.xfaDynamic) {
      const packet = (name: string, text: string): string => {
        const id = extra(`<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`);
        return `(${name}) ${id} 0 R`;
      };
      const packets = [
        packet("preamble", "<xdp>"),
        packet("template", "<template><subform name=\"f\"/></template>")
      ];
      if (!features.xfaStatic) {
        packets.push(packet("datasets", "<datasets/>"));
      }
      packets.push(packet("postamble", "</xdp>"));
      formExtras.push(`/XFA [${packets.join(" ")}]`);
    }
    bodies.set(
      form,
      `<<${fieldIds.length ? ` /Fields [${fieldIds.map((id) => `${id} 0 R`).join(" ")}]` : ""}${formExtras.length ? ` ${formExtras.join(" ")}` : ""} >>`
    );
    catalogExtras.push(`/AcroForm ${form} 0 R`);
  }
  if (features.usageRights || features.docMdpSignature) {
    const permsEntries: string[] = [];
    if (features.usageRights) {
      const rights = extra(
        "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <00> /Reference [<< /TransformMethod /UR3 /TransformParams << /Type /TransformParams /V /2.2 >> >>] >>"
      );
      permsEntries.push(`/UR3 ${rights} 0 R`);
    }
    if (features.docMdpSignature) {
      const mdp = extra(
        "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 300] /Contents <00> /Reference [<< /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P 1 /V /1.2 >> >>] >>"
      );
      permsEntries.push(`/DocMDP ${mdp} 0 R`);
    }
    catalogExtras.push(`/Perms << ${permsEntries.join(" ")} >>`);
  }
  if (features.nonTerminalFieldAction) {
    const widget = nextId++;
    const terminal = nextId++;
    const parent = nextId++;
    const form = nextId++;
    const format = extra("<< /S /JavaScript /JS (fixture-format) >>");
    bodies.set(parent, `<< /Kids [${terminal} 0 R] /AA << /F ${format} 0 R >> >>`);
    bodies.set(
      terminal,
      `<< /Parent ${parent} 0 R /FT /Tx /T (fixture-child) /V () /Kids [${widget} 0 R] >>`
    );
    bodies.set(
      widget,
      `<< /Type /Annot /Subtype /Widget /Rect [100 100 200 120] /P ${pageIds[0]} 0 R /Parent ${terminal} 0 R >>`
    );
    bodies.set(form, `<< /Fields [${parent} 0 R] >>`);
    catalogExtras.push(`/AcroForm ${form} 0 R`);
    addPageAnnot(0, widget);
  }
  if (features.pageLabels) {
    catalogExtras.push("/PageLabels << /Nums [0 << /S /D /P (A-) >>] >>");
  }
  if (features.tags) {
    const structTree = extra("<< /Type /StructTreeRoot /ParentTree << /Nums [] >> >>");
    catalogExtras.push(`/StructTreeRoot ${structTree} 0 R /MarkInfo << /Marked true >>`);
  }

  bodies.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R${catalogExtras.length ? ` ${catalogExtras.join(" ")}` : ""} >>`);
  bodies.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`
  );
  pages.forEach((page, index) => {
    const width = page.width ?? 600 + index;
    const extras = [...(pageExtras.get(index) ?? [])];
    const annots = pageAnnots.get(index);
    if (annots && annots.length > 0) {
      extras.push(`/Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]`);
    }
    bodies.set(
      pageIds[index],
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} 792] /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >>${extras.length ? ` ${extras.join(" ")}` : ""} >>`
    );
    const text = escapePdfText(page.label ?? `FIXTURE-${index + 1}`);
    const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
    bodies.set(contentIds[index], `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  bodies.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const ordered = [...bodies.entries()].sort((left, right) => left[0] - right[0]);
  const maxId = ordered[ordered.length - 1][0];
  const parts: string[] = ["%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"];
  const offsets = new Map<number, number>();
  const byteLength = (text: string): number => Buffer.byteLength(text, "latin1");
  for (const [id, body] of ordered) {
    offsets.set(id, parts.reduce((total, part) => total + byteLength(part), 0));
    parts.push(`${id} 0 obj\n${body}\nendobj\n`);
  }
  const startxref = parts.reduce((total, part) => total + byteLength(part), 0);
  const xref: string[] = [`xref\n0 ${maxId + 1}\n0000000000 65535 f \n`];
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets.get(id);
    xref.push(offset === undefined ? "0000000000 00000 f \n" : `${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(parts.join("") + xref.join("") + trailer, "latin1");
}

export async function writeTestPdf(
  directory: string,
  name: string,
  pages: FixturePage[],
  features: FixtureFeatures = {}
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, buildTestPdf(pages, features));
  return path;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Encrypt a fixture with qpdf. An empty user password models the
 * owner-restricted documents that open without one.
 */
export function encryptTestPdf(
  input: string,
  output: string,
  userPassword: string,
  ownerPassword: string,
  restrictions: readonly string[] = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "qpdf",
      ["--encrypt", userPassword, ownerPassword, "256", ...restrictions, "--", input, output],
      (error) => (error ? reject(error) : resolve())
    );
  });
}

export interface QpdfPageEntry {
  contents: string[];
  label: unknown;
  object: string;
  pageposfrom1: number;
}

export interface QpdfJsonDocument {
  pages: QpdfPageEntry[];
  outlines: unknown[];
  acroform: { hasacroform: boolean; fields: unknown[] };
  attachments: Record<string, unknown>;
  encrypt: { encrypted: boolean };
  pagelabels: unknown[];
  qpdf: [{ pdfversion: string }, Record<string, unknown>];
}

export async function qpdfJson(path: string): Promise<{ document: QpdfJsonDocument; stderr: string; code: number }> {
  const output = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    execFile("qpdf", ["--json", "--", path], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), code: error?.["code"] as number ?? 0 });
    });
  });
  return { document: JSON.parse(output.stdout) as QpdfJsonDocument, stderr: output.stderr, code: output.code };
}

/** Output page geometries in order: MediaBox width plus explicit /Rotate. */
export async function readPageGeometries(path: string): Promise<Array<{ width: number; rotate: number }>> {
  const { document } = await qpdfJson(path);
  const objects = document.qpdf[1];
  return document.pages.map((page) => {
    const raw = objects[`obj:${page.object}`] as { value?: { "/MediaBox"?: number[]; "/Rotate"?: number } };
    const mediaBox = raw?.value?.["/MediaBox"] ?? [0, 0, 0, 0];
    return { width: mediaBox[2] ?? 0, rotate: raw?.value?.["/Rotate"] ?? 0 };
  });
}
