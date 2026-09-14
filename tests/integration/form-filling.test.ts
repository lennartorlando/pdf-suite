import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assemblePages, fillForm, inventoryFormFields, verifyFormFill } from "@pdf-compressor/core";
import { serializeFormPlan, type FormPlan, type FormPlanEntry } from "@pdf-compressor/core/form-plan";
import type { FormFieldEntry } from "@pdf-compressor/core/form-inventory";
import { runFormsCommand } from "../../packages/cli/src/commands/forms.js";
import { buildTestPdf } from "../../packages/core/test/pdf-fixtures.js";
import { JobManager } from "../../apps/local-server/src/jobs.js";
import { createLocalServer } from "../../apps/local-server/src/server.js";
import { SessionStore } from "../../apps/local-server/src/session.js";

/**
 * U8 parity proof (R34, R22): one approved plan applied through the shared
 * core, the CLI's receipt-gated apply, and the loopback fill route, with an
 * independent readback on every output. Field values, appearance states,
 * warnings and placement behavior must agree across surfaces. The plan
 * carries a text placement, not only field values.
 *
 * A second proof covers R22 directly: qpdf page assembly of a filled form
 * keeps the fields, their values and their appearance states, so the old
 * documentation claim that forms may not survive assembly was too
 * pessimistic.
 */

interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

function buildMultipart(parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----u8parity${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const data = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : part.data;
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += "\r\n";
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += "\r\n";
    chunks.push(Buffer.from(header, "utf8"), data, Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function qpdfJson(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile("qpdf", ["--json", "--", path], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(JSON.parse(String(stdout)) as Record<string, unknown>);
    });
  });
}

interface FieldRow {
  fullname?: string;
  partialname?: string;
  value?: string;
  annotation?: { appearancestate?: string };
}

/**
 * Field state snapshot keyed by name: the raw qpdf value encoding plus the
 * appearance-state name. Object references differ between independently
 * written outputs, so names are the stable key.
 */
async function fieldSnapshot(path: string): Promise<Map<string, { value: string; appearance: string }>> {
  const raw = await qpdfJson(path);
  const acroform = raw["acroform"] as { fields?: FieldRow[] } | undefined;
  const map = new Map<string, { value: string; appearance: string }>();
  for (const row of acroform?.fields ?? []) {
    const name = row.fullname ?? row.partialname ?? "?";
    map.set(name, {
      value: String(row.value ?? ""),
      appearance: String(row.annotation?.appearancestate ?? "")
    });
  }
  return map;
}

function snapshotObject(map: Map<string, { value: string; appearance: string }>): Record<string, unknown> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe("U8 form-filling parity proof (real qpdf)", () => {
  let scratch = "";
  let source = "";
  let jobs: JobManager;
  let server: Server;
  let port = 0;

  function call(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}
  ): Promise<HttpResult> {
    return new Promise<HttpResult>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          setHost: false,
          agent: false,
          headers: { host: `127.0.0.1:${port}`, ...options.headers }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const headers: Record<string, string | undefined> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              headers[key] = Array.isArray(value) ? value.join("; ") : value;
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        }
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async function launch(): Promise<{ origin: string; cookie: string; token: string }> {
    const origin = `http://127.0.0.1:${port}`;
    const result = await call("/api/session/launch", { method: "POST", headers: { origin } });
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as { token: string };
    return { origin, cookie: (result.headers["set-cookie"] ?? "").split(";")[0], token: payload.token };
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u8-fill-proof-"));
    source = join(scratch, "form-source.pdf");
    await writeFile(
      source,
      buildTestPdf([{ width: 620, label: "U8-F-1" }, { width: 621, label: "U8-F-2" }], {
        formTextField: true,
        formCheckbox: true,
        formChoice: true
      })
    );
    jobs = await JobManager.create({ tempRoot: join(scratch, "app-temp") });
    const handle = createLocalServer({ sessions: new SessionStore(), jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
  });

  /** The shared entries: every field answered, plus one text placement. */
  function entriesFor(sourceBinding: string, fields: readonly FormFieldEntry[]): FormPlanEntry[] {
    const out: FormPlanEntry[] = [];
    for (const field of fields) {
      if (field.type === "checkbox") {
        out.push({ kind: "field", fieldId: field.fieldId, status: "answered", value: "Ja" });
      } else if (field.type === "choice") {
        out.push({ kind: "field", fieldId: field.fieldId, status: "answered", value: "beta" });
      } else {
        out.push({ kind: "field", fieldId: field.fieldId, status: "answered", value: "approved-text-value" });
      }
    }
    out.push({
      kind: "text",
      source: sourceBinding,
      page: 1,
      rect: { x: 50, y: 40, width: 180, height: 20 },
      text: "placed-text-value"
    });
    return out;
  }

  function planFor(sourceBinding: string, destination: string, nonce: string, fields: readonly FormFieldEntry[]): FormPlan {
    return {
      version: 1,
      source: sourceBinding,
      destination,
      overwrite: true,
      burnIn: false,
      nonce,
      entries: entriesFor(sourceBinding, fields)
    };
  }

  it("applies one plan identically through core, CLI, and the loopback route", { timeout: 120000 }, async () => {
    const { inventory } = await inventoryFormFields(source, { workspaceParent: scratch });
    expect(inventory.fields.length).toBe(3);

    /* ---- surface 1: shared core ---- */
    const coreOut = join(scratch, "core-filled.pdf");
    const corePlan = planFor(source, coreOut, `u8-core-${randomUUID()}`, inventory.fields);
    const corePlanPath = join(scratch, "core-plan.json");
    await writeFile(corePlanPath, serializeFormPlan(corePlan));
    const coreSummary = await fillForm({
      sourcePath: source,
      planPath: corePlanPath,
      destinationPath: coreOut,
      workspaceParent: scratch
    });
    expect(coreSummary.fieldsWritten).toBe(3);
    expect(coreSummary.placementsWritten).toBe(1);
    const coreVerify = await verifyFormFill(corePlan, source, coreOut, { workspaceParent: scratch });
    expect(coreVerify.allApplied).toBe(true);

    /* ---- surface 2: CLI, exercising the receipt-gated apply ---- */
    const cliOut = join(scratch, "cli-filled.pdf");
    const cliPlan = planFor(source, cliOut, `u8-cli-${randomUUID()}`, inventory.fields);
    const cliPlanPath = join(scratch, "cli-plan.json");
    await writeFile(cliPlanPath, serializeFormPlan(cliPlan));
    const cliDeps = {
      ledgerDir: join(scratch, "ledger"),
      workspaceParent: scratch,
      isInteractive: true,
      confirmApproval: async (display: string): Promise<boolean> => {
        // The approval display must render the approved values verbatim.
        expect(display).toContain("approved-text-value");
        expect(display).toContain("placed-text-value");
        return true;
      }
    };
    const validate = await runFormsCommand(["validate", cliPlanPath, "--json"], cliDeps);
    expect(validate.exitCode).toBe(0);
    const validated = JSON.parse(validate.stdout) as { ok: boolean; outstanding: unknown[] };
    expect(validated.ok).toBe(true);
    expect(validated.outstanding).toHaveLength(0);

    const apply = await runFormsCommand(["apply", cliPlanPath, "--json"], cliDeps);
    expect(apply.exitCode).toBe(0);
    const applied = JSON.parse(apply.stdout) as {
      ok: boolean;
      fieldsWritten: number;
      placementsWritten: number;
      audit: string | null;
      warnings: string[];
    };
    expect(applied.ok).toBe(true);
    expect(applied.fieldsWritten).toBe(3);
    expect(applied.placementsWritten).toBe(1);
    // R29 artifacts: owner-only receipt and audit beside the plan.
    expect(applied.audit).not.toBeNull();
    expect((await stat(`${cliPlanPath}.receipt.json`)).mode & 0o777).toBe(0o600);
    expect((await stat(applied.audit as string)).mode & 0o777).toBe(0o600);

    const cliVerify = await runFormsCommand(["verify", cliOut, "--plan", cliPlanPath, "--json"], cliDeps);
    expect(cliVerify.exitCode).toBe(0);
    const cliVerified = JSON.parse(cliVerify.stdout) as { ok: boolean; status: string };
    expect(cliVerified.ok).toBe(true);

    /* ---- surface 3: the loopback route (browser path) ---- */
    const auth = await launch();
    const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
      origin: auth.origin,
      cookie: auth.cookie,
      "x-launch-token": auth.token,
      ...extra
    });
    const serverPlan = planFor("upload", "download", `u8-web-${randomUUID()}`, inventory.fields);
    const upload = buildMultipart([
      { name: "plan", contentType: "application/json", data: serializeFormPlan(serverPlan) },
      { name: "source", filename: "form.pdf", contentType: "application/pdf", data: await readFile(source) }
    ]);
    const filled = await call("/api/forms/fill", {
      method: "POST",
      headers: authed({ "content-type": upload.contentType, "content-length": String(upload.body.length) }),
      body: upload.body
    });
    expect(filled.status).toBe(200);
    const fillPayload = JSON.parse(filled.body.toString("utf8")) as {
      ok: boolean;
      downloadUrl: string;
      fieldsWritten: number;
      placementsWritten: number;
      warnings: string[];
    };
    expect(fillPayload.ok).toBe(true);
    expect(fillPayload.fieldsWritten).toBe(3);
    expect(fillPayload.placementsWritten).toBe(1);
    const download = await call(fillPayload.downloadUrl, { headers: authed() });
    expect(download.status).toBe(200);
    const webOut = join(scratch, "web-filled.pdf");
    await writeFile(webOut, download.body);
    const webVerify = await verifyFormFill(serverPlan, source, webOut, { workspaceParent: scratch });
    expect(webVerify.allApplied).toBe(true);

    /* ---- parity: identical field values and appearance states ---- */
    const coreSnapshot = await fieldSnapshot(coreOut);
    const cliSnapshot = await fieldSnapshot(cliOut);
    const webSnapshot = await fieldSnapshot(webOut);
    expect(snapshotObject(cliSnapshot)).toEqual(snapshotObject(coreSnapshot));
    expect(snapshotObject(webSnapshot)).toEqual(snapshotObject(coreSnapshot));
    expect(coreSnapshot.get("fixture-name")?.value).toBe("u:approved-text-value");
    expect(coreSnapshot.get("fixture-check")?.appearance).toBe("/Ja");
    expect(coreSnapshot.get("fixture-choice")?.value).toBe("u:beta");

    // Placement and warning behavior agree across surfaces.
    expect(coreVerify.placements).toEqual([{ kind: "text", page: 1, applied: true }]);
    expect(webVerify.placements).toEqual(coreVerify.placements);
    expect(cliVerified.ok).toBe(true);
    expect(applied.warnings).toEqual(coreSummary.warnings);
    expect(fillPayload.warnings).toEqual(coreSummary.warnings);

    /* ---- R22: qpdf page assembly preserves the filled form ---- */
    const assembledOut = join(scratch, "assembled.pdf");
    const assembled = await assemblePages({
      sources: [{ id: "s", path: coreOut }],
      manifest: { version: 1, pages: [{ sourceId: "s", page: 1 }, { sourceId: "s", page: 2 }] },
      destinationPath: assembledOut
    });
    expect(assembled.status).toBe("success");
    const assembledInventory = await inventoryFormFields(assembledOut, { workspaceParent: scratch });
    expect(assembledInventory.inventory.fields.length).toBe(3);
    expect(snapshotObject(await fieldSnapshot(assembledOut))).toEqual(snapshotObject(coreSnapshot));

    /* ---- R29: clean removes plan, receipt and audit ---- */
    const clean = await runFormsCommand(["clean", cliPlanPath, "--json"], cliDeps);
    expect(clean.exitCode).toBe(0);
    const cleaned = JSON.parse(clean.stdout) as { ok: boolean; removed: string[] };
    expect(cleaned.ok).toBe(true);
    expect(cleaned.removed).toHaveLength(3);
  });
});
