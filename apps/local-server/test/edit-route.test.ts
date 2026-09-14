import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import * as core from "@pdf-compressor/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestPdf, writeTestPdf } from "../../../packages/core/test/pdf-fixtures.js";
import { JobManager } from "../src/jobs.js";
import { createLocalServer } from "../src/server.js";
import { SessionStore } from "../src/session.js";
import { sanitizeExportError } from "../src/routes/edit.js";

interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

interface Authed {
  origin: string;
  cookie: string;
  token: string;
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

function buildMultipart(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----u4test${randomBytes(8).toString("hex")}`;
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

describe("page export route", () => {
  let scratch = "";
  let jobs: JobManager;
  let server: Server;
  let port = 0;
  let fixtureA = Buffer.alloc(0);
  let fixtureB = Buffer.alloc(0);

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

  async function launch(): Promise<Authed> {
    const origin = `http://127.0.0.1:${port}`;
    const result = await call("/api/session/launch", { method: "POST", headers: { origin } });
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as { token: string };
    const cookie = (result.headers["set-cookie"] ?? "").split(";")[0];
    return { origin, cookie, token: payload.token };
  }

  function authedHeaders(auth: Authed, extra: Record<string, string> = {}): Record<string, string> {
    return { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token, ...extra };
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u4-edit-test-"));
    jobs = await JobManager.create({ tempRoot: join(scratch, "app") });
    const handle = createLocalServer({ sessions: new SessionStore(), jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
    await writeTestPdf(scratch, "a.pdf", [{ width: 200 }, { width: 300 }]);
    await writeTestPdf(scratch, "b.pdf", [{ width: 400 }]);
    fixtureA = buildTestPdf([{ width: 200 }, { width: 300 }]);
    fixtureB = buildTestPdf([{ width: 400 }]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  it("streams two sources plus a manifest and exposes no local path", async () => {
    const auth = await launch();
    const manifest = JSON.stringify({
      version: 1,
      pages: [
        { sourceId: "b", page: 1 },
        { sourceId: "a", page: 2, rotate: 90 },
        { sourceId: "a", page: 1 }
      ]
    });
    // Sources arrive in manifest source order: distinct ids are b, a.
    const ordered = buildMultipart([
      { name: "manifest", contentType: "application/json", data: manifest },
      { name: "source", filename: "secret-client-name.pdf", contentType: "application/pdf", data: fixtureB },
      { name: "source", filename: "other-secret.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const result = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": ordered.contentType, "content-length": String(ordered.body.length) }),
      body: ordered.body
    });
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as {
      ok: boolean;
      handle: string;
      downloadUrl: string;
      pageCount: number;
      engine: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.handle).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.downloadUrl).toBe(`/api/outputs/${payload.handle}/download`);
    expect(payload.pageCount).toBe(3);
    expect(result.body.toString("utf8")).not.toContain(jobs.tempRoot);
    expect(result.body.toString("utf8")).not.toContain("secret-client-name");
    expect(result.body.toString("utf8")).not.toContain("source-");

    // Only the validated output remains in the job workspace.
    const entries = await readdir(jobs.tempRoot);
    expect(entries).toHaveLength(1);
    const jobFiles = await readdir(join(jobs.tempRoot, entries[0]));
    expect(jobFiles).toEqual(["output.pdf"]);

    const download = await call(payload.downloadUrl, { headers: authedHeaders(auth) });
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const replay = await call(payload.downloadUrl, { headers: authedHeaders(auth) });
    expect(replay.status).toBe(404);
    expect(JSON.parse(replay.body.toString("utf8"))).toMatchObject({ ok: false, code: "HANDLE_NOT_FOUND" });
  });

  it("rejects a missing, duplicate, or unknown multipart section", async () => {
    const auth = await launch();
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });

    const noManifest = buildMultipart([
      { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const missing = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": noManifest.contentType }),
      body: noManifest.body
    });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body.toString("utf8"))).toMatchObject({ ok: false, code: "MISSING_MANIFEST" });

    const dup = buildMultipart([
      { name: "manifest", data: manifest },
      { name: "manifest", data: manifest },
      { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const duplicated = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": dup.contentType }),
      body: dup.body
    });
    expect(duplicated.status).toBe(400);
    expect(JSON.parse(duplicated.body.toString("utf8"))).toMatchObject({ ok: false, code: "DUPLICATE_MANIFEST" });

    const unknown = buildMultipart([
      { name: "manifest", data: manifest },
      { name: "notes", data: "hello" },
      { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const unknownPart = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": unknown.contentType }),
      body: unknown.body
    });
    expect(unknownPart.status).toBe(400);
    expect(JSON.parse(unknownPart.body.toString("utf8"))).toMatchObject({ ok: false, code: "UNKNOWN_PART" });
  });

  it("rejects oversized, deeply nested, malformed, and mismatched manifests", async () => {
    const auth = await launch();

    const malformed = buildMultipart([
      { name: "manifest", data: "not json" },
      { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const bad = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": malformed.contentType }),
      body: malformed.body
    });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body.toString("utf8"))).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });

    const deep = buildMultipart([
      { name: "manifest", data: JSON.stringify({ version: 1, pages: [], nested: { a: { b: { c: { d: 1 } } } } }) },
      { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const deepResult = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": deep.contentType }),
      body: deep.body
    });
    expect(deepResult.status).toBe(400);
    expect(JSON.parse(deepResult.body.toString("utf8"))).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });

    const pages: string[] = [];
    for (let i = 0; i < 12000; i += 1) pages.push(`{"sourceId":"a","page":1}`);
    const huge = buildMultipart([
      { name: "manifest", data: `{"version":1,"pages":[${pages.join(",")}]}` },
      { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    expect(huge.body.length).toBeGreaterThan(256 * 1024);
    const hugeResult = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": huge.contentType }),
      body: huge.body
    });
    expect(hugeResult.status).toBe(413);
    expect(JSON.parse(hugeResult.body.toString("utf8"))).toMatchObject({ ok: false, code: "MANIFEST_TOO_LARGE" });

    const mismatch = buildMultipart([
      { name: "manifest", data: JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }, { sourceId: "b", page: 1 }] }) },
      { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const mismatched = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": mismatch.contentType }),
      body: mismatch.body
    });
    expect(mismatched.status).toBe(400);
    expect(JSON.parse(mismatched.body.toString("utf8"))).toMatchObject({ ok: false, code: "MANIFEST_INVALID" });
  });

  it("rejects excess parts and blocked sources with cleanup", async () => {
    const auth = await launch();
    await jobs.sweepStartupOrphans();
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const parts: MultipartPart[] = [{ name: "manifest", data: manifest }];
    for (let i = 0; i < 11; i += 1) {
      parts.push({ name: "source", filename: `s${i}.pdf`, contentType: "application/pdf", data: fixtureA.subarray(0, 64) });
    }
    const many = buildMultipart(parts);
    const tooMany = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": many.contentType }),
      body: many.body
    });
    expect(tooMany.status).toBe(413);
    expect(JSON.parse(tooMany.body.toString("utf8"))).toMatchObject({ ok: false, code: "TOO_MANY_PARTS" });

    const encrypted = await readFile(join(process.cwd(), "tests", "fixtures", "encrypted-marker.pdf"));
    const blocked = buildMultipart([
      { name: "manifest", data: manifest },
      { name: "source", filename: "enc.pdf", contentType: "application/pdf", data: encrypted }
    ]);
    const before = await readdir(jobs.tempRoot);
    const rejected = await call("/api/pages/export", {
      method: "POST",
      headers: authedHeaders(auth, { "content-type": blocked.contentType }),
      body: blocked.body
    });
    expect(rejected.status).toBe(422);
    expect(JSON.parse(rejected.body.toString("utf8"))).toMatchObject({ ok: false, code: "INPUT_ENCRYPTED" });
    expect(await readdir(jobs.tempRoot)).toEqual(before);
  });

  it("rejects concurrent work promptly while native work is in flight", async () => {
    const auth = await launch();
    await jobs.sweepStartupOrphans();
    expect(jobs.tryAcquireNative()).toBe(true);
    try {
      const before = await readdir(jobs.tempRoot);
      const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
      const { body, contentType } = buildMultipart([
        { name: "manifest", data: manifest },
        { name: "source", filename: "s.pdf", contentType: "application/pdf", data: fixtureA }
      ]);
      const started = Date.now();
      const result = await call("/api/pages/export", {
        method: "POST",
        headers: authedHeaders(auth, { "content-type": contentType, "content-length": String(body.length) }),
        body
      });
      const elapsed = Date.now() - started;
      expect(result.status).toBe(429);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "NATIVE_BUSY" });
      expect(elapsed).toBeLessThan(500);
      expect(await readdir(jobs.tempRoot)).toEqual(before);
    } finally {
      jobs.releaseNative();
    }
  });

  it("passes the output cap to core and maps candidate overflow", async () => {
    const auth = await launch();
    await jobs.sweepStartupOrphans();
    const before = await readdir(jobs.tempRoot);
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const upload = buildMultipart([
      { name: "manifest", contentType: "application/json", data: manifest },
      { name: "source", filename: "source.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const assemble = vi.spyOn(core, "assemblePages").mockImplementationOnce(async (options) => {
      expect(options.maxOutputBytes).toBe(150 * 1024 * 1024);
      throw new core.CompressionError("OUTPUT_TOO_LARGE", "candidate crossed its byte cap");
    });
    try {
      const result = await call("/api/pages/export", {
        method: "POST",
        headers: authedHeaders(auth, {
          "content-type": upload.contentType,
          "content-length": String(upload.body.length)
        }),
        body: upload.body
      });
      expect(result.status).toBe(422);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "OUTPUT_TOO_LARGE" });
      expect(await readdir(jobs.tempRoot)).toEqual(before);
    } finally {
      assemble.mockRestore();
    }
  });

  it("passes OCR to core, returns its structured summary, and retains normal cleanup", async () => {
    const auth = await launch();
    await jobs.sweepStartupOrphans();
    const before = new Set(await readdir(jobs.tempRoot));
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const upload = buildMultipart([
      { name: "manifest", contentType: "application/json", data: manifest },
      { name: "source", filename: "source.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const assemble = vi.spyOn(core, "assemblePages").mockImplementationOnce(async (options) => {
      expect(options.ocr).toEqual({ languages: ["deu", "eng"], autoRotate: true });
      expect(options.compression).toBe("balanced");
      expect(options.workspaceParent).toBe(dirname(options.destinationPath));
      expect(options.destinationPath.startsWith(`${options.workspaceParent}/`)).toBe(true);
      expect(options.resourceCheck).toEqual(expect.any(Function));
      await expect(options.resourceCheck?.()).resolves.toBeUndefined();
      await writeFile(options.destinationPath, fixtureA);
      return {
        status: "success",
        outputPath: options.destinationPath,
        pageCount: 1,
        outputBytes: fixtureA.length,
        engine: "ocrmypdf",
        qpdfVersion: "12.4.1",
        ocr: {
          engine: "ocrmypdf",
          version: "17.11.0",
          tesseractVersion: "5.5.3",
          languages: ["deu", "eng"],
          autoRotate: true
        },
        warnings: [],
        compatWarnings: [],
        sourceHashes: { a: "fake" }
      };
    });
    const ghostscript = vi.spyOn(core, "getGhostscriptVersion").mockRejectedValue(
      new core.CompressionError("ENGINE_UNAVAILABLE", "Ghostscript missing")
    );
    try {
      const result = await call("/api/pages/export?compression=balanced&ocr=deu%2Beng&ocrAutoRotate=true", {
        method: "POST",
        headers: authedHeaders(auth, {
          "content-type": upload.contentType,
          "content-length": String(upload.body.length)
        }),
        body: upload.body
      });
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({
        ok: true,
        engine: "ocrmypdf",
        ocr: {
          engine: "ocrmypdf",
          version: "17.11.0",
          tesseractVersion: "5.5.3",
          languages: ["deu", "eng"],
          autoRotate: true
        }
      });
      expect(ghostscript).not.toHaveBeenCalled();
      const created = (await readdir(jobs.tempRoot)).filter((entry) => !before.has(entry));
      expect(created).toHaveLength(1);
      expect(await readdir(join(jobs.tempRoot, created[0]))).toEqual(["output.pdf"]);
    } finally {
      assemble.mockRestore();
      ghostscript.mockRestore();
    }
  });

  it("rejects invalid OCR before native work and releases the slot", async () => {
    const auth = await launch();
    await jobs.sweepStartupOrphans();
    const before = await readdir(jobs.tempRoot);
    const assemble = vi.spyOn(core, "assemblePages");
    try {
      const result = await call("/api/pages/export?ocr=fra&ocrAutoRotate=true", {
        method: "POST",
        headers: authedHeaders(auth)
      });
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "OCR_OPTIONS_INVALID" });
      expect(assemble).not.toHaveBeenCalled();
      expect(await readdir(jobs.tempRoot)).toEqual(before);
      expect(jobs.tryAcquireNative()).toBe(true);
      jobs.releaseNative();
    } finally {
      assemble.mockRestore();
    }
  });

  it.each([
    [
      "NATIVE_VERSION_UNSUPPORTED",
      "qpdf 11.9.1 is below the supported floor",
      "A required local PDF tool is too old. Update it and try again."
    ],
    [
      "OCR_LANGUAGE_UNAVAILABLE",
      "German language data is missing",
      "The selected OCR language data is unavailable. Install it and try again."
    ],
    [
      "ENGINE_UNAVAILABLE",
      "OCRmyPDF is missing",
      "A required local PDF tool is unavailable. Check your local setup and try again."
    ]
  ] as const)("maps %s to an actionable 503 and cleans up the upload", async (code, detail, message) => {
    const auth = await launch();
    await jobs.sweepStartupOrphans();
    const before = await readdir(jobs.tempRoot);
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const upload = buildMultipart([
      { name: "manifest", data: manifest },
      { name: "source", filename: "source.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const assemble = vi.spyOn(core, "assemblePages").mockRejectedValueOnce(
      new core.CompressionError(code, detail)
    );
    try {
      const result = await call("/api/pages/export?ocr=deu&ocrAutoRotate=true", {
        method: "POST",
        headers: authedHeaders(auth, {
          "content-type": upload.contentType,
          "content-length": String(upload.body.length)
        }),
        body: upload.body
      });
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({
        ok: false,
        code,
        message
      });
      expect(await readdir(jobs.tempRoot)).toEqual(before);
      expect(jobs.tryAcquireNative()).toBe(true);
      jobs.releaseNative();
    } finally {
      assemble.mockRestore();
    }
  });

  it("returns a stable capacity response when every retained output is leased", async () => {
    const auth = await launch();
    const sessionId = decodeURIComponent(auth.cookie.split("=")[1]);
    const leasedHandles: string[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const { dir } = await jobs.newJobDir("job-");
        const outputPath = join(dir, "output.pdf");
        await writeFile(outputPath, fixtureA);
        const retained = await jobs.retainOutput({ sessionId, jobDir: dir, outputPath, pageCount: 2 });
        expect(jobs.lease(retained.handle, sessionId).outcome).toBe("leased");
        leasedHandles.push(retained.handle);
      }

      const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
      const upload = buildMultipart([
        { name: "manifest", contentType: "application/json", data: manifest },
        { name: "source", filename: "source.pdf", contentType: "application/pdf", data: fixtureA }
      ]);
      const result = await call("/api/pages/export", {
        method: "POST",
        headers: authedHeaders(auth, {
          "content-type": upload.contentType,
          "content-length": String(upload.body.length)
        }),
        body: upload.body
      });
      expect(result.status).toBe(429);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({
        ok: false,
        code: "RETAINED_OUTPUT_CAPACITY"
      });
      expect(jobs.retainedCount()).toBe(2);
    } finally {
      for (const handle of leasedHandles) await jobs.consume(handle, sessionId);
    }
  });

  it("keeps an unrecognized core error code at 500 instead of masking it", async () => {
    // Simulates a code added to CompressionErrorCode without a route case: the
    // response must surface the new code, not collapse it to EXPORT_FAILED.
    const forged = new core.CompressionError("SOME_FUTURE_CODE" as core.CompressionErrorCode, "unmapped");
    expect(sanitizeExportError(forged)).toEqual({ status: 500, code: "SOME_FUTURE_CODE" });
  });

  it("reports qpdf and ghostscript capabilities independently", async () => {
    const auth = await launch();
    const result = await call("/api/capabilities", { headers: authedHeaders(auth) });
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as {
      ok: boolean;
      capabilities: { qpdf: { available: boolean; version: string | null }; ghostscript: { available: boolean; version: string | null } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.capabilities.qpdf.available).toBe(true);
    expect(typeof payload.capabilities.qpdf.version).toBe("string");
    expect(payload.capabilities.ghostscript.available).toBe(true);
    expect(typeof payload.capabilities.ghostscript.version).toBe("string");
  });
});
