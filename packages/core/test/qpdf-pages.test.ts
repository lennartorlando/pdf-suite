import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compressPdf } from "../src/compress.js";
import { ocrPdf } from "../src/ocr.js";
import { assemblePages } from "../src/pages.js";
import {
  classifyQpdfJson,
  inspectPdfSource,
  isAdmissibleFor,
  planFieldActionRemoval,
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

async function expectRefused(dir: string, path: string, code = "INPUT_HAS_ACTIVE_CONTENT"): Promise<void> {
  await expect(
    assemblePages({
      sources: [{ id: "a", path }],
      manifest: createManifest([{ sourceId: "a", page: 1 }]),
      destinationPath: join(dir, "assembled.pdf")
    })
  ).rejects.toMatchObject({ code });
  await expect(
    ocrPdf({ inputPath: path, outputPath: join(dir, "ocred.pdf"), languages: ["eng"] })
  ).rejects.toMatchObject({ code });
  let engineRan = false;
  await expect(
    compressPdf({
      inputPath: path,
      outputPath: join(dir, "compressed.pdf"),
      profile: "conservative",
      engines: [
        {
          name: "must-not-run",
          supports: () => true,
          compress: async (_input, output) => {
            engineRan = true;
            await writeFile(output, "x");
            return { engine: "must-not-run", warnings: [] };
          }
        }
      ]
    })
  ).rejects.toMatchObject({ code });
  expect(engineRan).toBe(false);
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

  it("refuses signed and XFA input for compress, assembly and OCR alike", async () => {
    await withFixture({ docMdpSignature: true }, async (dir, path) => {
      await expectRefused(dir, path, "INPUT_SIGNED");
    });
    await withFixture({ xfaDynamic: true }, async (dir, path) => {
      await expectRefused(dir, path, "INPUT_XFA");
    });
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

describe("tagged structure elements", () => {
  // PDF 32000 §14.7.2: on a structure element /A names attribute objects —
  // a dict, a reference, or an array of those interleaved with revision
  // numbers — not an action. Tagged documents like accessible SEPA forms
  // carry dozens of them and must not be refused.
  function taggedDocument(
    structTree: Record<string, unknown>,
    extraObjects: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {}
  ) {
    return jsonDocument(
      objectMap({
        "obj:1 0 R": {
          value: {
            "/Type": "/Catalog",
            "/Pages": "2 0 R",
            "/MarkInfo": { "/Marked": true },
            "/StructTreeRoot": "10 0 R"
          }
        },
        "obj:10 0 R": { value: structTree },
        ...extraObjects
      }),
      overrides
    );
  }

  it("admits structure attribute objects in dict, reference and array form", () => {
    const result = classifyQpdfJson(
      taggedDocument(
        { "/Type": "/StructTreeRoot", "/K": ["11 0 R"], "/ParentTree": { "/Nums": [] } },
        {
          "obj:11 0 R": {
            value: {
              "/Type": "/StructElem",
              "/S": "/Table",
              "/P": "10 0 R",
              "/K": ["12 0 R", "15 0 R"],
              "/A": "13 0 R"
            }
          },
          "obj:12 0 R": {
            value: {
              "/Type": "/StructElem",
              "/S": "/TD",
              "/P": "11 0 R",
              "/K": [0],
              "/A": ["14 0 R", 0, { "/O": "/Table", "/ColSpan": 8 }]
            }
          },
          "obj:13 0 R": {
            value: { "/O": "/Layout", "/BBox": [0, 0, 300, 60], "/Placement": "/Block" }
          },
          "obj:14 0 R": { value: { "/O": "/Table", "/ColSpan": 8, "/RowSpan": 2 } },
          "obj:15 0 R": {
            value: {
              "/S": "/P",
              "/P": "11 0 R",
              "/K": [1],
              "/A": { "/O": "/Layout", "/SpaceBefore": 4 }
            }
          }
        }
      )
    );
    expect(result.activeContent).toEqual([]);
    expect(result.compatWarnings).toContain("tags");
  });

  it("still refuses a link annotation action inside a tagged document", () => {
    const result = classifyQpdfJson(
      taggedDocument(
        { "/Type": "/StructTreeRoot", "/K": ["11 0 R"] },
        {
          "obj:3 0 R": {
            value: { "/Type": "/Page", "/Parent": "2 0 R", "/Annots": ["20 0 R"] }
          },
          "obj:11 0 R": {
            value: { "/Type": "/StructElem", "/S": "/P", "/P": "10 0 R", "/K": [0], "/A": "13 0 R" }
          },
          "obj:13 0 R": { value: { "/O": "/Layout" } },
          "obj:20 0 R": {
            value: {
              "/Type": "/Annot",
              "/Subtype": "/Link",
              "/Rect": [0, 0, 10, 10],
              "/A": { "/S": "/JavaScript", "/JS": "u:app.alert(1)" }
            }
          }
        }
      )
    );
    expect(result.activeContent).toContain("/JavaScript@catalog");
    expect(isAdmissibleFor(result, "fill")).toBe(false);
  });

  it("still flags a recognized action subtype inside a structure attribute object", () => {
    const result = classifyQpdfJson(
      taggedDocument(
        { "/Type": "/StructTreeRoot", "/K": ["11 0 R"] },
        {
          "obj:11 0 R": {
            value: {
              "/Type": "/StructElem",
              "/S": "/TD",
              "/P": "10 0 R",
              "/K": [0],
              "/A": { "/O": "/Table", "/S": "/JavaScript", "/JS": "u:fixture()" }
            }
          }
        }
      )
    );
    expect(result.activeContent).toContain("/JavaScript@catalog");
    expect(isAdmissibleFor(result, "fill")).toBe(false);
  });

  it("keeps a widget action reached through a structure-tree OBJR field-bound", () => {
    const result = classifyQpdfJson(
      taggedDocument(
        { "/Type": "/StructTreeRoot", "/K": ["11 0 R"] },
        {
          "obj:3 0 R": {
            value: { "/Type": "/Page", "/Parent": "2 0 R", "/Annots": ["6 0 R"] }
          },
          "obj:5 0 R": { value: { "/FT": "/Tx", "/T": "u:name", "/Kids": ["6 0 R"] } },
          "obj:6 0 R": {
            value: {
              "/Type": "/Annot",
              "/Subtype": "/Widget",
              "/Parent": "5 0 R",
              "/Rect": [100, 100, 200, 120],
              "/AA": "7 0 R"
            }
          },
          "obj:7 0 R": { value: { "/F": "9 0 R" } },
          "obj:9 0 R": { value: { "/S": "/JavaScript", "/JS": "u:fixture()" } },
          "obj:11 0 R": {
            value: { "/Type": "/StructElem", "/S": "/Form", "/P": "10 0 R", "/K": ["12 0 R"] }
          },
          "obj:12 0 R": { value: { "/Type": "/OBJR", "/Obj": "6 0 R", "/Pg": "3 0 R" } }
        },
        {
          acroform: {
            hasacroform: true,
            fields: [{ object: "6 0 R", annotation: { object: "6 0 R" }, parent: "5 0 R" }]
          }
        }
      )
    );
    expect(result.activeContent).toEqual(["/JavaScript@field"]);
    expect(isAdmissibleFor(result, "fill")).toBe(true);
    expect(isAdmissibleFor(result, "compress")).toBe(false);
  });

  it("still walks a non-widget annotation reached through an OBJR", () => {
    const result = classifyQpdfJson(
      taggedDocument(
        { "/Type": "/StructTreeRoot", "/K": ["11 0 R"] },
        {
          "obj:11 0 R": {
            value: { "/Type": "/StructElem", "/S": "/P", "/P": "10 0 R", "/K": ["12 0 R"] }
          },
          "obj:12 0 R": { value: { "/Type": "/OBJR", "/Obj": "20 0 R", "/Pg": "3 0 R" } },
          "obj:20 0 R": {
            value: {
              "/Type": "/Annot",
              "/Subtype": "/Link",
              "/Rect": [0, 0, 10, 10],
              "/A": { "/S": "/JavaScript", "/JS": "u:app.alert(1)" }
            }
          }
        }
      )
    );
    expect(result.activeContent).toContain("/JavaScript@catalog");
    expect(isAdmissibleFor(result, "fill")).toBe(false);
  });

  it("refuses an attribute-shaped dictionary that carries an action subtype outside the structure tree", () => {
    const result = classifyQpdfJson(
      jsonDocument(
        objectMap({
          "obj:1 0 R": {
            value: { "/Type": "/Catalog", "/Pages": "2 0 R", "/OpenAction": "9 0 R" }
          },
          "obj:9 0 R": { value: { "/O": "/Table", "/S": "/JavaScript", "/JS": "u:fixture()" } }
        })
      )
    );
    expect(result.activeContent).toContain("/JavaScript@catalog");
    expect(isAdmissibleFor(result, "fill")).toBe(false);
  });
});

describe("field-action removal", () => {
  it("strips only classified action edges and keeps appearance resources named like action keys", () => {
    // A widget appearance dictionary may legitimately hold keys spelled like
    // action edges (/A is an appearance-state name here). Cleanup must remove
    // the widget's real /AA action chain, never that dictionary's data.
    const raw = jsonDocument(
      objectMap({
        "obj:1 0 R": {
          value: { "/Type": "/Catalog", "/Pages": "2 0 R", "/AcroForm": "4 0 R" }
        },
        "obj:4 0 R": { value: { "/Fields": ["5 0 R"] } },
        "obj:5 0 R": {
          value: { "/FT": "/Tx", "/T": "u:name", "/Kids": ["6 0 R"] }
        },
        "obj:6 0 R": {
          value: {
            "/Type": "/Annot",
            "/Subtype": "/Widget",
            "/Parent": "5 0 R",
            "/AA": "7 0 R",
            "/AP": { "/N": "8 0 R" }
          }
        },
        "obj:7 0 R": { value: { "/O": "9 0 R" } },
        "obj:9 0 R": { value: { "/S": "/JavaScript", "/JS": "u:app.alert(1)" } },
        "obj:8 0 R": { value: { "/A": "10 0 R", "/Off": "11 0 R" } },
        "obj:10 0 R": { stream: { dict: { "/Subtype": "/Form", "/BBox": [0, 0, 10, 10] } } },
        "obj:11 0 R": { stream: { dict: { "/Subtype": "/Form", "/BBox": [0, 0, 10, 10] } } }
      }),
      {
        acroform: {
          hasacroform: true,
          fields: [{ object: "6 0 R", annotation: { object: "6 0 R" }, parent: "5 0 R" }]
        }
      }
    );
    const update = planFieldActionRemoval(raw);
    // Only the widget is rewritten; the appearance dictionary, its XObjects
    // and the orphaned action chain are all left alone (qpdf drops what the
    // removed /AA edge leaves unreachable).
    expect(Object.keys(update.objects)).toEqual(["obj:6 0 R"]);
    const widget = update.objects["obj:6 0 R"]?.value as Record<string, unknown>;
    expect(widget["/AA"]).toBeUndefined();
    expect(widget["/AP"]).toEqual({ "/N": "8 0 R" });
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
