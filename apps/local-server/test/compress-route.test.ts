import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestPdf } from "../../../packages/core/test/pdf-fixtures.js";
import { JobManager } from "../src/jobs.js";
import { toPublicSummary } from "../src/routes/compress.js";
import { createLocalServer } from "../src/server.js";
import { SessionStore } from "../src/session.js";

interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

describe("hardened compression route", () => {
  let scratch = "";
  let jobs: JobManager;
  let server: Server;
  let port = 0;
  let validPdfPath = "";

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
    scratch = await mkdtemp(join(tmpdir(), "u4-compress-test-"));
    jobs = await JobManager.create({ tempRoot: join(scratch, "app") });
    const handle = createLocalServer({ sessions: new SessionStore(), jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
    validPdfPath = await writeTestPdf(scratch, "valid.pdf", [{ width: 200 }, { width: 250 }]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  it("compresses a streamed upload and consumes the output on download", async () => {
    const { readFile } = await import("node:fs/promises");
    const input = await readFile(validPdfPath);
    const auth = await launch();
    const headers = {
      origin: auth.origin,
      cookie: auth.cookie,
      "x-launch-token": auth.token,
      "content-type": "application/pdf",
      "content-length": String(input.length)
    };
    const result = await call("/api/compress?profile=conservative", { method: "POST", headers, body: input });
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as {
      ok: boolean;
      handle: string;
      downloadUrl: string;
      summary: { inputPath: string; outputPath: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.handle).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.downloadUrl).toBe(`/api/outputs/${payload.handle}/download`);
    expect(payload.summary.inputPath).toBe("upload.pdf");
    expect(payload.summary.outputPath).toBe("compressed.pdf");
    expect(result.body.toString("utf8")).not.toContain(jobs.tempRoot);

    const download = await call(payload.downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(download.status).toBe(200);
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const replay = await call(payload.downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(replay.status).toBe(404);
  });

  it("enforces the same Host, Origin, token, and profile contract", async () => {
    const auth = await launch();
    const foreign = await call("/api/compress?profile=balanced", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        cookie: auth.cookie,
        "x-launch-token": auth.token,
        "content-type": "application/pdf",
        "content-length": "10"
      },
      body: Buffer.from("0123456789")
    });
    expect(foreign.status).toBe(400);
    expect(JSON.parse(foreign.body.toString("utf8"))).toMatchObject({ ok: false, code: "BAD_ORIGIN" });

    const anonymous = await call("/api/compress?profile=balanced", {
      method: "POST",
      headers: { origin: auth.origin, "content-type": "application/pdf", "content-length": "10" },
      body: Buffer.from("0123456789")
    });
    expect(anonymous.status).toBe(401);

    const badProfile = await call("/api/compress?profile=ultra", {
      method: "POST",
      headers: {
        origin: auth.origin,
        cookie: auth.cookie,
        "x-launch-token": auth.token,
        "content-type": "application/pdf",
        "content-length": "10"
      },
      body: Buffer.from("0123456789")
    });
    expect(badProfile.status).toBe(400);
    expect(JSON.parse(badProfile.body.toString("utf8"))).toMatchObject({ ok: false, code: "UNSUPPORTED_PROFILE" });
  });

  it("rejects over-cap bodies before allocation", async () => {
    const auth = await launch();
    const before = await readdir(jobs.tempRoot);
    const result = await call("/api/compress?profile=balanced", {
      method: "POST",
      headers: {
        origin: auth.origin,
        cookie: auth.cookie,
        "x-launch-token": auth.token,
        "content-type": "application/pdf",
        "content-length": String(100 * 1024 * 1024 + 1)
      }
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "BODY_TOO_LARGE" });
    expect(await readdir(jobs.tempRoot)).toEqual(before);
  });

  it("rejects concurrent compression while native work is in flight", async () => {
    const auth = await launch();
    expect(jobs.tryAcquireNative()).toBe(true);
    try {
      const result = await call("/api/compress?profile=balanced", {
        method: "POST",
        headers: {
          origin: auth.origin,
          cookie: auth.cookie,
          "x-launch-token": auth.token,
          "content-type": "application/pdf",
          "content-length": "10"
        },
        body: Buffer.from("0123456789")
      });
      expect(result.status).toBe(429);
      expect(JSON.parse(result.body.toString("utf8"))).toMatchObject({ ok: false, code: "NATIVE_BUSY" });
    } finally {
      jobs.releaseNative();
    }
  });

  it("refuses a form-bearing upload and names burn-in as the way forward", async () => {
    const { readFile } = await import("node:fs/promises");
    const formPath = await writeTestPdf(scratch, "form.pdf", [{}], { formTextField: true });
    const input = await readFile(formPath);
    const auth = await launch();
    const result = await call("/api/compress?profile=balanced", {
      method: "POST",
      headers: {
        origin: auth.origin,
        cookie: auth.cookie,
        "x-launch-token": auth.token,
        "content-type": "application/pdf",
        "content-length": String(input.length)
      },
      body: input
    });
    expect(result.status).toBe(422);
    const payload = JSON.parse(result.body.toString("utf8")) as { ok: boolean; code: string; message: string };
    expect(payload).toMatchObject({ ok: false, code: "INPUT_HAS_FORM_FIELDS" });
    expect(payload.message.toLowerCase()).toContain("burn");
  });

  it("does not expose temporary local paths in web summaries", () => {
    expect(
      toPublicSummary({
        status: "success",
        inputPath: "/tmp/private/input.pdf",
        outputPath: "/tmp/private/output.pdf",
        profile: "balanced",
        originalBytes: 100,
        outputBytes: 50,
        reductionBytes: 50,
        reductionPercent: 50,
        outputSmaller: true,
        engine: "mock",
        warnings: []
      })
    ).toMatchObject({ inputPath: "upload.pdf", outputPath: "compressed.pdf" });
  });
});
