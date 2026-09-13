import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compressPdf } from "../src/compress.js";
import { ocrPdf } from "../src/ocr.js";
import { assemblePages } from "../src/pages.js";
import { createManifest } from "../src/page-manifest.js";
import {
  admitFillSource,
  inspectPdfSource,
  isAdmissibleFor,
  validatePdfArtifact
} from "../src/engines/qpdf-pages.js";
import { validatePdfFillInput, validatePdfInput } from "../src/validation.js";
import {
  encryptTestPdf,
  qpdfJson,
  writeTestPdf,
  type FixtureFeatures
} from "./pdf-fixtures.js";

async function makeDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-u9-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function writeFixture(dir: string, name: string, features: FixtureFeatures = {}): Promise<string> {
  return writeTestPdf(dir, name, [{ width: 612 }], features);
}

describe("fill-path input validation", () => {
  it("reports encryption instead of rejecting it while the shared validator stays closed", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "source.pdf", { formTextField: true });
      const encrypted = join(dir, "encrypted.pdf");
      await encryptTestPdf(source, encrypted, "", "owner");

      const result = await validatePdfFillInput(encrypted);
      expect(result.encrypted).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
      await expect(validatePdfInput(encrypted)).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
    } finally {
      await cleanup();
    }
  });

  it("keeps the non-encryption checks: missing file, not a PDF, output-is-input", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      await expect(validatePdfFillInput(join(dir, "missing.pdf"))).rejects.toMatchObject({
        code: "INPUT_NOT_FOUND"
      });
      const garbage = join(dir, "garbage.pdf");
      await writeFile(garbage, "not a pdf\n");
      await expect(validatePdfFillInput(garbage)).rejects.toMatchObject({ code: "INPUT_NOT_PDF" });
      const source = await writeFixture(dir, "plain.pdf");
      await expect(validatePdfFillInput(source, source)).rejects.toMatchObject({
        code: "OUTPUT_WOULD_OVERWRITE_INPUT"
      });
      expect((await validatePdfFillInput(source)).encrypted).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("fill admission", () => {
  it("admits a Reader-extended form: empty user password plus a usage-rights signature (AE8)", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "reader-extended.pdf", {
        formTextField: true,
        usageRights: true
      });
      const encrypted = join(dir, "encrypted.pdf");
      await encryptTestPdf(source, encrypted, "", "owner", [
        "--print=none",
        "--modify=none",
        "--extract=n"
      ]);

      const admission = await admitFillSource(encrypted, dir);
      expect(admission.inspection.encrypted).toBe(false);
      expect(admission.inspection.signed).toBe(false);
      expect(admission.inspection.usageRights).toBe(true);
      expect(admission.removedRestrictions).toBe(true);
      expect(admission.removedUsageRights).toBe(true);

      const { document } = await qpdfJson(admission.workingPath);
      expect(document.encrypt.encrypted).toBe(false);
      await expect(stat(source)).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("admits an owner-password-only document and reports that its restrictions are gone", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "restricted.pdf", { formTextField: true });
      const encrypted = join(dir, "restricted-enc.pdf");
      await encryptTestPdf(source, encrypted, "", "owner", ["--modify=none"]);

      const admission = await admitFillSource(encrypted, dir);
      expect(admission.removedRestrictions).toBe(true);
      expect(admission.removedUsageRights).toBe(false);
      expect(admission.inspection.encrypted).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("refuses a document needing a real password with the existing code, on every path", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "locked.pdf", { formTextField: true });
      const locked = join(dir, "locked-enc.pdf");
      await encryptTestPdf(source, locked, "userpass", "ownerpass");

      await expect(admitFillSource(locked, dir)).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
      await expect(validatePdfInput(locked)).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
      await expect(
        assemblePages({
          sources: [{ id: "s", path: locked }],
          manifest: createManifest([{ sourceId: "s", page: 1 }]),
          destinationPath: join(dir, "assembled.pdf")
        })
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
      await expect(
        ocrPdf({ inputPath: locked, outputPath: join(dir, "ocred.pdf"), languages: ["eng"] })
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
      await expect(
        compressPdf({ inputPath: locked, outputPath: join(dir, "compressed.pdf"), profile: "balanced" })
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
    } finally {
      await cleanup();
    }
  });

  it("keeps compression, page assembly and OCR refusing an empty-password document", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "open.pdf", { formTextField: true });
      const encrypted = join(dir, "open-enc.pdf");
      await encryptTestPdf(source, encrypted, "", "owner");

      await expect(
        assemblePages({
          sources: [{ id: "s", path: encrypted }],
          manifest: createManifest([{ sourceId: "s", page: 1 }]),
          destinationPath: join(dir, "assembled.pdf")
        })
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
      await expect(
        ocrPdf({ inputPath: encrypted, outputPath: join(dir, "ocred.pdf"), languages: ["eng"] })
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
      await expect(
        compressPdf({ inputPath: encrypted, outputPath: join(dir, "compressed.pdf"), profile: "balanced" })
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });

      // The same document is admitted on the fill path.
      const admission = await admitFillSource(encrypted, dir);
      expect(admission.inspection.encrypted).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("admits a usage-rights signature that is not a blocking signature", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "usage-rights.pdf", { usageRights: true });
      const admission = await admitFillSource(source, dir);
      expect(admission.inspection.signed).toBe(false);
      expect(admission.inspection.usageRights).toBe(true);
      expect(admission.removedUsageRights).toBe(true);
      expect(admission.removedRestrictions).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("admits an empty signature widget and refuses DocMDP and held field signatures everywhere", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const empty = await writeFixture(dir, "empty-sig.pdf", { emptySignatureField: true });
      expect((await inspectPdfSource(empty)).signed).toBe(false);
      await expect(admitFillSource(empty, dir)).resolves.toMatchObject({
        inspection: { signed: false }
      });

      for (const [name, features] of [
        ["docmdp.pdf", { docMdpSignature: true }],
        ["field-sig.pdf", { signatureField: true }]
      ] as const) {
        const source = await writeFixture(dir, name, features);
        expect((await inspectPdfSource(source)).signed).toBe(true);
        await expect(admitFillSource(source, dir), name).rejects.toMatchObject({
          code: "INPUT_SIGNED"
        });
        await expect(
          assemblePages({
            sources: [{ id: "s", path: source }],
            manifest: createManifest([{ sourceId: "s", page: 1 }]),
            destinationPath: join(dir, `${name}-assembled.pdf`)
          }),
          name
        ).rejects.toMatchObject({ code: "INPUT_SIGNED" });
        await expect(
          ocrPdf({ inputPath: source, outputPath: join(dir, `${name}-ocr.pdf`), languages: ["eng"] }),
          name
        ).rejects.toMatchObject({ code: "INPUT_SIGNED" });
      }
    } finally {
      await cleanup();
    }
  });

  it("refuses a partially signed document with one signed and several empty fields", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "partial.pdf", {
        formTextField: true,
        signatureField: true,
        emptySignatureField: true
      });
      expect((await inspectPdfSource(source)).signed).toBe(true);
      await expect(admitFillSource(source, dir)).rejects.toMatchObject({ code: "INPUT_SIGNED" });
    } finally {
      await cleanup();
    }
  });

  it.each([
    ["dynamic", { xfaDynamic: true }],
    ["static without a datasets stream", { xfaStatic: true }],
    ["static with a datasets stream", { xfaStaticWithDatasets: true }]
  ])("refuses %s XFA with a reason that names XFA (AE9)", async (_label, features) => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "xfa.pdf", features);
      const inspection = await inspectPdfSource(source);
      expect(inspection.xfa).toBe(true);
      expect(isAdmissibleFor(inspection, "fill")).toBe(false);
      await expect(admitFillSource(source, dir)).rejects.toMatchObject({
        code: "INPUT_XFA",
        message: expect.stringContaining("XFA") as unknown as string
      });
    } finally {
      await cleanup();
    }
  });

  it("detects a document whose field appearances need rendering", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "needs-rendering.pdf", {
        formTextField: true,
        needAppearances: true
      });
      expect((await inspectPdfSource(source)).needsRendering).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("fires the now-live encryption check when handed an encrypted candidate", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const source = await writeFixture(dir, "candidate.pdf");
      const encrypted = join(dir, "candidate-enc.pdf");
      await encryptTestPdf(source, encrypted, "", "owner");
      await expect(validatePdfArtifact(encrypted, 1)).rejects.toMatchObject({
        code: "OUTPUT_INVALID"
      });
    } finally {
      await cleanup();
    }
  });
});
