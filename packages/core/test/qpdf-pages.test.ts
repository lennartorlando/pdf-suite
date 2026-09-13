import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ocrPdf } from "../src/ocr.js";
import { assemblePages } from "../src/pages.js";
import {
  classifyQpdfJson,
  inspectPdfSource,
  isAdmissibleFor,
  type AdmissionOperation,
  type PdfInspection
} from "../src/engines/qpdf-pages.js";
import { createManifest } from "../src/page-manifest.js";
import { writeTestPdf, type FixtureFeatures } from "./pdf-fixtures.js";

const OPERATIONS: AdmissionOperation[] = ["compress", "assemble", "ocr", "fill"];

function admissionSets(inspection: PdfInspection): Record<AdmissionOperation, boolean> {
  return Object.fromEntries(
    OPERATIONS.map((operation) => [operation, isAdmissibleFor(inspection, operation)])
  ) as Record<AdmissionOperation, boolean>;
}

function objectMap(entries: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trailer: { value: { "/Root": "1 0 R" } },
    "obj:1 0 R": { value: { "/Type": "/Catalog", "/Pages": "2 0 R" } },
    "obj:2 0 R": { value: { "/Type": "/Pages", "/Kids": ["3 0 R"], "/Count": 1 } },
    "obj:3 0 R": { value: { "/Type": "/Page", "/Parent": "2 0 R", "/MediaBox": [0, 0, 612, 792] } },
    ...entries
  };
}

function jsonDocument(objects: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    pages: [{ object: "3 0 R" }],
    outlines: [],
    acroform: { hasacroform: false, fields: [] },
    attachments: {},
    encrypt: { encrypted: false },
    pagelabels: [],
    qpdf: [{ pdfversion: "1.7", jsonversion: 2 }, objects],
    ...overrides
  };
}

async function withFixture(
  features: FixtureFeatures,
  run: (dir: string, path: string, inspection: PdfInspection) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-u2-"));
  try {
    const path = await writeTestPdf(dir, "fixture.pdf", [{ width: 612 }], features);
    await run(dir, path, await inspectPdfSource(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function expectRefused(dir: string, path: string): Promise<void> {
  await expect(
    assemblePages({
      sources: [{ id: "a", path }],
      manifest: createManifest([{ sourceId: "a", page: 1 }]),
      destinationPath: join(dir, "assembled.pdf")
    })
  ).rejects.toMatchObject({ code: "INPUT_HAS_ACTIVE_CONTENT" });
  await expect(
    ocrPdf({ inputPath: path, outputPath: join(dir, "ocred.pdf"), languages: ["eng"] })
  ).rejects.toMatchObject({ code: "INPUT_HAS_ACTIVE_CONTENT" });
}

describe("active-content admission", () => {
  it("refuses a document whose only action opens a remote address", async () => {
    await withFixture({ remoteLinkAction: true }, async (dir, path, inspection) => {
      expect(inspection.activeContent).toContain("/URI@catalog");
      expect(admissionSets(inspection)).toEqual({
        compress: false,
        assemble: false,
        ocr: false,
        fill: false
      });
      await expectRefused(dir, path);
    });
  });

  it("admits a document whose only action is internal navigation", () => {
    const withOpenAction = classifyQpdfJson(
      jsonDocument({
        trailer: { value: { "/Root": "1 0 R" } },
        "obj:1 0 R": {
          value: { "/Type": "/Catalog", "/Pages": "2 0 R", "/OpenAction": "9 0 R" }
        },
        "obj:2 0 R": { value: { "/Type": "/Pages", "/Kids": ["3 0 R"], "/Count": 1 } },
        "obj:3 0 R": { value: { "/Type": "/Page", "/Parent": "2 0 R" } },
        "obj:9 0 R": { value: { "/S": "/GoTo", "/D": ["3 0 R", "/Fit"] } }
      })
    );
    expect(withOpenAction.activeContent).toEqual([]);
    expect(isAdmissibleFor(withOpenAction, "fill")).toBe(true);
    expect(isAdmissibleFor(withOpenAction, "assemble")).toBe(true);
  });

  it("follows a widget action chain to a launch action and refuses it", async () => {
    await withFixture(
      { formTextField: true, widgetChainedLaunch: true },
      async (dir, path, inspection) => {
        expect(inspection.activeContent).toContain("/Launch@field");
        expect(admissionSets(inspection)).toEqual({
          compress: false,
          assemble: false,
          ocr: false,
          fill: false
        });
        await expectRefused(dir, path);
      }
    );
  });

  it("follows a catalog open-action chain to a launch action and refuses it", async () => {
    await withFixture({ chainedLaunchAction: true }, async (dir, path, inspection) => {
      expect(inspection.activeContent).toContain("/Launch@catalog");
      expect(admissionSets(inspection)).toEqual({
        compress: false,
        assemble: false,
        ocr: false,
        fill: false
      });
      await expectRefused(dir, path);
    });
  });

  it("scopes an action shared by a widget and the catalog open action as catalog", async () => {
    await withFixture(
      { formTextField: true, sharedCatalogAction: true },
      async (dir, path, inspection) => {
        expect(inspection.activeContent).toContain("/URI@catalog");
        expect(inspection.activeContent).not.toContain("/URI@field");
        expect(admissionSets(inspection)).toEqual({
          compress: false,
          assemble: false,
          ocr: false,
          fill: false
        });
        await expectRefused(dir, path);
      }
    );
  });

  it("scopes a non-terminal parent field action as field-bound", async () => {
    await withFixture({ nonTerminalFieldAction: true }, async (dir, path, inspection) => {
      expect(inspection.activeContent).toContain("/JavaScript@field");
      expect(admissionSets(inspection)).toEqual({
        compress: false,
        assemble: false,
        ocr: false,
        fill: true
      });
      await expectRefused(dir, path);
    });
  });

  it("scopes an action on the form dictionary itself as catalog", async () => {
    await withFixture(
      { formTextField: true, formDictAction: true },
      async (dir, path, inspection) => {
        expect(inspection.activeContent).toContain("/JavaScript@catalog");
        expect(admissionSets(inspection)).toEqual({
          compress: false,
          assemble: false,
          ocr: false,
          fill: false
        });
        await expectRefused(dir, path);
      }
    );
  });

  it("keeps a widget action reached through the page annotation array field-bound", async () => {
    await withFixture(
      { formTextField: true, widgetFieldAction: true },
      async (dir, path, inspection) => {
        expect(inspection.activeContent).toContain("/JavaScript@field");
        expect(admissionSets(inspection)).toEqual({
          compress: false,
          assemble: false,
          ocr: false,
          fill: true
        });
        await expectRefused(dir, path);
      }
    );
  });

  it("terminates a cyclic action chain within the budget and refuses", async () => {
    await withFixture({ cyclicActions: true }, async (dir, path, inspection) => {
      expect(inspection.activeContent).toContain("/Launch@catalog");
      expect(admissionSets(inspection)).toEqual({
        compress: false,
        assemble: false,
        ocr: false,
        fill: false
      });
      await expectRefused(dir, path);
    });
  });

  it.each([
    "/GoToR",
    "/GoToE",
    "/GoToDp",
    "/Launch",
    "/Thread",
    "/URI",
    "/Sound",
    "/Movie",
    "/Hide",
    "/Named",
    "/SetOCGState",
    "/Rendition",
    "/Trans",
    "/GoTo3DView",
    "/JavaScript",
    "/SubmitForm",
    "/ResetForm",
    "/ImportData"
  ])("reports action subtype %s as active content", (subtype) => {
    const result = classifyQpdfJson(
      jsonDocument({
        trailer: { value: { "/Root": "1 0 R" } },
        "obj:1 0 R": {
          value: { "/Type": "/Catalog", "/Pages": "2 0 R", "/OpenAction": "9 0 R" }
        },
        "obj:2 0 R": { value: { "/Type": "/Pages", "/Kids": ["3 0 R"], "/Count": 1 } },
        "obj:3 0 R": { value: { "/Type": "/Page", "/Parent": "2 0 R" } },
        "obj:9 0 R": { value: { "/S": subtype } }
      })
    );
    expect(result.activeContent).toContain(`${subtype}@catalog`);
  });

  it("fails closed when the form section lacks annotation references", () => {
    expect(() =>
      classifyQpdfJson(
        jsonDocument(objectMap(), {
          acroform: { hasacroform: true, fields: [{ object: "not-a-ref" }] }
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INSPECTION_INCOMPLETE" }) as Error);
  });

  it("fails closed when a field reference is missing from the object map", () => {
    expect(() =>
      classifyQpdfJson(
        jsonDocument(objectMap(), {
          acroform: {
            hasacroform: true,
            fields: [{ object: "40 0 R", annotation: { object: "41 0 R" } }]
          }
        })
      )
    ).toThrowError(expect.objectContaining({ code: "INSPECTION_INCOMPLETE" }) as Error);
  });

  it("fails closed on a missing catalog or an unsupported JSON version", () => {
    expect(() => classifyQpdfJson(jsonDocument({}))).toThrowError(
      expect.objectContaining({ code: "INSPECTION_INCOMPLETE" }) as Error
    );
    const wrongVersion = jsonDocument(objectMap());
    wrongVersion.qpdf = [{ pdfversion: "1.7", jsonversion: 1 }, objectMap()];
    expect(() => classifyQpdfJson(wrongVersion)).toThrowError(
      expect.objectContaining({ code: "INSPECTION_INCOMPLETE" }) as Error
    );
  });

  it("classifies a 2000-field document within the node budget", () => {
    const objects = objectMap();
    const fields: unknown[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const widget = 100 + index * 2;
      const field = widget + 1;
      objects[`obj:${widget} 0 R`] = {
        value: {
          "/Type": "/Annot",
          "/Subtype": "/Widget",
          "/Parent": `${field} 0 R`,
          "/Rect": [0, 0, 10, 10]
        }
      };
      objects[`obj:${field} 0 R`] = {
        value: { "/FT": "/Tx", "/T": `u:f${index}`, "/Kids": [`${widget} 0 R`] }
      };
      fields.push({
        object: `${widget} 0 R`,
        annotation: { object: `${widget} 0 R` },
        parent: `${field} 0 R`
      });
    }
    const result = classifyQpdfJson(
      jsonDocument(objects, { acroform: { hasacroform: true, fields } })
    );
    expect(result.activeContent).toEqual([]);
    expect(result.compatWarnings).toContain("forms");
  });
});

describe("signature and XFA classification", () => {
  const SIG_DICT = {
    "/Type": "/Sig",
    "/Filter": "/Adobe.PPKLite",
    "/ByteRange": [0, 100, 200, 300],
    "/Contents": "h:00"
  };

  function formDocument(
    form: Record<string, unknown>,
    catalogExtra: Record<string, unknown> = {},
    extraObjects: Record<string, unknown> = {},
    acroform: Record<string, unknown> = { hasacroform: true, fields: [] }
  ) {
    return jsonDocument(
      objectMap({
        "obj:1 0 R": {
          value: { "/Type": "/Catalog", "/Pages": "2 0 R", "/AcroForm": "4 0 R", ...catalogExtra }
        },
        "obj:4 0 R": { value: form },
        ...extraObjects
      }),
      { acroform }
    );
  }

  it("does not treat an empty signature widget as signed (R16)", () => {
    const result = classifyQpdfJson(
      formDocument({ "/Fields": ["5 0 R"] }, {}, {
        "obj:5 0 R": { value: { "/FT": "/Sig", "/T": "u:sig", "/Kids": ["6 0 R"] } },
        "obj:6 0 R": { value: { "/Type": "/Annot", "/Subtype": "/Widget", "/Parent": "5 0 R" } }
      })
    );
    expect(result.signed).toBe(false);
    expect(isAdmissibleFor({ encrypted: false, ...result }, "fill")).toBe(true);
  });

  it("blocks a signature field holding a value", () => {
    const result = classifyQpdfJson(
      formDocument({ "/Fields": ["5 0 R"] }, {}, {
        "obj:5 0 R": { value: { "/FT": "/Sig", "/T": "u:sig", "/V": "7 0 R" } },
        "obj:7 0 R": { value: SIG_DICT }
      })
    );
    expect(result.signed).toBe(true);
  });

  it("does not block on a usage-rights signature but reports it", () => {
    const result = classifyQpdfJson(
      formDocument({}, { "/Perms": { "/UR3": "8 0 R" } }, {
        "obj:8 0 R": {
          value: { ...SIG_DICT, "/Reference": [{ "/TransformMethod": "/UR3" }] }
        }
      })
    );
    expect(result.signed).toBe(false);
    expect(result.usageRights).toBe(true);
    expect(isAdmissibleFor({ encrypted: false, ...result }, "fill")).toBe(true);
  });

  it("blocks a document-modification permission signature", () => {
    const result = classifyQpdfJson(
      formDocument({}, { "/Perms": { "/DocMDP": "8 0 R" } }, {
        "obj:8 0 R": {
          value: { ...SIG_DICT, "/Reference": [{ "/TransformMethod": "/DocMDP" }] }
        }
      })
    );
    expect(result.signed).toBe(true);
    expect(result.usageRights).toBe(false);
  });

  it("detects XFA on the form dictionary and needs-rendering on the form section", () => {
    const xfa = classifyQpdfJson(
      formDocument({ "/XFA": ["u:preamble", "7 0 R"] }, {}, {
        "obj:7 0 R": { stream: { dict: { "/Length": 5 } } }
      })
    );
    expect(xfa.xfa).toBe(true);

    const needs = classifyQpdfJson(
      formDocument({ "/Fields": [] }, {}, {}, { hasacroform: true, needappearances: true, fields: [] })
    );
    expect(needs.needsRendering).toBe(true);
    expect(needs.xfa).toBe(false);
  });

  it("makes encrypted, signed and XFA documents inadmissible for every operation", () => {
    const base = { encrypted: false, ...classifyQpdfJson(jsonDocument(objectMap())) };
    for (const flagged of [
      { ...base, encrypted: true },
      { ...base, signed: true },
      { ...base, xfa: true }
    ]) {
      for (const operation of OPERATIONS) {
        expect(isAdmissibleFor(flagged, operation)).toBe(false);
      }
    }
  });
});
