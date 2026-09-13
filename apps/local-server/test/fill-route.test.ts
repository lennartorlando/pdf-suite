import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as core from "@pdf-compressor/core";
import { parseFormPlan, serializeFormPlan } from "@pdf-compressor/core/form-plan";
import { writeTestPdf } from "../../../packages/core/test/pdf-fixtures.js";
import { JobManager, LIMITS } from "../src/jobs.js";
import { createLocalServer } from "../src/server.js";
import { SessionStore } from "../src/session.js";

interface HttpResult {
  status: number;
  body: Buffer;
}

interface Auth {
  origin: string;
  cookie: string;
  token: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function makePlan(nonce: string, fieldId: string, value = "Ada"): string {
  return serializeFormPlan({
    version: 1,
    source: "upload",
    destination: "download",
    overwrite: false,
    burnIn: false,
    nonce,
    entries: [{ kind: "field", fieldId, status: "answered", value }]
  });
}

function fillBody(edge: string, plan: string, pdf: Buffer): Buffer {
  const head =
    `--${edge}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n` +
    `--${edge}\r\nContent-Disposition: form-data; name="source"; filename="form.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "utf8"), pdf, Buffer.from(`\r\n--${edge}--\r\n`, "utf8")]);
}

function sourceBody(edge: string, pdf: Buffer): Buffer {
  const head = `--${edge}\r\nContent-Disposition: form-data; name="source"; filename="form.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "utf8"), pdf, Buffer.from(`\r\n--${edge}--\r\n`, "utf8")]);
}

describe("fill and inventory routes", () => {
  let scratch = "";
  let sessions: SessionStore;
  let jobs: JobManager;
  let server: Server;
  let port = 0;
  let pdf = Buffer.alloc(0);
  let sourcePath = "";
  let fieldId = "";

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
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        }
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async function launch(targetPort = port): Promise<Auth> {
    const origin = `http://127.0.0.1:${targetPort}`;
    const { headers, body, status } = await new Promise<{
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
      status: number;
    }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: targetPort,
          path: "/api/session/launch",
          method: "POST",
          setHost: false,
          agent: false,
          headers: { host: `127.0.0.1:${targetPort}`, origin }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks),
              status: res.statusCode ?? 0
            })
          );
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    const payload = JSON.parse(body.toString("utf8")) as { token: string };
    const rawCookie = headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie.join("; ") : (rawCookie ?? "")).split(";")[0];
    return { origin, cookie, token: payload.token };
  }

  function authedHeaders(auth: Auth): Record<string, string> {
    return { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token };
  }

  async function postFill(auth: Auth, body: Buffer, edge = "filledge"): Promise<HttpResult> {
    return call("/api/forms/fill", {
      method: "POST",
      headers: {
        ...authedHeaders(auth),
        "content-type": `multipart/form-data; boundary=${edge}`,
        "content-length": String(body.length)
      },
      body
    });
  }

  async function postInventory(auth: Auth, body: Buffer, edge = "inventoryedge", query = ""): Promise<HttpResult> {
    return call(`/api/forms/inventory${query}`, {
      method: "POST",
      headers: {
        ...authedHeaders(auth),
        "content-type": `multipart/form-data; boundary=${edge}`,
        "content-length": String(body.length)
      },
      body
    });
  }

  async function tempEntries(): Promise<string[]> {
    return (await readdir(jobs.tempRoot)).sort();
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u5-fill-test-"));
    sessions = new SessionStore();
    jobs = await JobManager.create({ tempRoot: join(scratch, "app") });
    const handle = createLocalServer({ sessions, jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
    sourcePath = await writeTestPdf(scratch, "form.pdf", [{ width: 210 }], {
      formTextField: true,
      formPrefilledText: "prefill"
    });
    pdf = await readFile(sourcePath);
    const inventory = await core.inventoryFormFields(sourcePath);
    fieldId = inventory.inventory.fields[0]?.fieldId ?? "";
    expect(fieldId).not.toBe("");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the source once, hands the core the parsed plan and returns no local path", async () => {
    const auth = await launch();
    const plan = makePlan("nonce-rebind", fieldId);
    const seen: { sourcePath?: string; planPath?: string; destinationPath?: string } = {};
    const fill = vi.spyOn(core, "fillForm").mockImplementationOnce(async (options) => {
      seen.sourcePath = options.sourcePath;
      seen.planPath = options.planPath;
      seen.destinationPath = options.destinationPath;
      const planOnDisk = parseFormPlan(JSON.parse(await readFile(options.planPath, "utf8")));
      expect(planOnDisk.nonce).toBe("nonce-rebind");
      expect(planOnDisk.source).toBe(options.sourcePath);
      expect(planOnDisk.destination).toBe(options.destinationPath);
      expect((await readFile(options.sourcePath)).equals(pdf)).toBe(true);
      const siblings = await readdir(dirname(options.sourcePath));
      expect(siblings.filter((name) => name.startsWith("source-"))).toEqual(["source-0.pdf"]);
      await writeFile(options.destinationPath, pdf);
      return {
        outputPath: options.destinationPath,
        outputBytes: pdf.length,
        pageCount: 1,
        burnedIn: false,
        fieldsWritten: 1,
        placementsWritten: 0,
        computedFields: 0,
        removedRestrictions: false,
        removedUsageRights: false,
        qpdfVersion: "12.4.1",
        sourceHash: sha256(pdf),
        warnings: [],
        compatWarnings: []
      };
    });

    const result = await postFill(auth, fillBody("rebindedge", plan, pdf), "rebindedge");
    expect(fill).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as {
      ok: boolean;
      handle: string;
      downloadUrl: string;
      fieldsWritten: number;
      sourceHash: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.handle).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.downloadUrl).toBe(`/api/outputs/${payload.handle}/download`);
    expect(payload.fieldsWritten).toBe(1);
    expect(payload.sourceHash).toBe(sha256(pdf));
    const text = result.body.toString("utf8");
    expect(text).not.toContain(scratch);
    expect(text).not.toContain("source-0");
    expect(text).not.toContain("form.pdf");
    expect(seen.sourcePath).toBeTruthy();

    // Only the validated output remains in the retained fill directory.
    const dirs = await tempEntries();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^fill-[0-9a-f]{32}$/);
    expect(await readdir(join(jobs.tempRoot, dirs[0]))).toEqual(["output.pdf"]);
    expect(jobs.retainedCount()).toBe(1);

    // The retained artifact downloads once under the owning session.
    const download = await call(payload.downloadUrl, { headers: authedHeaders(auth) });
    expect(download.status).toBe(200);
    expect(download.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const replay = await call(payload.downloadUrl, { headers: authedHeaders(auth) });
    expect(replay.status).toBe(404);
  });

  it("returns the authoritative inventory with values digested, matching the CLI's", async () => {
    const auth = await launch();
    const direct = await core.inventoryFormFields(sourcePath);
    const result = await postInventory(auth, sourceBody("invedge", pdf), "invedge");
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as {
      ok: boolean;
      inventory: { fields: Array<Record<string, unknown>> };
      pageCount: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.pageCount).toBe(direct.pageCount);
    expect(payload.inventory.fields.map((field) => field["fieldId"])).toEqual(
      direct.inventory.fields.map((field) => field.fieldId)
    );
    const field = payload.inventory.fields[0];
    expect("currentValue" in field).toBe(false);
    expect(field["currentValueDigest"]).toBe(sha256("prefill"));
    expect(result.body.toString("utf8")).not.toContain(scratch);
    expect(await tempEntries()).toEqual([]);

    const revealed = await postInventory(auth, sourceBody("invedge2", pdf), "invedge2", "?reveal=values");
    expect(revealed.status).toBe(200);
    const revealedPayload = JSON.parse(revealed.body.toString("utf8")) as {
      inventory: { fields: Array<Record<string, unknown>> };
    };
    expect(revealedPayload.inventory.fields[0]["currentValue"]).toBe("prefill");
  });

  it("rejects boundary, session and token failures before any job directory exists", async () => {
    const auth = await launch();
    const plan = makePlan("nonce-guard", fieldId);
    const body = fillBody("guardedge", plan, pdf);
    const headers = {
      ...authedHeaders(auth),
      "content-type": "multipart/form-data; boundary=guardedge",
      "content-length": String(body.length)
    };
    const cases: { name: string; headers: Record<string, string>; path: string; status: number; code: string }[] = [
      {
        name: "foreign origin",
        headers: { ...headers, origin: "https://evil.example" },
        path: "/api/forms/fill",
        status: 400,
        code: "BAD_ORIGIN"
      },
      {
        name: "unexpected host",
        headers: { ...headers, host: "evil.example" },
        path: "/api/forms/fill",
        status: 400,
        code: "BAD_HOST"
      },
      {
        name: "cross-site fetch metadata",
        headers: { ...headers, "sec-fetch-site": "cross-site" },
        path: "/api/forms/fill",
        status: 400,
        code: "CROSS_SITE_REQUEST"
      },
      {
        name: "missing token",
        headers: { origin: auth.origin, cookie: auth.cookie, "content-type": headers["content-type"] },
        path: "/api/forms/fill",
        status: 401,
        code: "TOKEN_REQUIRED"
      },
      {
        name: "wrong token",
        headers: { ...headers, "x-launch-token": "0".repeat(64) },
        path: "/api/forms/fill",
        status: 401,
        code: "TOKEN_INVALID"
      },
      {
        name: "foreign origin on inventory",
        headers: { ...headers, origin: "https://evil.example" },
        path: "/api/forms/inventory",
        status: 400,
        code: "BAD_ORIGIN"
      }
    ];
    for (const entry of cases) {
      const result = await call(entry.path, { method: "POST", headers: entry.headers, body });
      expect(result.status, entry.name).toBe(entry.status);
      expect(JSON.parse(result.body.toString("utf8")), entry.name).toMatchObject({ ok: false, code: entry.code });
      expect(await tempEntries(), entry.name).toEqual([]);
    }

    // A different session's cookie with this session's token is invalid.
    const other = await launch();
    const wrongSession = await call("/api/forms/fill", {
      method: "POST",
      headers: { ...headers, cookie: other.cookie },
      body
    });
    expect(wrongSession.status).toBe(401);
    expect(await tempEntries()).toEqual([]);
  });

  it("rejects an expired launch token before allocation", async () => {
    const tightSessions = new SessionStore({ tokenTtlMs: 1 });
    const tightJobs = await JobManager.create({ tempRoot: join(scratch, "expired") });
    const tightHandle = createLocalServer({ sessions: tightSessions, jobs: tightJobs });
    await new Promise<void>((resolve) => tightHandle.server.listen(0, "127.0.0.1", () => resolve()));
    const tightPort = (tightHandle.server.address() as AddressInfo).port;
    try {
      const auth = await launch(tightPort);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const plan = makePlan("nonce-expired", fieldId);
      const body = fillBody("expirededge", plan, pdf);
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: tightPort,
            path: "/api/forms/fill",
            method: "POST",
            setHost: false,
            agent: false,
            headers: {
              host: `127.0.0.1:${tightPort}`,
              origin: auth.origin,
              cookie: auth.cookie,
              "x-launch-token": auth.token,
              "content-type": "multipart/form-data; boundary=expirededge",
              "content-length": String(body.length)
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "TOKEN_EXPIRED" });
      expect(await readdir(tightJobs.tempRoot)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => tightHandle.server.close(() => resolve()));
      await tightJobs.shutdown();
    }
  });

  it("rejects malformed, oversized, duplicate and excess parts with cleanup", async () => {
    const auth = await launch();
    const plan = makePlan("nonce-limits", fieldId);

    const expectRejected = async (
      name: string,
      body: Buffer,
      edge: string,
      status: number,
      code: string
    ): Promise<void> => {
      const result = await postFill(auth, body, edge);
      expect(result.status, name).toBe(status);
      expect(JSON.parse(result.body.toString("utf8")), name).toMatchObject({ ok: false, code });
      expect(await tempEntries(), name).toEqual([]);
    };

    // Not multipart at all.
    const plain = await call("/api/forms/fill", {
      method: "POST",
      headers: { ...authedHeaders(auth), "content-type": "application/json", "content-length": "2" },
      body: Buffer.from("{}")
    });
    expect(plain.status).toBe(415);
    expect(JSON.parse(plain.body.toString("utf8"))).toMatchObject({ ok: false, code: "NOT_MULTIPART" });

    // Missing plan field.
    await expectRejected("missing plan", sourceBody("noplanedge", pdf), "noplanedge", 400, "MISSING_PLAN");

    // Missing source file.
    const noSource = Buffer.from(
      `--nosourceedge\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n--nosourceedge--\r\n`,
      "utf8"
    );
    await expectRejected("missing source", noSource, "nosourceedge", 400, "MISSING_SOURCE");

    // Duplicate plan field.
    const dupPlan = Buffer.from(
      `--dupedge\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n` +
        `--dupedge\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n` +
        `--dupedge\r\nContent-Disposition: form-data; name="source"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      "utf8"
    );
    await expectRejected(
      "duplicate plan",
      Buffer.concat([dupPlan, pdf, Buffer.from("\r\n--dupedge--\r\n", "utf8")]),
      "dupedge",
      400,
      "DUPLICATE_PLAN"
    );

    // Unknown field part.
    const unknownField = Buffer.from(
      `--unknownedge\r\nContent-Disposition: form-data; name="notes"\r\n\r\nhi\r\n` +
        `--unknownedge\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n` +
        `--unknownedge\r\nContent-Disposition: form-data; name="source"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      "utf8"
    );
    await expectRejected(
      "unknown field",
      Buffer.concat([unknownField, pdf, Buffer.from("\r\n--unknownedge--\r\n", "utf8")]),
      "unknownedge",
      400,
      "UNKNOWN_PART"
    );

    // Two source parts.
    const twoSources = Buffer.from(
      `--twosrc\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n` +
        `--twosrc\r\nContent-Disposition: form-data; name="source"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      "utf8"
    );
    const twoTail = Buffer.from(
      `\r\n--twosrc\r\nContent-Disposition: form-data; name="source"; filename="b.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      "utf8"
    );
    await expectRejected(
      "two sources",
      Buffer.concat([twoSources, pdf, twoTail, pdf, Buffer.from("\r\n--twosrc--\r\n", "utf8")]),
      "twosrc",
      413,
      "TOO_MANY_SOURCES"
    );

    // Plan one byte over its cap.
    const bigPlanBody = Buffer.from(
      `--bigplan\r\nContent-Disposition: form-data; name="plan"\r\n\r\n`,
      "utf8"
    );
    await expectRejected(
      "oversized plan",
      Buffer.concat([
        bigPlanBody,
        Buffer.from(" ".repeat(LIMITS.maxFillPlanBytes + 1), "utf8"),
        Buffer.from(
          `\r\n--bigplan\r\nContent-Disposition: form-data; name="source"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          "utf8"
        ),
        pdf,
        Buffer.from("\r\n--bigplan--\r\n", "utf8")
      ]),
      "bigplan",
      413,
      "PLAN_TOO_LARGE"
    );

    // Plan at exactly its byte cap is accepted by the boundary (a valid plan
    // padded with trailing JSON whitespace), then the fill proceeds.
    const padded = makePlan("nonce-exact", fieldId);
    const exactPlan = padded + " ".repeat(LIMITS.maxFillPlanBytes - Buffer.byteLength(padded, "utf8"));
    const fill = vi.spyOn(core, "fillForm").mockImplementationOnce(async (options) => {
      await writeFile(options.destinationPath, pdf);
      return {
        outputPath: options.destinationPath,
        outputBytes: pdf.length,
        pageCount: 1,
        burnedIn: false,
        fieldsWritten: 1,
        placementsWritten: 0,
        computedFields: 0,
        removedRestrictions: false,
        removedUsageRights: false,
        qpdfVersion: "12.4.1",
        sourceHash: sha256(pdf),
        warnings: [],
        compatWarnings: []
      };
    });
    const exact = await postFill(auth, fillBody("exactedge", exactPlan, pdf), "exactedge");
    expect(exact.status).toBe(200);
    expect(fill).toHaveBeenCalledTimes(1);
    const exactHandle = (JSON.parse(exact.body.toString("utf8")) as { handle: string }).handle;
    await jobs.discard(exactHandle, auth.cookie.split("=")[1]);

    // Plan that is not JSON.
    await expectRejected("bad json", fillBody("badjsonedge", "not json", pdf), "badjsonedge", 400, "PLAN_INVALID");

    // Plan deeper than the schema's depth cap (six levels of nesting).
    const deepPlan = JSON.stringify({ a: { b: { c: { d: { e: { f: 1 } } } } } });
    await expectRejected("deep plan", fillBody("deepedge", deepPlan, pdf), "deepedge", 400, "PLAN_INVALID");

    // Declared bytes beyond the aggregate cap are refused before a job dir.
    const tooBig = await call("/api/forms/fill", {
      method: "POST",
      headers: {
        ...authedHeaders(auth),
        "content-type": "multipart/form-data; boundary=toobig",
        "content-length": String(LIMITS.maxFillTotalBytes + 1)
      },
      body: Buffer.alloc(0)
    });
    expect(tooBig.status).toBe(413);
    expect(JSON.parse(tooBig.body.toString("utf8"))).toMatchObject({ ok: false, code: "TOTAL_TOO_LARGE" });
    expect(await tempEntries()).toEqual([]);
  });

  it("rejects a source over its byte cap and cleans up", async () => {
    const auth = await launch();
    const plan = makePlan("nonce-bigsrc", fieldId);
    const edge = "bigsrc";
    const head = Buffer.from(
      `--${edge}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n` +
        `--${edge}\r\nContent-Disposition: form-data; name="source"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      "utf8"
    );
    const source = Buffer.alloc(LIMITS.maxFillSourceBytes + 1, 0x41);
    const body = Buffer.concat([head, source, Buffer.from(`\r\n--${edge}--\r\n`, "utf8")]);
    const result = await postFill(auth, body, edge);
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "SOURCE_TOO_LARGE" });
    expect(await tempEntries()).toEqual([]);
  }, 60_000);

  it("rejects while another native operation is in flight, before body allocation", async () => {
    const auth = await launch();
    const slot = jobs.acquireNativeSlot();
    expect(slot).not.toBeNull();
    try {
      const started = Date.now();
      for (const path of ["/api/forms/fill", "/api/forms/inventory"]) {
        const result = await call(path, {
          method: "POST",
          headers: {
            ...authedHeaders(auth),
            "content-type": "multipart/form-data; boundary=busy",
            "content-length": "1048576"
          },
          body: Buffer.alloc(0)
        });
        expect(result.status).toBe(429);
        expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "NATIVE_BUSY" });
      }
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await tempEntries()).toEqual([]);
    } finally {
      slot?.release();
    }
  });

  it("returns the stored outcome for an identical repeat and writes once", async () => {
    const auth = await launch();
    const plan = makePlan("nonce-replay", fieldId);
    const body = fillBody("replayedge", plan, pdf);
    let calls = 0;
    const fill = vi.spyOn(core, "fillForm").mockImplementation(async (options) => {
      calls += 1;
      await writeFile(options.destinationPath, pdf);
      return {
        outputPath: options.destinationPath,
        outputBytes: pdf.length,
        pageCount: 1,
        burnedIn: false,
        fieldsWritten: 1,
        placementsWritten: 0,
        computedFields: 0,
        removedRestrictions: false,
        removedUsageRights: false,
        qpdfVersion: "12.4.1",
        sourceHash: sha256(pdf),
        warnings: [],
        compatWarnings: []
      };
    });

    const first = await postFill(auth, body, "replayedge");
    expect(first.status).toBe(200);
    const firstPayload = JSON.parse(first.body.toString("utf8")) as { handle: string };

    const second = await postFill(auth, body, "replayedge");
    expect(second.status).toBe(200);
    expect(second.body.toString("utf8")).toBe(first.body.toString("utf8"));
    expect(calls).toBe(1);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(jobs.retainedCount()).toBe(1);
    expect((await tempEntries()).filter((name) => name.startsWith("fill-"))).toHaveLength(1);

    // A fresh nonce fills again.
    const third = await postFill(auth, fillBody("replayedge2", makePlan("nonce-replay-2", fieldId), pdf), "replayedge2");
    expect(third.status).toBe(200);
    expect(calls).toBe(2);
    const thirdPayload = JSON.parse(third.body.toString("utf8")) as { handle: string };
    expect(thirdPayload.handle).not.toBe(firstPayload.handle);
    for (const handle of [firstPayload.handle, thirdPayload.handle]) {
      await jobs.discard(handle, auth.cookie.split("=")[1]);
    }
  });

  it("rejects a consumed nonce over changed plan bytes, changed source bytes or a foreign session", async () => {
    const auth = await launch();
    const plan = makePlan("nonce-mismatch", fieldId);
    const fill = vi.spyOn(core, "fillForm").mockImplementation(async (options) => {
      await writeFile(options.destinationPath, pdf);
      return {
        outputPath: options.destinationPath,
        outputBytes: pdf.length,
        pageCount: 1,
        burnedIn: false,
        fieldsWritten: 1,
        placementsWritten: 0,
        computedFields: 0,
        removedRestrictions: false,
        removedUsageRights: false,
        qpdfVersion: "12.4.1",
        sourceHash: sha256(pdf),
        warnings: [],
        compatWarnings: []
      };
    });
    const first = await postFill(auth, fillBody("mismatch", plan, pdf), "mismatch");
    expect(first.status).toBe(200);
    const firstPayload = JSON.parse(first.body.toString("utf8")) as { handle: string };

    const changedPlan = await postFill(auth, fillBody("mismatch2", makePlan("nonce-mismatch", fieldId, "Grace"), pdf), "mismatch2");
    expect(changedPlan.status).toBe(409);
    expect(JSON.parse(changedPlan.body.toString("utf8"))).toMatchObject({ ok: false, code: "FILL_PLAN_CHANGED" });

    const changedSource = await postFill(auth, fillBody("mismatch3", plan, Buffer.concat([pdf, Buffer.from("%")])), "mismatch3");
    expect(changedSource.status).toBe(409);
    expect(JSON.parse(changedSource.body.toString("utf8"))).toMatchObject({ ok: false, code: "FILL_SOURCE_CHANGED" });

    const other = await launch();
    const foreign = await postFill(other, fillBody("mismatch4", plan, pdf), "mismatch4");
    expect(foreign.status).toBe(409);
    expect(JSON.parse(foreign.body.toString("utf8"))).toMatchObject({ ok: false, code: "FILL_NONCE_REUSED" });

    expect(fill).toHaveBeenCalledTimes(1);
    expect(jobs.retainedCount()).toBe(1);
    await jobs.discard(firstPayload.handle, auth.cookie.split("=")[1]);
  });

  it("fills a real form end to end through the route", async () => {
    const auth = await launch();
    const plan = makePlan("nonce-real", fieldId, "Route-filled");
    const result = await postFill(auth, fillBody("realedge", plan, pdf), "realedge");
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as {
      handle: string;
      downloadUrl: string;
      fieldsWritten: number;
      sourceHash: string;
    };
    expect(payload.fieldsWritten).toBeGreaterThanOrEqual(1);
    expect(payload.sourceHash).toBe(sha256(pdf));
    const download = await call(payload.downloadUrl, { headers: authedHeaders(auth) });
    expect(download.status).toBe(200);
    expect(download.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("aborts on child failure and timeout without a downloadable partial artifact", async () => {
    const auth = await launch();
    vi.spyOn(core, "fillForm").mockImplementationOnce(async () => {
      throw new core.CompressionError("FILL_CHILD_OUT_OF_MEMORY", "child died");
    });
    const plan = makePlan("nonce-child-fail", fieldId);
    const failed = await postFill(auth, fillBody("childfail", plan, pdf), "childfail");
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body.toString("utf8"))).toMatchObject({ ok: false, code: "FILL_CHILD_OUT_OF_MEMORY" });
    expect(await tempEntries()).toEqual([]);
    expect(jobs.retainedCount()).toBe(0);

    // Runtime budget: the handler's deadline aborts in-flight work.
    const tightJobs = await JobManager.create({ tempRoot: join(scratch, "timeout"), jobTimeoutMs: 30 });
    const tightHandle = createLocalServer({ sessions: new SessionStore(), jobs: tightJobs });
    await new Promise<void>((resolve) => tightHandle.server.listen(0, "127.0.0.1", () => resolve()));
    const tightPort = (tightHandle.server.address() as AddressInfo).port;
    try {
      const tightAuth = await launch(tightPort);
      vi.spyOn(core, "fillForm").mockImplementationOnce(async (options) => {
        return await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new core.CompressionError("JOB_CANCELLED", "cancelled"))
          );
        });
      });
      const timedBody = fillBody("timeoutedge", makePlan("nonce-timeout", fieldId), pdf);
      const timed = await new Promise<HttpResult>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: tightPort,
            path: "/api/forms/fill",
            method: "POST",
            setHost: false,
            agent: false,
            headers: {
              host: `127.0.0.1:${tightPort}`,
              origin: tightAuth.origin,
              cookie: tightAuth.cookie,
              "x-launch-token": tightAuth.token,
              "content-type": "multipart/form-data; boundary=timeoutedge",
              "content-length": String(timedBody.length)
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          }
        );
        req.on("error", reject);
        req.write(timedBody);
        req.end();
      });
      expect(timed.status).toBe(504);
      expect(JSON.parse(timed.body.toString("utf8"))).toMatchObject({ ok: false, code: "JOB_TIMEOUT" });
      expect(await readdir(tightJobs.tempRoot)).toEqual([]);
      expect(tightJobs.retainedCount()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => tightHandle.server.close(() => resolve()));
      await tightJobs.shutdown();
    }
  });

  it("aborts a fill on client disconnect and leaves no partial artifact", async () => {
    const auth = await launch();
    const edge = "disconnectedge";
    const plan = makePlan("nonce-disconnect", fieldId);
    const body = fillBody(edge, plan, pdf);
    await new Promise<void>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/api/forms/fill",
        method: "POST",
        setHost: false,
        agent: false,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: auth.origin,
          cookie: auth.cookie,
          "x-launch-token": auth.token,
          "content-type": `multipart/form-data; boundary=${edge}`,
          "content-length": String(body.length)
        }
      });
      req.on("error", () => undefined);
      req.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 30);
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await tempEntries()).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await tempEntries()).toEqual([]);
    expect(jobs.retainedCount()).toBe(0);
  });

  it("reports filling unavailable when qpdf is missing instead of degrading", async () => {
    vi.spyOn(core, "getQpdfVersion").mockImplementation(async () => {
      throw new core.CompressionError("ENGINE_UNAVAILABLE", "qpdf is not installed.");
    });
    const probeJobs = await JobManager.create({ tempRoot: join(scratch, "unavailable") });
    const probeHandle = createLocalServer({ sessions: new SessionStore(), jobs: probeJobs });
    await new Promise<void>((resolve) => probeHandle.server.listen(0, "127.0.0.1", () => resolve()));
    const probePort = (probeHandle.server.address() as AddressInfo).port;
    try {
      const auth = await launch(probePort);
      const plan = makePlan("nonce-unavailable", fieldId);
      const body = fillBody("unavailedge", plan, pdf);
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: probePort,
            path: "/api/forms/fill",
            method: "POST",
            setHost: false,
            agent: false,
            headers: {
              host: `127.0.0.1:${probePort}`,
              origin: auth.origin,
              cookie: auth.cookie,
              "x-launch-token": auth.token,
              "content-type": "multipart/form-data; boundary=unavailedge",
              "content-length": String(body.length)
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "FILL_UNAVAILABLE" });
      expect(await readdir(probeJobs.tempRoot)).toEqual([]);

      const capabilities = await new Promise<HttpResult>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: probePort,
            path: "/api/capabilities",
            method: "GET",
            setHost: false,
            agent: false,
            headers: {
              host: `127.0.0.1:${probePort}`,
              origin: auth.origin,
              cookie: auth.cookie,
              "x-launch-token": auth.token
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          }
        );
        req.on("error", reject);
        req.end();
      });
      expect(capabilities.status).toBe(200);
      const payload = JSON.parse(capabilities.body.toString("utf8")) as {
        capabilities: { fill: { available: boolean; version: string | null } };
      };
      expect(payload.capabilities.fill.available).toBe(false);
    } finally {
      await new Promise<void>((resolve) => probeHandle.server.close(() => resolve()));
      await probeJobs.shutdown();
    }
  });
});
