import { mkdtemp, readdir, readFile, rm, stat, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompressionError } from "../src/errors.js";
import {
  assemblePages,
  type AssemblePagesOptions,
  type PageSourceBinding
} from "../src/pages.js";
import {
  assertNativeFloor,
  compareVersionTuples,
  getQpdfVersion,
  parseVersionTuple,
  publishNoClobber,
  type NativeRunner,
  type ProcessResult
} from "../src/engines/qpdf-pages.js";
import { createManifest, type PageRotation } from "../src/page-manifest.js";
import { buildTestPdf, sha256File } from "./pdf-fixtures.js";

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

interface FakeState {
  mutations: number;
  gsCalls: number;
  ocrCalls: number;
  calls: string[][];
  /** Extra bytes the fake gs candidate differs by (negative = smaller). */
  gsDelta: number;
  /** Corrupt the gs candidate validation (wrong page count). */
  gsCandidatePages: number | null;
  gsVersion: string;
  gsError?: CompressionError;
  ocrError?: CompressionError;
  ocrCandidatePages?: number;
  onMutation?: () => void | Promise<void>;
  failJsonWith?: string;
}

/** Fake native layer over real files: assembly copies the first group input. */
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
      return okResult("qpdf version 12.4.1\nRun qpdf --copyright to see copyright and license information.");
    }
    if (command === "gs" && args[0] === "--version") {
      if (state.gsError) throw state.gsError;
      return okResult(state.gsVersion);
    }
    if (command === "ocrmypdf" && args[0] === "--version") return okResult("17.11.0");
    if (command === "tesseract" && args[0] === "--version") return okResult("tesseract 5.5.3");
    if (command === "tesseract" && args[0] === "--list-langs") {
      return okResult("List of available languages (3):\ndeu\neng\nosd");
    }
    if (command === "qpdf" && args[0] === "--json") {
      if (state.failJsonWith !== undefined) {
        throw new CompressionError("ENGINE_FAILED", "qpdf exited with code 2.", {
          command,
          exitCode: 2,
          stderr: state.failJsonWith
        });
      }
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
    if (command === "qpdf" && args[0] === "--check") {
      return okResult("No syntax or stream encoding errors found");
    }
    if (command === "qpdf" && args[0] === "--is-encrypted") {
      // The only --json failure this fake models is a password-protected
      // source, which is exactly what --is-encrypted reports via exit 0.
      return { stdout: "", stderr: "", exitCode: state.failJsonWith !== undefined ? 0 : 2 };
    }
    if (command === "qpdf" && args.includes("--pages")) {
      state.mutations += 1;
      await state.onMutation?.();
      const candidate = args[args.length - 1];
      const firstFile = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length);
      if (!firstFile) throw new Error("fake: no --file group");
      const bytes = await readFile(firstFile);
      await writeFile(candidate, bytes);
      pagesByPath.set(candidate, rangeSize(args));
      return okResult("");
    }
    if (command === "gs") {
      if (state.gsError) throw state.gsError;
      state.gsCalls += 1;
      const outputFlag = args.find((arg) => arg.startsWith("-sOutputFile="));
      const input = args[args.length - 1];
      const output = outputFlag?.slice("-sOutputFile=".length);
      if (!output) throw new Error("fake: no gs output");
      const bytes = await readFile(input);
      const adjusted =
        state.gsDelta >= 0
          ? Buffer.concat([bytes, Buffer.alloc(state.gsDelta)])
          : bytes.subarray(0, Math.max(1, bytes.length + state.gsDelta));
      await writeFile(output, adjusted);
      const inputPages = pagesByPath.get(input) ?? 0;
      pagesByPath.set(output, state.gsCandidatePages ?? inputPages);
      return okResult("");
    }
    if (command === "ocrmypdf") {
      if (state.ocrError) throw state.ocrError;
      state.ocrCalls += 1;
      const input = args[args.length - 2];
      const output = args[args.length - 1];
      await writeFile(output, await readFile(input));
      pagesByPath.set(output, state.ocrCandidatePages ?? pagesByPath.get(input) ?? 0);
      return okResult("");
    }
    throw new Error(`fake: unexpected call ${command} ${args.join(" ")}`);
  };
}

async function setupTwoSources(): Promise<{
  dir: string;
  pagesByPath: Map<string, number>;
  bindings: PageSourceBinding[];
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-pages-unit-"));
  const aPath = join(dir, "a.pdf");
  const bPath = join(dir, "b.pdf");
  await writeFile(aPath, buildTestPdf([{ width: 611 }, { width: 612 }, { width: 613 }]));
  await writeFile(bPath, buildTestPdf([{ width: 701 }, { width: 702 }]));
  const pagesByPath = new Map([
    [aPath, 3],
    [bPath, 2]
  ]);
  return {
    dir,
    pagesByPath,
    bindings: [
      { id: "a", path: aPath },
      { id: "b", path: bPath }
    ],
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function assembleWith(
  options: Partial<AssemblePagesOptions> & { sources: PageSourceBinding[]; destinationPath: string },
  state: FakeState,
  pagesByPath: Map<string, number>
): Promise<Awaited<ReturnType<typeof assemblePages>>> {
  return assemblePages({
    manifest: createManifest([{ sourceId: "a", page: 1 }]),
    run: makeFakeRunner(state, pagesByPath),
    ...options
  });
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    mutations: 0,
    gsCalls: 0,
    ocrCalls: 0,
    calls: [],
    gsDelta: 50,
    gsCandidatePages: null,
    gsVersion: "10.07.1",
    ...overrides
  };
}

describe("assemblePages validation", () => {
  it("rejects source bindings that cannot round-trip through CLI binding syntax", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    try {
      await expect(
        assembleWith(
          {
            sources: [{ id: "a=b", path: setup.bindings[0].path }],
            destinationPath: join(setup.dir, "out.pdf"),
            manifest: { version: 1, pages: [{ sourceId: "a=b", page: 1, rotate: 0 }] }
          },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
      expect(state.calls).toHaveLength(0);
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects duplicate source ids without native work", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    try {
      await expect(
        assembleWith(
          {
            sources: [
              { id: "a", path: setup.bindings[0].path },
              { id: "a", path: setup.bindings[1].path }
            ],
            destinationPath: join(setup.dir, "out.pdf")
          },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "MANIFEST_DUPLICATE_SOURCE" });
      expect(state.calls).toHaveLength(0);
    } finally {
      await setup.cleanup();
    }
  });

  it("ignores unreferenced bindings after still validating duplicate ids", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    const missing = join(setup.dir, "unused-missing.pdf");
    try {
      const summary = await assembleWith(
        {
          sources: [setup.bindings[0], { id: "unused", path: missing }],
          destinationPath: join(setup.dir, "out.pdf"),
          manifest: createManifest([{ sourceId: "a", page: 1 }])
        },
        state,
        setup.pagesByPath
      );
      expect(summary.sourceHashes).toEqual({ a: await sha256File(setup.bindings[0].path) });
      expect(state.calls.some((call) => call.includes(missing))).toBe(false);
      const mutation = state.calls.find((call) => call.includes("--pages"));
      expect(mutation).toContain(`--file=${setup.bindings[0].path}`);
      expect(mutation).not.toContain(`--file=${missing}`);
      expect(mutation).not.toContain("--empty");
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects unknown sources, empty output, bad pages, and bad rotations", async () => {
    const setup = await setupTwoSources();
    try {
      const dest = join(setup.dir, "out.pdf");
      await expect(
        assembleWith({ sources: setup.bindings, destinationPath: dest, manifest: createManifest([{ sourceId: "zzz", page: 1 }]) }, freshState(), setup.pagesByPath)
      ).rejects.toMatchObject({ code: "MANIFEST_UNKNOWN_SOURCE" });
      await expect(
        assembleWith({ sources: setup.bindings, destinationPath: dest, manifest: createManifest([]) }, freshState(), setup.pagesByPath)
      ).rejects.toMatchObject({ code: "MANIFEST_EMPTY" });
      await expect(
        assembleWith({ sources: setup.bindings, destinationPath: dest, manifest: { version: 1, pages: [{ sourceId: "a", page: 0, rotate: 0 }] } }, freshState(), setup.pagesByPath)
      ).rejects.toMatchObject({ code: "MANIFEST_INVALID_PAGE" });
      await expect(
        assembleWith(
          { sources: setup.bindings, destinationPath: dest, manifest: createManifest([{ sourceId: "a", page: 4 }]) },
          freshState(),
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "MANIFEST_PAGE_OUT_OF_RANGE" });
      await expect(
        assembleWith(
          {
            sources: setup.bindings,
            destinationPath: dest,
            manifest: { version: 1, pages: [{ sourceId: "a", page: 1, rotate: 45 as PageRotation }] }
          },
          freshState(),
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "MANIFEST_INVALID_ROTATION" });
      await expect(stat(dest)).rejects.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects an over-cap manifest before mutation", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    try {
      const entries = Array.from({ length: 501 }, (_, index) => ({ sourceId: "a", page: (index % 3) + 1 }));
      await expect(
        assembleWith(
          { sources: setup.bindings, destinationPath: join(setup.dir, "out.pdf"), manifest: createManifest(entries) },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "OUTPUT_PAGE_LIMIT_EXCEEDED" });
      expect(state.mutations).toBe(0);
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects an existing destination without native work", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    const dest = join(setup.dir, "out.pdf");
    try {
      await writeFile(dest, "taken");
      await expect(
        assembleWith({ sources: setup.bindings, destinationPath: dest }, state, setup.pagesByPath)
      ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      expect(state.calls).toHaveLength(0);
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects symlink and hard-link destination aliases", async () => {
    const setup = await setupTwoSources();
    try {
      const symlinkDest = join(setup.dir, "alias.pdf");
      await symlink(setup.bindings[0].path, symlinkDest);
      await expect(
        assembleWith(
          { sources: setup.bindings, destinationPath: symlinkDest },
          freshState(),
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "OUTPUT_WOULD_OVERWRITE_INPUT" });

      const hardlinkDest = join(setup.dir, "hard.pdf");
      await link(setup.bindings[1].path, hardlinkDest);
      await expect(
        assembleWith(
          { sources: setup.bindings, destinationPath: hardlinkDest },
          freshState(),
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "OUTPUT_WOULD_OVERWRITE_INPUT" });
    } finally {
      await setup.cleanup();
    }
  });

  it("treats cancellation before mutation as JOB_CANCELLED", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        assembleWith(
          { sources: setup.bindings, destinationPath: join(setup.dir, "out.pdf"), signal: controller.signal },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
      expect(state.calls).toHaveLength(0);
    } finally {
      await setup.cleanup();
    }
  });

  it("maps qpdf password failures to INPUT_ENCRYPTED and bad JSON to INSPECTION_INCOMPLETE", async () => {
    const setup = await setupTwoSources();
    try {
      const dest = join(setup.dir, "out.pdf");
      await expect(
        assembleWith(
          { sources: setup.bindings, destinationPath: dest },
          freshState({ failJsonWith: "qpdf: invalid password" }),
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });

      const garbage = join(setup.dir, "garbage.pdf");
      await writeFile(garbage, "%PDF-1.4\n%not-a-real-document\n");
      const pagesByPath = new Map(setup.pagesByPath);
      pagesByPath.set(garbage, -1);
      const brokenJson: NativeRunner = async (command, args) => {
        if (command === "qpdf" && args[0] === "--version") return okResult("qpdf version 12.4.1");
        if (command === "qpdf" && args[0] === "--json") return okResult("this is not json");
        throw new Error("unexpected");
      };
      await expect(
        assemblePages({
          sources: [{ id: "g", path: garbage }],
          manifest: createManifest([{ sourceId: "g", page: 1 }]),
          destinationPath: join(setup.dir, "out2.pdf"),
          run: brokenJson
        })
      ).rejects.toMatchObject({ code: "INSPECTION_INCOMPLETE" });
      await expect(stat(dest)).rejects.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("preserves encrypted-marker detection across streaming chunk boundaries", async () => {
    const setup = await setupTwoSources();
    const splitMarker = join(setup.dir, "split-encrypt.pdf");
    await writeFile(
      splitMarker,
      Buffer.concat([
        Buffer.from("%PDF-1.7\n", "latin1"),
        Buffer.alloc(65_532 - 9, 0x20),
        Buffer.from("/Encrypt trailer", "latin1")
      ])
    );
    try {
      await expect(
        assemblePages({
          sources: [{ id: "split", path: splitMarker }],
          manifest: createManifest([{ sourceId: "split", page: 1 }]),
          destinationPath: join(setup.dir, "split-out.pdf"),
          run: makeFakeRunner(freshState(), new Map([[splitMarker, 1]]))
        })
      ).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects unsupported native versions", async () => {
    const setup = await setupTwoSources();
    try {
      const oldQpdf: NativeRunner = async () => okResult("qpdf version 11.8.0");
      await expect(
        assemblePages({
          sources: setup.bindings,
          manifest: createManifest([{ sourceId: "a", page: 1 }]),
          destinationPath: join(setup.dir, "out.pdf"),
          run: oldQpdf
        })
      ).rejects.toMatchObject({ code: "NATIVE_VERSION_UNSUPPORTED" });
    } finally {
      await setup.cleanup();
    }
  });

  it("fails a destination created mid-export without clobbering and cleans staging", async () => {
    const setup = await setupTwoSources();
    const dest = join(setup.dir, "out.pdf");
    const state = freshState({
      onMutation: () => writeFile(dest, "racing writer")
    });
    try {
      await expect(
        assembleWith({ sources: setup.bindings, destinationPath: dest }, state, setup.pagesByPath)
      ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      expect(await readFile(dest, "utf8")).toBe("racing writer");
      const leftovers = (await readdir(setup.dir)).filter((name) => name.includes("staging"));
      expect(leftovers).toEqual([]);
    } finally {
      await setup.cleanup();
    }
  });
});

describe("assemblePages candidates", () => {
  it("requires OCR, validates its candidate, and skips unsafe combined compression", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ gsDelta: -32 });
    try {
      const summary = await assembleWith(
        {
          sources: setup.bindings,
          destinationPath: join(setup.dir, "out.pdf"),
          ocr: { languages: ["deu", "eng"], autoRotate: true },
          compression: "balanced"
        },
        state,
        setup.pagesByPath
      );
      expect(state.ocrCalls).toBe(1);
      expect(state.gsCalls).toBe(0);
      expect(summary.engine).toBe("ocrmypdf");
      expect(summary.status).toBe("no_gain");
      expect(summary.warnings).toContain(
        'Profile "balanced" was not applied because compression is disabled for searchable OCR exports.'
      );
      expect(summary.ocr).toEqual({
        engine: "ocrmypdf",
        version: "17.11.0",
        tesseractVersion: "5.5.3",
        languages: ["deu", "eng"],
        autoRotate: true
      });
      const ocrIndex = state.calls.findIndex((call) => call[0] === "ocrmypdf" && call[1] !== "--version");
      const ocrValidationIndex = state.calls.findIndex(
        (call, index) => index > ocrIndex && call[0] === "qpdf" && call[1] === "--check"
      );
      const gsIndex = state.calls.findIndex((call) => call[0] === "gs" && call[1] !== "--version");
      expect(ocrIndex).toBeGreaterThan(-1);
      expect(ocrValidationIndex).toBeGreaterThan(ocrIndex);
      expect(gsIndex).toBe(-1);
      expect(ocrValidationIndex).toBeGreaterThan(ocrIndex);
    } finally {
      await setup.cleanup();
    }
  });

  it("does not fall back to assembly when selected OCR fails", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ ocrError: new CompressionError("ENGINE_FAILED", "OCR failed") });
    try {
      await expect(
        assembleWith(
          {
            sources: setup.bindings,
            destinationPath: join(setup.dir, "out.pdf"),
            ocr: { languages: ["eng"] }
          },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "ENGINE_FAILED" });
      expect(state.gsCalls).toBe(0);
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects an invalid selected OCR candidate", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ ocrCandidatePages: 99 });
    try {
      await expect(
        assembleWith(
          {
            sources: setup.bindings,
            destinationPath: join(setup.dir, "out.pdf"),
            ocr: { languages: ["eng"] }
          },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
    } finally {
      await setup.cleanup();
    }
  });

  it.each([
    "ENGINE_FAILED",
    "ENGINE_UNAVAILABLE",
    "JOB_TIMEOUT"
  ] as const)("falls back to qpdf when optional Ghostscript fails with %s", async (code) => {
    const setup = await setupTwoSources();
    const state = freshState({ gsError: new CompressionError(code, `gs ${code}`) });
    const dest = join(setup.dir, "out.pdf");
    try {
      const summary = await assembleWith(
        { sources: setup.bindings, destinationPath: dest, compression: "balanced" },
        state,
        setup.pagesByPath
      );
      expect(summary.status).toBe("no_gain");
      expect(summary.engine).toBe("qpdf");
      expect(summary.warnings.join("\n")).toContain(code);
      await expect(stat(dest)).resolves.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("falls back to qpdf when the optional Ghostscript version is unsupported", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ gsVersion: "10.06.0" });
    try {
      const summary = await assembleWith(
        {
          sources: setup.bindings,
          destinationPath: join(setup.dir, "out.pdf"),
          compression: "balanced"
        },
        state,
        setup.pagesByPath
      );
      expect(summary.status).toBe("no_gain");
      expect(summary.engine).toBe("qpdf");
      expect(summary.warnings.join("\n")).toContain("NATIVE_VERSION_UNSUPPORTED");
    } finally {
      await setup.cleanup();
    }
  });

  it("preserves explicit cancellation from optional Ghostscript", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ gsError: new CompressionError("JOB_CANCELLED", "cancelled") });
    try {
      await expect(
        assembleWith(
          {
            sources: setup.bindings,
            destinationPath: join(setup.dir, "out.pdf"),
            compression: "balanced"
          },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    } finally {
      await setup.cleanup();
    }
  });

  it("delivers the qpdf assembly with no_gain when Ghostscript is larger", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ gsDelta: 64 });
    const dest = join(setup.dir, "out.pdf");
    try {
      const summary = await assembleWith(
        {
          sources: setup.bindings,
          destinationPath: dest,
          compression: "balanced",
          manifest: createManifest([
            { sourceId: "a", page: 2 },
            { sourceId: "b", page: 1 }
          ])
        },
        state,
        setup.pagesByPath
      );
      expect(state.mutations).toBe(1);
      expect(state.gsCalls).toBe(1);
      expect(summary.status).toBe("no_gain");
      expect(summary.engine).toBe("qpdf");
      expect(summary.pageCount).toBe(2);
      expect(summary.qpdfVersion).toBe("12.4.1");
      expect(summary.ghostscriptVersion).toBe("10.07.1");
      expect(summary.sourceHashes["a"]).toBe(await sha256File(setup.bindings[0].path));
      await expect(stat(dest)).resolves.toBeTruthy();
    } finally {
      await setup.cleanup();
    }
  });

  it("delivers the Ghostscript candidate only when smaller and valid", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ gsDelta: -32 });
    const dest = join(setup.dir, "out.pdf");
    try {
      const summary = await assembleWith(
        { sources: setup.bindings, destinationPath: dest, compression: "balanced" },
        state,
        setup.pagesByPath
      );
      expect(summary.status).toBe("success");
      expect(summary.engine).toBe("ghostscript");
      expect(state.mutations).toBe(1);
    } finally {
      await setup.cleanup();
    }
  });

  it("discards an invalid compression candidate and keeps the assembly", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ gsDelta: -32, gsCandidatePages: 99 });
    const dest = join(setup.dir, "out.pdf");
    try {
      const summary = await assembleWith(
        { sources: setup.bindings, destinationPath: dest, compression: "balanced" },
        state,
        setup.pagesByPath
      );
      expect(summary.status).toBe("no_gain");
      expect(summary.engine).toBe("qpdf");
      expect(summary.warnings.join("\n")).toMatch(/invalid/i);
    } finally {
      await setup.cleanup();
    }
  });

  it("skips Ghostscript for lossless profiles without native compression work", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    const dest = join(setup.dir, "out.pdf");
    try {
      const summary = await assembleWith(
        { sources: setup.bindings, destinationPath: dest, compression: "conservative" },
        state,
        setup.pagesByPath
      );
      expect(summary.status).toBe("no_gain");
      expect(summary.engine).toBe("qpdf");
      expect(state.gsCalls).toBe(0);
      expect(state.mutations).toBe(1);
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects an oversized qpdf candidate through the core byte limit", async () => {
    const setup = await setupTwoSources();
    const state = freshState();
    try {
      await expect(
        assembleWith(
          {
            sources: setup.bindings,
            destinationPath: join(setup.dir, "out.pdf"),
            maxOutputBytes: 32
          },
          state,
          setup.pagesByPath
        )
      ).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    } finally {
      await setup.cleanup();
    }
  });

  it("falls back when only the optional Ghostscript candidate exceeds the core byte limit", async () => {
    const setup = await setupTwoSources();
    const state = freshState({ gsDelta: 64 });
    const assemblyBytes = (await stat(setup.bindings[0].path)).size;
    try {
      const summary = await assembleWith(
        {
          sources: setup.bindings,
          destinationPath: join(setup.dir, "out.pdf"),
          compression: "balanced",
          maxOutputBytes: assemblyBytes
        },
        state,
        setup.pagesByPath
      );
      expect(summary.status).toBe("no_gain");
      expect(summary.engine).toBe("qpdf");
      expect(summary.warnings.join("\n")).toContain("OUTPUT_TOO_LARGE");
    } finally {
      await setup.cleanup();
    }
  });
});

describe("native version floors", () => {
  it("parses and compares dotted versions", () => {
    expect(parseVersionTuple("12.4.1")).toEqual([12, 4, 1]);
    expect(parseVersionTuple("10.07.1")).toEqual([10, 7, 1]);
    expect(parseVersionTuple("bogus")).toBeNull();
    expect(compareVersionTuples([12, 4, 1], [11, 9, 0])).toBe(1);
    expect(compareVersionTuples([11, 8, 0], [11, 9, 0])).toBe(-1);
    expect(compareVersionTuples([12, 4, 1], [12, 4, 1])).toBe(0);
    expect(() => assertNativeFloor("qpdf", "11.8.0", "12.4.1")).toThrow(
      expect.objectContaining({ code: "NATIVE_VERSION_UNSUPPORTED" })
    );
    assertNativeFloor("qpdf", "12.4.1", "12.4.1");
  });

  it("reports missing binaries as unavailable", async () => {
    await expect(getQpdfVersion({ run: async () => okResult("no version here") })).rejects.toMatchObject({
      code: "INSPECTION_INCOMPLETE"
    });
  });
});

describe("publishNoClobber", () => {
  it("links the staged file and removes staging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-publish-"));
    try {
      const staging = join(dir, "staging.pdf");
      const dest = join(dir, "final.pdf");
      await writeFile(staging, "bytes");
      await publishNoClobber(staging, dest);
      expect(await readFile(dest, "utf8")).toBe("bytes");
      await expect(stat(staging)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps a raced destination to OUTPUT_EXISTS and cleans staging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-publish-"));
    try {
      const staging = join(dir, "staging.pdf");
      const dest = join(dir, "final.pdf");
      await writeFile(staging, "bytes");
      await writeFile(dest, "winner");
      await expect(publishNoClobber(staging, dest)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
      await expect(stat(staging)).rejects.toBeTruthy();
      expect(await readFile(dest, "utf8")).toBe("winner");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the platform cannot link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-publish-"));
    try {
      const staging = join(dir, "staging-dir");
      await expect(publishNoClobber(staging, join(dir, "final.pdf"))).rejects.toMatchObject({
        code: "PUBLISH_FAILED"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
