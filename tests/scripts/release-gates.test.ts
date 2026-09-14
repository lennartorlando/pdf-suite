import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EAGER_BASELINE_GZIP,
  assetPath,
  evaluateBundleGate
} from "../../scripts/check-editor-bundle.mjs";
import {
  floors,
  meetsFloor,
  parseGhostscriptVersion,
  parseOcrMyPdfVersion,
  parseQpdfVersion
} from "../../scripts/check-native-versions.mjs";
import {
  evaluateSc5Gate,
  parseMaxAssembleP95,
  readCommit,
  resolveGitDir,
  rotationRangesFor,
  sc5BudgetMs
} from "../../scripts/benchmark-page-editor.mjs";
import {
  checkCorpusMatch,
  environmentClass,
  evaluateBudget,
  percentileStats,
  resolveBudgetName
} from "../../scripts/benchmark-harness.mjs";
import { evaluateSc5FormGate, SC5_FORM_BUDGETS_MS } from "../../scripts/benchmark-form-filling.mjs";
import { BROWSER_BUDGETS_MS, evaluateBrowserGate } from "../../scripts/benchmark-browser.mjs";
import {
  GHOSTSCRIPT_SECURITY_FLOOR as BUILT_GS_FLOOR,
  OCRMY_PDF_FEATURE_FLOOR as BUILT_OCR_FLOOR,
  QPDF_SECURITY_FLOOR as BUILT_QPDF_FLOOR
} from "@pdf-compressor/core/native-floors";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("release gates: bundle checker", () => {
  it("pins the independently reproduced pre-editor eager baseline (1973 gzip bytes)", () => {
    expect(EAGER_BASELINE_GZIP).toBe(1973);
  });

  it("passes the current build and fails an impossible budget", () => {
    const eagerGzip = 3386;
    const ok = evaluateBundleGate({ eagerGzip, displayPlusWorker: 520351, lazyGraph: 529646 });
    expect(ok.sc1Ok).toBe(true);
    expect(ok.displayOk).toBe(true);
    expect(ok.lazyOk).toBe(true);
    // Deliberately impossible thresholds prove the gate can fail.
    expect(evaluateBundleGate({ eagerGzip, displayPlusWorker: 650 * 1024 + 1, lazyGraph: 1 }).displayOk).toBe(false);
    expect(evaluateBundleGate({ eagerGzip, displayPlusWorker: 1, lazyGraph: 2 * 1024 * 1024 + 1 }).lazyOk).toBe(false);
    expect(
      evaluateBundleGate({ eagerGzip: EAGER_BASELINE_GZIP + 20 * 1024 + 1, displayPlusWorker: 1, lazyGraph: 1 }).sc1Ok
    ).toBe(false);
  });

  it("resolves asset paths without URL-encoding, even under directories with spaces", () => {
    const self = fileURLToPath(pathToFileURL(fileURLToPath(import.meta.url)));
    expect(self).not.toMatch(/%20/i);
    // Prove decoding inside a directory that really contains spaces.
    const spaced = mkdtempSync(join(tmpdir(), "u6f spaces-"));
    try {
      const decoded = fileURLToPath(pathToFileURL(join(spaced, "x")));
      expect(decoded).toContain(" ");
      expect(decoded).not.toMatch(/%20/i);
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
    const resolved = assetPath("index--qc_VHCC.js");
    expect(resolved).not.toMatch(/%20/i);
    // The script source itself must use path-safe APIs everywhere.
    const source = readFileSync(join(HERE, "..", "..", "scripts", "check-editor-bundle.mjs"), "utf8");
    expect(source).toContain("fileURLToPath");
    expect(source).not.toMatch(/new URL\([^)]*\)\.pathname/);
  });

  it("round-trips file URLs through directories containing spaces", () => {
    const spaced = mkdtempSync(join(tmpdir(), "u6f spaces-"));
    try {
      const file = join(spaced, "probe.txt");
      writeFileSync(file, "spaces-ok");
      const roundTripped = fileURLToPath(pathToFileURL(file));
      expect(roundTripped).toBe(file);
      expect(readFileSync(roundTripped, "utf8")).toBe("spaces-ok");
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });
});

describe("release gates: native floors are shared, not duplicated", () => {
  it("reads the single source of truth from the built core", () => {
    expect(floors()).toEqual({
      QPDF_SECURITY_FLOOR: BUILT_QPDF_FLOOR,
      GHOSTSCRIPT_SECURITY_FLOOR: BUILT_GS_FLOOR,
      OCRMY_PDF_FEATURE_FLOOR: BUILT_OCR_FLOOR
    });
    expect(BUILT_QPDF_FLOOR).toBe("12.4.1");
    expect(BUILT_GS_FLOOR).toBe("10.07.1");
    expect(BUILT_OCR_FLOOR).toBe("17.0.0");
    const source = readFileSync(join(HERE, "..", "..", "scripts", "check-native-versions.mjs"), "utf8");
    expect(source).not.toMatch(/const QPDF_SECURITY_FLOOR = "/);
    expect(source).not.toMatch(/const GHOSTSCRIPT_SECURITY_FLOOR = "/);
    expect(source).not.toMatch(/const OCRMY_PDF_FEATURE_FLOOR = "/);
  });

  it("parses real tool output and enforces floors", () => {
    expect(parseQpdfVersion("qpdf version 12.4.1\nRun qpdf --copyright")).toBe("12.4.1");
    expect(parseQpdfVersion("garbage")).toBeNull();
    expect(parseGhostscriptVersion("10.07.1\n")).toBe("10.07.1");
    expect(parseGhostscriptVersion("nope")).toBeNull();
    expect(parseOcrMyPdfVersion("17.11.0\n")).toBe("17.11.0");
    expect(parseOcrMyPdfVersion("ocrmypdf 17.11.0")).toBe("17.11.0");
    expect(parseOcrMyPdfVersion("", "17.11.0\n")).toBe("17.11.0");
    expect(parseOcrMyPdfVersion("nope")).toBeNull();
    expect(meetsFloor("12.4.1", BUILT_QPDF_FLOOR)).toBe(true);
    expect(meetsFloor("11.9.0", BUILT_QPDF_FLOOR)).toBe(false);
  });
});

describe("release gates: benchmark SC5 gate", () => {
  it("compares p95 values against max(300ms, 20% beyond native p95)", () => {
    expect(sc5BudgetMs(10)).toBe(300);
    expect(sc5BudgetMs(500)).toBe(600);
    expect(evaluateSc5Gate(100, 10).withinSc5).toBe(true);
    expect(evaluateSc5Gate(300, 10).withinSc5).toBe(true);
    // Deliberately impossible budget proves the gate fails without
    // committing a failing threshold.
    expect(evaluateSc5Gate(301, 10).withinSc5).toBe(false);
    expect(evaluateSc5Gate(721, 600).withinSc5).toBe(false);
    expect(evaluateSc5Gate(720, 600).withinSc5).toBe(true);
  });

  it("parses the testable --max-assemble-p95-ms option", () => {
    expect(parseMaxAssembleP95(["node", "bench", "--max-assemble-p95-ms=0"])).toBe(0);
    expect(parseMaxAssembleP95(["node", "bench", "--max-assemble-p95-ms=12.5"])).toBe(12.5);
    expect(parseMaxAssembleP95(["node", "bench"])).toBeNull();
  });

  it("derives native rotation ranges identical to the core manifest", () => {
    const manifest = { version: 1 as const, pages: [
      { sourceId: "bench", page: 8, rotate: 90 as const },
      { sourceId: "bench", page: 7, rotate: 0 as const },
      { sourceId: "bench", page: 4, rotate: 90 as const },
      { sourceId: "bench", page: 1, rotate: 0 as const }
    ] };
    expect(rotationRangesFor(manifest)).toEqual({ 90: ["1,3"] });
  });

  it("discovers commits through a normal .git directory and a worktree pointer", () => {
    const root = mkdtempSync(join(tmpdir(), "u6f-git-"));
    try {
      mkdirSync(join(root, "real.git", "refs", "heads"), { recursive: true });
      writeFileSync(join(root, "real.git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(root, "real.git", "refs", "heads", "main"), "abc123\n");
      // Normal directory layout.
      mkdirSync(join(root, "normal", ".git", "refs", "heads"), { recursive: true });
      writeFileSync(join(root, "normal", ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(root, "normal", ".git", "refs", "heads", "main"), "def456\n");
      expect(resolveGitDir(join(root, "normal"))).toBe(join(root, "normal", ".git"));
      expect(readCommit(join(root, "normal"))).toBe("def456");
      // Worktree pointer layout.
      mkdirSync(join(root, "wt"));
      writeFileSync(join(root, "wt", ".git"), `gitdir: ${join(root, "real.git")}\n`);
      expect(resolveGitDir(join(root, "wt"))).toBe(join(root, "real.git"));
      expect(readCommit(join(root, "wt"))).toBe("abc123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("release gates: shared benchmark harness (U8)", () => {
  it("computes p95 over sorted samples", () => {
    const stats = percentileStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]);
    expect(stats.samples).toBe(20);
    expect(stats.p95Ms).toBe(200);
    expect(stats.minMs).toBe(10);
  });

  it("refuses to record against a changed corpus", () => {
    expect(checkCorpusMatch({ "a.pdf": "sha" }, { "a.pdf": "sha" }).ok).toBe(true);
    const changed = checkCorpusMatch({ "a.pdf": "sha" }, { "a.pdf": "other" });
    expect(changed.ok).toBe(false);
    expect(changed.mismatched).toEqual(["a.pdf"]);
    // No recorded corpus: first run admits anything.
    expect(checkCorpusMatch(undefined, { "a.pdf": "x" }).ok).toBe(true);
  });

  it("classifies hosted runners so their numbers can never pose as reference evidence", () => {
    expect(environmentClass({ CI: "true" })).toBe("hosted-runner");
    expect(environmentClass({ GITHUB_ACTIONS: "true" })).toBe("hosted-runner");
    expect(environmentClass({})).toBe("local");
  });

  it("refuses the reference-mac budget under CI and defaults each class to its own budget", () => {
    expect(resolveBudgetName([], {})).toBe("reference-mac");
    expect(resolveBudgetName([], { CI: "true" })).toBe("hosted-runner");
    expect(resolveBudgetName(["--budget=hosted-runner"], {})).toBe("hosted-runner");
    expect(() => resolveBudgetName(["--budget=reference-mac"], { CI: "true" })).toThrow(/reference-mac/);
    expect(() => resolveBudgetName(["--budget=bogus"], {})).toThrow(/budget/);
  });

  it("evaluates a pure budget verdict", () => {
    expect(evaluateBudget(100, 100).withinBudget).toBe(true);
    expect(evaluateBudget(101, 100).withinBudget).toBe(false);
  });
});

describe("release gates: form-fill SC5 gate (U8)", () => {
  it("keeps separate budgets per environment class and fails an impossible one", () => {
    expect(SC5_FORM_BUDGETS_MS["reference-mac"]).toBe(4000);
    expect(evaluateSc5FormGate(3999, "reference-mac").withinBudget).toBe(true);
    expect(evaluateSc5FormGate(4001, "reference-mac").withinBudget).toBe(false);
    expect(evaluateSc5FormGate(4001, "hosted-runner").withinBudget).toBe(true);
    expect(() => evaluateSc5FormGate(1, "nowhere")).toThrow();
  });
});

describe("release gates: browser SC3/SC4 gates (U8)", () => {
  it("fails an impossible budget on every gated metric", () => {
    for (const metric of ["coldOpen", "typeInput", "checkboxToggle", "dragMove", "dragCommit"] as const) {
      const ok = evaluateBrowserGate(metric, BROWSER_BUDGETS_MS["reference-mac"][metric], "reference-mac");
      expect(ok.withinBudget).toBe(true);
      const over = evaluateBrowserGate(metric, BROWSER_BUDGETS_MS["reference-mac"][metric] + 1, "reference-mac");
      expect(over.withinBudget).toBe(false);
    }
    expect(BROWSER_BUDGETS_MS["reference-mac"].coldOpen).toBe(1500);
    expect(BROWSER_BUDGETS_MS["reference-mac"].typeInput).toBe(50);
    expect(BROWSER_BUDGETS_MS["hosted-runner"].coldOpen).toBeGreaterThan(BROWSER_BUDGETS_MS["reference-mac"].coldOpen);
    expect(() => evaluateBrowserGate("nope", 1, "reference-mac")).toThrow();
  });

  it("keeps the browser driver development-only", () => {
    const manifest = JSON.parse(
      readFileSync(join(HERE, "..", "..", "package.json"), "utf8")
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(manifest.devDependencies?.puppeteer).toBeDefined();
    expect(manifest.dependencies?.puppeteer).toBeUndefined();
  });
});
