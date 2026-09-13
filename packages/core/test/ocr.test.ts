import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompressionError } from "../src/errors.js";
import {
  getOcrMyPdfVersion,
  getTesseractLanguages,
  getTesseractVersion,
  ocrMyPdfArgs
} from "../src/engines/ocrmypdf.js";
import { OCRMY_PDF_FEATURE_FLOOR } from "../src/native-floors.js";
import { ocrPdf } from "../src/ocr.js";
import type { NativeRunner, ProcessResult } from "../src/engines/qpdf-pages.js";
import { buildTestPdf } from "./pdf-fixtures.js";

function okResult(stdout = "", stderr = ""): ProcessResult {
  return { stdout, stderr, exitCode: 0 };
}

function inspectionJson(pageCount: number): string {
  return JSON.stringify({
    pages: Array.from({ length: pageCount }, (_, index) => ({ object: `${index + 3} 0 R` })),
    outlines: [],
    acroform: { hasacroform: false, fields: [] },
    attachments: {},
    encrypt: { encrypted: false },
    pagelabels: [],
    qpdf: [
      { pdfversion: "1.7", jsonversion: 2 },
      {
        trailer: { value: { "/Root": "1 0 R" } },
        "obj:1 0 R": { value: { "/Type": "/Catalog", "/Pages": "2 0 R" } },
        "obj:2 0 R": { value: { "/Type": "/Pages", "/Kids": ["3 0 R"], "/Count": pageCount } },
        "obj:3 0 R": { value: { "/Type": "/Page", "/Parent": "2 0 R", "/MediaBox": [0, 0, 612, 792] } }
      }
    ]
  });
}

describe("OCRmyPDF adapter", () => {
  it("builds the fixed safe OCR argument set", () => {
    expect(
      ocrMyPdfArgs("/private/input.pdf", "/private/output.pdf", {
        languages: ["deu", "eng"],
        autoRotate: true
      })
    ).toEqual([
      "--mode",
      "skip",
      "--output-type",
      "pdf",
      "--optimize",
      "0",
      "--language",
      "deu+eng",
      "--rotate-pages",
      "--",
      "/private/input.pdf",
      "/private/output.pdf"
    ]);
  });

  it("parses OCRmyPDF and Tesseract capabilities", async () => {
    const run: NativeRunner = async (command, args) => {
      if (command === "ocrmypdf" && args[0] === "--version") return okResult("17.11.0\n");
      if (command === "tesseract" && args[0] === "--version") {
        return okResult("tesseract 5.5.3\n leptonica-1.85.0\n");
      }
      if (command === "tesseract" && args[0] === "--list-langs") {
        return okResult("List of available languages in /private/tessdata (3):\ndeu\neng\nosd\n");
      }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };

    await expect(getOcrMyPdfVersion({ run })).resolves.toBe("17.11.0");
    await expect(getTesseractVersion({ run })).resolves.toBe("5.5.3");
    await expect(getTesseractLanguages({ run })).resolves.toEqual(["deu", "eng", "osd"]);
  });

  it("parses the OCRmyPDF version when the tool writes it to stderr", async () => {
    const run: NativeRunner = async () => okResult("", "17.11.0\n");

    await expect(getOcrMyPdfVersion({ run })).resolves.toBe("17.11.0");
  });

  it("rejects OCRmyPDF below the mode-skip feature floor", async () => {
    const run: NativeRunner = async () => okResult("16.12.0");
    await expect(getOcrMyPdfVersion({ run })).rejects.toMatchObject({
      code: "NATIVE_VERSION_UNSUPPORTED",
      details: { floor: OCRMY_PDF_FEATURE_FLOOR }
    });
  });

  it("maps missing tools without hiding the native error", async () => {
    const missing = new CompressionError("ENGINE_UNAVAILABLE", "missing");
    await expect(getOcrMyPdfVersion({ run: async () => { throw missing; } })).rejects.toBe(missing);
    await expect(getTesseractVersion({ run: async () => { throw missing; } })).rejects.toBe(missing);
  });
});

describe("ocrPdf", () => {
  async function setup(): Promise<{
    dir: string;
    inputPath: string;
    outputPath: string;
    pagesByPath: Map<string, number>;
  }> {
    const dir = await mkdtemp(join(tmpdir(), "pdf-ocr-unit-"));
    const inputPath = join(dir, "input.pdf");
    await writeFile(inputPath, buildTestPdf([{ label: "scan" }, { label: "text" }]));
    return {
      dir,
      inputPath,
      outputPath: join(dir, "output.pdf"),
      pagesByPath: new Map([[inputPath, 2]])
    };
  }

  function runner(
    pagesByPath: Map<string, number>,
    calls: Array<{ command: string; args: readonly string[]; cwd?: string; tempDir?: string }>,
    overrides: { languages?: string[]; outputPages?: number; ocrError?: CompressionError } = {}
  ): NativeRunner {
    return async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd, tempDir: options?.tempDir });
      if (command === "qpdf" && args[0] === "--version") return okResult("qpdf version 12.4.1");
      if (command === "qpdf" && args[0] === "--json") {
        const path = args[args.length - 1];
        const pages = pagesByPath.get(path);
        if (pages === undefined) throw new Error(`unknown PDF ${path}`);
        return okResult(inspectionJson(pages));
      }
      if (command === "qpdf" && args[0] === "--check") return okResult();
      if (command === "ocrmypdf" && args[0] === "--version") return okResult("17.11.0");
      if (command === "tesseract" && args[0] === "--version") return okResult("tesseract 5.5.3");
      if (command === "tesseract" && args[0] === "--list-langs") {
        return okResult(`List of available languages:\n${(overrides.languages ?? ["deu", "eng", "osd"]).join("\n")}`);
      }
      if (command === "ocrmypdf") {
        if (overrides.ocrError) throw overrides.ocrError;
        const input = args[args.length - 2];
        const output = args[args.length - 1];
        await writeFile(output, await readFile(input));
        pagesByPath.set(output, overrides.outputPages ?? pagesByPath.get(input) ?? 0);
        return okResult("", "OCR complete");
      }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
  }

  it("publishes a validated no-clobber OCR result from a private native workspace", async () => {
    const test = await setup();
    const calls: Array<{ command: string; args: readonly string[]; cwd?: string; tempDir?: string }> = [];
    try {
      const summary = await ocrPdf({
        inputPath: test.inputPath,
        outputPath: test.outputPath,
        languages: ["deu", "eng"],
        autoRotate: true,
        workspaceParent: test.dir,
        run: runner(test.pagesByPath, calls)
      });

      expect(summary).toMatchObject({
        status: "success",
        inputPath: test.inputPath,
        outputPath: test.outputPath,
        pageCount: 2,
        outputBytes: expect.any(Number),
        engine: "ocrmypdf",
        version: "17.11.0",
        qpdfVersion: "12.4.1",
        tesseractVersion: "5.5.3",
        languages: ["deu", "eng"],
        autoRotate: true,
        warnings: ["OCR complete"],
        compatWarnings: []
      });
      await expect(stat(test.outputPath)).resolves.toBeTruthy();
      const ocrCall = calls.find((call) => call.command === "ocrmypdf" && call.args[0] !== "--version");
      expect(ocrCall?.cwd).toBeTruthy();
      expect(ocrCall?.cwd?.startsWith(`${test.dir}/pdf-ocr-`)).toBe(true);
      expect(ocrCall?.tempDir).toBe(ocrCall?.cwd);
      for (const call of calls.filter((candidate) => candidate.command === "ocrmypdf" || candidate.command === "tesseract")) {
        expect(call.cwd).toBe(ocrCall?.cwd);
        expect(call.tempDir).toBe(ocrCall?.cwd);
      }
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it("rejects an existing destination before native work", async () => {
    const test = await setup();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    try {
      await writeFile(test.outputPath, "owner bytes");
      await expect(
        ocrPdf({
          inputPath: test.inputPath,
          outputPath: test.outputPath,
          languages: ["eng"],
          run: runner(test.pagesByPath, calls)
        })
      ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      expect(calls).toHaveLength(0);
      expect(await readFile(test.outputPath, "utf8")).toBe("owner bytes");
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it("fails with OCR_LANGUAGE_UNAVAILABLE before OCR when a requested pack is missing", async () => {
    const test = await setup();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    try {
      await expect(
        ocrPdf({
          inputPath: test.inputPath,
          outputPath: test.outputPath,
          languages: ["deu", "eng"],
          run: runner(test.pagesByPath, calls, { languages: ["eng"] })
        })
      ).rejects.toMatchObject({
        code: "OCR_LANGUAGE_UNAVAILABLE",
        details: { missingLanguages: ["deu"] }
      });
      expect(calls.filter((call) => call.command === "ocrmypdf")).toHaveLength(1);
      await expect(stat(test.outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it("requires osd language data when automatic rotation is enabled", async () => {
    const test = await setup();
    try {
      await expect(ocrPdf({
        inputPath: test.inputPath,
        outputPath: test.outputPath,
        languages: ["eng"],
        autoRotate: true,
        run: runner(test.pagesByPath, [], { languages: ["eng"] })
      })).rejects.toMatchObject({
        code: "OCR_LANGUAGE_UNAVAILABLE",
        details: { missingLanguages: ["osd"] }
      });
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a live temporary-storage check rejects native work", async () => {
    const test = await setup();
    try {
      await expect(ocrPdf({
        inputPath: test.inputPath,
        outputPath: test.outputPath,
        languages: ["eng"],
        autoRotate: false,
        resourceCheck: async () => {
          throw new CompressionError("TEMP_QUOTA_EXCEEDED", "quota crossed");
        },
        run: runner(test.pagesByPath, [])
      })).rejects.toMatchObject({ code: "TEMP_QUOTA_EXCEEDED" });
      await expect(stat(test.outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it("reserves capacity for the final publication copy", async () => {
    const test = await setup();
    const reservations: number[] = [];
    try {
      await expect(ocrPdf({
        inputPath: test.inputPath,
        outputPath: test.outputPath,
        languages: ["eng"],
        autoRotate: false,
        resourceCheck: async (additionalBytes = 0) => {
          reservations.push(additionalBytes);
          if (additionalBytes > 0) {
            throw new CompressionError("TEMP_QUOTA_EXCEEDED", "publication would cross quota");
          }
        },
        run: runner(test.pagesByPath, [])
      })).rejects.toMatchObject({ code: "TEMP_QUOTA_EXCEEDED" });
      expect(reservations.some((bytes) => bytes > 0)).toBe(true);
      await expect(stat(test.outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid OCR candidate instead of publishing it", async () => {
    const test = await setup();
    try {
      await expect(
        ocrPdf({
          inputPath: test.inputPath,
          outputPath: test.outputPath,
          languages: ["eng"],
          run: runner(test.pagesByPath, [], { outputPages: 1 })
        })
      ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
      await expect(stat(test.outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it.each(["JOB_CANCELLED", "JOB_TIMEOUT"] as const)("preserves %s from OCRmyPDF", async (code) => {
    const test = await setup();
    try {
      await expect(
        ocrPdf({
          inputPath: test.inputPath,
          outputPath: test.outputPath,
          languages: ["eng"],
          run: runner(test.pagesByPath, [], { ocrError: new CompressionError(code, code) })
        })
      ).rejects.toMatchObject({ code });
      await expect(stat(test.outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });

  it("enforces the OCR output byte cap", async () => {
    const test = await setup();
    try {
      await expect(
        ocrPdf({
          inputPath: test.inputPath,
          outputPath: test.outputPath,
          languages: ["eng"],
          maxOutputBytes: 32,
          run: runner(test.pagesByPath, [])
        })
      ).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    } finally {
      await rm(test.dir, { recursive: true, force: true });
    }
  });
});
