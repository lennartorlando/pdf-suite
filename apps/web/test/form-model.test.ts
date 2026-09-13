// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FormFieldEntry, FormInventory } from "@pdf-compressor/core/form-inventory";
import { parseFormPlan, serializeFormPlan, type FormPlan } from "@pdf-compressor/core/form-plan";
import {
  addPlacement,
  approveField,
  buildReceipt,
  chooseOption,
  createFormState,
  derivePlan,
  loadPlan,
  markSaved,
  movePlacement,
  rejectField,
  removePlacement,
  serializeReceipt,
  setBurnIn,
  setFieldText,
  toggleCheckbox,
  updatePlacementText,
  FormModelError,
  type FormFillState
} from "../src/form/model.js";

function field(partial: Partial<FormFieldEntry> & Pick<FormFieldEntry, "fieldId" | "type">): FormFieldEntry {
  return {
    widgets: [{ widgetId: `${partial.fieldId}-w0`, page: 1, rect: { x: 50, y: 700, width: 120, height: 20 } }],
    required: false,
    readOnly: false,
    computed: false,
    password: false,
    hidden: false,
    multiline: false,
    comb: false,
    ...partial
  };
}

function inventory(fields: readonly FormFieldEntry[]): FormInventory {
  return { version: 1, fields };
}

const TEXT = field({ fieldId: "10 0 R", type: "text", label: { text: { text: "Name", documentDerived: true }, source: "name" } });
const CHECK = field({ fieldId: "11 0 R", type: "checkbox", allowedValues: [{ text: "Ja", documentDerived: true }] });
const RADIO = field({
  fieldId: "12 0 R",
  type: "radio",
  allowedValues: [
    { text: "A", documentDerived: true },
    { text: "B", documentDerived: true }
  ],
  widgets: [
    { widgetId: "f-radio-w0", page: 1, rect: { x: 50, y: 600, width: 15, height: 15 } },
    { widgetId: "f-radio-w1", page: 1, rect: { x: 70, y: 600, width: 15, height: 15 } }
  ]
});
const CHOICE = field({
  fieldId: "13 0 R",
  type: "choice",
  allowedValues: [
    { text: "alpha", documentDerived: true },
    { text: "beta", documentDerived: true }
  ]
});
const READONLY = field({ fieldId: "14 0 R", type: "text", readOnly: true, currentValue: "fixed" });
const READONLY_CHECK = field({ fieldId: "15 0 R", type: "checkbox", readOnly: true });
const GROUP = field({ fieldId: "16 0 R", type: "group", widgets: [] });
const SIGNATURE = field({ fieldId: "17 0 R", type: "signature" });

function base(): FormFillState {
  return createFormState(inventory([TEXT, CHECK, RADIO, CHOICE, READONLY, READONLY_CHECK, GROUP, SIGNATURE]));
}

describe("form model: creation", () => {
  it("initializes fillable fields as unknown with their current value", () => {
    const state = base();
    expect(state.fields["10 0 R"]).toEqual({ status: "unknown", value: "" });
    expect(state.fields["11 0 R"]).toEqual({ status: "unknown", value: "" });
    expect(state.fields["16 0 R"]).toBeUndefined();
    expect(state.fields["17 0 R"]).toBeUndefined();
    expect(state.dirty).toBe(false);
    expect(state.placements).toEqual([]);
  });
});

describe("form model: field edits are immutable", () => {
  it("typing answers a text field without mutating the prior state", () => {
    const before = base();
    const after = setFieldText(before, "10 0 R", "Ada");
    expect(after).not.toBe(before);
    expect(before.fields["10 0 R"].status).toBe("unknown");
    expect(after.fields["10 0 R"]).toEqual({ status: "answered", value: "Ada" });
    expect(after.dirty).toBe(true);
  });

  it("toggles a checkbox between its on-state and Off", () => {
    let state = base();
    state = toggleCheckbox(state, "11 0 R");
    expect(state.fields["11 0 R"]).toEqual({ status: "answered", value: "Ja" });
    state = toggleCheckbox(state, "11 0 R");
    expect(state.fields["11 0 R"].value).toBe("Off");
  });

  it("chooses a radio export value", () => {
    const state = chooseOption(base(), "12 0 R", "B");
    expect(state.fields["12 0 R"]).toEqual({ status: "answered", value: "B" });
  });

  it("clamps to the field's max length", () => {
    const limited = createFormState(inventory([field({ fieldId: "18 0 R", type: "text", maxLength: 5 })]));
    expect(setFieldText(limited, "18 0 R", "123456789").fields["18 0 R"].value).toBe("12345");
  });

  it("refuses control characters", () => {
    expect(() => setFieldText(base(), "10 0 R", "a\nb")).toThrow(FormModelError);
    expect(() => addPlacement(base(), { kind: "text", page: 1, rect: { x: 1, y: 1, width: 50, height: 12 }, text: "x\0" })).toThrow(
      FormModelError
    );
  });

  it("cannot edit a read-only field", () => {
    const state = base();
    expect(setFieldText(state, "14 0 R", "nope")).toBe(state);
    expect(toggleCheckbox(state, "15 0 R")).toBe(state);
    expect(chooseOption(state, "14 0 R", "nope")).toBe(state);
    // The field is tracked for display but keeps its document value.
    expect(state.fields["14 0 R"]).toEqual({ status: "unknown", value: "fixed" });
  });

  it("cannot edit a field that is not fillable", () => {
    expect(() => setFieldText(base(), "16 0 R", "x")).toThrow(FormModelError);
  });
});

describe("form model: placements", () => {
  it("adds, moves, retexts and removes placements", () => {
    let state = addPlacement(base(), {
      kind: "text",
      page: 2,
      rect: { x: 100, y: 200, width: 180, height: 18 },
      text: "hi"
    });
    const id = state.placements[0].id;
    state = movePlacement(state, id, 150, 250);
    expect(state.placements[0].rect).toEqual({ x: 150, y: 250, width: 180, height: 18 });
    state = updatePlacementText(state, id, "moved");
    expect(state.placements[0].text).toBe("moved");
    state = removePlacement(state, id);
    expect(state.placements).toEqual([]);
  });

  it("caps placements at the plan limit", () => {
    let state = base();
    for (let i = 0; i < 200; i += 1) {
      state = addPlacement(state, { kind: "checkmark", page: 1, rect: { x: i, y: 0, width: 14, height: 14 } });
    }
    expect(() =>
      addPlacement(state, { kind: "checkmark", page: 1, rect: { x: 0, y: 0, width: 14, height: 14 } })
    ).toThrow(/200 placements/);
  });
});

describe("form model: plan derivation", () => {
  it("derives a plan where unapproved fields become skipped", () => {
    let state = base();
    state = setFieldText(state, "10 0 R", "Ada");
    state = toggleCheckbox(state, "11 0 R");
    const plan = derivePlan(state, "nonce-1");
    expect(plan.nonce).toBe("nonce-1");
    expect(plan.source).toBe("upload");
    expect(plan.destination).toBe("download");
    expect(plan.overwrite).toBe(false);
    expect(plan.burnIn).toBe(false);
    const byId = new Map(plan.entries.filter((e) => e.kind === "field").map((e) => [e.kind === "field" ? e.fieldId : "", e]));
    expect(byId.get("10 0 R")).toEqual({ kind: "field", fieldId: "10 0 R", status: "answered", value: "Ada" });
    expect(byId.get("11 0 R")).toEqual({ kind: "field", fieldId: "11 0 R", status: "answered", value: "Ja" });
    expect(byId.get("12 0 R")).toEqual({ kind: "field", fieldId: "12 0 R", status: "skipped" });
    expect(byId.get("13 0 R")).toEqual({ kind: "field", fieldId: "13 0 R", status: "skipped" });
    // Non-fillable fields never enter the plan.
    expect(byId.get("16 0 R")).toBeUndefined();
    expect(byId.get("17 0 R")).toBeUndefined();
    // Read-only fields are skipped, never answered.
    expect(byId.get("14 0 R")).toEqual({ kind: "field", fieldId: "14 0 R", status: "skipped" });
    // The derived plan must survive the shared closed-schema parse.
    expect(() => parseFormPlan(JSON.parse(serializeFormPlan(plan)))).not.toThrow();
  });

  it("emits placements keyed by page with source binding", () => {
    let state = base();
    state = addPlacement(state, {
      kind: "signature",
      page: 3,
      rect: { x: 100, y: 100, width: 220, height: 72 },
      strokes: [
        [0, 0, 10, 20],
        [5, 5, 30, 40]
      ]
    });
    state = addPlacement(state, { kind: "checkmark", page: 1, rect: { x: 10, y: 10, width: 14, height: 14 } });
    const plan = derivePlan(state, "n");
    const sig = plan.entries.find((e) => e.kind === "signature");
    expect(sig && sig.kind === "signature" ? sig.strokes : []).toEqual([
      [100, 100, 110, 120],
      [105, 105, 130, 140]
    ]);
    const check = plan.entries.find((e) => e.kind === "checkmark");
    expect(check).toMatchObject({ kind: "checkmark", source: "upload", page: 1 });
  });

  it("reuses the loaded plan's nonce when present", () => {
    let state = base();
    const plan: FormPlan = {
      version: 1,
      source: "upload",
      destination: "download",
      overwrite: false,
      burnIn: false,
      nonce: "agent-nonce",
      entries: [{ kind: "field", fieldId: "10 0 R", status: "proposed", value: "Grace" }]
    };
    state = loadPlan(state, plan).state;
    expect(derivePlan(state).nonce).toBe("agent-nonce");
    // A fresh nonce is minted when none was loaded.
    expect(derivePlan(base()).nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("form model: loading a plan", () => {
  const agentPlan: FormPlan = {
    version: 1,
    source: "upload",
    destination: "download",
    overwrite: false,
    burnIn: true,
    nonce: "n-agent",
    entries: [
      { kind: "field", fieldId: "10 0 R", status: "proposed", value: "Grace" },
      { kind: "field", fieldId: "12 0 R", status: "skipped" },
      { kind: "field", fieldId: "99 0 R", status: "proposed", value: "x" },
      { kind: "text", source: "upload", page: 2, rect: { x: 10, y: 20, width: 100, height: 14 }, text: "note" },
      {
        kind: "signature",
        source: "upload",
        page: 1,
        rect: { x: 0, y: 0, width: 100, height: 30 },
        strokes: [[0, 0, 1, 1]]
      }
    ]
  };

  it("lands proposals as proposed, drops signatures, reports unknowns", () => {
    const result = loadPlan(base(), agentPlan);
    expect(result.state.fields["10 0 R"]).toEqual({ status: "proposed", value: "Grace" });
    expect(result.state.fields["12 0 R"]).toEqual({ status: "skipped", value: "" });
    expect(result.droppedSignatures).toBe(1);
    expect(result.unknownFields).toBe(1);
    expect(result.state.placements).toHaveLength(1);
    expect(result.state.placements[0]).toMatchObject({ kind: "text", page: 2 });
    expect(result.state.burnIn).toBe(true);
    expect(result.state.planNonce).toBe("n-agent");
  });

  it("keeps a loaded plan's real source and destination bindings through approval (F3)", () => {
    const plan: FormPlan = {
      version: 1,
      source: "/agent/inbox/form.pdf",
      destination: "/agent/outbox/form-filled.pdf",
      overwrite: false,
      burnIn: false,
      nonce: "agent-nonce-9",
      entries: [
        { kind: "field", fieldId: "10 0 R", status: "proposed", value: "Grace" },
        { kind: "text", source: "/agent/inbox/form.pdf", page: 1, rect: { x: 10, y: 20, width: 100, height: 14 }, text: "note" }
      ]
    };
    let state = loadPlan(base(), plan).state;
    state = approveField(state, "10 0 R");
    const derived = derivePlan(state);
    expect(derived.source).toBe("/agent/inbox/form.pdf");
    expect(derived.destination).toBe("/agent/outbox/form-filled.pdf");
    expect(derived.nonce).toBe("agent-nonce-9");
    // Apply refuses a placement whose source differs from the plan's
    // (FILL_PLAN_SOURCE_MISMATCH), so it must carry the same binding.
    const placement = derived.entries.find((entry) => entry.kind === "text");
    expect(placement && placement.kind === "text" ? placement.source : "").toBe("/agent/inbox/form.pdf");
  });

  it("approval turns proposals into answers; rejection reopens them", () => {
    let state = loadPlan(base(), agentPlan).state;
    state = approveField(state, "10 0 R");
    expect(state.fields["10 0 R"]).toEqual({ status: "answered", value: "Grace" });
    state = loadPlan(base(), agentPlan).state;
    state = rejectField(state, "10 0 R");
    expect(state.fields["10 0 R"]).toEqual({ status: "unknown", value: "" });
    // And the derived plan never writes an unapproved proposal.
    const plan = derivePlan(loadPlan(base(), agentPlan).state, "n");
    const entry = plan.entries.find((e) => e.kind === "field" && e.fieldId === "10 0 R");
    expect(entry).toEqual({ kind: "field", fieldId: "10 0 R", status: "skipped" });
  });
});

describe("form model: receipt and dirty tracking", () => {
  it("mints a receipt bound to the exact plan and source digests", () => {
    const state = setFieldText(base(), "10 0 R", "Ada");
    const plan = derivePlan(state, "nonce-9");
    const planBytes = serializeFormPlan(plan);
    const sourceBytes = "%PDF-fixture";
    const receipt = buildReceipt(
      plan.nonce,
      createHash("sha256").update(planBytes).digest("hex"),
      createHash("sha256").update(sourceBytes).digest("hex"),
      new Date("2026-09-10T12:00:00Z")
    );
    expect(receipt.channel).toBe("browser");
    expect(receipt.nonce).toBe("nonce-9");
    expect(receipt.expiresAt).toBe("2026-09-10T12:30:00.000Z");
    const parsed = JSON.parse(serializeReceipt(receipt));
    expect(Object.keys(parsed)).toEqual([
      "version",
      "receiptId",
      "nonce",
      "planDigest",
      "sourceDigest",
      "channel",
      "mintedAt",
      "expiresAt"
    ]);
    expect(parsed.planDigest).toBe(createHash("sha256").update(planBytes).digest("hex"));
  });

  it("tracks dirty across edits and clears on save", () => {
    let state = base();
    expect(state.dirty).toBe(false);
    state = markSaved(setFieldText(state, "10 0 R", "x"));
    expect(state.dirty).toBe(false);
    // The burn-in choice alone is an output option, not an unsaved value.
    state = setBurnIn(state, true);
    expect(state.dirty).toBe(false);
  });
});
