import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompressionError } from "../src/errors.js";
import { assemblePages, inspectSources } from "../src/pages.js";
import {
  defaultNativeRunner,
  inspectPdfSource,
  type NativeRunner
} from "../src/engines/qpdf-pages.js";
import {
  createManifest,
  deriveSelection,
  type PageRotation
} from "../src/page-manifest.js";
import { buildTestPdf, qpdfJson, readPageGeometries, sha256File, writeTestPdf } from "./pdf-fixtures.js";

interface CallLog {
  mutations: number;
  gsCalls: number;
  calls: string[][];
}

function countingRunner(log: CallLog, base: NativeRunner = defaultNativeRunner): NativeRunner {
  return async (command, args, options) => {
    log.calls.push([command, ...args]);
    if (command === "qpdf" && args.includes("--pages")) log.mutations += 1;
    if (command === "gs" && args[0] !== "--version") log.gsCalls += 1;
    return base(command, args, options);
  };
}

function freshLog(): CallLog {
  return { mutations: 0, gsCalls: 0, calls: [] };
}

async function makeDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-pages-int-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function writePair(dir: string): Promise<{ aPath: string; bPath: string }> {
  const aPath = await writeTestPdf(dir, "pages-a.pdf", [
    { width: 611, label: "A-1" },
    { width: 612, label: "A-2" },
    { width: 613, label: "A-3" },
    { width: 614, label: "A-4" },
    { width: 615, label: "A-5" }
  ]);
  const bPath = await writeTestPdf(dir, "pages-b.pdf", [
    { width: 701, label: "B-1" },
    { width: 702, label: "B-2" },
    { width: 703, label: "B-3" }
  ]);
  return { aPath, bPath };
}

async function snapshot(paths: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(paths.map(async (path) => [path, await sha256File(path)] as const));
  return new Map(entries);
}

async function expectHashesUnchanged(before: Map<string, string>): Promise<void> {
  for (const [path, hash] of before) {
    expect(await sha256File(path), `source changed: ${path}`).toBe(hash);
  }
}

async function expectNoStaging(dir: string): Promise<void> {
  const names = await readdir(dir);
  expect(names.filter((name) => name.includes("staging"))).toEqual([]);
}

function encryptPdf(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("qpdf", ["--encrypt", "user", "owner", "256", "--", input, output], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe("qpdf page assembly integration", () => {
  it("assembles reordered pages with relative rotations from one source", async () => {
    const { dir, cleanup } = await makeDir();
    const log = freshLog();
    try {
      const { aPath } = await writePair(dir);
      const before = await snapshot([aPath]);
      const dest = join(dir, "reordered.pdf");
      const summary = await assemblePages({
        sources: [{ id: "a", path: aPath }],
        manifest: createManifest([
          { sourceId: "a", page: 5, rotate: 90 },
          { sourceId: "a", page: 1 },
          { sourceId: "a", page: 3, rotate: 270 }
        ]),
        destinationPath: dest,
        run: countingRunner(log)
      });
      expect(log.mutations).toBe(1);
      expect(summary.status).toBe("success");
      expect(summary.pageCount).toBe(3);
      expect(summary.engine).toBe("qpdf");
      expect(await readPageGeometries(dest)).toEqual([
        { width: 615, rotate: 90 },
        { width: 611, rotate: 0 },
        { width: 613, rotate: 270 }
      ]);
      await expectHashesUnchanged(before);
      await expectNoStaging(dir);
    } finally {
      await cleanup();
    }
  });

  it("interleaves two sources through an empty primary and warns on compat features", async () => {
    const { dir, cleanup } = await makeDir();
    const log = freshLog();
    try {
      const { aPath, bPath } = await writePair(dir);
      const compatPath = await writeTestPdf(
        dir,
        "form-with-bookmark.pdf",
        [{ width: 801 }, { width: 802 }],
        { bookmarks: true, formTextField: true, pageLabels: true, tags: true }
      );
      const before = await snapshot([aPath, bPath, compatPath]);
      const dest = join(dir, "merged.pdf");
      const summary = await assemblePages({
        sources: [
          { id: "a", path: aPath },
          { id: "b", path: bPath },
          { id: "c", path: compatPath }
        ],
        manifest: createManifest([
          { sourceId: "a", page: 2 },
          { sourceId: "c", page: 1 },
          { sourceId: "b", page: 3 },
          { sourceId: "c", page: 2, rotate: 180 }
        ]),
        destinationPath: dest,
        run: countingRunner(log)
      });
      expect(log.mutations).toBe(1);
      // Empty primary: document-level structures come from assembled pages only.
      const primaryUses = log.calls.filter((call) => call[0] === "qpdf" && call.includes("--pages"));
      expect(primaryUses[0]).toContain("--empty");
      expect(await readPageGeometries(dest)).toEqual([
        { width: 612, rotate: 0 },
        { width: 801, rotate: 0 },
        { width: 703, rotate: 0 },
        { width: 802, rotate: 180 }
      ]);
      expect(summary.compatWarnings).toEqual(expect.arrayContaining(["forms", "bookmarks", "tags", "page-labels"]));
      await expectHashesUnchanged(before);
      await expectNoStaging(dir);
    } finally {
      await cleanup();
    }
  });

  it("exports a selection without changing the workspace manifest", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const { aPath, bPath } = await writePair(dir);
      const before = await snapshot([aPath, bPath]);
      const workspace = createManifest([
        { sourceId: "a", page: 1 },
        { sourceId: "b", page: 2 },
        { sourceId: "a", page: 4 }
      ]);
      const frozen = JSON.parse(JSON.stringify(workspace)) as typeof workspace;
      const selection = deriveSelection(workspace, [2, 0]);
      const summary = await assemblePages({
        sources: [
          { id: "a", path: aPath },
          { id: "b", path: bPath }
        ],
        manifest: selection,
        destinationPath: join(dir, "selection.pdf")
      });
      expect(workspace).toEqual(frozen);
      expect(summary.pageCount).toBe(2);
      expect(await readPageGeometries(join(dir, "selection.pdf"))).toEqual([
        { width: 614, rotate: 0 },
        { width: 611, rotate: 0 }
      ]);
      await expectHashesUnchanged(before);
    } finally {
      await cleanup();
    }
  });

  it("rejects bad manifests and destinations before mutation", async () => {
    const { dir, cleanup } = await makeDir();
    const log = freshLog();
    const run = countingRunner(log);
    try {
      const { aPath, bPath } = await writePair(dir);
      const bindings = [
        { id: "a", path: aPath },
        { id: "b", path: bPath }
      ];
      const cases: Array<{ code: string; manifest?: Parameters<typeof createManifest>[0]; dest?: string; sources?: typeof bindings; raw?: boolean }> = [
        { code: "MANIFEST_UNKNOWN_SOURCE", manifest: [{ sourceId: "nope", page: 1 }] },
        {
          code: "MANIFEST_DUPLICATE_SOURCE",
          sources: [
            { id: "a", path: aPath },
            { id: "a", path: bPath }
          ],
          manifest: [{ sourceId: "a", page: 1 }]
        },
        { code: "MANIFEST_INVALID_PAGE", manifest: [{ sourceId: "a", page: 0, rotate: 0 as PageRotation }], raw: true },
        { code: "MANIFEST_PAGE_OUT_OF_RANGE", manifest: [{ sourceId: "b", page: 9 }] },
        { code: "MANIFEST_INVALID_ROTATION", manifest: [{ sourceId: "a", page: 1, rotate: 45 as PageRotation }], raw: true },
        { code: "MANIFEST_EMPTY", manifest: [] }
      ];
      for (const [index, candidate] of cases.entries()) {
        const manifest = candidate.raw
          ? { version: 1 as const, pages: candidate.manifest ?? [{ sourceId: "a", page: 1 }] }
          : createManifest(candidate.manifest ?? [{ sourceId: "a", page: 1 }]);
        await expect(
          assemblePages({
            sources: candidate.sources ?? bindings,
            manifest,
            destinationPath: join(dir, `rejected-${index}.pdf`),
            run
          })
        ).rejects.toMatchObject({ code: candidate.code });
      }
      const taken = join(dir, "taken.pdf");
      await writeFile(taken, "taken");
      await expect(
        assemblePages({ sources: bindings, manifest: createManifest([{ sourceId: "a", page: 1 }]), destinationPath: taken, run })
      ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });

      const alias = join(dir, "alias.pdf");
      await symlink(aPath, alias);
      await expect(
        assemblePages({ sources: bindings, manifest: createManifest([{ sourceId: "a", page: 1 }]), destinationPath: alias, run })
      ).rejects.toMatchObject({ code: "OUTPUT_WOULD_OVERWRITE_INPUT" });

      const hardlink = join(dir, "hard.pdf");
      await link(bPath, hardlink);
      await expect(
        assemblePages({ sources: bindings, manifest: createManifest([{ sourceId: "b", page: 1 }]), destinationPath: hardlink, run })
      ).rejects.toMatchObject({ code: "OUTPUT_WOULD_OVERWRITE_INPUT" });

      expect(log.mutations).toBe(0);
      await expectHashesUnchanged(await snapshot([aPath, bPath]));
      await expectNoStaging(dir);
    } finally {
      await cleanup();
    }
  });

  it("blocks encrypted, signed, and each active-content class before assembly", async () => {
    const { dir, cleanup } = await makeDir();
    const log = freshLog();
    const run = countingRunner(log);
    try {
      const { aPath } = await writePair(dir);
      const encrypted = join(dir, "encrypted.pdf");
      await encryptPdf(aPath, encrypted);
      const blockCases: Array<{ name: string; build: () => Promise<string>; code: string }> = [
        { name: "encrypted", build: async () => encrypted, code: "INPUT_ENCRYPTED" },
        {
          name: "signed",
          build: () => writeTestPdf(dir, "signed.pdf", [{ width: 901 }], { signatureField: true }),
          code: "INPUT_SIGNED"
        },
        {
          name: "javascript",
          build: () => writeTestPdf(dir, "active-js.pdf", [{ width: 902 }], { javascript: true }),
          code: "INPUT_HAS_ACTIVE_CONTENT"
        },
        {
          name: "launch",
          build: () => writeTestPdf(dir, "active-launch.pdf", [{ width: 903 }], { launchAction: true }),
          code: "INPUT_HAS_ACTIVE_CONTENT"
        },
        {
          name: "additional-actions",
          build: () => writeTestPdf(dir, "active-aa.pdf", [{ width: 904 }], { additionalActions: true }),
          code: "INPUT_HAS_ACTIVE_CONTENT"
        },
        {
          name: "submit",
          build: () => writeTestPdf(dir, "active-submit.pdf", [{ width: 905 }], { submitForm: true }),
          code: "INPUT_HAS_ACTIVE_CONTENT"
        },
        {
          name: "import",
          build: () => writeTestPdf(dir, "active-import.pdf", [{ width: 906 }], { importData: true }),
          code: "INPUT_HAS_ACTIVE_CONTENT"
        },
        {
          name: "rich-media",
          build: () => writeTestPdf(dir, "active-rich.pdf", [{ width: 907 }], { richMedia: true }),
          code: "INPUT_HAS_ACTIVE_CONTENT"
        },
        {
          name: "embedded-files",
          build: () => writeTestPdf(dir, "active-embedded.pdf", [{ width: 908 }], { embeddedFiles: true }),
          code: "INPUT_HAS_ACTIVE_CONTENT"
        }
      ];
      for (const blocked of blockCases) {
        const path = await blocked.build();
        const dest = join(dir, `${blocked.name}-out.pdf`);
        await expect(
          assemblePages({
            sources: [{ id: "s", path }],
            manifest: createManifest([{ sourceId: "s", page: 1 }]),
            destinationPath: dest,
            run
          }),
          blocked.name
        ).rejects.toMatchObject({ code: blocked.code });
        await expect(stat(dest), blocked.name).rejects.toBeTruthy();
      }
      expect(log.mutations).toBe(0);
      await expectHashesUnchanged(await snapshot([aPath]));
    } finally {
      await cleanup();
    }
  });

  it("admits a tagged document whose structure elements carry attribute objects", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const path = await writeTestPdf(dir, "tagged.pdf", [{ width: 640 }], {
        taggedStructure: true
      });
      const inspection = await inspectPdfSource(path);
      expect(inspection.activeContent).toEqual([]);
      expect(inspection.compatWarnings).toContain("tags");
    } finally {
      await cleanup();
    }
  });

  it("treats incomplete inspection as fatal and keeps exit-3 output as warnings", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const garbage = join(dir, "garbage.pdf");
      await writeFile(garbage, "%PDF-1.4\n%not-a-real-document\n");
      await expect(
        assemblePages({
          sources: [{ id: "g", path: garbage }],
          manifest: createManifest([{ sourceId: "g", page: 1 }]),
          destinationPath: join(dir, "garbage-out.pdf")
        })
      ).rejects.toMatchObject({ code: "INSPECTION_INCOMPLETE" });

      const damaged = await inspectSources([{ id: "m", path: join(process.cwd(), "tests", "fixtures", "minimal.pdf") }]);
      expect(damaged[0].pageCount).toBe(1);
      expect(damaged[0].warnings.join("\n")).toMatch(/reconstruct|damaged/i);
    } finally {
      await cleanup();
    }
  });

  it("reports missing qpdf as unavailable", async () => {
    const missing: NativeRunner = async () => {
      throw new CompressionError("ENGINE_UNAVAILABLE", "qpdf is not installed or not on PATH.", { command: "qpdf" });
    };
    const { dir, cleanup } = await makeDir();
    try {
      const { aPath } = await writePair(dir);
      await expect(
        assemblePages({
          sources: [{ id: "a", path: aPath }],
          manifest: createManifest([{ sourceId: "a", page: 1 }]),
          destinationPath: join(dir, "out.pdf"),
          run: missing
        })
      ).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
      await expectHashesUnchanged(await snapshot([aPath]));
    } finally {
      await cleanup();
    }
  });

  it("runs exactly one qpdf mutation with optional compression and validates the final artifact", async () => {
    const { dir, cleanup } = await makeDir();
    const log = freshLog();
    try {
      const { aPath, bPath } = await writePair(dir);
      const before = await snapshot([aPath, bPath]);
      const manifest = createManifest([
        { sourceId: "b", page: 2, rotate: 90 },
        { sourceId: "a", page: 1 }
      ]);
      const plain = await assemblePages({
        sources: [
          { id: "a", path: aPath },
          { id: "b", path: bPath }
        ],
        manifest,
        destinationPath: join(dir, "plain.pdf"),
        run: countingRunner(log)
      });
      expect(plain.status).toBe("success");

      const compressed = await assemblePages({
        sources: [
          { id: "a", path: aPath },
          { id: "b", path: bPath }
        ],
        manifest,
        destinationPath: join(dir, "compressed.pdf"),
        compression: "balanced",
        run: countingRunner(log)
      });
      expect(log.mutations).toBe(2);
      expect(log.gsCalls).toBe(1);
      expect(["success", "no_gain"]).toContain(compressed.status);
      for (const output of [join(dir, "plain.pdf"), join(dir, "compressed.pdf")]) {
        const { document } = await qpdfJson(output);
        expect(document.pages).toHaveLength(2);
      }
      await expectHashesUnchanged(before);
      await expectNoStaging(dir);
    } finally {
      await cleanup();
    }
  });

  it("handles option-hostile source filenames without a shell", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const tricky = join(dir, "--tricky.pdf");
      await writeFile(tricky, buildTestPdf([{ width: 631 }, { width: 632 }]));
      const dest = join(dir, "tricky-out.pdf");
      const summary = await assemblePages({
        sources: [{ id: "t", path: tricky }],
        manifest: createManifest([{ sourceId: "t", page: 2 }]),
        destinationPath: dest
      });
      expect(summary.pageCount).toBe(1);
      expect(await readPageGeometries(dest)).toEqual([{ width: 632, rotate: 0 }]);
    } finally {
      await cleanup();
    }
  });

  it("cancels and times out without publishing or leaving staging", async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const { aPath } = await writePair(dir);
      const before = await snapshot([aPath]);
      const hanging: NativeRunner = (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("fake should have been aborted first")), 10_000);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new CompressionError("JOB_CANCELLED", "fake native call cancelled."));
            },
            { once: true }
          );
        });
      const controller = new AbortController();
      const dest = join(dir, "cancelled.pdf");
      const pending = assemblePages({
        sources: [{ id: "a", path: aPath }],
        manifest: createManifest([{ sourceId: "a", page: 1 }]),
        destinationPath: dest,
        run: hanging,
        signal: controller.signal
      });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({ code: "JOB_CANCELLED" });
      await expect(stat(dest)).rejects.toBeTruthy();

      const timingOut: NativeRunner = (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          const budget = options?.timeoutMs ?? 0;
          setTimeout(() => reject(new CompressionError("JOB_TIMEOUT", `fake exceeded ${budget} ms.`)), Math.min(budget, 50));
        });
      await expect(
        assemblePages({
          sources: [{ id: "a", path: aPath }],
          manifest: createManifest([{ sourceId: "a", page: 1 }]),
          destinationPath: join(dir, "timed-out.pdf"),
          run: timingOut,
          timeoutMs: 100
        })
      ).rejects.toMatchObject({ code: "JOB_TIMEOUT" });
      await expectHashesUnchanged(before);
      await expectNoStaging(dir);
    } finally {
      await cleanup();
    }
  });
});
