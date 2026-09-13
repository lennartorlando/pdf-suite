import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompressionError, type NativeRunner, type ProcessResult } from "@pdf-compressor/core";
import { parseOcrArgs, runOcrCommand } from "../src/commands/ocr.js";

function testPdf(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
}

function inspectionJson(): string {
  return JSON.stringify({
    pages: [{ object: "3 0 R" }],
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
        "obj:2 0 R": { value: { "/Type": "/Pages", "/Kids": ["3 0 R"], "/Count": 1 } },
        "obj:3 0 R": { value: { "/Type": "/Page", "/Parent": "2 0 R", "/MediaBox": [0, 0, 612, 792] } }
      }
    ]
  });
}

function okResult(stdout = "", stderr = ""): ProcessResult {
  return { stdout, stderr, exitCode: 0 };
}

function makeRunner(calls: string[][]): NativeRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === "qpdf" && args[0] === "--version") return okResult("qpdf version 12.4.1");
    if (command === "qpdf" && args[0] === "--json") return okResult(inspectionJson());
    if (command === "qpdf" && args[0] === "--check") return okResult("No errors");
    if (command === "ocrmypdf" && args[0] === "--version") return okResult("17.1.0\n");
    if (command === "tesseract" && args[0] === "--version") return okResult("tesseract 5.5.3\n");
    if (command === "tesseract" && args[0] === "--list-langs") return okResult("List of available languages (3):\ndeu\neng\nosd\n");
    if (command === "ocrmypdf") {
      const outputPath = args.at(-1);
      if (!outputPath) throw new Error("fake: missing output");
      await writeFile(outputPath, testPdf());
      return okResult();
    }
    throw new Error(`fake: unexpected call ${command} ${args.join(" ")}`);
  };
}

function json(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("parseOcrArgs", () => {
  it("uses German and English with automatic rotation by default", () => {
    expect(parseOcrArgs(["input.pdf", "--output", "out.pdf"])).toEqual({
      inputPath: "input.pdf",
      outputPath: "out.pdf",
      languages: ["deu", "eng"],
      autoRotate: true,
      overwrite: false,
      json: false
    });
  });

  it("parses agent-facing OCR options", () => {
    expect(parseOcrArgs(["input.pdf", "--output=out.pdf", "--language", "eng", "--no-rotate-pages", "--overwrite", "--json"]))
      .toMatchObject({ languages: ["eng"], autoRotate: false, overwrite: true, json: true });
  });

  it("rejects non-canonical language combinations", () => {
    for (const value of ["eng+deu", "deu+deu", "deu+eng+eng"]) {
      expect(() => parseOcrArgs(["input.pdf", "--output", "out.pdf", "--language", value]))
        .toThrow("OCR languages must be deu, eng, or deu+eng");
    }
  });
});

describe("runOcrCommand", () => {
  it("resolves paths and returns exactly one JSON object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-ocr-"));
    const previousCwd = process.cwd();
    const calls: string[][] = [];
    try {
      await writeFile(join(dir, "input.pdf"), testPdf());
      process.chdir(dir);
      const result = await runOcrCommand(["input.pdf", "--output", "out.pdf", "--json"], {
        run: makeRunner(calls)
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(json(result.stdout)).toMatchObject({
        ok: true,
        status: "success",
        engine: "ocrmypdf",
        pageCount: 1,
        qpdfVersion: "12.4.1",
        languages: ["deu", "eng"],
        autoRotate: true
      });
      const ocrCall = calls.find(([command, first]) => command === "ocrmypdf" && first === "--mode");
      expect(ocrCall).toContain("--rotate-pages");
      expect(ocrCall).toContain("deu+eng");
      expect(isAbsolute(String(ocrCall?.at(-2)))).toBe(true);
      expect(isAbsolute(String(ocrCall?.at(-1)))).toBe(true);
      await expect(stat(join(dir, "out.pdf"))).resolves.toBeTruthy();
    } finally {
      process.chdir(previousCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an existing output unless --overwrite is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-ocr-clobber-"));
    try {
      const input = join(dir, "input.pdf");
      const output = join(dir, "out.pdf");
      await writeFile(input, testPdf());
      await writeFile(output, "keep me");
      const blocked = await runOcrCommand([input, "--output", output, "--json"], { run: makeRunner([]) });
      expect(blocked.exitCode).toBe(2);
      expect(json(blocked.stdout)).toMatchObject({ ok: false, code: "OUTPUT_EXISTS" });
      expect(await readFile(output, "utf8")).toBe("keep me");

      const replaced = await runOcrCommand([input, "--output", output, "--overwrite", "--json"], {
        run: makeRunner([])
      });
      expect(replaced.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).not.toBe("keep me");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps unavailable OCR languages to validation exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-ocr-language-"));
    try {
      const input = join(dir, "input.pdf");
      await writeFile(input, testPdf());
      const run: NativeRunner = async (command, args, options) => {
        if (command === "tesseract" && args[0] === "--list-langs") {
          return okResult("List of available languages (1):\neng\n");
        }
        return makeRunner([])(command, args, options);
      };
      const result = await runOcrCommand([input, "--output", join(dir, "out.pdf"), "--language", "deu", "--json"], { run });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(json(result.stdout)).toMatchObject({ ok: false, code: "OCR_LANGUAGE_UNAVAILABLE" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps invalid OCR options to validation exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-ocr-options-"));
    try {
      const input = join(dir, "input.pdf");
      await writeFile(input, testPdf());
      const result = await runOcrCommand([input, "--output", join(dir, "out.pdf"), "--language", "fra", "--json"], {
        run: async () => { throw new CompressionError("ENGINE_FAILED", "must not run"); }
      });
      expect(result.exitCode).toBe(2);
      expect(json(result.stdout)).toMatchObject({ ok: false, code: "OCR_OPTIONS_INVALID" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
