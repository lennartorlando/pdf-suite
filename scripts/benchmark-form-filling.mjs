#!/usr/bin/env node
/**
 * U8 form-filling benchmark (SC5), a thin operation definition over the
 * shared harness of KTD16 (scripts/benchmark-harness.mjs). Owns
 * docs/benchmarks/form-filling-baseline.json.
 *
 * Corpora: deterministic, generated, redistributable synthetic PDFs built
 * by tests/performance/form-corpora.mjs (form-100, form-200,
 * form-8page-2mb, scanned-form-icc). Regenerate: `--regen-corpora`.
 *
 * The measured operation is the real core fill path, not a stand-in:
 * `fillForm` (empty-password decryption where relevant, admission, plan
 * validation, the PDF.js write, qpdf appearance generation and rewrite,
 * revision collapse, strict validation) plus `verifyFormFill` (the
 * independent readback). `inventoryFormFields` and `checkFormPlan` are
 * measured separately so each stage's cost is visible.
 *
 * SC5 gate: the 100-field form's fill-plus-readback p95 against the budget
 * class of this run (reference-mac 4000ms; hosted-runner 12000ms). The
 * reference-mac budget is refused under CI, so a hosted-runner result can
 * never be recorded as reference evidence.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFormCorpora } from "../tests/performance/form-corpora.mjs";
import {
  BENCHMARK_DIR,
  checkCorpusMatch,
  collectAssetHashes,
  collectEnvironment,
  hasFlag,
  hashCorpusFiles,
  invokedDirectly,
  measure,
  readBaseline,
  resolveBudgetName,
  writeBaseline
} from "./benchmark-harness.mjs";

const BASELINE_PATH = join(BENCHMARK_DIR, "form-filling-baseline.json");
const SC5_CORPUS = "form-100.pdf";

/** SC5 budgets by environment class; hosted runners get generous headroom. */
export const SC5_FORM_BUDGETS_MS = { "reference-mac": 4000, "hosted-runner": 12000 };

/** Pure SC5 verdict; exported so the gate can be proven fallible in tests. */
export function evaluateSc5FormGate(p95Ms, budgetName) {
  const budgetMs = SC5_FORM_BUDGETS_MS[budgetName];
  if (budgetMs === undefined) throw new Error(`Unknown budget class "${budgetName}".`);
  return {
    p95Ms,
    budgetMs,
    budgetName,
    withinBudget: p95Ms <= budgetMs,
    note: "SC5: 100-field core fill (decryption, admission, write, appearance, collapse, validation, readback) p95 against the run's budget class."
  };
}

/** Turn an inventory into a fully answered plan: every fillable field gets a legal value. */
function planFor(inventory, source, destination, nonce) {
  const entries = inventory.fields.map((field, index) => {
    const fillable = !field.readOnly && !field.password && !field.hidden &&
      ["text", "checkbox", "radio", "choice"].includes(field.type);
    if (!fillable) return { kind: "field", fieldId: field.fieldId, status: "skipped" };
    if (field.type === "checkbox" || field.type === "radio") {
      const on = field.allowedValues?.map((v) => v.text).find((v) => v !== "Off") ?? "Yes";
      return { kind: "field", fieldId: field.fieldId, status: "answered", value: on };
    }
    if (field.type === "choice") {
      return { kind: "field", fieldId: field.fieldId, status: "answered", value: field.allowedValues?.[0]?.text ?? "" };
    }
    return { kind: "field", fieldId: field.fieldId, status: "answered", value: `value-${String(index + 1).padStart(3, "0")}` };
  });
  entries.push({
    kind: "text",
    source,
    page: 1,
    rect: { x: 50, y: 40, width: 200, height: 20 },
    text: "benchmark-placement"
  });
  return {
    version: 1,
    source,
    destination,
    overwrite: true,
    burnIn: false,
    nonce,
    entries
  };
}

if (invokedDirectly(import.meta.url)) {
  const regen = hasFlag(process.argv, "--regen-corpora");
  const budgetName = resolveBudgetName(process.argv);
  const corpora = ensureFormCorpora(regen);
  const corpusHashes = hashCorpusFiles([...corpora.values()]);

  const prior = readBaseline(BASELINE_PATH);
  if (!regen && prior?.corpusHashes) {
    const match = checkCorpusMatch(prior.corpusHashes, corpusHashes);
    if (!match.ok) {
      console.error(
        `benchmark-form-filling: FAIL: corpus hashes changed (${match.mismatched.join(", ")}); ` +
          "regenerate with --regen-corpora if the change is intentional."
      );
      process.exit(1);
    }
  }

  const assetHashes = collectAssetHashes();
  if (Object.keys(assetHashes).length === 0) {
    console.error("benchmark-form-filling: FAIL: apps/web/dist is missing; run `npm run build` first.");
    process.exit(1);
  }

  const core = await import("../packages/core/dist/index.js");

  const results = {};
  const scratch = mkdtempSync(join(tmpdir(), "u8-fill-bench-"));
  try {
    for (const [name, corpusPath] of corpora) {
      // One unmeasured inventory pass builds the approved plan; the plan is
      // then fixed for every measured sample.
      const first = await core.inventoryFormFields(corpusPath, { workspaceParent: scratch });
      const destination = join(scratch, `out-${name}`);
      const plan = planFor(first.inventory, corpusPath, destination, `bench-${randomUUID()}`);
      const planPath = join(scratch, `plan-${name}.json`);
      writeFileSync(planPath, JSON.stringify(plan));

      const inventory = await measure(
        () => core.inventoryFormFields(corpusPath, { workspaceParent: scratch }),
        `inventory-${name}`
      );
      const checkPlan = await measure(
        () => core.checkFormPlan(plan, corpusPath, { workspaceParent: scratch }),
        `check-plan-${name}`
      );
      const fillAndReadback = await measure(async () => {
        await core.fillForm({
          sourcePath: corpusPath,
          planPath,
          destinationPath: destination,
          workspaceParent: scratch
        });
        const verdict = await core.verifyFormFill(plan, corpusPath, destination, { workspaceParent: scratch });
        if (!verdict.allApplied) throw new Error(`readback failed for ${name}`);
      }, `core-fill-${name}`);

      const entry = { inventory, checkPlan, coreFill: fillAndReadback };
      if (name === SC5_CORPUS) entry.sc5 = evaluateSc5FormGate(fillAndReadback.p95Ms, budgetName);
      results[name] = entry;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const environment = await collectEnvironment();
  const baseline = {
    ...environment,
    assetHashes,
    corpusHashes,
    method: { warmups: 5, samples: 20, note: "Fill and readback timed as one operation per SC5." },
    budgetClass: budgetName,
    results,
    // The browser section is owned by benchmark-browser.mjs; preserve it so
    // this run never silently deletes recorded browser evidence.
    ...(prior?.browser !== undefined ? { browser: prior.browser } : {}),
    corpusLicense: "Generated synthetic fixtures (no private data); safe to redistribute."
  };
  writeBaseline(BASELINE_PATH, baseline);

  let failed = false;
  console.log(
    `benchmark-form-filling: ${environment.class} (${environment.os}, ${environment.hardwareClass.cpuModel}), ` +
      `budget ${budgetName}, qpdf ${environment.qpdf}, gs ${environment.ghostscript}, node ${environment.node}`
  );
  for (const [name, entry] of Object.entries(results)) {
    console.log(
      `  ${name}: inventory p95 ${entry.inventory.p95Ms}ms, check-plan p95 ${entry.checkPlan.p95Ms}ms, ` +
        `fill+readback p95 ${entry.coreFill.p95Ms}ms` +
        (entry.sc5 ? `, SC5 ${entry.sc5.withinBudget ? "within" : "OVER"} budget ${entry.sc5.budgetMs}ms` : "")
    );
    if (entry.sc5 && !entry.sc5.withinBudget) failed = true;
  }
  console.log(`benchmark-form-filling: wrote ${BASELINE_PATH}`);
  if (failed) {
    console.error("benchmark-form-filling: FAIL: SC5 exceeded its budget.");
    process.exit(1);
  }
}
