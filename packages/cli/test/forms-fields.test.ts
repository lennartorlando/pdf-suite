import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFormPlan, serializeFormPlan, type FormPlanEntry } from "@pdf-compressor/core/form-plan";
import type { FormFieldEntry } from "@pdf-compressor/core/form-inventory";
import { buildTestPdf, sha256File, type FixtureFeatures, type FixturePage } from "../../core/test/pdf-fixtures.js";
import { mintFormReceipt, runFormsCommand, type FormsCommandDeps } from "../src/commands/forms.js";

let scratch: string;
let workspaceParent: string;
let ledgerDir: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pdf-forms-cli-fields-"));
  workspaceParent = join(scratch, "workspaces");
  ledgerDir = join(scratch, "ledger");
  await mkdir(workspaceParent);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let counter = 0;
function unique(name: string): string {
  counter += 1;
  return `${counter}-${name}`;
}

function deps(extra: Partial<FormsCommandDeps> = {}): FormsCommandDeps {
  return { workspaceParent, ledgerDir, isInteractive: false, ...extra };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeSource(
  name: string,
  features: FixtureFeatures,
  pages: FixturePage[] = [{}]
): Promise<string> {
  const path = join(scratch, `${name}.pdf`);
  await writeFile(path, buildTestPdf(pages, features));
  return path;
}

async function writePlan(
  name: string,
  sourcePath: string,
  entries: readonly FormPlanEntry[],
  extras: { overwrite?: boolean; burnIn?: boolean } = {}
): Promise<{ planPath: string; destPath: string }> {
  const destPath = join(scratch, `${name}-out.pdf`);
  const planPath = join(scratch, `${name}.plan.json`);
  await writeFile(
    planPath,
    serializeFormPlan(
      parseFormPlan({
        version: 1,
        source: sourcePath,
        destination: destPath,
        overwrite: extras.overwrite ?? false,
        burnIn: extras.burnIn ?? false,
        nonce: `nonce-${name}`,
        entries
      })
    )
  );
  return { planPath, destPath };
}

async function inventoryOf(sourcePath: string): Promise<FormFieldEntry[]> {
  const result = await runFormsCommand(["fields", sourcePath, "--json"], deps());
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as { inventory: { fields: FormFieldEntry[] } };
  return payload.inventory.fields;
}

function fieldIdByLabel(fields: readonly FormFieldEntry[], label: string): string {
  const field = fields.find((candidate) => candidate.label?.text.text === label);
  if (!field) throw new Error(`No field labelled ${label}`);
  return field.fieldId;
}

/** Mint a browser-channel receipt over the plan and source's current bytes. */
async function approvePlan(planPath: string, sourcePath: string, minted = new Date()): Promise<string> {
  const plan = parseFormPlan(JSON.parse(await readFile(planPath, "utf8")));
  const receipt = mintFormReceipt(
    plan.nonce,
    await sha256File(planPath),
    await sha256File(sourcePath),
    "browser",
    minted
  );
  const receiptPath = join(scratch, `${unique("receipt")}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  return receiptPath;
}

describe("forms fields", () => {
  it("inventories stable identifiers, widget sets, label sources, types, allowed values, flags and pages", async () => {
    const source = await writeSource("inv-all", {
      formTextField: true,
      formPrefilledText: "PREFILL-U4",
      formMaxLen: true,
      formCheckbox: true,
      formRadio: true,
      formChoice: true,
      formSpanPages: true,
      formMergedField: true,
      emptySignatureField: true
    }, [{}, {}]);

    const first = await runFormsCommand(["fields", source, "--json"], deps());
    expect(first.exitCode).toBe(0);
    expect(first.stdout).not.toContain("PREFILL-U4");
    const payload = JSON.parse(first.stdout) as { ok: boolean; pageCount: number; inventory: { fields: FormFieldEntry[] } };
    expect(payload.ok).toBe(true);
    expect(payload.pageCount).toBe(2);
    const fields = payload.inventory.fields;

    // Field identifiers are stable across runs (the loop depends on it).
    const second = await runFormsCommand(["fields", source, "--json"], deps());
    const rerun = (JSON.parse(second.stdout) as { inventory: { fields: FormFieldEntry[] } }).inventory.fields;
    expect(rerun.map((field) => field.fieldId)).toEqual(fields.map((field) => field.fieldId));

    const byLabel = new Map(fields.map((field) => [field.label?.text.text ?? "", field]));
    const text = byLabel.get("fixture-name");
    expect(text?.type).toBe("text");
    expect(text?.label?.source).toBe("name");
    expect(text?.maxLength).toBe(5);
    expect(text?.widgets).toHaveLength(1);
    expect(text?.widgets[0]?.page).toBe(1);

    const check = byLabel.get("fixture-check");
    expect(check?.type).toBe("checkbox");
    expect(check?.allowedValues?.map((value) => value.text)).toContain("Ja");

    const radio = byLabel.get("fixture-radio");
    expect(radio?.type).toBe("radio");
    expect(radio?.widgets.map((widget) => widget.page).sort()).toEqual([1, 2]);
    expect(radio?.allowedValues?.map((value) => value.text)).toEqual(expect.arrayContaining(["A", "B"]));

    const choice = byLabel.get("fixture-choice");
    expect(choice?.type).toBe("choice");
    expect(choice?.allowedValues?.map((value) => value.text)).toEqual(["alpha", "beta", "gamma"]);

    const span = byLabel.get("fixture-span");
    expect(span?.widgets.map((widget) => widget.page).sort()).toEqual([1, 2]);

    const merged = byLabel.get("fixture-merged");
    expect(merged?.widgets[0]?.widgetId).toBe(merged?.fieldId);

    expect(fields.some((field) => field.type === "signature")).toBe(true);

    // Current values are digested, never emitted (R13).
    for (const field of fields) {
      expect(field).not.toHaveProperty("currentValue");
    }
    const redacted = fields as readonly (FormFieldEntry & { currentValueDigest?: string })[];
    expect(text && redacted.find((f) => f.fieldId === text.fieldId)?.currentValueDigest).toBe(sha256("PREFILL-U4"));
    expect(check && redacted.find((f) => f.fieldId === check.fieldId)?.currentValueDigest).toBe(sha256("Off"));
  });

  it("reports the fill-blocking flags and marks document-derived labels", async () => {
    const source = await writeSource("inv-flags", {
      formTextField: true,
      formTooltip: "Vollständiger Name",
      formReadOnly: true,
      formPassword: true,
      formHiddenWidget: true,
      formFieldScripts: true
    });
    const fields = await inventoryOf(source);
    const field = fields.find((candidate) => candidate.type === "text");
    expect(field?.readOnly).toBe(true);
    expect(field?.password).toBe(true);
    expect(field?.hidden).toBe(true);
    expect(field?.computed).toBe(true);
    expect(field?.required).toBe(false);
    expect(field?.label?.source).toBe("tooltip");
    expect(field?.label?.text.documentDerived).toBe(true);
    expect(field?.label?.text.text).toBe("Vollständiger Name");
  });

  it("reveals current values verbatim only under --reveal-values", async () => {
    const source = await writeSource("inv-reveal", { formTextField: true, formPrefilledText: "PREFILL-U4" });
    const result = await runFormsCommand(["fields", source, "--json", "--reveal-values"], deps());
    expect(result.exitCode).toBe(0);
    const fields = (JSON.parse(result.stdout) as { inventory: { fields: FormFieldEntry[] } }).inventory.fields;
    expect(fields.find((field) => field.label?.text.text === "fixture-name")?.currentValue).toBe("PREFILL-U4");
  });

  it("reports no derivable label for an unnamed field without a tooltip (AE5)", async () => {
    const source = await writeSource("inv-unlabeled", { formTextField: true, formUnnamedField: true });
    const fields = await inventoryOf(source);
    const unnamed = fields.filter((field) => field.label === undefined);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]?.type).toBe("text");
  });
});

describe("forms validate", () => {
  it("re-emits only the outstanding entries and digests every value", async () => {
    const source = await writeSource("val-mix", { formTextField: true, formCheckbox: true });
    const fields = await inventoryOf(source);
    const textId = fieldIdByLabel(fields, "fixture-name");
    const checkId = fieldIdByLabel(fields, "fixture-check");
    const { planPath } = await writePlan("val-mix", source, [
      { kind: "field", fieldId: textId, status: "answered", value: "SECRET-VALUE-9" },
      { kind: "field", fieldId: checkId, status: "proposed", value: "Ja" }
    ]);

    const result = await runFormsCommand(["validate", planPath, "--json"], deps());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("SECRET-VALUE-9");
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      outstanding: { fieldId: string; status: string }[];
      entries: Record<string, unknown>[];
      planDigest: string;
      sourceDigest: string;
      nonce: string;
    };
    expect(payload.ok).toBe(true);
    // Idempotent: only non-terminal entries come back (KTD8).
    expect(payload.outstanding).toEqual([{ fieldId: checkId, status: "proposed" }]);
    expect(payload.planDigest).toBe(await sha256File(planPath));
    expect(payload.sourceDigest).toBe(await sha256File(source));
    expect(payload.nonce).toBe("nonce-val-mix");
    const answered = payload.entries.find((entry) => entry["fieldId"] === textId);
    expect(answered).not.toHaveProperty("value");
    expect(answered?.["valueDigest"]).toBe(sha256("SECRET-VALUE-9"));

    // A second run re-emits the same outstanding set.
    const again = await runFormsCommand(["validate", planPath, "--json"], deps());
    expect((JSON.parse(again.stdout) as { outstanding: unknown[] }).outstanding).toEqual(payload.outstanding);
  });

  it("refuses a signature placement before any field work", async () => {
    const source = await writeSource("val-sig", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath } = await writePlan("val-sig", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "x" },
      {
        kind: "signature",
        source,
        page: 1,
        rect: { x: 10, y: 10, width: 80, height: 30 },
        strokes: [[10, 10, 90, 40]]
      }
    ]);
    const result = await runFormsCommand(["validate", planPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_SIGNATURE_FORBIDDEN");
  });

  it("refuses a plan entry that names a field the document does not contain", async () => {
    const source = await writeSource("val-unknown", { formTextField: true });
    const { planPath } = await writePlan("val-unknown", source, [
      { kind: "field", fieldId: "999 0 R", status: "answered", value: "x" }
    ]);
    const result = await runFormsCommand(["validate", planPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_UNKNOWN_FIELD");
  });
});

describe("forms verify", () => {
  it("confirms every approved entry on the delivered artifact", async () => {
    const source = await writeSource("ver-ok", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath } = await writePlan("ver-ok", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "APPROVED-7" }
    ]);
    const receiptPath = await approvePlan(planPath, source);
    const applied = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(applied.exitCode).toBe(0);

    const verified = await runFormsCommand(["verify", destPath, "--plan", planPath, "--json"], deps());
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout).not.toContain("APPROVED-7");
    const payload = JSON.parse(verified.stdout) as {
      ok: boolean;
      status: string;
      fields: { fieldId: string; applied: boolean; expectedDigest?: string }[];
    };
    expect(payload.status).toBe("verified");
    expect(payload.fields).toHaveLength(1);
    expect(payload.fields[0]?.applied).toBe(true);
    expect(payload.fields[0]?.expectedDigest).toBe(sha256("APPROVED-7"));
  });

  it("reports a mismatch with digested expected and actual values", async () => {
    const source = await writeSource("ver-mismatch", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath } = await writePlan("ver-mismatch", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "APPROVED-8" }
    ]);
    // The artifact at the approved destination is a copy of the source: the
    // approved value was never written.
    await cp(source, destPath);

    const result = await runFormsCommand(["verify", destPath, "--plan", planPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain("APPROVED-8");
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      code: string;
      fields: { applied: boolean; expectedDigest?: string; actualDigest?: string; expected?: string; actual?: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("FILL_VERIFY_MISMATCH");
    expect(payload.fields[0]?.applied).toBe(false);
    expect(payload.fields[0]?.expectedDigest).toBe(sha256("APPROVED-8"));
    expect(payload.fields[0]?.actualDigest).toBe(sha256(""));
    expect(payload.fields[0]).not.toHaveProperty("expected");
    expect(payload.fields[0]).not.toHaveProperty("actual");
  });

  it("refuses to verify an artifact that is not the plan's destination", async () => {
    const source = await writeSource("ver-binding", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath } = await writePlan("ver-binding", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "skipped" }
    ]);
    const other = await writeSource("ver-other", { formTextField: true });
    const result = await runFormsCommand(["verify", other, "--plan", planPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_PLAN_SOURCE_MISMATCH");
  });
});
