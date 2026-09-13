import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultNativeRunner,
  type NativeRunner,
  type ProcessResult
} from "@pdf-compressor/core";
import { parseFormPlan, serializeFormPlan, type FormPlan, type FormPlanEntry } from "@pdf-compressor/core/form-plan";
import type { FormFieldEntry } from "@pdf-compressor/core/form-inventory";
import { buildTestPdf, sha256File, type FixtureFeatures, type FixturePage } from "../../core/test/pdf-fixtures.js";
import {
  mintFormReceipt,
  parseApplyArgs,
  runFormsCommand,
  type FormsCommandDeps
} from "../src/commands/forms.js";

let scratch: string;
let workspaceParent: string;
let ledgerDir: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pdf-forms-cli-approval-"));
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

function sha256(value: string | Buffer): string {
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
): Promise<{ planPath: string; destPath: string; plan: FormPlan }> {
  const destPath = join(scratch, `${name}-out.pdf`);
  const planPath = join(scratch, `${name}.plan.json`);
  const plan = parseFormPlan({
    version: 1,
    source: sourcePath,
    destination: destPath,
    overwrite: extras.overwrite ?? false,
    burnIn: extras.burnIn ?? false,
    nonce: `nonce-${name}`,
    entries
  });
  await writeFile(planPath, serializeFormPlan(plan));
  return { planPath, destPath, plan };
}

async function inventoryOf(sourcePath: string): Promise<FormFieldEntry[]> {
  const result = await runFormsCommand(["fields", sourcePath, "--json"], deps());
  expect(result.exitCode).toBe(0);
  return (JSON.parse(result.stdout) as { inventory: { fields: FormFieldEntry[] } }).inventory.fields;
}

function fieldIdByLabel(fields: readonly FormFieldEntry[], label: string): string {
  const field = fields.find((candidate) => candidate.label?.text.text === label);
  if (!field) throw new Error(`No field labelled ${label}`);
  return field.fieldId;
}

/** A terminal one-field plan against a fresh fixture, ready for the gate. */
async function approvedFixture(name: string, value = "APPROVED-U4"): Promise<{
  sourcePath: string;
  planPath: string;
  destPath: string;
  plan: FormPlan;
  receiptPath: string;
}> {
  const sourcePath = await writeSource(name, { formTextField: true });
  const fields = await inventoryOf(sourcePath);
  const { planPath, destPath, plan } = await writePlan(name, sourcePath, [
    { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value }
  ]);
  const receipt = mintFormReceipt(plan.nonce, await sha256File(planPath), await sha256File(sourcePath), "browser");
  const receiptPath = join(scratch, `${name}.receipt.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  return { sourcePath, planPath, destPath, plan, receiptPath };
}

function claimPathFor(nonce: string): string {
  return join(ledgerDir, `${sha256(nonce)}.json`);
}

describe("apply argument contract", () => {
  it("accepts a plan path, an optional receipt path and --json — nothing that steers the write", () => {
    expect(parseApplyArgs(["plan.json"])).toEqual({ planPath: "plan.json", json: false });
    expect(parseApplyArgs(["plan.json", "--receipt", "r.json", "--json"])).toEqual({
      planPath: "plan.json",
      receiptPath: "r.json",
      json: true
    });
    expect(parseApplyArgs(["--receipt=r.json", "plan.json"])).toEqual({
      planPath: "plan.json",
      receiptPath: "r.json",
      json: false
    });
    for (const flag of [
      "--output",
      "-o",
      "--destination",
      "--overwrite",
      "--force",
      "--burn-in",
      "--set",
      "--value",
      "--stdout",
      "--reveal-values"
    ]) {
      expect(() => parseApplyArgs(["plan.json", flag])).toThrow();
      expect(() => parseApplyArgs(["plan.json", `${flag}=anything`])).toThrow();
    }
  });
});

describe("the approval gate", () => {
  it("refuses a non-interactive apply that carries no receipt", async () => {
    const source = await writeSource("gate-noreceipt", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath } = await writePlan("gate-noreceipt", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "x" }
    ]);
    const result = await runFormsCommand(["apply", planPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_RECEIPT_REQUIRED");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("refuses when the plan's bytes changed after approval", async () => {
    const { planPath, destPath, receiptPath } = await approvedFixture("gate-planchanged");
    // One byte of the approved plan differs: a different value, same nonce.
    const plan = parseFormPlan(JSON.parse(await readFile(planPath, "utf8")));
    const mutated = {
      ...plan,
      entries: plan.entries.map((entry) =>
        entry.kind === "field" && entry.status === "answered" ? { ...entry, value: "TAMPERED" } : entry
      )
    };
    await writeFile(planPath, serializeFormPlan(parseFormPlan(mutated)));

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_PLAN_CHANGED");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("refuses when the source's bytes changed after approval", async () => {
    const { sourcePath, planPath, destPath, receiptPath } = await approvedFixture("gate-srcchanged");
    const bytes = await readFile(sourcePath);
    await writeFile(sourcePath, Buffer.concat([bytes, Buffer.from("\n%tampered\n", "latin1")]));

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_SOURCE_CHANGED");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("refuses an expired receipt", async () => {
    const source = await writeSource("gate-expired", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath, plan } = await writePlan("gate-expired", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "x" }
    ]);
    const stale = mintFormReceipt(
      plan.nonce,
      await sha256File(planPath),
      await sha256File(source),
      "browser",
      new Date(Date.now() - 31 * 60 * 1000)
    );
    const receiptPath = join(scratch, "gate-expired.receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(stale)}\n`);

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_RECEIPT_EXPIRED");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("refuses a receipt whose nonce does not match the plan", async () => {
    const { planPath, destPath, sourcePath, receiptPath } = await approvedFixture("gate-nonce");
    const wrong = mintFormReceipt("a-different-nonce", await sha256File(planPath), await sha256File(sourcePath), "browser");
    await writeFile(receiptPath, `${JSON.stringify(wrong)}\n`);

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_RECEIPT_INVALID");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("refuses a malformed receipt file", async () => {
    const { planPath, destPath } = await approvedFixture("gate-malformed");
    const receiptPath = join(scratch, "gate-malformed.receipt.json");
    await writeFile(receiptPath, `{"version":1,"receiptId":"x"}\n`);

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_RECEIPT_INVALID");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("refuses a signature placement", async () => {
    const source = await writeSource("gate-sig", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath } = await writePlan("gate-sig", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "x" },
      {
        kind: "signature",
        source,
        page: 1,
        rect: { x: 10, y: 10, width: 80, height: 30 },
        strokes: [[10, 10, 90, 40]]
      }
    ]);
    const receipt = mintFormReceipt(
      parseFormPlan(JSON.parse(await readFile(planPath, "utf8"))).nonce,
      await sha256File(planPath),
      await sha256File(source),
      "browser"
    );
    const receiptPath = join(scratch, "gate-sig.receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_SIGNATURE_FORBIDDEN");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("refuses a plan the interview left unfinished", async () => {
    const source = await writeSource("gate-incomplete", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath } = await writePlan("gate-incomplete", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "proposed", value: "draft" }
    ]);
    const receipt = mintFormReceipt("nonce-gate-incomplete", await sha256File(planPath), await sha256File(source), "browser");
    const receiptPath = join(scratch, "gate-incomplete.receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_PLAN_INCOMPLETE");
    await expect(stat(destPath)).rejects.toThrow();
  });

  it("claims the nonce before core starts, and deleting the output does not free it", async () => {
    const { planPath, destPath, plan, receiptPath } = await approvedFixture("gate-ledger");

    // The claim file must exist before the first native call the fill makes.
    let ledgerSeenBeforeCore = false;
    let calls = 0;
    const run: NativeRunner = async (command, args, options): Promise<ProcessResult> => {
      calls += 1;
      if (calls === 1) {
        ledgerSeenBeforeCore = await stat(claimPathFor(plan.nonce)).then(() => true, () => false);
      }
      return defaultNativeRunner(command, args, options);
    };

    const applied = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps({ run }));
    expect(applied.exitCode).toBe(0);
    expect(ledgerSeenBeforeCore).toBe(true);
    const claim = JSON.parse(await readFile(claimPathFor(plan.nonce), "utf8")) as { nonce: string };
    expect(claim.nonce).toBe(plan.nonce);

    // Deleting the delivered file does not make the nonce reusable.
    await rm(destPath);
    const replay = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(replay.exitCode).toBe(2);
    expect((JSON.parse(replay.stdout) as { code: string }).code).toBe("FILL_RECEIPT_CONSUMED");
  });

  it("lets exactly one of two concurrent applies through the gate", async () => {
    const { planPath, destPath, receiptPath } = await approvedFixture("gate-race");
    const [first, second] = await Promise.all([
      runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps()),
      runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps())
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    const loser = results.find((result) => result.exitCode !== 0);
    expect(loser?.exitCode).toBe(2);
    expect((JSON.parse(loser?.stdout ?? "{}") as { code: string }).code).toBe("FILL_RECEIPT_CONSUMED");
    expect((await stat(destPath)).isFile()).toBe(true);
  });

  it("keeps the approved value out of every apply output channel", async () => {
    const marker = "S3KRET-MARKER-U4";
    const { planPath, receiptPath } = await approvedFixture("gate-redact", marker);
    const applied = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).not.toContain(marker);
    expect(applied.stderr).not.toContain(marker);
  });

  it("writes an audit record for a core failure, without leaking the value", async () => {
    const longMarker = "MARKER-THAT-EXCEEDS-MAXLEN";
    const source = await writeSource("gate-failaudit", { formTextField: true, formMaxLen: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath, plan } = await writePlan("gate-failaudit", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: longMarker }
    ]);
    const receipt = mintFormReceipt(plan.nonce, await sha256File(planPath), await sha256File(source), "browser");
    const receiptPath = join(scratch, "gate-failaudit.receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

    const result = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(result.exitCode).toBe(2);
    expect((JSON.parse(result.stdout) as { code: string }).code).toBe("FILL_VALUE_INVALID");
    expect(result.stdout).not.toContain(longMarker);
    expect(result.stderr).not.toContain(longMarker);

    const audit = JSON.parse(await readFile(`${planPath}.audit.json`, "utf8")) as {
      outcome: { status: string; code: string };
      planDigest: string;
      sourceDigest: string;
      receiptId: string;
      channel: string;
    };
    expect(audit.outcome).toEqual({ status: "failed", code: "FILL_VALUE_INVALID" });
    expect(audit.planDigest).toBe(await sha256File(planPath));
    expect(audit.sourceDigest).toBe(await sha256File(source));
    expect(audit.channel).toBe("browser");
    expect(audit.receiptId).toBe(receipt.receiptId);
    await expect(stat(destPath)).rejects.toThrow();
  });
});

describe("interactive approval", () => {
  it("renders every approved value and mints a terminal-channel receipt", async () => {
    const source = await writeSource("mint-ok", { formTextField: true, formCheckbox: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath } = await writePlan("mint-ok", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "VISIBLE-VALUE-1" },
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-check"), status: "skipped" }
    ]);
    let display = "";
    const applied = await runFormsCommand(["apply", planPath, "--json"], deps({
      isInteractive: true,
      confirmApproval: async (rendered) => {
        display = rendered;
        return true;
      }
    }));
    expect(applied.exitCode).toBe(0);
    // The display carries every value verbatim, the resolved destination, the
    // overwrite decision and the entry count — nothing else agent-supplied.
    expect(display).toContain("VISIBLE-VALUE-1");
    expect(display).toContain(destPath);
    expect(display).toContain("overwrite:");
    expect(display).toContain("2 (1 answered, 1 skipped, 0 placements)");
    expect((await stat(destPath)).isFile()).toBe(true);

    const receipt = JSON.parse(await readFile(`${planPath}.receipt.json`, "utf8")) as {
      channel: string;
      nonce: string;
      planDigest: string;
      sourceDigest: string;
    };
    expect(receipt.channel).toBe("terminal");
    expect(receipt.nonce).toBe("nonce-mint-ok");
    expect(receipt.planDigest).toBe(await sha256File(planPath));
    expect(receipt.sourceDigest).toBe(await sha256File(source));
    expect(((await stat(`${planPath}.receipt.json`)).mode & 0o777)).toBe(0o600);

    const audit = JSON.parse(await readFile(`${planPath}.audit.json`, "utf8")) as {
      qpdfPath: string | null;
      qpdfVersion: string | null;
      outcome: { status: string };
    };
    expect(audit.qpdfVersion).not.toBeNull();
    expect(audit.outcome.status).toBe("applied");
  });

  it("a declined approval writes nothing and burns no nonce", async () => {
    const source = await writeSource("mint-no", { formTextField: true });
    const fields = await inventoryOf(source);
    const { planPath, destPath, plan } = await writePlan("mint-no", source, [
      { kind: "field", fieldId: fieldIdByLabel(fields, "fixture-name"), status: "answered", value: "x" }
    ]);
    const declined = await runFormsCommand(["apply", planPath, "--json"], deps({
      isInteractive: true,
      confirmApproval: async () => false
    }));
    expect(declined.exitCode).toBe(4);
    await expect(stat(destPath)).rejects.toThrow();
    await expect(stat(claimPathFor(plan.nonce))).rejects.toThrow();
    await expect(stat(`${planPath}.receipt.json`)).rejects.toThrow();
  });
});

describe("forms clean", () => {
  it("removes the plan, its receipt and its audit record", async () => {
    const { planPath, receiptPath } = await approvedFixture("clean-ok");
    const applied = await runFormsCommand(["apply", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(applied.exitCode).toBe(0);
    const auditPath = `${planPath}.audit.json`;
    expect((await stat(auditPath)).isFile()).toBe(true);

    const cleaned = await runFormsCommand(["clean", planPath, "--receipt", receiptPath, "--json"], deps());
    expect(cleaned.exitCode).toBe(0);
    const payload = JSON.parse(cleaned.stdout) as { removed: string[] };
    expect(payload.removed).toHaveLength(3);
    for (const path of [planPath, receiptPath, auditPath]) {
      await expect(stat(path)).rejects.toThrow();
    }
  });
});
