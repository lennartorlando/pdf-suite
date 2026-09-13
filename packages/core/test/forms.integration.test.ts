import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillForm, inventoryFormFields } from "../src/forms.js";
import { buildTestPdf } from "./pdf-fixtures.js";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "pdf-forms-it-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writePlan(
  name: string,
  source: string,
  destination: string,
  entries: unknown[],
  burnIn = false
): Promise<string> {
  const planPath = join(scratch, name);
  await writeFile(
    planPath,
    JSON.stringify({
      version: 1,
      source,
      destination,
      overwrite: false,
      burnIn,
      nonce: `n-${name}`,
      entries
    })
  );
  return planPath;
}

describe("fillForm", () => {
  it("removes superseded values from delivered bytes when filled twice", async () => {
    const source = join(scratch, "twice-source.pdf");
    await writeFile(source, buildTestPdf([{}], { formTextField: true }));

    const inventory = await inventoryFormFields(source);
    const fieldId = inventory.inventory.fields[0]?.fieldId;
    expect(fieldId).toBeDefined();

    const first = join(scratch, "twice-first.pdf");
    const firstPlan = await writePlan("twice-plan-1.json", source, first, [
      { kind: "field", fieldId, status: "answered", value: "superseded-first" }
    ]);
    await fillForm({ sourcePath: source, planPath: firstPlan, destinationPath: first });

    const second = join(scratch, "twice-second.pdf");
    const secondPlan = await writePlan("twice-plan-2.json", first, second, [
      { kind: "field", fieldId, status: "answered", value: "approved-second" }
    ]);
    await fillForm({ sourcePath: first, planPath: secondPlan, destinationPath: second });

    const delivered = await readFile(second);
    expect(delivered.includes(Buffer.from("superseded-first", "latin1"))).toBe(false);
    expect(delivered.includes(Buffer.from("approved-second", "latin1"))).toBe(true);
  });
});
