import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillForm, inventoryFormFields, type FillFormOptions, type FillSummary } from "../src/forms.js";
import { FormPlanError, serializeFormPlan, parseFormPlan, type FormPlanEntry } from "../src/form-plan.js";
import { defaultNativeRunner, type NativeRunner } from "../src/engines/qpdf-pages.js";
import { outputContainsMarker, readFieldRows } from "../../../tests/helpers/pdf-assertions.js";
import { buildTestPdf, encryptTestPdf, sha256File, type FixtureFeatures } from "./pdf-fixtures.js";

let scratch: string;
let workspaceParent: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pdf-forms-ut-"));
  workspaceParent = join(scratch, "workspaces");
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

async function writeSource(name: string, features: FixtureFeatures, pages = [{}]): Promise<string> {
  const path = join(scratch, `${name}.pdf`);
  await writeFile(path, buildTestPdf(pages, features));
  return path;
}

async function writePlan(
  name: string,
  sourcePath: string,
  destinationPath: string,
  entries: readonly FormPlanEntry[],
  extras: { burnIn?: boolean; overwrite?: boolean } = {}
): Promise<string> {
  const planPath = join(scratch, `${name}.json`);
  await writeFile(
    planPath,
    serializeFormPlan(
      parseFormPlan({
        version: 1,
        source: sourcePath,
        destination: destinationPath,
        overwrite: extras.overwrite ?? false,
        burnIn: extras.burnIn ?? false,
        nonce: `nonce-${name}`,
        entries
      })
    )
  );
  return planPath;
}

async function fill(
  sourcePath: string,
  entries: readonly FormPlanEntry[],
  extras: { burnIn?: boolean; run?: NativeRunner; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ outputPath: string; summary: FillSummary }> {
  const outputPath = join(scratch, `${unique("out")}.pdf`);
  const planPath = await writePlan(unique("plan"), sourcePath, outputPath, entries, extras);
  const options: FillFormOptions = {
    sourcePath,
    planPath,
    destinationPath: outputPath,
    workspaceParent,
    ...(extras.run ? { run: extras.run } : {}),
    ...(extras.timeoutMs !== undefined ? { timeoutMs: extras.timeoutMs } : {}),
    ...(extras.signal ? { signal: extras.signal } : {})
  };
  const summary = await fillForm(options);
  return { outputPath, summary };
}

async function expectFillError(
  sourcePath: string,
  entries: readonly FormPlanEntry[],
  code: string,
  extras: { burnIn?: boolean; run?: NativeRunner } = {}
): Promise<void> {
  const outputPath = join(scratch, `${unique("rejected")}.pdf`);
  const planPath = await writePlan(unique("plan"), sourcePath, outputPath, entries, extras);
  await expect(
    fillForm({ sourcePath, planPath, destinationPath: outputPath, workspaceParent, ...(extras.run ? { run: extras.run } : {}) })
  ).rejects.toMatchObject({ code });
  // No rejection ever leaves a partial write behind.
  await expect(stat(outputPath)).rejects.toThrow();
}

async function fieldIdOf(sourcePath: string, index = 0): Promise<string> {
  const { inventory } = await inventoryFormFields(sourcePath, { workspaceParent });
  const field = inventory.fields[index];
  if (!field) throw new Error("fixture produced no field");
  return field.fieldId;
}

async function workspaceIsEmpty(): Promise<void> {
  const entries = await readdir(workspaceParent).catch(() => ["<missing>"]);
  expect(entries).toEqual([]);
}

describe("inventoryFormFields", () => {
  it("joins qpdf semantics with PDF.js addressing for every field kind", async () => {
    const source = await writeSource("inv-all", {
      formTextField: true,
      formMaxLen: true,
      formCheckbox: true,
      formRadio: true,
      formChoice: true,
      formSpanPages: true,
      formMergedField: true
    }, [{}, {}]);
    const { inventory } = await inventoryFormFields(source, { workspaceParent });
    const byName = new Map(inventory.fields.map((f) => [f.label?.text.text, f]));

    const text = byName.get("fixture-name");
    expect(text?.type).toBe("text");
    expect(text?.maxLength).toBe(5);
    expect(text?.label?.source).toBe("name");

    const check = byName.get("fixture-check");
    expect(check?.type).toBe("checkbox");
    expect(check?.allowedValues?.map((v) => v.text)).toContain("Ja");
    expect(check?.currentValue).toBe("Off");

    const radio = byName.get("fixture-radio");
    expect(radio?.type).toBe("radio");
    expect(radio?.widgets).toHaveLength(2);
    expect(radio?.widgets.map((w) => w.page).sort()).toEqual([1, 2]);
    expect(radio?.allowedValues?.map((v) => v.text)).toEqual(expect.arrayContaining(["A", "B"]));
    expect(radio?.currentValue).toBe("B");

    const choice = byName.get("fixture-choice");
    expect(choice?.type).toBe("choice");
    expect(choice?.allowedValues?.map((v) => v.text)).toEqual(["alpha", "beta", "gamma"]);

    const span = byName.get("fixture-span");
    expect(span?.widgets).toHaveLength(2);
    expect(span?.widgets.map((w) => w.page).sort()).toEqual([1, 2]);

    const merged = byName.get("fixture-merged");
    expect(merged?.type).toBe("text");
    expect(merged?.widgets[0]?.widgetId).toBe(merged?.fieldId);
    await workspaceIsEmpty();
  });

  it("emits tooltips as capped, marked, document-derived labels", async () => {
    // Stripping runs before the cap: 190 + 20 visible characters cap to 200.
    const tooltip = `${"x".repeat(190)}\n\n${"y".repeat(20)}`;
    const source = await writeSource("inv-tooltip", { formTextField: true, formTooltip: tooltip });
    const { inventory } = await inventoryFormFields(source, { workspaceParent });
    const label = inventory.fields[0]?.label;
    expect(label?.source).toBe("tooltip");
    expect(label?.text.documentDerived).toBe(true);
    expect(label?.text.text).toBe("x".repeat(190) + "y".repeat(10));
  });

  it("marks password, hidden, read-only and computed fields so agents never propose them blindly", async () => {
    const source = await writeSource("inv-flags", {
      formTextField: true,
      formPassword: true,
      formHiddenWidget: true,
      formReadOnly: true,
      formFieldScripts: true
    });
    const { inventory } = await inventoryFormFields(source, { workspaceParent });
    const field = inventory.fields[0];
    expect(field?.password).toBe(true);
    expect(field?.hidden).toBe(true);
    expect(field?.readOnly).toBe(true);
    expect(field?.computed).toBe(true);
  });

  it("lists a non-terminal parent as an unfillable group", async () => {
    const source = await writeSource("inv-group", { nonTerminalFieldAction: true });
    const { inventory } = await inventoryFormFields(source, { workspaceParent });
    const group = inventory.fields.find((f) => f.type === "group");
    expect(group).toBeDefined();
    expect(group?.widgets).toEqual([]);
  });
});

describe("fillForm rejections", () => {
  it("refuses a plan whose entries are not all terminal", async () => {
    const source = await writeSource("rej-incomplete", { formTextField: true });
    const fieldId = await fieldIdOf(source);
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "proposed", value: "draft" }],
      "FILL_PLAN_INCOMPLETE"
    );
  });

  it("refuses an unknown field identifier", async () => {
    const source = await writeSource("rej-unknown", { formTextField: true });
    await expectFillError(
      source,
      [{ kind: "field", fieldId: "999 0 R", status: "answered", value: "x" }],
      "FILL_UNKNOWN_FIELD"
    );
  });

  it("refuses to answer a group entry", async () => {
    const source = await writeSource("rej-group", { nonTerminalFieldAction: true });
    const { inventory } = await inventoryFormFields(source, { workspaceParent });
    const group = inventory.fields.find((f) => f.type === "group");
    await expectFillError(
      source,
      [{ kind: "field", fieldId: group!.fieldId, status: "answered", value: "x" }],
      "FILL_NOT_FILLABLE"
    );
  });

  it("refuses a read-only field", async () => {
    const source = await writeSource("rej-ro", { formTextField: true, formReadOnly: true });
    const fieldId = await fieldIdOf(source);
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "x" }],
      "FILL_NOT_FILLABLE"
    );
  });

  it("rejects rather than truncates an over-limit value", async () => {
    const source = await writeSource("rej-maxlen", { formTextField: true, formMaxLen: true });
    const fieldId = await fieldIdOf(source);
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "six-plus" }],
      "FILL_VALUE_INVALID"
    );
  });

  it("rejects a choice value outside the option list", async () => {
    const source = await writeSource("rej-choice", { formChoice: true });
    const fieldId = await fieldIdOf(source);
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "delta" }],
      "FILL_VALUE_INVALID"
    );
  });

  it("rejects an on-state the widget's appearance dictionary does not define", async () => {
    const source = await writeSource("rej-state", { formCheckbox: true });
    const fieldId = await fieldIdOf(source);
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "Maybe" }],
      "FILL_VALUE_INVALID"
    );
  });

  it("rejects clearing a radio group", async () => {
    const source = await writeSource("rej-radio", { formRadio: true });
    const fieldId = await fieldIdOf(source);
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "" }],
      "FILL_VALUE_INVALID"
    );
  });

  it.each([["carriage return", "a\rb"], ["line feed", "a\nb"], ["null byte", "a\0b"]])(
    "refuses a %s before the child runs",
    async (_what, value) => {
      const source = await writeSource("rej-ctrl", { formTextField: true });
      const fieldId = await fieldIdOf(source);
      const outputPath = join(scratch, `${unique("ctrl")}.pdf`);
      const planPath = join(scratch, `${unique("plan")}.json`);
      await writeFile(
        planPath,
        JSON.stringify({
          version: 1,
          source,
          destination: outputPath,
          overwrite: false,
          burnIn: false,
          nonce: `n-${counter}`,
          entries: [{ kind: "field", fieldId, status: "answered", value }]
        })
      );
      await expect(
        fillForm({ sourcePath: source, planPath, destinationPath: outputPath, workspaceParent })
      ).rejects.toBeInstanceOf(FormPlanError);
      await expect(stat(outputPath)).rejects.toThrow();
      await workspaceIsEmpty();
    }
  );

  it("refuses when the plan's bindings name other paths", async () => {
    const source = await writeSource("rej-bind", { formTextField: true });
    const outputPath = join(scratch, `${unique("bind")}.pdf`);
    const planPath = await writePlan(unique("plan"), source, outputPath, []);
    await expect(
      fillForm({ sourcePath: source, planPath, destinationPath: join(scratch, "elsewhere.pdf"), workspaceParent })
    ).rejects.toMatchObject({ code: "FILL_PLAN_SOURCE_MISMATCH" });
  });

  it("refuses an existing destination unless the plan approved overwrite", async () => {
    const source = await writeSource("rej-exists", { formTextField: true });
    const fieldId = await fieldIdOf(source);
    const outputPath = join(scratch, `${unique("exists")}.pdf`);
    await writeFile(outputPath, "occupied");
    const planPath = await writePlan(unique("plan"), source, outputPath, [
      { kind: "field", fieldId, status: "answered", value: "x" }
    ]);
    await expect(
      fillForm({ sourcePath: source, planPath, destinationPath: outputPath, workspaceParent })
    ).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    expect((await readFile(outputPath)).toString()).toBe("occupied");
  });

  it("refuses a signed source", async () => {
    const source = await writeSource("rej-signed", { formTextField: true, docMdpSignature: true });
    const fieldId = "8 0 R";
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "x" }],
      "INPUT_SIGNED"
    );
  });

  it("refuses a source whose catalog carries active content", async () => {
    const source = await writeSource("rej-active", { formTextField: true, javascript: true });
    await expectFillError(source, [], "INPUT_HAS_ACTIVE_CONTENT");
  });

  it("refuses a source that needs a real password", async () => {
    const plain = await writeSource("rej-enc-plain", { formTextField: true });
    const source = join(scratch, "rej-enc.pdf");
    await encryptTestPdf(plain, source, "user-pw", "owner-pw");
    await expectFillError(source, [], "INPUT_ENCRYPTED");
  });

  it("leaves the workspace empty after a rejection", workspaceIsEmpty);
});

describe("fillForm success paths", () => {
  it("fills a text field and proves the value by readback", async () => {
    const source = await writeSource("ok-text", { formTextField: true });
    const fieldId = await fieldIdOf(source);
    const before = await sha256File(source);
    const { outputPath } = await fill(source, [
      { kind: "field", fieldId, status: "answered", value: "approved value" }
    ]);
    const rows = await readFieldRows(outputPath, fieldId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.value === "approved value")).toBe(true);
    expect(await sha256File(source)).toBe(before);
    await workspaceIsEmpty();
  });

  it("round-trips parentheses, backslashes, angle brackets and wide characters byte for byte", async () => {
    const source = await writeSource("ok-wide", { formTextField: true });
    const fieldId = await fieldIdOf(source);
    const value = "pre (paren) \\back <angle> 中文括号 e\u0301";
    const { outputPath } = await fill(source, [
      { kind: "field", fieldId, status: "answered", value }
    ]);
    const rows = await readFieldRows(outputPath, fieldId);
    expect(rows.every((row) => row.value === value)).toBe(true);
  });

  it("checks a checkbox by its non-standard on-state and clears it again", async () => {
    const source = await writeSource("ok-check", { formCheckbox: true });
    const fieldId = await fieldIdOf(source);
    const { outputPath } = await fill(source, [
      { kind: "field", fieldId, status: "answered", value: "Ja" }
    ]);
    const rows = await readFieldRows(outputPath, fieldId);
    expect(rows.every((row) => row.appearanceState === "Ja" && row.value === "Ja")).toBe(true);

    const cleared = join(scratch, `${unique("off")}.pdf`);
    const plan = await writePlan(unique("plan"), outputPath, cleared, [
      { kind: "field", fieldId, status: "answered", value: "" }
    ]);
    await fillForm({ sourcePath: outputPath, planPath: plan, destinationPath: cleared, workspaceParent });
    const clearedRows = await readFieldRows(cleared, fieldId);
    expect(clearedRows.every((row) => row.appearanceState === "Off")).toBe(true);
  });

  it("selects one radio state and settles the siblings", async () => {
    const source = await writeSource("ok-radio", { formRadio: true }, [{}, {}]);
    const { inventory } = await inventoryFormFields(source, { workspaceParent });
    const radio = inventory.fields[0];
    const { outputPath } = await fill(source, [
      { kind: "field", fieldId: radio!.fieldId, status: "answered", value: "A" }
    ]);
    const rows = await readFieldRows(outputPath, radio!.fieldId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.appearanceState).sort()).toEqual(["A", "Off"]);
    expect(rows.every((row) => row.value === "A")).toBe(true);
  });

  it("writes one value to widgets spread across two pages", async () => {
    const source = await writeSource("ok-span", { formSpanPages: true }, [{}, {}]);
    const fieldId = await fieldIdOf(source);
    const { outputPath } = await fill(source, [
      { kind: "field", fieldId, status: "answered", value: "two pages" }
    ]);
    const rows = await readFieldRows(outputPath, fieldId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.value === "two pages")).toBe(true);
  });

  it("fills a field whose widgets share a merged dictionary", async () => {
    const source = await writeSource("ok-merged", { formMergedField: true });
    const fieldId = await fieldIdOf(source);
    const { outputPath } = await fill(source, [
      { kind: "field", fieldId, status: "answered", value: "merged" }
    ]);
    const rows = await readFieldRows(outputPath, fieldId);
    expect(rows.every((row) => row.value === "merged")).toBe(true);
  });

  it("fills a field carrying format actions and delivers no script or submit action", async () => {
    const source = await writeSource("ok-scripts", { formTextField: true, formFieldScripts: true });
    const fieldId = await fieldIdOf(source);
    const { outputPath, summary } = await fill(source, [
      { kind: "field", fieldId, status: "answered", value: "done" }
    ]);
    expect(summary.computedFields).toBe(1);
    expect(summary.warnings.some((w) => w.includes("arithmetic"))).toBe(true);
    const bytes = await readFile(outputPath);
    for (const marker of ["fixture-format", "fixture-validate", "fixture-calc", "SubmitForm"]) {
      expect(bytes.includes(Buffer.from(marker, "latin1"))).toBe(false);
    }
    const rows = await readFieldRows(outputPath, fieldId);
    expect(rows.every((row) => row.value === "done")).toBe(true);
  });

  it("places text and a drawn signature on a field-free document and burns them in", async () => {
    const source = await writeSource("ok-place", {});
    const { outputPath } = await fill(
      source,
      [
        {
          kind: "text",
          source,
          page: 1,
          rect: { x: 120, y: 500, width: 160, height: 20 },
          text: "placed-text"
        },
        {
          kind: "signature",
          source,
          page: 1,
          rect: { x: 120, y: 400, width: 160, height: 40 },
          strokes: [[120, 400, 160, 440, 200, 405, 260, 435]]
        }
      ],
      { burnIn: true }
    );
    expect(await outputContainsMarker(outputPath, "placed-text")).toBe(true);
  });

  it("burns a checked checkbox into page content", async () => {
    const source = await writeSource("ok-burn", { formCheckbox: true });
    const fieldId = await fieldIdOf(source);
    const { outputPath } = await fill(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "Ja" }],
      { burnIn: true }
    );
    const { inventory } = await inventoryFormFields(outputPath, { workspaceParent });
    expect(inventory.fields).toHaveLength(0);
  });

  it("admits an empty-password-encrypted source and reports the removed restrictions", async () => {
    const plain = await writeSource("ok-enc-plain", { formTextField: true });
    const source = join(scratch, "ok-enc.pdf");
    await encryptTestPdf(plain, source, "", "owner-pw");
    const fieldId = await fieldIdOf(source);
    const { outputPath, summary } = await fill(source, [
      { kind: "field", fieldId, status: "answered", value: "decrypted" }
    ]);
    expect(summary.removedRestrictions).toBe(true);
    const bytes = await readFile(outputPath);
    expect(bytes.length).toBeGreaterThan(0);
    await workspaceIsEmpty();
  });

  it("leaves the workspace empty after success", workspaceIsEmpty);
});

describe("fillForm terminal-state hygiene", () => {
  it("fails burn-in instead of delivering a blank when the renderer cannot build an appearance", async () => {
    // Wide characters do not fit the field's latin1 font: pdf.js writes the
    // value but reports needAppearances rather than an appearance stream.
    const source = await writeSource("fail-blank", { formTextField: true });
    const fieldId = await fieldIdOf(source);
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "中文无法渲染" }],
      "FILL_APPEARANCE_MISSING",
      { burnIn: true }
    );
    await workspaceIsEmpty();
  });

  it("reports a deliberately mismatched on-state as not applied, interactive and burned in", async () => {
    const source = await writeSource("fail-state", { formCheckbox: true });
    const fieldId = await fieldIdOf(source);

    // Corrupt the child's candidate: the value stays approved but the widget's
    // appearance state is forced back to Off before the output stage runs.
    const corruptingRun: NativeRunner = async (command, args, options) => {
      const result = await defaultNativeRunner(command, args, options);
      const candidateIndex = args.findIndex((arg) => arg.startsWith("--candidate="));
      if (command === process.execPath && candidateIndex >= 0) {
        const candidatePath = args[candidateIndex].slice("--candidate=".length);
        const bytes = await readFile(candidatePath);
        const corrupted = Buffer.from(
          bytes.toString("latin1").replace("/AS /Ja", "/AS /Off"),
          "latin1"
        );
        if (!corrupted.equals(bytes)) await writeFile(candidatePath, corrupted);
      }
      return result;
    };

    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "Ja" }],
      "FILL_READBACK_FAILED",
      { run: corruptingRun }
    );
    await expectFillError(
      source,
      [{ kind: "field", fieldId, status: "answered", value: "Ja" }],
      "FILL_READBACK_FAILED",
      { run: corruptingRun, burnIn: true }
    );
    await workspaceIsEmpty();
  });

  it("cancels cleanly with a pre-aborted signal", async () => {
    const source = await writeSource("fail-cancel", { formTextField: true });
    const controller = new AbortController();
    controller.abort();
    const outputPath = join(scratch, `${unique("cancel")}.pdf`);
    const planPath = await writePlan(unique("plan"), source, outputPath, []);
    await expect(
      fillForm({ sourcePath: source, planPath, destinationPath: outputPath, signal: controller.signal, workspaceParent })
    ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(stat(outputPath)).rejects.toThrow();
    await workspaceIsEmpty();
  });

  it("times out cleanly", async () => {
    const source = await writeSource("fail-timeout", { formTextField: true });
    const outputPath = join(scratch, `${unique("timeout")}.pdf`);
    const planPath = await writePlan(unique("plan"), source, outputPath, []);
    await expect(
      fillForm({ sourcePath: source, planPath, destinationPath: outputPath, timeoutMs: 1, workspaceParent })
    ).rejects.toMatchObject({ code: "JOB_TIMEOUT" });
    await expect(stat(outputPath)).rejects.toThrow();
    await workspaceIsEmpty();
  });
});
