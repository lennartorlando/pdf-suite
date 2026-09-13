import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluatePdfjsPin,
  pdfjsPin
} from "../../../scripts/check-native-versions.mjs";
import {
  FILL_CHILD_HEAP_SIZE_MB,
  FILL_CHILD_TIMEOUT_MS,
  fillChildEntryPath,
  runFillChild,
  type FillChildRequest
} from "../src/engines/pdfjs-fill.js";
import { isCompressionError } from "../src/errors.js";
import { parseFormPlan, serializeFormPlan, type FormPlanEntry } from "../src/form-plan.js";
import { PDFJS_PINNED_VERSION } from "../src/pdfjs-version.js";
import { buildTestPdf, sha256File } from "./pdf-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FILL_VALUE = "Ada Lovelace";

interface FieldProbe {
  id?: string;
  kidIds?: string[];
  type?: string;
  value?: string;
}

/** Load a document with the pinned renderer and return its field objects. */
async function fieldObjects(pdfPath: string): Promise<FieldProbe[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(await readFile(pdfPath)) });
  const doc = await loadingTask.promise;
  try {
    const fields = await doc.getFieldObjects();
    const result: FieldProbe[] = [];
    for (const list of fields?.values() ?? []) {
      for (const entry of list) result.push(entry as FieldProbe);
    }
    return result;
  } finally {
    await loadingTask.destroy();
  }
}

/** Plan identifiers are canonical "N G R" refs; PDF.js reports "NR". */
async function fieldIdOf(pdfPath: string): Promise<string> {
  const fields = await fieldObjects(pdfPath);
  const parent = fields.find((entry) => Array.isArray(entry.kidIds) && entry.kidIds.length > 0);
  const raw = parent?.id ?? fields.find((entry) => entry.type === "text")?.id ?? "";
  const match = /^(\d+)R(\d*)$/.exec(raw);
  return match ? `${match[1]} ${match[2] || "0"} R` : raw;
}

async function planFile(dir: string, entries: readonly FormPlanEntry[]): Promise<string> {
  const path = join(dir, "plan.json");
  await writeFile(
    path,
    serializeFormPlan(
      parseFormPlan({
        version: 1,
        source: "test-source",
        destination: "test-destination",
        overwrite: false,
        burnIn: false,
        nonce: "u11-test",
        entries
      })
    )
  );
  return path;
}

async function makeJob(prefix: string): Promise<{
  dir: string;
  workspace: string;
  sourcePath: string;
  planPath: string;
  request: (entries: readonly FormPlanEntry[], maxOutputBytes?: number) => Promise<FillChildRequest>;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(dir, "workspace");
  const sourcePath = join(dir, "source.pdf");
  await writeFile(sourcePath, buildTestPdf([{ width: 600, label: "U11" }], { formTextField: true }));
  await mkdir(workspace);
  return {
    dir,
    workspace,
    sourcePath,
    planPath: join(dir, "plan.json"),
    request: async (entries, maxOutputBytes = 150 * 1024 * 1024) => ({
      sourcePath,
      planPath: await planFile(dir, entries),
      candidatePath: join(workspace, "candidate.pdf"),
      outcomePath: join(workspace, "outcome.json"),
      workspacePath: workspace,
      maxOutputBytes
    })
  };
}

interface OutcomeFile {
  status: string;
  bytes?: number;
  code?: string;
  child?: { pid: number; cwd: string; envKeys: string[]; stdinEnded: boolean };
}

async function readOutcomeFile(path: string): Promise<OutcomeFile> {
  return JSON.parse(await readFile(path, "utf8")) as OutcomeFile;
}

async function waitForRunningMarker(path: string): Promise<OutcomeFile> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const outcome = await readOutcomeFile(path);
      if (outcome.status === "running") return outcome;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The fill child never reached its running marker.");
}

describe("fill child containment", () => {
  it("applies a hard-coded plan and writes the candidate at the requested path only", async () => {
    const job = await makeJob("pdfjs-fill-apply-");
    try {
      const request = await job.request([
        { kind: "field", fieldId: await fieldIdOf(job.sourcePath), status: "answered", value: FILL_VALUE }
      ]);
      const outcome = await runFillChild(request);
      expect(outcome.status).toBe("filled");
      expect(outcome.bytes).toBeGreaterThan(0);

      const bytes = await readFile(request.candidatePath);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.toString("latin1")).toContain(`/V (${FILL_VALUE})`);

      // The workspace holds exactly the candidate and the outcome file; the
      // source and plan directories gained nothing.
      expect(readdirSync(job.workspace).sort()).toEqual(["candidate.pdf", "outcome.json"]);
      expect(readdirSync(job.dir).sort()).toEqual(["plan.json", "source.pdf", "workspace"]);

      // The written value is a real field value, not just bytes in a stream.
      const fields = await fieldObjects(request.candidatePath);
      expect(fields.find((entry) => entry.type === "text")?.value).toBe(FILL_VALUE);
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses to write past the byte budget and leaves no candidate", async () => {
    const job = await makeJob("pdfjs-fill-budget-");
    try {
      const request = await job.request([
        { kind: "field", fieldId: await fieldIdOf(job.sourcePath), status: "answered", value: FILL_VALUE }
      ], 50);
      await expect(runFillChild(request)).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
      expect(existsSync(request.candidatePath)).toBe(false);
      const outcome = await readOutcomeFile(request.outcomePath);
      expect(outcome.status).toBe("refused");
      expect(outcome.code).toBe("OUTPUT_TOO_LARGE");
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("terminates the child mid-work on abort: process group dies, no candidate, source unchanged", async () => {
    const job = await makeJob("pdfjs-fill-kill-");
    try {
      const request = await job.request([
        { kind: "field", fieldId: await fieldIdOf(job.sourcePath), status: "answered", value: FILL_VALUE }
      ]);
      const sourceHash = await sha256File(job.sourcePath);
      const controller = new AbortController();
      const pending = runFillChild(request, { signal: controller.signal });
      const marker = await waitForRunningMarker(request.outcomePath);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "JOB_CANCELLED" });
      expect(() => process.kill(marker.child!.pid, 0)).toThrow();
      expect(existsSync(request.candidatePath)).toBe(false);
      expect(await sha256File(job.sourcePath)).toBe(sourceHash);
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("terminates the child on timeout with no candidate and an unchanged source", async () => {
    const job = await makeJob("pdfjs-fill-timeout-");
    try {
      const request = await job.request([
        { kind: "field", fieldId: await fieldIdOf(job.sourcePath), status: "answered", value: FILL_VALUE }
      ]);
      const sourceHash = await sha256File(job.sourcePath);
      await expect(runFillChild(request, { timeoutMs: 50 })).rejects.toMatchObject({ code: "JOB_TIMEOUT" });
      expect(existsSync(request.candidatePath)).toBe(false);
      expect(await sha256File(job.sourcePath)).toBe(sourceHash);
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("surfaces a heap-cap kill as FILL_CHILD_OUT_OF_MEMORY, not ENGINE_FAILED", async () => {
    const job = await makeJob("pdfjs-fill-oom-");
    try {
      const request = await job.request([
        { kind: "field", fieldId: await fieldIdOf(job.sourcePath), status: "answered", value: FILL_VALUE }
      ]);
      let code: string | null = null;
      try {
        await runFillChild(request, { heapSizeMb: 8 });
      } catch (error) {
        code = isCompressionError(error) ? error.code : "unexpected";
      }
      // The 8 MiB cap cannot fit the renderer's module graph, so the child
      // dies on V8's heap limit. If an environment ever makes this outcome
      // unreachable the mechanism must still fail loudly, not pass by
      // skipping.
      expect(code).toBe("FILL_CHILD_OUT_OF_MEMORY");
      expect(existsSync(request.candidatePath)).toBe(false);
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs the child with a minimal environment, closed stdin and the workspace as cwd", async () => {
    const job = await makeJob("pdfjs-fill-env-");
    try {
      const request = await job.request([
        { kind: "field", fieldId: await fieldIdOf(job.sourcePath), status: "answered", value: FILL_VALUE }
      ]);
      process.env["PDF_COMPRESSOR_FILL_PROBE"] = "s3cret";
      try {
        await runFillChild(request);
      } finally {
        delete process.env["PDF_COMPRESSOR_FILL_PROBE"];
      }
      const outcome = await readOutcomeFile(request.outcomePath);
      expect(outcome.status).toBe("filled");
      expect(outcome.child?.stdinEnded).toBe(true);
      expect(outcome.child?.cwd).toBe(await realpath(job.workspace));
      expect(outcome.child?.envKeys.length).toBeLessThanOrEqual(16);
      expect(outcome.child?.envKeys).not.toContain("PDF_COMPRESSOR_FILL_PROBE");
      // NODE_OPTIONS would carry a heap cap through the environment; the
      // minimal environment drops it, so the cap must travel by argument.
      expect(outcome.child?.envKeys).not.toContain("NODE_OPTIONS");
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("passes the heap cap as an argv entry to the same Node binary", async () => {
    const job = await makeJob("pdfjs-fill-args-");
    try {
      const request = await job.request([], 12345);
      let captured: { command: string; args: readonly string[] } | null = null;
      await runFillChild(request, {
        run: async (command, args) => {
          captured = { command, args };
          await writeFile(request.candidatePath, Buffer.from("%PDF-1.4 fake"));
          await writeFile(request.outcomePath, JSON.stringify({ status: "filled", bytes: 1 }));
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      });
      expect(captured).not.toBeNull();
      expect(captured!.command).toBe(process.execPath);
      expect(captured!.args[0]).toBe(`--max-old-space-size=${FILL_CHILD_HEAP_SIZE_MB}`);
      expect(captured!.args[1]).toBe(fillChildEntryPath());
      expect(captured!.args.slice(2)).toEqual([
        `--source=${request.sourcePath}`,
        `--plan=${request.planPath}`,
        `--candidate=${request.candidatePath}`,
        `--outcome=${request.outcomePath}`,
        `--max-bytes=12345`
      ]);
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  });

  it("resolves the child entry from the source layout and the built layout", async () => {
    const sourceEntry = fillChildEntryPath();
    expect(sourceEntry).toContain(join("src", "engines", "pdfjs-fill-child.ts"));
    expect(existsSync(sourceEntry)).toBe(true);

    const builtPath = join(REPO_ROOT, "packages", "core", "dist", "engines", "pdfjs-fill.js");
    expect(existsSync(builtPath), "run `npm run typecheck` first so the built layout exists").toBe(true);
    const built = (await import(pathToFileURL(builtPath).href)) as typeof import("../src/engines/pdfjs-fill.js");
    const builtEntry = built.fillChildEntryPath();
    expect(builtEntry).toContain(join("dist", "engines", "pdfjs-fill-child.js"));
    expect(existsSync(builtEntry)).toBe(true);
    expect(builtEntry).not.toBe(sourceEntry);
  });
});

describe("headless renderer capability", () => {
  it("produces appearance streams for text, checkmark and drawn signature without a canvas", async () => {
    const job = await makeJob("pdfjs-fill-draw-");
    try {
      const request = await job.request([
        { kind: "text", source: "test-source", page: 1, rect: { x: 50, y: 500, width: 150, height: 40 }, text: "Placed text" },
        { kind: "checkmark", source: "test-source", page: 1, rect: { x: 300, y: 100, width: 20, height: 20 } },
        {
          kind: "signature",
          source: "test-source",
          page: 1,
          rect: { x: 60, y: 620, width: 140, height: 50 },
          strokes: [[65, 630, 90, 650, 120, 625, 160, 648]]
        }
      ]);
      const outcome = await runFillChild(request);
      expect(outcome.status).toBe("filled");
      const text = (await readFile(request.candidatePath)).toString("latin1");
      // Each placement serialized its annotation with a real appearance
      // stream; OffscreenCanvas was never configured and never needed.
      expect(text).toContain("/Subtype /FreeText");
      expect(text).toContain("(Placed text) Tj");
      expect(text).toContain("/InkList");
      expect(text).toContain("/Subtype /Stamp");
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("cannot express an uploaded image anywhere in the child path", () => {
    // The plan schema has no image placement kind at all (KTD1 defers image
    // stamping because Node has no canvas capability).
    expect(() =>
      parseFormPlan({
        version: 1,
        source: "s",
        destination: "d",
        overwrite: false,
        burnIn: false,
        nonce: "u11",
        entries: [{ kind: "image", source: "s", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 } }]
      })
    ).toThrowError(/kind/);
    const childSource = readFileSync(fillChildEntryPath(), "utf8");
    expect(childSource).toContain("isOffscreenCanvasSupported: false");
    expect(childSource).toContain("isImageDecoderSupported: false");
    expect(childSource).not.toMatch(/bitmapId|createImageBitmap|ImageData|OffscreenCanvas\(/);
  });
});

describe("renderer version gate", () => {
  it("fails when the constant, a manifest or the installed package disagree", () => {
    const require = createRequire(import.meta.url);
    const installedVersion = JSON.parse(
      readFileSync(require.resolve("pdfjs-dist/package.json"), "utf8")
    ).version as string;
    const coreDependency = (JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> }).dependencies?.["pdfjs-dist"];
    const webDependency = (JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "web", "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> }).dependencies?.["pdfjs-dist"];

    // The real inputs agree: one owned constant behind the gate.
    expect(pdfjsPin()).toBe(PDFJS_PINNED_VERSION);
    expect(installedVersion).toBe(PDFJS_PINNED_VERSION);
    expect(
      evaluatePdfjsPin({
        constant: PDFJS_PINNED_VERSION,
        coreDependency,
        webDependency,
        installedVersion
      }).ok
    ).toBe(true);

    // Every disagreement mode fails.
    for (const overrides of [
      { coreDependency: "6.3.0" },
      { webDependency: "^6.3.289" },
      { webDependency: undefined },
      { installedVersion: "6.3.290" },
      { constant: "0.0.0" }
    ]) {
      const verdict = evaluatePdfjsPin({
        constant: PDFJS_PINNED_VERSION,
        coreDependency,
        webDependency,
        installedVersion,
        ...overrides
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.length).toBeGreaterThan(0);
    }
  });
});
