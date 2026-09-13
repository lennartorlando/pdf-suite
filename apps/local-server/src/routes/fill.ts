import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CompressionError,
  fillForm,
  getQpdfVersion,
  inventoryFormFields,
  QPDF_SECURITY_FLOOR
} from "@pdf-compressor/core";
import { parseFormPlan, serializeFormPlan, type FormPlan } from "@pdf-compressor/core/form-plan";
import type { FormInventory } from "@pdf-compressor/core/form-inventory";
import { LIMITS, type JobManager } from "../jobs.js";
import { streamFillMultipart, streamSourceUpload } from "../multipart.js";
import type { SessionStore } from "../session.js";
import { probeVersion, sanitizeExportError, writeJson } from "./edit.js";

export interface FillRouteContext {
  sessions: SessionStore;
  jobs: JobManager;
  sessionId: string;
}

interface FillRouteOutcome {
  status: number;
  payload: unknown;
  retainedDir: string | null;
}

/**
 * Shared bounded-job skeleton for the form routes: an intake estimate gate
 * before any job directory exists, then a private `fill-` directory, one
 * deadline-driven abort controller, and cleanup of everything but the
 * retained output. The caller holds the global native slot and releases it
 * after the handler settles; this never releases it.
 */
async function runBoundedFillJob(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: FillRouteContext,
  maxIntakeBytes: number,
  work: (jobDir: string, controller: AbortController, deadline: { timedOut: boolean }) => Promise<FillRouteOutcome>
): Promise<void> {
  const { jobs } = ctx;
  const expectedIntake = claimedBytes(req, maxIntakeBytes);
  if (expectedIntake > maxIntakeBytes) {
    writeJson(res, 413, { ok: false, code: "TOTAL_TOO_LARGE", message: "Upload exceeds its total byte cap." });
    return;
  }

  const { dir: jobDir } = await jobs.newJobDir("fill-");
  const controller = new AbortController();
  const deadline = { timedOut: false };
  const timeout = setTimeout(() => {
    deadline.timedOut = true;
    controller.abort();
  }, jobs.jobTimeoutMs);
  timeout.unref?.();
  // A response that closes before headers are written means the client went
  // away; a completed request stream alone must not cancel native work.
  const onResClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onResClose);

  try {
    const outcome = await work(jobDir, controller, deadline);
    // Attempt cleanup before responding; transient failures stay registered
    // with the job manager for its sweeper and shutdown retry.
    if (outcome.retainedDir === null) {
      await jobs.removeDir(jobDir);
    }
    writeJson(res, outcome.status, outcome.payload);
  } finally {
    clearTimeout(timeout);
    res.off("close", onResClose);
  }
}

function claimedBytes(req: IncomingMessage, fallback: number): number {
  const claimed = Number(req.headers["content-length"]);
  return Number.isInteger(claimed) && claimed > 0 ? claimed : fallback;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function fillFailureMessage(mapped: { status: number; code: string }): string {
  if (mapped.status === 499) return "Fill was cancelled.";
  if (mapped.status === 504) return "Fill exceeded its runtime budget.";
  if (mapped.code === "NATIVE_VERSION_UNSUPPORTED") {
    return "A required local PDF tool is too old. Update it and try again.";
  }
  if (mapped.code === "ENGINE_UNAVAILABLE") {
    return "A required local PDF tool is unavailable. Check your local setup and try again.";
  }
  return mapped.status >= 500 ? "Fill failed." : "Fill was rejected.";
}

/** R13: current values stay digested unless the caller opted into reveal. */
function inventoryForWire(inventory: FormInventory, revealValues: boolean): unknown {
  if (revealValues) return inventory;
  return {
    version: inventory.version,
    fields: inventory.fields.map((field) => {
      if (field.currentValue === undefined) return field;
      const { currentValue, ...rest } = field;
      return {
        ...rest,
        currentValueDigest: createHash("sha256").update(currentValue, "utf8").digest("hex")
      };
    })
  };
}

/**
 * Server-authoritative form inventory (KTD6): the browser cannot run qpdf,
 * so it consumes the same inventory the CLI does.
 */
export async function handleFormInventory(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: FillRouteContext
): Promise<void> {
  const reveals = url.searchParams.getAll("reveal");
  if (reveals.length > 1 || (reveals.length === 1 && reveals[0] !== "values")) {
    writeJson(res, 400, { ok: false, code: "QUERY_INVALID", message: "Unknown inventory option." });
    return;
  }
  const revealValues = reveals.length === 1;
  await runBoundedFillJob(req, res, ctx, LIMITS.maxFillSourceBytes, (jobDir, controller, deadline) =>
    runInventoryWork(req, ctx, jobDir, controller, deadline, revealValues)
  );
}

async function runInventoryWork(
  req: IncomingMessage,
  ctx: FillRouteContext,
  jobDir: string,
  controller: AbortController,
  deadline: { timedOut: boolean },
  revealValues: boolean
): Promise<FillRouteOutcome> {
  const { jobs } = ctx;
  const fail = (status: number, code: string, message: string): FillRouteOutcome => ({
    status,
    payload: { ok: false, code, message },
    retainedDir: null
  });
  try {
    const intake = await jobs.checkCapacity(claimedBytes(req, LIMITS.maxFillSourceBytes));
    if (!intake.ok) {
      return fail(507, intake.code, "Insufficient temporary capacity.");
    }

    const upload = await streamSourceUpload(req, jobDir, controller.signal);

    const qpdf = await probeVersion(
      () => getQpdfVersion({ signal: controller.signal, timeoutMs: jobs.jobTimeoutMs }),
      QPDF_SECURITY_FLOOR
    );
    if (!qpdf.available) {
      return fail(503, "FILL_UNAVAILABLE", "Form filling is unavailable.");
    }

    const result = await inventoryFormFields(upload.sourcePath, {
      signal: controller.signal,
      timeoutMs: jobs.jobTimeoutMs,
      workspaceParent: jobDir
    });
    return {
      status: 200,
      payload: {
        ok: true,
        inventory: inventoryForWire(result.inventory, revealValues),
        pageCount: result.pageCount,
        qpdfVersion: result.qpdfVersion,
        removedRestrictions: result.removedRestrictions,
        removedUsageRights: result.removedUsageRights,
        warnings: result.warnings
      },
      retainedDir: null
    };
  } catch (error) {
    if (deadline.timedOut) {
      error = new CompressionError("JOB_TIMEOUT", "Inventory exceeded its runtime budget.");
    }
    const mapped = sanitizeExportError(error);
    return fail(mapped.status, mapped.code, fillFailureMessage(mapped));
  }
}

/**
 * Bounded multipart fill (KTD12): the browser posts one source plus one
 * plan of values; the same core `fillForm` the CLI uses produces and
 * validates the output. The plan's nonce is honoured per KTD18: the
 * idempotency record is bound to the authenticated session and to digests
 * of the exact source and plan bytes, so only a true repeat is answered
 * from the record.
 */
export async function handleFormFill(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: FillRouteContext
): Promise<void> {
  await runBoundedFillJob(req, res, ctx, LIMITS.maxFillTotalBytes, (jobDir, controller, deadline) =>
    runFillWork(req, ctx, jobDir, controller, deadline)
  );
}

async function runFillWork(
  req: IncomingMessage,
  ctx: FillRouteContext,
  jobDir: string,
  controller: AbortController,
  deadline: { timedOut: boolean }
): Promise<FillRouteOutcome> {
  const { jobs } = ctx;
  let nonce: string | null = null;
  const finish = (outcome: FillRouteOutcome): FillRouteOutcome => {
    // Only a produced write is stored: an interrupted or refused attempt may
    // re-run for identical bytes, while different bytes are always rejected.
    if (nonce !== null && outcome.status === 200) {
      jobs.completeFillNonce(nonce, { status: outcome.status, payload: outcome.payload });
    }
    return outcome;
  };
  const fail = (status: number, code: string, message: string): FillRouteOutcome =>
    finish({ status, payload: { ok: false, code, message }, retainedDir: null });
  try {
    const intake = await jobs.checkCapacity(claimedBytes(req, LIMITS.maxFillTotalBytes));
    if (!intake.ok) {
      return fail(507, intake.code, "Insufficient temporary capacity.");
    }

    const upload = await streamFillMultipart(req, jobDir, controller.signal);

    let parsed: unknown;
    try {
      parsed = JSON.parse(upload.planRaw);
    } catch {
      return fail(400, "PLAN_INVALID", "Plan is not valid JSON.");
    }
    let plan: FormPlan;
    try {
      plan = parseFormPlan(parsed);
    } catch (error) {
      const mapped = sanitizeExportError(error);
      return fail(mapped.status, mapped.code, "Plan violates its closed schema.");
    }
    nonce = plan.nonce;

    // KTD18: the record answers a repeat only for the same session and the
    // same source and plan bytes.
    const planDigest = createHash("sha256").update(upload.planRaw, "utf8").digest("hex");
    const sourceDigest = await hashFile(upload.sourcePath);
    const verdict = jobs.resolveFillNonce(nonce, {
      sessionId: ctx.sessionId,
      planDigest,
      sourceDigest
    });
    if (verdict.kind === "foreign") {
      return fail(409, "FILL_NONCE_REUSED", "The plan nonce was consumed under a different session.");
    }
    if (verdict.kind === "plan-mismatch") {
      return fail(409, "FILL_PLAN_CHANGED", "The plan changed after this nonce was consumed.");
    }
    if (verdict.kind === "source-mismatch") {
      return fail(409, "FILL_SOURCE_CHANGED", "The source changed after this nonce was consumed.");
    }
    if (verdict.kind === "replay") {
      return { status: verdict.outcome.status, payload: verdict.outcome.payload, retainedDir: null };
    }

    // Rebind the opaque plan bindings to this job's private paths (KTD12):
    // the browser names roles, never paths. Placement entries carry their
    // own source binding per KTD13, so entries bound to the plan's source
    // role follow it; anything else stays foreign and the fill refuses it.
    const destinationPath = join(jobDir, "output.pdf");
    const planPath = join(jobDir, "plan.json");
    const rebound: FormPlan = {
      ...plan,
      source: upload.sourcePath,
      destination: destinationPath,
      entries: plan.entries.map((entry) =>
        entry.kind === "field" || entry.source !== plan.source ? entry : { ...entry, source: upload.sourcePath }
      )
    };
    await writeFile(planPath, serializeFormPlan(rebound), { mode: 0o600 });

    const qpdf = await probeVersion(
      () => getQpdfVersion({ signal: controller.signal, timeoutMs: jobs.jobTimeoutMs }),
      QPDF_SECURITY_FLOOR
    );
    if (!qpdf.available) {
      return fail(503, "FILL_UNAVAILABLE", "Form filling is unavailable.");
    }

    const outputCapacity = await jobs.checkCapacity(upload.totalBytes + LIMITS.maxOutputBytes);
    if (!outputCapacity.ok) {
      return fail(507, outputCapacity.code, "Insufficient temporary capacity.");
    }

    const summary = await fillForm({
      sourcePath: upload.sourcePath,
      planPath,
      destinationPath,
      signal: controller.signal,
      timeoutMs: jobs.jobTimeoutMs,
      maxOutputBytes: LIMITS.maxOutputBytes,
      workspaceParent: jobDir,
      resourceCheck: (additionalBytes) => jobs.assertRuntimeCapacity(additionalBytes)
    });
    const outputStat = await stat(destinationPath);
    if (outputStat.size > LIMITS.maxOutputBytes) {
      throw new Error("OUTPUT_TOO_LARGE");
    }
    // Keep only the validated output; remove uploads immediately.
    await Promise.all([rm(upload.sourcePath, { force: true }), rm(planPath, { force: true })]);
    const retained = await jobs.retainOutput({
      sessionId: ctx.sessionId,
      jobDir,
      outputPath: destinationPath,
      pageCount: summary.pageCount,
      ttlMs: LIMITS.fillOutputTtlMs
    });
    return finish({
      status: 200,
      payload: {
        ok: true,
        handle: retained.handle,
        downloadUrl: `/api/outputs/${retained.handle}/download`,
        pageCount: summary.pageCount,
        outputBytes: summary.outputBytes,
        burnedIn: summary.burnedIn,
        fieldsWritten: summary.fieldsWritten,
        placementsWritten: summary.placementsWritten,
        computedFields: summary.computedFields,
        removedRestrictions: summary.removedRestrictions,
        removedUsageRights: summary.removedUsageRights,
        sourceHash: summary.sourceHash,
        warnings: summary.warnings,
        compatWarnings: summary.compatWarnings
      },
      retainedDir: jobDir
    });
  } catch (error) {
    if (deadline.timedOut) {
      error = new CompressionError("JOB_TIMEOUT", "Fill exceeded its runtime budget.");
    }
    const mapped = sanitizeExportError(error);
    return fail(mapped.status, mapped.code, fillFailureMessage(mapped));
  }
}
