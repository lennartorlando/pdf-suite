#!/usr/bin/env node
/**
 * U6 reproducible benchmark (SC5 plus honest SC4/SC7 probes), now a thin
 * operation definition over the shared harness of KTD16
 * (scripts/benchmark-harness.mjs). This script owns the `results` section
 * of docs/benchmarks/page-editor-baseline.json; the `browser` section is
 * owned by scripts/benchmark-browser.mjs and preserved verbatim here.
 *
 * Corpora: deterministic, generated, redistributable synthetic PDFs
 * (tests/performance/corpus-{20,100,500}.pdf). Each page carries a distinct
 * MediaBox width and marker label so order survives assembly checks.
 * Regenerate: `node scripts/benchmark-page-editor.mjs --regen-corpora`.
 *
 * Method: five warmups plus twenty measured samples per operation.
 * Measured for real: core inspect, core assemble, core validate, equivalent
 * direct native pipeline (qpdf --json + one qpdf page-selection mutation +
 * qpdf --check with result validation), 100-page in-memory manifest/gesture
 * latency, cancellation/cleanup timing. Recorded honestly: commit (read
 * from .git/HEAD or a worktree .git pointer, never via git), hardware
 * class without private identifiers, OS, Node, qpdf/Ghostscript versions,
 * environment class, production asset hashes, corpus hashes.
 *
 * Browser criteria are measured by scripts/benchmark-browser.mjs into the
 * `browser` section of the same baseline. What stays `unverified`: the
 * criteria no installed harness can reach yet (SC7 in-flight cancellation,
 * SC8 streaming RSS). This script exits nonzero when any measured gate
 * (SC5 p95 overhead, or --max-assemble-p95-ms when provided) is exceeded,
 * or when the on-disk corpora no longer match the recorded hashes without
 * --regen-corpora.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SAMPLES,
  DEFAULT_WARMUPS,
  BENCHMARK_DIR,
  PERF_DIR,
  checkCorpusMatch,
  collectAssetHashes,
  collectEnvironment,
  execCapture,
  hashCorpusFiles,
  hasFlag,
  invokedDirectly,
  measure,
  readBaseline,
  writeBaseline
} from "./benchmark-harness.mjs";

const BASELINE_PATH = join(BENCHMARK_DIR, "page-editor-baseline.json");
const WARMUPS = DEFAULT_WARMUPS;
const SAMPLES = DEFAULT_SAMPLES;

/* --- pure SC5 gate (exported for tests; p95 compared, never medians) --- */

/** Budget: core assemble p95 must stay within max(300ms, 20% beyond native p95). */
export function sc5BudgetMs(nativeP95Ms) {
  return Math.max(300, nativeP95Ms * 1.2);
}

export function evaluateSc5Gate(coreP95Ms, nativeP95Ms) {
  const budgetMs = +sc5BudgetMs(nativeP95Ms).toFixed(2);
  return {
    coreP95Ms,
    nativeP95Ms,
    budgetMs,
    withinSc5: coreP95Ms <= sc5BudgetMs(nativeP95Ms),
    note: "SC5 gate: core assemble p95 within max(300ms, 20% beyond direct native pipeline p95)."
  };
}

/* --- deterministic minimal-PDF builder (standalone; mirrors the TS test fixture shape) --- */

function buildPdf(pageCount, labelPrefix) {
  const bodies = new Map();
  let nextId = 1;
  const catalogId = nextId++;
  const pagesId = nextId++;
  const pageIds = [];
  for (let i = 0; i < pageCount; i += 1) pageIds.push(nextId++);
  const contentIds = [];
  for (let i = 0; i < pageCount; i += 1) contentIds.push(nextId++);
  const fontId = nextId++;
  bodies.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  bodies.set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`);
  for (let i = 0; i < pageCount; i += 1) {
    const width = 600 + i;
    bodies.set(
      pageIds[i],
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} 792] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    );
    const stream = `BT /F1 24 Tf 100 700 Td (${labelPrefix}-${i + 1}) Tj ET`;
    bodies.set(contentIds[i], `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  bodies.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const ordered = [...bodies.entries()].sort((a, b) => a[0] - b[0]);
  const maxId = ordered[ordered.length - 1][0];
  const parts = ["%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"];
  const offsets = new Map();
  const len = (t) => Buffer.byteLength(t, "latin1");
  for (const [id, body] of ordered) {
    offsets.set(id, parts.reduce((t, p) => t + len(p), 0));
    parts.push(`${id} 0 obj\n${body}\nendobj\n`);
  }
  const startxref = parts.reduce((t, p) => t + len(p), 0);
  const xref = [`xref\n0 ${maxId + 1}\n0000000000 65535 f \n`];
  for (let id = 1; id <= maxId; id += 1) {
    const off = offsets.get(id);
    xref.push(off === undefined ? "0000000000 00000 f \n" : `${String(off).padStart(10, "0")} 00000 n \n`);
  }
  return Buffer.from(parts.join("") + xref.join("") + `trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`, "latin1");
}

export function ensurePageEditorCorpora(regen) {
  mkdirSync(PERF_DIR, { recursive: true });
  const specs = [
    ["corpus-20.pdf", 20],
    ["corpus-100.pdf", 100],
    ["corpus-500.pdf", 500]
  ];
  for (const [name, pages] of specs) {
    const path = join(PERF_DIR, name);
    if (!existsSync(path) || regen) writeFileSync(path, buildPdf(pages, name.replace(".pdf", "")));
  }
  return specs.map(([name]) => join(PERF_DIR, name));
}

/* --- helpers shared through benchmark-harness.mjs (re-exported for tests) --- */

export { readCommit, resolveGitDir } from "./benchmark-harness.mjs";

/**
 * Output-position rotation ranges for the direct native pipeline, mirroring
 * the core manifest exactly: for each relative angle, the 1-based output
 * positions carrying that rotation, comma-joined into a single range.
 */
export function rotationRangesFor(manifest) {
  const positions = { 90: [], 180: [], 270: [] };
  manifest.pages.forEach((entry, index) => {
    const rotate = entry.rotate ?? 0;
    if (rotate === 90 || rotate === 180 || rotate === 270) positions[rotate].push(index + 1);
  });
  const ranges = {};
  for (const angle of [90, 180, 270]) {
    if (positions[angle].length > 0) ranges[angle] = [positions[angle].join(",")];
  }
  return ranges;
}

export function parseMaxAssembleP95(argv) {
  for (const arg of argv) {
    const match = /^--max-assemble-p95-ms=(\d+(?:\.\d+)?)$/.exec(arg);
    if (match) return Number(match[1]);
  }
  return null;
}

if (invokedDirectly(import.meta.url)) {
  const regen = hasFlag(process.argv, "--regen-corpora");
  const maxAssembleP95 = parseMaxAssembleP95(process.argv);
  const corpora = ensurePageEditorCorpora(regen);

  /* Dynamic imports of the built core (benchmark runs after `npm run build`). */
  const core = await import("../packages/core/dist/index.js");
  const manifestMod = await import("../packages/core/dist/page-manifest.js");

  const corpusHashes = hashCorpusFiles(corpora);
  const prior = readBaseline(BASELINE_PATH);
  if (!regen && prior?.corpusHashes) {
    const match = checkCorpusMatch(prior.corpusHashes, corpusHashes);
    if (!match.ok) {
      console.error(
        `benchmark-page-editor: FAIL: corpus hashes changed (${match.mismatched.join(", ")}); ` +
          "regenerate with --regen-corpora if the change is intentional."
      );
      process.exit(1);
    }
  }

  const assetHashes = collectAssetHashes();
  if (Object.keys(assetHashes).length === 0) {
    console.error("benchmark-page-editor: FAIL: apps/web/dist is missing; run `npm run build` first.");
    process.exit(1);
  }

  /* Manifests: reverse order with a 90-degree rotation on every 4th output page. */
  function manifestFor(sourceId, pageCount) {
    const pages = [];
    for (let p = pageCount; p >= 1; p -= 1) {
      const entry = { sourceId, page: p };
      if (p % 4 === 0) entry.rotate = 90;
      pages.push(entry);
    }
    return manifestMod.parsePageManifest({ version: 1, pages });
  }

  const results = {};
  const scratchDirs = [];
  try {
    for (const corpusPath of corpora) {
      const name = corpusPath.split("/").pop();
      const pageCount = Number(/corpus-(\d+)/.exec(name)[1]);
      const manifest = manifestFor("bench", pageCount);
      const scratch = mkdtempSync(join(tmpdir(), "u6-bench-"));
      scratchDirs.push(scratch);
      try {
        const coreInspect = await measure(
          () => core.inspectSources([{ id: "bench", path: corpusPath }]),
          `core-inspect-${name}`
        );
        const coreAssemble = await measure(
          async () => {
            const dest = join(scratch, `a-${randomUUID()}.pdf`);
            await core.assemblePages({ sources: [{ id: "bench", path: corpusPath }], manifest, destinationPath: dest });
          },
          `core-assemble-${name}`
        );

        // Equivalent direct native pipeline: the same single qpdf
        // page-selection mutation the core runs for this manifest
        // (reversed order, same relative rotations, same structural
        // optimization flags), bracketed by --json inspection and --check,
        // with the result validated for page count.
        const reversed = Array.from({ length: pageCount }, (_, i) => pageCount - i).join(",");
        const rotations = rotationRangesFor(manifest);
        const directNative = await measure(async () => {
          const dest = join(scratch, `n-${randomUUID()}.pdf`);
          await execCapture("qpdf", ["--json", "--", corpusPath]);
          const mutationArgs = ["--", corpusPath, "--pages", `--file=${corpusPath}`, `--range=${reversed}`, "--"];
          for (const angle of [90, 180, 270]) {
            if (rotations[angle]) mutationArgs.push(`--rotate=+${angle}:${rotations[angle].join(",")}`);
          }
          mutationArgs.push(
            "--object-streams=generate",
            "--compress-streams=y",
            "--recompress-flate",
            "--",
            dest
          );
          await execCapture("qpdf", mutationArgs);
          await execCapture("qpdf", ["--check", "--", dest]);
          const { stdout } = await execCapture("qpdf", ["--json", "--", dest]);
          const parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed.pages) || parsed.pages.length !== pageCount) {
            throw new Error(
              `direct native pipeline produced ${Array.isArray(parsed.pages) ? parsed.pages.length : "?"} pages, expected ${pageCount}`
            );
          }
        }, `direct-native-${name}`);

        const sc5 = evaluateSc5Gate(coreAssemble.p95Ms, directNative.p95Ms);

        let entry = { inspect: coreInspect, assemble: coreAssemble, directNative, sc5 };

        if (name === "corpus-100.pdf") {
          // 100-page in-memory gesture latency: pure manifest parse + reorder/rotate/delete ops.
          const gesture = await measure(async () => {
            const parsed = manifestMod.parsePageManifest(JSON.parse(JSON.stringify({ version: 1, pages: manifest.pages })));
            const pages = [...parsed.pages];
            const [moved] = pages.splice(49, 1);
            pages.unshift(moved);
            pages[9] = { ...pages[9], rotate: 90 };
            pages.splice(19, 1);
          }, "gesture-100-page-manifest-node");
          entry.gesture = { ...gesture, note: "Node-side manifest ops; the browser p95 lives in the browser section (benchmark-browser.mjs)." };

          // Cancellation/cleanup timing: abort before start must fail fast with no residue.
          const controller = new AbortController();
          const cancelStart = performance.now();
          const cancelDest = join(scratch, `c-${randomUUID()}.pdf`);
          controller.abort();
          let cancelCode = "";
          try {
            await core.assemblePages({
              sources: [{ id: "bench", path: corpusPath }],
              manifest,
              destinationPath: cancelDest,
              signal: controller.signal
            });
          } catch (error) {
            cancelCode = error.code ?? error.name ?? "unknown";
          }
          entry.cancellation = {
            abortToRejectionMs: +(performance.now() - cancelStart).toFixed(2),
            code: cancelCode,
            destCreated: existsSync(cancelDest),
            note: "Pre-start abort path; SC7 process-group timing needs an in-flight native process and stays unverified."
          };
        }
        results[name] = entry;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  } finally {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  }

  const environment = await collectEnvironment();
  const baseline = {
    ...environment,
    assetHashes,
    corpusHashes,
    method: { warmups: WARMUPS, samples: SAMPLES },
    owners: {
      baseline: "scripts/benchmark-page-editor.mjs",
      browser: "scripts/benchmark-browser.mjs (the browser section is preserved verbatim when present)"
    },
    results,
    // The browser section is owned by benchmark-browser.mjs; preserve it so
    // this run never silently deletes recorded browser evidence.
    ...(prior?.browser !== undefined ? { browser: prior.browser } : {}),
    unverified: [
      "SC7 in-flight cancellation (500ms signal / 2s group termination / 2s cleanup): only the pre-start abort path is timed here.",
      "SC8 100 MiB streaming RSS: needs an isolated memory harness the browser driver does not provide; not measured."
    ],
    corpusLicense: "Generated synthetic fixtures (no private data); safe to redistribute."
  };

  writeBaseline(BASELINE_PATH, baseline);

  let failed = false;
  console.log(
    `benchmark-page-editor: ${environment.class} (${environment.os}, ${environment.hardwareClass.cpuModel}), qpdf ${environment.qpdf}, gs ${environment.ghostscript}, node ${environment.node}`
  );
  for (const [name, entry] of Object.entries(results)) {
    console.log(`  ${name}: inspect p95 ${entry.inspect.p95Ms}ms, assemble p95 ${entry.assemble.p95Ms}ms, native p95 ${entry.directNative.p95Ms}ms, SC5 ${entry.sc5.withinSc5 ? "within" : "OVER"} budget (p95 vs budget ${entry.sc5.budgetMs}ms)`);
    if (!entry.sc5.withinSc5) failed = true;
    if (maxAssembleP95 !== null && entry.assemble.p95Ms > maxAssembleP95) {
      console.error(`  ${name}: FAIL: assemble p95 ${entry.assemble.p95Ms}ms exceeds --max-assemble-p95-ms=${maxAssembleP95}ms.`);
      failed = true;
    }
    if (entry.gesture) console.log(`  gesture-100: p95 ${entry.gesture.p95Ms}ms (node manifest ops; browser p95 in the browser section)`);
    if (entry.cancellation) console.log(`  cancellation: ${entry.cancellation.abortToRejectionMs}ms -> ${entry.cancellation.code}`);
  }
  console.log(`benchmark-page-editor: wrote ${BASELINE_PATH}`);
  if (failed) {
    console.error("benchmark-page-editor: FAIL: one or more measured gates exceeded their budget.");
    process.exit(1);
  }
}
