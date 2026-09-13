import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PageManifestError } from "../src/page-manifest.js";
import { SchemaError } from "../src/schema-error.js";
import {
  FORM_PLAN_ENTRY_STATUSES,
  MAX_SIGNATURE_POINTS,
  MAX_TEXT_VALUE_LENGTH,
  FormPlanError,
  isTerminalEntryStatus,
  parseFormPlan,
  serializeFormPlan,
  type FormPlan
} from "../src/form-plan.js";

const basePlan = {
  version: 1,
  source: "forms/scan.pdf",
  destination: "out/filled.pdf",
  overwrite: false,
  burnIn: true,
  nonce: "abc123",
  entries: []
};

const fullPlan = parseFormPlan({
  ...basePlan,
  entries: [
    { kind: "field", fieldId: "12 0 R", status: "answered", value: "Lennart" },
    { kind: "field", fieldId: "13 0 R", status: "proposed", value: "Hamburg" },
    { kind: "field", fieldId: "14 0 R", status: "skipped" },
    { kind: "field", fieldId: "15 0 R", status: "unknown" },
    { kind: "text", source: "forms/scan.pdf", page: 2, rect: { x: 10, y: 20, width: 100, height: 12 }, text: "a note" },
    { kind: "checkmark", source: "forms/scan.pdf", page: 3, rect: { x: 5, y: 5, width: 8, height: 8 } },
    {
      kind: "signature",
      source: "forms/scan.pdf",
      page: 4,
      rect: { x: 50, y: 60, width: 120, height: 40 },
      strokes: [
        [50, 60, 80, 90],
        [100, 70, 110, 75]
      ]
    }
  ]
});

describe("form-plan contract", () => {
  it("parses every entry kind into an immutable plan", () => {
    expect(fullPlan.entries).toHaveLength(7);
    expect(fullPlan.entries[0]).toEqual({ kind: "field", fieldId: "12 0 R", status: "answered", value: "Lennart" });
    expect(fullPlan.entries[6]).toMatchObject({ kind: "signature" });
    expect(Object.isFrozen(fullPlan)).toBe(true);
    expect(Object.isFrozen(fullPlan.entries)).toBe(true);
    expect(FORM_PLAN_ENTRY_STATUSES).toEqual(["unknown", "proposed", "answered", "skipped"]);
    expect(isTerminalEntryStatus("answered")).toBe(true);
    expect(isTerminalEntryStatus("skipped")).toBe(true);
    expect(isTerminalEntryStatus("proposed")).toBe(false);
    expect(isTerminalEntryStatus("unknown")).toBe(false);
  });

  it("serialises to canonical bytes that round-trip stably", () => {
    const minimal = parseFormPlan(basePlan);
    expect(serializeFormPlan(minimal)).toBe(
      '{"version":1,"source":"forms/scan.pdf","destination":"out/filled.pdf","overwrite":false,"burnIn":true,"nonce":"abc123","entries":[]}'
    );
    const bytes = serializeFormPlan(fullPlan);
    const reparsed: FormPlan = parseFormPlan(JSON.parse(bytes));
    expect(reparsed).toEqual(fullPlan);
    expect(serializeFormPlan(reparsed)).toBe(bytes);
    expect(serializeFormPlan(parseFormPlan(JSON.parse(serializeFormPlan(reparsed))))).toBe(bytes);
  });

  it("rejects an unknown key and a wrong version", () => {
    expect(() => parseFormPlan({ ...basePlan, comment: "x" })).toThrow(
      expect.objectContaining({ code: "PLAN_INVALID" })
    );
    expect(() => parseFormPlan({ ...basePlan, version: 2 })).toThrow(FormPlanError);
    expect(() => parseFormPlan("not a plan")).toThrow(FormPlanError);
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [{ kind: "field", fieldId: "12 0 R", status: "skipped", note: "x" }]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID" }));
    expect(() => parseFormPlan({ ...basePlan, entries: [{ kind: "stamp" }] })).toThrow(
      expect.objectContaining({ code: "PLAN_INVALID" })
    );
  });

  it("rejects excess depth", () => {
    let caught: unknown;
    try {
      parseFormPlan({ ...basePlan, entries: [[[[["too deep"]]]]] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FormPlanError);
    expect(caught).toMatchObject({ code: "PLAN_INVALID" });
    expect((caught as FormPlanError).message).toContain("depth");
  });

  it("rejects an over-long value and control characters in carried strings", () => {
    const longValue = "x".repeat(MAX_TEXT_VALUE_LENGTH + 1);
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [{ kind: "field", fieldId: "12 0 R", status: "answered", value: longValue }]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_VALUE" }));
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [{ kind: "field", fieldId: "12 0 R", status: "answered", value: "a\nb" }]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_VALUE" }));
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [
          { kind: "text", source: "s", page: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, text: longValue }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_TEXT" }));
    expect(() => parseFormPlan({ ...basePlan, destination: "out\u0000bad.pdf" })).toThrow(
      expect.objectContaining({ code: "PLAN_INVALID_DESTINATION" })
    );
    expect(() => parseFormPlan({ ...basePlan, destination: "x".repeat(5000) })).toThrow(
      expect.objectContaining({ code: "PLAN_INVALID_DESTINATION" })
    );
    expect(() => parseFormPlan({ ...basePlan, nonce: "has space" })).toThrow(
      expect.objectContaining({ code: "PLAN_INVALID_NONCE" })
    );
  });

  it("enforces the value/status invariant of KTD8", () => {
    expect(() =>
      parseFormPlan({ ...basePlan, entries: [{ kind: "field", fieldId: "12 0 R", status: "answered" }] })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_VALUE" }));
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [{ kind: "field", fieldId: "12 0 R", status: "skipped", value: "x" }]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_VALUE" }));
    expect(() =>
      parseFormPlan({ ...basePlan, entries: [{ kind: "field", fieldId: "12 0 R", status: "draft" }] })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_STATUS" }));
    expect(() =>
      parseFormPlan({ ...basePlan, entries: [{ kind: "field", fieldId: "Surname", status: "skipped" }] })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_FIELD_ID" }));
    const cleared = parseFormPlan({
      ...basePlan,
      entries: [{ kind: "field", fieldId: "12 0 R", status: "answered", value: "" }]
    });
    expect(cleared.entries[0]).toMatchObject({ status: "answered", value: "" });
  });

  it("rejects malformed placements and enforces the placement and stroke limits", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(() =>
      parseFormPlan({ ...basePlan, entries: [{ kind: "text", source: "s", page: 0, rect, text: "t" }] })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_PAGE" }));
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [{ kind: "text", source: "s", page: 1, rect: { x: 0, y: 0, width: 0, height: 10 }, text: "t" }]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_RECT" }));
    expect(() =>
      parseFormPlan({ ...basePlan, entries: [{ kind: "signature", source: "s", page: 1, rect, strokes: [[1, 2, 3]] }] })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID_STROKES" }));
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [
          { kind: "signature", source: "s", page: 1, rect, strokes: [new Array(2 * (MAX_SIGNATURE_POINTS + 1)).fill(0)] }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_LIMIT_EXCEEDED" }));
    const manyPlacements = new Array(201).fill({ kind: "checkmark", source: "s", page: 1, rect });
    expect(() => parseFormPlan({ ...basePlan, entries: manyPlacements })).toThrow(
      expect.objectContaining({ code: "PLAN_LIMIT_EXCEEDED" })
    );
  });

  it("rejects duplicate field entries", () => {
    expect(() =>
      parseFormPlan({
        ...basePlan,
        entries: [
          { kind: "field", fieldId: "12 0 R", status: "skipped" },
          { kind: "field", fieldId: "12 0 R", status: "answered", value: "x" }
        ]
      })
    ).toThrow(expect.objectContaining({ code: "PLAN_INVALID" }));
  });
});

describe("schema-error base", () => {
  it("carries the code on every schema error", () => {
    const planError = new FormPlanError("PLAN_INVALID_NONCE", "bad nonce");
    expect(planError).toBeInstanceOf(SchemaError);
    expect(planError.code).toBe("PLAN_INVALID_NONCE");
    const manifestError = new PageManifestError("MANIFEST_INVALID_ROTATION", "Invalid rotation 45.");
    expect(manifestError).toBeInstanceOf(SchemaError);
    expect(manifestError).toBeInstanceOf(PageManifestError);
    expect(manifestError.code).toBe("MANIFEST_INVALID_ROTATION");
    expect(manifestError.name).toBe("PageManifestError");
  });
});

describe("browser-safe boundary", () => {
  it("resolves no Node import in any browser-safe schema module", () => {
    const specifierPattern =
      /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
    for (const file of [
      "packages/core/src/schema-error.ts",
      "packages/core/src/page-manifest.ts",
      "packages/core/src/form-plan.ts",
      "packages/core/src/form-inventory.ts",
      "packages/core/src/ocr-contract.ts",
      "packages/core/src/pdfjs-version.ts"
    ]) {
      const source = readFileSync(file, "utf8");
      const specifiers = [...source.matchAll(specifierPattern)].flatMap((match) =>
        match.slice(1).filter((part): part is string => part !== undefined)
      );
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith("./") || specifier.startsWith("../"),
          `${file} must import only relative paths, found "${specifier}"`
        ).toBe(true);
      }
    }
  });
});
