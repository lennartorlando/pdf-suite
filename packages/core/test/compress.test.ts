import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CompressionError,
  compressPdf,
  type CompressionEngine,
  type NativeRunner
} from "../src/index.js";
import { fillForm, inventoryFormFields } from "../src/forms.js";
import { parseFormPlan, serializeFormPlan } from "../src/form-plan.js";
import { buildTestPdf } from "./pdf-fixtures.js";

const fixture = (name: string) => join(process.cwd(), "tests", "fixtures", name);

function mockEngine(writeBytes: Buffer, engine = "mock"): CompressionEngine {
  return {
    name: engine,
    supports: () => true,
    async compress(_inputPath, outputPath) {
      await writeFile(outputPath, writeBytes);
      return { engine, warnings: [] };
    }
  };
}

describe("compressPdf", () => {
  it("returns byte summary and reduction metadata for a smaller output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");

    try {
      const summary = await compressPdf({
        inputPath: fixture("minimal.pdf"),
        outputPath,
        profile: "conservative",
        engines: [mockEngine(Buffer.from("%PDF-1.4\n%%EOF\n"))]
      });

      expect(summary.status).toBe("success");
      expect(summary.outputSmaller).toBe(true);
      expect(summary.originalBytes).toBeGreaterThan(summary.outputBytes);
      expect(summary.reductionPercent).toBeGreaterThan(0);
      expect(summary.engine).toBe("mock");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports no_gain when compression output is larger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");
    const input = await readFile(fixture("minimal.pdf"));

    try {
      const summary = await compressPdf({
        inputPath: fixture("minimal.pdf"),
        outputPath,
        profile: "balanced",
        engines: [mockEngine(Buffer.concat([input, Buffer.alloc(100)]))]
      });

      expect(summary.status).toBe("no_gain");
      expect(summary.outputSmaller).toBe(false);
      expect(summary.reductionBytes).toBeLessThanOrEqual(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects encrypted PDFs without creating output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");

    try {
      await expect(compressPdf({
        inputPath: fixture("encrypted-marker.pdf"),
        outputPath,
        profile: "conservative",
        engines: [mockEngine(Buffer.from("unused"))]
      })).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
    } finally {
      await expect(stat(outputPath)).rejects.toBeTruthy();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-PDF input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));

    try {
      await expect(compressPdf({
        inputPath: fixture("not-a-pdf.txt"),
        outputPath: join(dir, "out.pdf"),
        profile: "conservative",
        engines: [mockEngine(Buffer.from("unused"))]
      })).rejects.toMatchObject({ code: "INPUT_NOT_PDF" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not allow overwriting the input path", async () => {
    await expect(compressPdf({
      inputPath: fixture("minimal.pdf"),
      outputPath: fixture("minimal.pdf"),
      profile: "conservative",
      engines: [mockEngine(Buffer.from("unused"))]
    })).rejects.toMatchObject({ code: "OUTPUT_WOULD_OVERWRITE_INPUT" });
  });

  it("cleans partial output on cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");
    const controller = new AbortController();
    const cancellingEngine: CompressionEngine = {
      name: "cancelling",
      supports: () => true,
      async compress(_inputPath, candidatePath) {
        await writeFile(candidatePath, Buffer.from("%PDF-1.4\n%%EOF\n"));
        await writeFile(outputPath, Buffer.from("partial"));
        controller.abort();
        throw new CompressionError("JOB_CANCELLED", "Compression job was cancelled.");
      }
    };

    try {
      await expect(compressPdf({
        inputPath: fixture("minimal.pdf"),
        outputPath,
        profile: "conservative",
        signal: controller.signal,
        engines: [cancellingEngine]
      })).rejects.toMatchObject({ code: "JOB_CANCELLED" });
      await expect(stat(outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("compressPdf form admission (U12)", () => {
  function flaggedEngine(flag: { ran: boolean }): CompressionEngine {
    return {
      name: "mock",
      supports: () => true,
      async compress(_inputPath, candidatePath) {
        flag.ran = true;
        await writeFile(candidatePath, Buffer.from("%PDF-1.4\n%%EOF\n"));
        return { engine: "mock", warnings: [] };
      }
    };
  }

  it("refuses a document that carries form fields before any engine runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const formPath = join(dir, "form.pdf");
    const outputPath = join(dir, "out.pdf");
    const flag = { ran: false };

    try {
      await writeFile(formPath, buildTestPdf([{}], { formTextField: true }));
      await expect(compressPdf({
        inputPath: formPath,
        outputPath,
        profile: "conservative",
        engines: [flaggedEngine(flag)]
      })).rejects.toMatchObject({ code: "INPUT_HAS_FORM_FIELDS" });
      expect(flag.ran).toBe(false);
      await expect(stat(outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports itself unavailable when qpdf is missing rather than degrading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");
    const flag = { ran: false };
    const missingQpdf: NativeRunner = () =>
      Promise.reject(
        new CompressionError("ENGINE_UNAVAILABLE", "qpdf is not installed or not on PATH.", { command: "qpdf" })
      );

    try {
      await expect(compressPdf({
        inputPath: fixture("minimal.pdf"),
        outputPath,
        profile: "conservative",
        run: missingQpdf,
        engines: [flaggedEngine(flag)]
      })).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
      expect(flag.ran).toBe(false);
      await expect(stat(outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compresses an artifact the fill operation already burned in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const sourcePath = join(dir, "form.pdf");
    const filledPath = join(dir, "filled.pdf");
    const outputPath = join(dir, "out.pdf");

    try {
      await writeFile(sourcePath, buildTestPdf([{}], { formTextField: true }));
      const { inventory } = await inventoryFormFields(sourcePath);
      const planPath = join(dir, "plan.json");
      await writeFile(planPath, serializeFormPlan(parseFormPlan({
        version: 1,
        source: sourcePath,
        destination: filledPath,
        overwrite: false,
        burnIn: true,
        nonce: "burn-then-compress",
        entries: inventory.fields.map((field) => ({
          kind: "field" as const,
          fieldId: field.fieldId,
          status: "answered" as const,
          value: "burned"
        }))
      })));
      await fillForm({ sourcePath, planPath, destinationPath: filledPath });

      const input = await readFile(filledPath);
      const summary = await compressPdf({
        inputPath: filledPath,
        outputPath,
        profile: "conservative",
        engines: [mockEngine(input.subarray(0, input.length - 1))]
      });
      expect(summary.status).toBe("success");
      expect(summary.engine).toBe("mock");
      await expect(stat(outputPath)).resolves.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
