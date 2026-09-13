import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompressionError, type NativeRunner, type ProcessResult } from "@pdf-compressor/core";
import { parseInspectArgs, runInspectCommand } from "../src/commands/inspect.js";

/** Minimal fixture: passes validatePdfInput (%PDF header, no /Encrypt). */
function testPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n%fixture-${marker}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

function okResult(stdout = ""): ProcessResult {
  return { stdout, stderr: "", exitCode: 0 };
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

function makeInspectRunner(pagesByPath: Map<string, number>): NativeRunner {
  return async (command, args) => {
    if (command === "qpdf" && args[0] === "--version") {
      return okResult("qpdf version 12.4.1\nRun qpdf --copyright to see copyright and license information.");
    }
    if (command === "qpdf" && args[0] === "--json") {
      const target = args[args.length - 1];
      const count = pagesByPath.get(target);
      if (count === undefined) {
        throw new CompressionError("ENGINE_FAILED", "qpdf exited with code 2.", {
          command,
          exitCode: 2,
          stderr: "qpdf: open: No such file or directory"
        });
      }
      return okResult(inspectionJson(count));
    }
    throw new Error(`fake: unexpected call ${command} ${args.join(" ")}`);
  };
}

function expectSingleJsonObject(stdout: string): unknown {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout);
}

describe("parseInspectArgs", () => {
  it("accepts one or more paths with --json", () => {
    expect(parseInspectArgs(["a.pdf", "b.pdf", "--json"])).toEqual({
      paths: ["a.pdf", "b.pdf"],
      json: true
    });
  });

  it("rejects a missing input path", () => {
    expect(() => parseInspectArgs(["--json"])).toThrow("Missing input PDF path");
  });
});

describe("runInspectCommand", () => {
  it("inspects multiple PDFs with stable ids and one JSON object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-inspect-"));
    try {
      const aPath = join(dir, "a.pdf");
      const bPath = join(dir, "b.pdf");
      await writeFile(aPath, testPdf("inspect-a"));
      await writeFile(bPath, testPdf("inspect-b"));
      const run = makeInspectRunner(
        new Map([
          [aPath, 3],
          [bPath, 2]
        ])
      );
      const result = await runInspectCommand([aPath, bPath, "--json"], { run });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const payload = expectSingleJsonObject(result.stdout) as {
        ok: boolean;
        status: string;
        qpdfVersion: string;
        sources: Array<{ id: string; path: string; pageCount: number; warnings: string[] }>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.status).toBe("success");
      expect(payload.qpdfVersion).toBe("12.4.1");
      expect(payload.sources.map((source) => [source.id, source.pageCount])).toEqual([
        ["source-1", 3],
        ["source-2", 2]
      ]);
      expect(payload.sources[0].path).toBe(aPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps a missing source to INPUT_NOT_FOUND with exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-inspect-"));
    try {
      const missing = join(dir, "gone.pdf");
      const run = makeInspectRunner(new Map());
      const result = await runInspectCommand([missing, "--json"], { run });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({
        ok: false,
        code: "INPUT_NOT_FOUND"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps an unsupported qpdf to NATIVE_VERSION_UNSUPPORTED with exit 3", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-inspect-"));
    try {
      const aPath = join(dir, "a.pdf");
      await writeFile(aPath, testPdf("inspect-a"));
      const run: NativeRunner = async () => okResult("qpdf version 11.8.0");
      const result = await runInspectCommand([aPath, "--json"], { run });
      expect(result.exitCode).toBe(3);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({
        ok: false,
        code: "NATIVE_VERSION_UNSUPPORTED"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves invocation-relative paths before native inspection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-cli-inspect-"));
    try {
      const aPath = join(dir, "a.pdf");
      await writeFile(aPath, testPdf("inspect-relative"));
      const seen: string[] = [];
      const run: NativeRunner = async (command, args) => {
        if (command === "qpdf" && args[0] === "--version") {
          return okResult("qpdf version 12.4.1");
        }
        if (command === "qpdf" && args[0] === "--json") {
          seen.push(args[args.length - 1]);
          return okResult(inspectionJson(1));
        }
        throw new Error(`fake: unexpected call ${command} ${args.join(" ")}`);
      };
      const previousCwd = process.cwd();
      process.chdir(dir);
      try {
        const result = await runInspectCommand(["a.pdf", "--json"], { run });
        expect(result.exitCode).toBe(0);
      } finally {
        process.chdir(previousCwd);
      }
      expect(seen).toHaveLength(1);
      expect(isAbsolute(seen[0])).toBe(true);
      expect(await realpath(seen[0])).toBe(await realpath(aPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns usage 64 without paths", async () => {
    const result = await runInspectCommand([]);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Missing input PDF path/);
  });

  it("returns usage errors as one JSON object when --json is present", async () => {
    const result = await runInspectCommand(["--json"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(expectSingleJsonObject(result.stdout)).toMatchObject({
      ok: false,
      code: "USAGE"
    });
  });
});
