import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../src/jobs.js";
import { MultipartError, streamExportMultipart, streamFillMultipart } from "../src/multipart.js";

describe("multipart aggregate byte cap", () => {
  let jobDir = "";
  let scratch = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u4f-multi-test-"));
    jobDir = join(scratch, "job");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(jobDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function streamBody(body: Buffer, contentType: string): Promise<{
    manifestRaw: string;
    sourcePaths: string[];
    sourceBytes: number[];
    totalBytes: number;
  }> {
    const req = new PassThrough() as PassThrough & {
      headers: Record<string, string>;
    };
    req.headers = { "content-type": contentType, "content-length": String(body.length) };
    const pending = streamExportMultipart(req as unknown as IncomingMessage, jobDir);
    req.end(body);
    return pending;
  }

  function buildMultipart(boundary: string, manifest: string, sources: Buffer[]): Buffer {
    const chunks: Buffer[] = [];
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}\r\n`,
        "utf8"
      )
    );
    for (const source of sources) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          "utf8"
        ),
        source,
        Buffer.from("\r\n", "utf8")
      );
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    return Buffer.concat(chunks);
  }

  it("counts manifest field bytes in the aggregate total", async () => {
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const source = Buffer.alloc(1024, 0x25);
    const boundary = "aggregateedge";
    const body = buildMultipart(boundary, manifest, [source]);
    const upload = await streamBody(body, `multipart/form-data; boundary=${boundary}`);
    expect(upload.sourceBytes).toEqual([1024]);
    expect(upload.totalBytes).toBe(Buffer.byteLength(manifest, "utf8") + 1024);
    await rm(upload.sourcePaths[0], { force: true });
  });

  it("rejects when manifest bytes push the aggregate over the cap", async () => {
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const manifestBytes = Buffer.byteLength(manifest, "utf8");
    // One byte over the aggregate cap once the manifest is included.
    const source = Buffer.alloc(LIMITS.maxTotalBytes - manifestBytes + 1, 0x25);
    const boundary = "aggregateoveredge";
    const body = buildMultipart(boundary, manifest, [source]);
    await expect(streamBody(body, `multipart/form-data; boundary=${boundary}`)).rejects.toMatchObject({
      name: "MultipartError",
      code: "TOTAL_TOO_LARGE"
    } satisfies Partial<MultipartError>);
  }, 60_000);

  describe("fill contract", () => {
    function streamFill(body: Buffer, contentType: string): Promise<{
      planRaw: string;
      sourcePath: string;
      sourceBytes: number;
      totalBytes: number;
    }> {
      const req = new PassThrough() as PassThrough & {
        headers: Record<string, string>;
      };
      req.headers = { "content-type": contentType, "content-length": String(body.length) };
      const pending = streamFillMultipart(req as unknown as IncomingMessage, jobDir);
      req.end(body);
      return pending;
    }

    function buildFillMultipart(boundary: string, plan: string, source: Buffer): Buffer {
      return Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n`, "utf8"),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          "utf8"
        ),
        source,
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
      ]);
    }

    it("counts plan field bytes in the aggregate total", async () => {
      const plan = JSON.stringify({ version: 1, entries: [] });
      const source = Buffer.alloc(1024, 0x25);
      const boundary = "fillaggregate";
      const upload = await streamFill(
        buildFillMultipart(boundary, plan, source),
        `multipart/form-data; boundary=${boundary}`
      );
      expect(upload.planRaw).toBe(plan);
      expect(upload.sourceBytes).toBe(1024);
      expect(upload.totalBytes).toBe(Buffer.byteLength(plan, "utf8") + 1024);
      await rm(upload.sourcePath, { force: true });
    });

    it("rejects a missing plan, a duplicate plan and an unknown part", async () => {
      const source = Buffer.alloc(16, 0x25);
      const boundary = "fillmissing";
      await expect(
        streamFill(
          Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
              "utf8"
            ),
            source,
            Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
          ]),
          `multipart/form-data; boundary=${boundary}`
        )
      ).rejects.toMatchObject({ name: "MultipartError", code: "MISSING_PLAN" } satisfies Partial<MultipartError>);

      const plan = JSON.stringify({ version: 1, entries: [] });
      const dupBoundary = "filldup";
      await expect(
        streamFill(
          Buffer.concat([
            Buffer.from(`--${dupBoundary}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n`, "utf8"),
            Buffer.from(`--${dupBoundary}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n`, "utf8"),
            Buffer.from(
              `--${dupBoundary}\r\nContent-Disposition: form-data; name="source"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
              "utf8"
            ),
            source,
            Buffer.from(`\r\n--${dupBoundary}--\r\n`, "utf8")
          ]),
          `multipart/form-data; boundary=${dupBoundary}`
        )
      ).rejects.toMatchObject({ name: "MultipartError", code: "DUPLICATE_PLAN" } satisfies Partial<MultipartError>);

      const unknownBoundary = "fillunknown";
      await expect(
        streamFill(
          Buffer.concat([
            Buffer.from(`--${unknownBoundary}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n`, "utf8"),
            Buffer.from(`--${unknownBoundary}\r\nContent-Disposition: form-data; name="notes"\r\n\r\nhi\r\n`, "utf8"),
            Buffer.from(
              `--${unknownBoundary}\r\nContent-Disposition: form-data; name="source"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
              "utf8"
            ),
            source,
            Buffer.from(`\r\n--${unknownBoundary}--\r\n`, "utf8")
          ]),
          `multipart/form-data; boundary=${unknownBoundary}`
        )
      ).rejects.toMatchObject({ name: "MultipartError", code: "UNKNOWN_PART" } satisfies Partial<MultipartError>);
    });

    it("rejects a missing source and a second source", async () => {
      const plan = JSON.stringify({ version: 1, entries: [] });
      const nosource = "fillnosource";
      await expect(
        streamFill(
          Buffer.from(`--${nosource}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n--${nosource}--\r\n`, "utf8"),
          `multipart/form-data; boundary=${nosource}`
        )
      ).rejects.toMatchObject({ name: "MultipartError", code: "MISSING_SOURCE" } satisfies Partial<MultipartError>);

      const source = Buffer.alloc(16, 0x25);
      const twoBoundary = "filltwo";
      await expect(
        streamFill(
          Buffer.concat([
            Buffer.from(`--${twoBoundary}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n${plan}\r\n`, "utf8"),
            Buffer.from(
              `--${twoBoundary}\r\nContent-Disposition: form-data; name="source"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
              "utf8"
            ),
            source,
            Buffer.from(
              `\r\n--${twoBoundary}\r\nContent-Disposition: form-data; name="source"; filename="b.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
              "utf8"
            ),
            source,
            Buffer.from(`\r\n--${twoBoundary}--\r\n`, "utf8")
          ]),
          `multipart/form-data; boundary=${twoBoundary}`
        )
      ).rejects.toMatchObject({ name: "MultipartError", code: "TOO_MANY_SOURCES" } satisfies Partial<MultipartError>);
    });

    it("rejects a plan over its byte cap", async () => {
      const boundary = "fillbigplan";
      const source = Buffer.alloc(16, 0x25);
      await expect(
        streamFill(
          Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n`, "utf8"),
            Buffer.alloc(LIMITS.maxFillPlanBytes + 1, 0x20),
            Buffer.from(
              `\r\n--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
              "utf8"
            ),
            source,
            Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
          ]),
          `multipart/form-data; boundary=${boundary}`
        )
      ).rejects.toMatchObject({ name: "MultipartError", code: "PLAN_TOO_LARGE" } satisfies Partial<MultipartError>);
    });
  });
});
