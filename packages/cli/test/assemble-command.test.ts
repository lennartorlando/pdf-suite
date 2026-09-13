import { link, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompressionError,
  assemblePages,
  type NativeRunner,
  type PageSourceBinding,
  type ProcessResult
} from "@pdf-compressor/core";
import { parseAssembleArgs, runAssembleCommand } from "../src/commands/assemble.js";

/** Minimal fixture: passes validatePdfInput (%PDF header, no /Encrypt). */
function testPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n%fixture-${marker}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

async function sha256File(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function okResult(stdout = ""): ProcessResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function inspectionJson(pageCount: number, objects: Record<string, unknown> = {}): string {
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
        "obj:3 0 R": { value: { "/Type": "/Page", "/Parent": "2 0 R", "/MediaBox": [0, 0, 612, 792] } },
        ...objects
      }
    ]
  });
}

interface FakeState {
  mutations: number;
  calls: string[][];
  /** Force every --json inspection to report these objects (e.g. signatures). */
  objects: Record<string, unknown>;
  qpdfVersion: string;
  mutationError?: CompressionError;
}

function makeFakeRunner(state: FakeState, pagesByPath: Map<string, number>): NativeRunner {
  const rangeSize = (args: readonly string[]): number => {
    let total = 0;
    for (const arg of args) {
      if (arg.startsWith("--range=")) total += arg.slice("--range=".length).split(",").length;
    }
    return total;
  };
  return async (command, args) => {
    state.calls.push([command, ...args]);
    if (command === "qpdf" && args[0] === "--version") {
      return okResult(`qpdf version ${state.qpdfVersion}`);
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
      return okResult(inspectionJson(count, state.objects));
    }
    if (command === "qpdf" && args[0] === "--check") {
      return okResult("No syntax or stream encoding errors found");
    }
    if (command === "qpdf" && args.includes("--pages")) {
      state.mutations += 1;
      if (state.mutationError) throw state.mutationError;
      const candidate = args[args.length - 1];
      const firstFile = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
      if (!firstFile) throw new Error("fake: no --file group");
      await writeFile(candidate, await readFile(firstFile));
      pagesByPath.set(candidate, rangeSize(args));
      return okResult("");
    }
    throw new Error(`fake: unexpected call ${command} ${args.join(" ")}`);
  };
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return { mutations: 0, calls: [], objects: {}, qpdfVersion: "12.4.1", ...overrides };
}

function expectSingleJsonObject(stdout: string): unknown {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout);
}

async function setupTwoSources(): Promise<{
  dir: string;
  aPath: string;
  bPath: string;
  manifestPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-cli-assemble-"));
  const aPath = join(dir, "a.pdf");
  const bPath = join(dir, "b.pdf");
  await writeFile(aPath, testPdf("assemble-a"));
  await writeFile(bPath, testPdf("assemble-b"));
  const manifestPath = join(dir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      pages: [
        { sourceId: "a", page: 3 },
        { sourceId: "b", page: 2, rotate: 90 },
        { sourceId: "a", page: 1, rotate: 180 }
      ]
    })
  );
  return { dir, aPath, bPath, manifestPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function assembleArgs(
  setup: { aPath: string; bPath: string; manifestPath: string; dir: string },
  outputName = "out.pdf",
  extra: string[] = []
): string[] {
  return [
    "--source",
    `a=${setup.aPath}`,
    "--source",
    `b=${setup.bPath}`,
    "--manifest",
    setup.manifestPath,
    "--output",
    join(setup.dir, outputName),
    "--json",
    ...extra
  ];
}

describe("parseAssembleArgs", () => {
  it("parses source bindings, manifest, output, and flags", () => {
    expect(
      parseAssembleArgs([
        "--source",
        "a=a.pdf",
        "--source",
        "b=b.pdf",
        "--manifest",
        "manifest.json",
        "--output",
        "out.pdf",
        "--json"
      ])
    ).toMatchObject({
      sources: [
        { id: "a", path: "a.pdf" },
        { id: "b", path: "b.pdf" }
      ],
      manifestPath: "manifest.json",
      destinationPath: "out.pdf",
      json: true,
      overwrite: false
    });
  });

  it("rejects malformed source bindings and missing parts", () => {
    expect(() => parseAssembleArgs(["--source", "abc", "--manifest", "m.json", "--output", "o.pdf"])).toThrow(
      "Invalid --source binding"
    );
    expect(() => parseAssembleArgs(["--source", "a=a.pdf", "--output", "o.pdf"])).toThrow(
      "Missing --manifest"
    );
  });

  it("keeps equals signs in source paths", () => {
    expect(
      parseAssembleArgs([
        "--source",
        "a=folder/name=revision.pdf",
        "--manifest",
        "m.json",
        "--output",
        "o.pdf"
      ]).sources
    ).toEqual([{ id: "a", path: "folder/name=revision.pdf" }]);
  });

  it("parses OCR as an optional post-assembly stage", () => {
    expect(
      parseAssembleArgs([
        "--source", "a=a.pdf", "--manifest", "m.json", "--output", "o.pdf",
        "--ocr", "--ocr-language", "eng", "--no-ocr-rotate-pages"
      ]).ocr
    ).toEqual({ languages: ["eng"], autoRotate: false });
  });

  it("rejects OCR options unless the OCR stage is enabled", () => {
    expect(() => parseAssembleArgs([
      "--source", "a=a.pdf", "--manifest", "m.json", "--output", "o.pdf",
      "--ocr-language", "eng"
    ])).toThrow("--ocr-language requires --ocr");
    expect(() => parseAssembleArgs([
      "--source", "a=a.pdf", "--manifest", "m.json", "--output", "o.pdf",
      "--no-ocr-rotate-pages"
    ])).toThrow("--no-ocr-rotate-pages requires --ocr");
  });

  it("reports invalid OCR languages as a validation failure", async () => {
    const result = await runAssembleCommand([
      "--source", "a=a.pdf", "--manifest", "m.json", "--output", "o.pdf",
      "--ocr", "--ocr-language", "fra", "--json"
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "OCR_OPTIONS_INVALID" });
    expect(result.stderr).toBe("");
  });
});

describe("runAssembleCommand", () => {
  it("assembles a multi-source manifest with core-matching order and hashes", async () => {
    const setup = await setupTwoSources();
    const pagesByPath = new Map([
      [setup.aPath, 3],
      [setup.bPath, 2]
    ]);
    const state = freshState();
    try {
      const args = assembleArgs(setup);
      const result = await runAssembleCommand(args, { run: makeFakeRunner(state, pagesByPath) });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const payload = expectSingleJsonObject(result.stdout) as {
        ok: boolean;
        status: string;
        pageCount: number;
        engine: string;
        qpdfVersion: string;
        outputBytes: number;
        warnings: string[];
        compatWarnings: string[];
        sourceHashes: Record<string, string>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.pageCount).toBe(3);
      expect(payload.engine).toBe("qpdf");
      expect(payload.qpdfVersion).toBe("12.4.1");
      expect(payload.sourceHashes["a"]).toBe(await sha256File(setup.aPath));
      expect(payload.sourceHashes["b"]).toBe(await sha256File(setup.bPath));
      expect(state.mutations).toBe(1);

      const mutation = state.calls.find((call) => call.includes("--pages"));
      expect(mutation).toBeDefined();
      const files = mutation!.filter((arg) => arg.startsWith("--file="));
      const ranges = mutation!.filter((arg) => arg.startsWith("--range="));
      expect(files).toEqual([`--file=${setup.aPath}`, `--file=${setup.bPath}`, `--file=${setup.aPath}`]);
      expect(ranges).toEqual(["--range=3", "--range=2", "--range=1"]);
      expect(mutation!.join(" ")).toContain("--rotate=+90:2");
      expect(mutation!.join(" ")).toContain("--rotate=+180:3");

      await expect(stat(join(setup.dir, "out.pdf"))).resolves.toBeTruthy();
      // Sources are never rewritten by assembly.
      expect(await sha256File(setup.aPath)).toBe(payload.sourceHashes["a"]);
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects malformed JSON manifests with a stable code", async () => {
    const setup = await setupTwoSources();
    try {
      await writeFile(join(setup.dir, "broken.json"), "{ not json");
      const result = await runAssembleCommand(
        [
          "--source",
          `a=${setup.aPath}`,
          "--manifest",
          join(setup.dir, "broken.json"),
          "--output",
          join(setup.dir, "out.pdf"),
          "--json"
        ],
        { run: makeFakeRunner(freshState(), new Map([[setup.aPath, 3]])) }
      );
      expect(result.exitCode).toBe(2);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
      await expect(stat(join(setup.dir, "out.pdf"))).rejects.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects an invalid manifest shape with a stable code", async () => {
    const setup = await setupTwoSources();
    try {
      const badManifest = join(setup.dir, "bad.json");
      await writeFile(badManifest, JSON.stringify({ version: 1, pages: [{ sourceId: "zzz", page: 1 }] }));
      const result = await runAssembleCommand(
        [
          "--source",
          `a=${setup.aPath}`,
          "--manifest",
          badManifest,
          "--output",
          join(setup.dir, "out.pdf"),
          "--json"
        ],
        { run: makeFakeRunner(freshState(), new Map([[setup.aPath, 3]])) }
      );
      expect(result.exitCode).toBe(2);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({
        ok: false,
        code: "MANIFEST_UNKNOWN_SOURCE"
      });
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects a missing source with INPUT_NOT_FOUND", async () => {
    const setup = await setupTwoSources();
    try {
      const missing = join(setup.dir, "gone.pdf");
      const singleManifest = join(setup.dir, "single.json");
      await writeFile(singleManifest, JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] }));
      const result = await runAssembleCommand(
        [
          "--source",
          `a=${missing}`,
          "--manifest",
          singleManifest,
          "--output",
          join(setup.dir, "out.pdf"),
          "--json"
        ],
        { run: makeFakeRunner(freshState(), new Map()) }
      );
      expect(result.exitCode).toBe(2);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({ ok: false, code: "INPUT_NOT_FOUND" });
    } finally {
      await setup.cleanup();
    }
  });

  it("refuses to clobber an existing output and leaves it untouched", async () => {
    const setup = await setupTwoSources();
    const pagesByPath = new Map([
      [setup.aPath, 3],
      [setup.bPath, 2]
    ]);
    const state = freshState();
    try {
      const dest = join(setup.dir, "out.pdf");
      await writeFile(dest, "already here");
      const result = await runAssembleCommand(assembleArgs(setup), {
        run: makeFakeRunner(state, pagesByPath)
      });
      expect(result.exitCode).toBe(2);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({ ok: false, code: "OUTPUT_EXISTS" });
      expect(await readFile(dest, "utf8")).toBe("already here");
      expect(state.mutations).toBe(0);
    } finally {
      await setup.cleanup();
    }
  });

  it("replaces an existing output only with --overwrite", async () => {
    const setup = await setupTwoSources();
    const pagesByPath = new Map([
      [setup.aPath, 3],
      [setup.bPath, 2]
    ]);
    try {
      const dest = join(setup.dir, "out.pdf");
      await writeFile(dest, "already here");
      const baseRunner = makeFakeRunner(freshState(), pagesByPath);
      const run: NativeRunner = async (command, args, options) => {
        if (command === "qpdf" && args.includes("--pages")) {
          expect(await readFile(dest, "utf8")).toBe("already here");
        }
        return baseRunner(command, args, options);
      };
      const result = await runAssembleCommand(assembleArgs(setup, "out.pdf", ["--overwrite"]), {
        run
      });
      expect(result.exitCode).toBe(0);
      expect((expectSingleJsonObject(result.stdout) as { ok: boolean }).ok).toBe(true);
      expect(await readFile(dest, "utf8")).not.toBe("already here");
    } finally {
      await setup.cleanup();
    }
  });

  it("refuses overwrite when the destination is a hard-link alias of a source", async () => {
    const setup = await setupTwoSources();
    const destinationPath = join(setup.dir, "out.pdf");
    try {
      const sourceHash = await sha256File(setup.aPath);
      await link(setup.aPath, destinationPath);
      const result = await runAssembleCommand(assembleArgs(setup, "out.pdf", ["--overwrite"]), {
        run: makeFakeRunner(freshState(), new Map([
          [setup.aPath, 3],
          [setup.bPath, 2]
        ]))
      });
      expect(result.exitCode).toBe(2);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({
        ok: false,
        code: "OUTPUT_WOULD_OVERWRITE_INPUT"
      });
      expect(await sha256File(setup.aPath)).toBe(sourceHash);
      expect(await sha256File(destinationPath)).toBe(sourceHash);
    } finally {
      await setup.cleanup();
    }
  });

  it("preserves an overwritten destination when a referenced input is missing", async () => {
    const setup = await setupTwoSources();
    const destinationPath = join(setup.dir, "out.pdf");
    const manifestPath = join(setup.dir, "single.json");
    try {
      await writeFile(destinationPath, "original destination");
      await writeFile(manifestPath, JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] }));
      const result = await runAssembleCommand(
        [
          "--source",
          `a=${join(setup.dir, "missing.pdf")}`,
          "--manifest",
          manifestPath,
          "--output",
          destinationPath,
          "--overwrite",
          "--json"
        ],
        { run: makeFakeRunner(freshState(), new Map()) }
      );
      expect(result.exitCode).toBe(2);
      expect(await readFile(destinationPath, "utf8")).toBe("original destination");
    } finally {
      await setup.cleanup();
    }
  });

  it.each([
    ["native failure", new CompressionError("ENGINE_FAILED", "native failure")],
    ["timeout", new CompressionError("JOB_TIMEOUT", "timed out")],
    ["cancellation", new CompressionError("JOB_CANCELLED", "cancelled")]
  ])("preserves an overwritten destination after %s", async (_label, mutationError) => {
    const setup = await setupTwoSources();
    const destinationPath = join(setup.dir, "out.pdf");
    try {
      await writeFile(destinationPath, "original destination");
      const result = await runAssembleCommand(assembleArgs(setup, "out.pdf", ["--overwrite"]), {
        run: makeFakeRunner(freshState({ mutationError }), new Map([
          [setup.aPath, 3],
          [setup.bPath, 2]
        ]))
      });
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(destinationPath, "utf8")).toBe("original destination");
      expect((await readdir(setup.dir)).some((name) => name.includes("overwrite"))).toBe(false);
    } finally {
      await setup.cleanup();
    }
  });

  it("returns usage errors as one JSON object when --json is present", async () => {
    const result = await runAssembleCommand(["--json"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(expectSingleJsonObject(result.stdout)).toMatchObject({ ok: false, code: "USAGE" });
  });

  it("blocks signed inputs without writing a destination", async () => {
    const setup = await setupTwoSources();
    const pagesByPath = new Map([
      [setup.aPath, 3],
      [setup.bPath, 2]
    ]);
    const signedObjects = {
      "obj:9 0 R": { value: { "/Type": "/Sig", "/Filter": "/Adobe.PPKLite", "/ByteRange": [0, 100, 200, 300] } }
    };
    try {
      const result = await runAssembleCommand(assembleArgs(setup, "blocked.pdf"), {
        run: makeFakeRunner(freshState({ objects: signedObjects }), pagesByPath)
      });
      expect(result.exitCode).toBe(2);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({ ok: false, code: "INPUT_SIGNED" });
      await expect(stat(join(setup.dir, "blocked.pdf"))).rejects.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("blocks active-content inputs without writing a destination", async () => {
    const setup = await setupTwoSources();
    const pagesByPath = new Map([
      [setup.aPath, 3],
      [setup.bPath, 2]
    ]);
    const activeObjects = {
      "obj:9 0 R": { value: { "/S": "/JavaScript", "/JS": "u:app.alert('x')" } }
    };
    try {
      const result = await runAssembleCommand(assembleArgs(setup, "blocked.pdf"), {
        run: makeFakeRunner(freshState({ objects: activeObjects }), pagesByPath)
      });
      expect(result.exitCode).toBe(2);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({
        ok: false,
        code: "INPUT_HAS_ACTIVE_CONTENT"
      });
      await expect(stat(join(setup.dir, "blocked.pdf"))).rejects.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("maps an unsupported qpdf to NATIVE_VERSION_UNSUPPORTED with exit 3", async () => {
    const setup = await setupTwoSources();
    try {
      const result = await runAssembleCommand(assembleArgs(setup), {
        run: makeFakeRunner(freshState({ qpdfVersion: "11.8.0" }), new Map())
      });
      expect(result.exitCode).toBe(3);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({
        ok: false,
        code: "NATIVE_VERSION_UNSUPPORTED"
      });
      await expect(stat(join(setup.dir, "out.pdf"))).rejects.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("cancels assembly without a destination or temp artifact", async () => {
    const setup = await setupTwoSources();
    const pagesByPath = new Map([
      [setup.aPath, 3],
      [setup.bPath, 2]
    ]);
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await runAssembleCommand(assembleArgs(setup, "cancelled.pdf"), {
        run: makeFakeRunner(freshState(), pagesByPath),
        signal: controller.signal
      });
      expect(result.exitCode).toBe(4);
      expect(expectSingleJsonObject(result.stdout)).toMatchObject({ ok: false, code: "JOB_CANCELLED" });
      await expect(stat(join(setup.dir, "cancelled.pdf"))).rejects.toBeTruthy();
      const leftovers = (await readdir(setup.dir)).filter((name) => name.includes("staging"));
      expect(leftovers).toEqual([]);
    } finally {
      await setup.cleanup();
    }
  });

  it("matches the core summary for the same manifest (normalized parity)", async () => {
    const setup = await setupTwoSources();
    try {
      const bindings: PageSourceBinding[] = [
        { id: "a", path: setup.aPath },
        { id: "b", path: setup.bPath }
      ];
      const manifest = JSON.parse(await readFile(setup.manifestPath, "utf8")) as {
        version: 1;
        pages: Array<{ sourceId: string; page: number; rotate?: 0 | 90 | 180 | 270 }>;
      };
      const cliPages = new Map([
        [setup.aPath, 3],
        [setup.bPath, 2]
      ]);
      const corePages = new Map([
        [setup.aPath, 3],
        [setup.bPath, 2]
      ]);
      const cliDest = join(setup.dir, "cli.pdf");
      const coreDest = join(setup.dir, "core.pdf");
      const cliResult = await runAssembleCommand(
        [
          "--source",
          `a=${setup.aPath}`,
          "--source",
          `b=${setup.bPath}`,
          "--manifest",
          setup.manifestPath,
          "--output",
          cliDest,
          "--json"
        ],
        { run: makeFakeRunner(freshState(), cliPages) }
      );
      expect(cliResult.exitCode).toBe(0);
      const cliSummary = expectSingleJsonObject(cliResult.stdout) as Record<string, unknown>;
      const coreSummary = await assemblePages({
        sources: bindings,
        manifest,
        destinationPath: coreDest,
        run: makeFakeRunner(freshState(), corePages)
      });
      for (const key of ["status", "pageCount", "engine", "qpdfVersion", "warnings", "compatWarnings", "sourceHashes"] as const) {
        expect(cliSummary[key]).toEqual(coreSummary[key]);
      }
      expect(cliSummary["outputBytes"]).toEqual(coreSummary["outputBytes"]);
    } finally {
      await setup.cleanup();
    }
  });
});
