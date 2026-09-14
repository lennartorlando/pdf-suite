import { randomBytes } from "node:crypto";
import { chmodSync, Dirent, lstatSync, mkdirSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompressionError, FILL_MAX_PLAN_BYTES, FILL_MAX_SOURCE_BYTES } from "@pdf-compressor/core";

/** Initial Safety Limits shared by compression and page export. */
export const LIMITS = {
  /** Source PDFs per export. */
  maxSources: 10,
  /** Bytes per uploaded source. */
  maxSourceBytes: 100 * 1024 * 1024,
  /** Total multipart bytes per export. */
  maxTotalBytes: 100 * 1024 * 1024,
  /** Manifest field bytes. */
  maxManifestBytes: 256 * 1024,
  /** Multipart parts: exactly 1 manifest plus up to 10 sources. */
  maxParts: 11,
  /** Multipart header pairs. */
  maxHeaderPairs: 50,
  /** Source-id characters. */
  maxSourceIdLength: 64,
  /** Manifest JSON depth. */
  maxJsonDepth: 4,
  /** Output pages per export. */
  maxOutputPages: 500,
  /** Candidate or final output bytes. */
  maxOutputBytes: 150 * 1024 * 1024,
  /** Native export runtime budget. */
  jobTimeoutMs: 120_000,
  /** Global in-flight native operations across compression and export. */
  maxNativeOperations: 1,
  /** Retained downloadable jobs. */
  maxRetainedOutputs: 2,
  /** Aggregate app temp storage. */
  maxTempBytes: 600 * 1024 * 1024,
  /** Free-disk reserve after allocation. */
  minFreeBytes: 1024 * 1024 * 1024,
  /** Download artifact TTL. */
  outputTtlMs: 10 * 60 * 1000,
  /** Bytes per uploaded fill source (Initial Safety Limits). */
  maxFillSourceBytes: FILL_MAX_SOURCE_BYTES,
  /** Fill plan field bytes. */
  maxFillPlanBytes: FILL_MAX_PLAN_BYTES,
  /** Fill multipart parts: exactly 1 plan field plus 1 source file. */
  maxFillParts: 2,
  /** Aggregate fill multipart bytes. */
  maxFillTotalBytes: FILL_MAX_SOURCE_BYTES + FILL_MAX_PLAN_BYTES,
  /** Fill output TTL: longer than exports, since re-filling costs typed values. */
  fillOutputTtlMs: 30 * 60 * 1000,
  /** Stored fill idempotency records (KTD18). */
  maxFillRecords: 1024
} as const;

export interface CapacityCheck {
  ok: true;
}

export type CapacityFailureCode = "TEMP_QUOTA_EXCEEDED" | "DISK_RESERVE_EXHAUSTED";

export interface RetainedOutput {
  handle: string;
  sessionId: string;
  jobDir: string;
  outputPath: string;
  bytes: number;
  pageCount: number;
  createdAt: number;
  expiresAt: number;
  leased: boolean;
  deleteAfterRelease: boolean;
}

export type LeaseOutcome = "leased" | "not_found" | "forbidden" | "expired" | "busy";

export interface FillOutcome {
  status: number;
  payload: unknown;
}

export interface FillIdempotencyRecord {
  readonly sessionId: string;
  readonly planDigest: string;
  readonly sourceDigest: string;
  /** Present once the nonce's request produced an outcome worth replaying. */
  outcome?: FillOutcome;
  /** The retained output the outcome's download handle names; replay dies with it. */
  retainedHandle?: string;
}

export type FillNonceVerdict =
  | { kind: "claimed" }
  /** Same session and bytes, but the earlier attempt produced no outcome. */
  | { kind: "resume" }
  | { kind: "replay"; outcome: FillOutcome }
  | { kind: "foreign" }
  | { kind: "plan-mismatch" }
  | { kind: "source-mismatch" };

export interface JobManagerOptions {
  /** Owned app temp root; defaults to a current-user private dir. */
  tempRoot?: string;
  outputTtlMs?: number;
  jobTimeoutMs?: number;
  now?: () => number;
  /** Test seam for deterministic transient-cleanup failures. */
  removeDir?: (dir: string) => Promise<void>;
}

export const RETAINED_OUTPUT_CAPACITY = "RETAINED_OUTPUT_CAPACITY";
const TEMP_ROOT_UNSAFE = "TEMP_ROOT_UNSAFE";

function randomHandle(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Startup-sweep ownership predicate. On platforms exposing
 * `process.getuid`, a temp-root child is only eligible for recursive
 * deletion when its owner matches the current user; foreign-owned
 * directories are ignored. Where ownership is unavailable (or the uid is
 * not a number), every canonical candidate stays eligible so behavior on
 * those platforms is unchanged.
 */
export function isOwnedByCurrentUser(statUid: number | undefined): boolean {
  const getuid = (process as unknown as { getuid?: () => number }).getuid;
  if (typeof getuid !== "function") return true;
  if (typeof statUid !== "number") return false;
  try {
    return statUid === getuid();
  } catch {
    return false;
  }
}

interface SafeRootStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  uid: number;
  mode: number;
}

function assertSafeTempRoot(rootStat: SafeRootStat): void {
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !isOwnedByCurrentUser(rootStat.uid)) {
    throw new Error(TEMP_ROOT_UNSAFE);
  }
  if (process.platform !== "win32" && (rootStat.mode & 0o777) !== 0o700) {
    throw new Error(TEMP_ROOT_UNSAFE);
  }
}

async function prepareTempRoot(tempRoot: string): Promise<void> {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(tempRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !isOwnedByCurrentUser(rootStat.uid)) {
    throw new Error(TEMP_ROOT_UNSAFE);
  }
  await chmod(tempRoot, 0o700);
  assertSafeTempRoot(await lstat(tempRoot));
}

function prepareTempRootSync(tempRoot: string): void {
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(tempRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !isOwnedByCurrentUser(rootStat.uid)) {
    throw new Error(TEMP_ROOT_UNSAFE);
  }
  chmodSync(tempRoot, 0o700);
  assertSafeTempRoot(lstatSync(tempRoot));
}

/**
 * Owns the app temp root, the single global native-operation slot, retained
 * downloadable outputs, and lifecycle cleanup. Only canonical child
 * directories created by this manager are ever swept; symlinks and foreign
 * entries are ignored. Never logs tokens, handles, paths, or filenames.
 */
export class JobManager {
  readonly tempRoot: string;
  private readonly outputTtlMs: number;
  readonly jobTimeoutMs: number;
  private readonly now: () => number;
  private nativeInFlight = false;
  private nativeEpoch = 0;
  private readonly retained = new Map<string, RetainedOutput>();
  private readonly fillRecords = new Map<string, FillIdempotencyRecord>();
  private readonly pendingCleanup = new Set<string>();
  private readonly removeJobDir: (dir: string) => Promise<void>;
  private sweeper: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(tempRoot: string, options: JobManagerOptions) {
    this.tempRoot = tempRoot;
    this.outputTtlMs = options.outputTtlMs ?? LIMITS.outputTtlMs;
    this.jobTimeoutMs = options.jobTimeoutMs ?? LIMITS.jobTimeoutMs;
    this.now = options.now ?? Date.now;
    this.removeJobDir = options.removeDir ?? ((dir) => rm(dir, { recursive: true, force: true }));
  }

  static async create(options: JobManagerOptions = {}): Promise<JobManager> {
    const tempRoot = options.tempRoot ?? join(tmpdir(), "pdf-compressor-app");
    await prepareTempRoot(tempRoot);
    const manager = new JobManager(tempRoot, options);
    await manager.sweepStartupOrphans();
    manager.startSweeper();
    return manager;
  }

  /** Synchronous construction for embedding in a sync server factory. */
  static createSync(options: JobManagerOptions = {}): JobManager {
    const tempRoot = options.tempRoot ?? join(tmpdir(), "pdf-compressor-app");
    prepareTempRootSync(tempRoot);
    const manager = new JobManager(tempRoot, options);
    void manager.sweepStartupOrphans().catch(() => undefined);
    manager.startSweeper();
    return manager;
  }

  private startSweeper(): void {
    this.sweeper = setInterval(() => {
      void this.sweepExpired().catch(() => undefined);
    }, 30_000);
    this.sweeper.unref?.();
  }

  /** Single global native-operation slot; no queue. */
  tryAcquireNative(): boolean {
    if (this.nativeInFlight) return false;
    this.nativeInFlight = true;
    this.nativeEpoch += 1;
    return true;
  }

  /**
   * Single-owner acquisition for request dispatch. The returned guard
   * releases exactly once and only while its own acquisition is still the
   * active holder: a stale guard from a completed request can never clear
   * a slot acquired later by another request. Dispatch owns the guard;
   * route handlers must never release the slot themselves.
   */
  acquireNativeSlot(): { release(): void } | null {
    if (!this.tryAcquireNative()) return null;
    const epoch = this.nativeEpoch;
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        if (this.nativeEpoch === epoch) this.nativeInFlight = false;
      }
    };
  }

  releaseNative(): void {
    this.nativeInFlight = false;
  }

  isNativeBusy(): boolean {
    return this.nativeInFlight;
  }

  /**
   * Resolve a plan nonce against its idempotency record (KTD18). The record
   * is keyed by nonce and bound to the claiming session plus digests of the
   * exact source and plan bytes: an identical repeat returns the stored
   * outcome, an interrupted identical attempt resumes, and any other reuse
   * is rejected instead of being answered from the record. Callers hold the
   * native slot, so check-and-claim is serial.
   */
  resolveFillNonce(
    nonce: string,
    claim: { sessionId: string; planDigest: string; sourceDigest: string }
  ): FillNonceVerdict {
    const record = this.fillRecords.get(nonce);
    if (!record) {
      if (this.fillRecords.size >= LIMITS.maxFillRecords) {
        const oldest = this.fillRecords.keys().next().value;
        if (oldest !== undefined) this.fillRecords.delete(oldest);
      }
      this.fillRecords.set(nonce, { ...claim });
      return { kind: "claimed" };
    }
    if (record.sessionId !== claim.sessionId) return { kind: "foreign" };
    if (record.planDigest !== claim.planDigest) return { kind: "plan-mismatch" };
    if (record.sourceDigest !== claim.sourceDigest) return { kind: "source-mismatch" };
    if (record.outcome) {
      // Replay is only valid while the retained output it references lives.
      if (record.retainedHandle === undefined || this.retained.has(record.retainedHandle)) {
        return { kind: "replay", outcome: record.outcome };
      }
      delete record.outcome;
      delete record.retainedHandle;
    }
    return { kind: "resume" };
  }

  /** Attach the produced outcome to a claimed nonce; a byte-identical repeat replays it while the retained output lives. */
  completeFillNonce(nonce: string, outcome: FillOutcome, retainedHandle?: string): void {
    const record = this.fillRecords.get(nonce);
    if (!record) return;
    record.outcome = outcome;
    record.retainedHandle = retainedHandle;
  }

  /** Create a private per-job directory owned by the current user. */
  async newJobDir(prefix: string): Promise<{ id: string; dir: string }> {
    const id = randomHandle();
    const dir = join(this.tempRoot, `${prefix}${id}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { id, dir };
  }

  async removeDir(dir: string): Promise<void> {
    await this.cleanupDirectory(dir);
  }

  /** Sum of bytes in owned canonical child directories (symlinks ignored). */
  async tempUsageBytes(): Promise<number> {
    let total = 0;
    let entries: Dirent[];
    try {
      entries = await readdir(this.tempRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      total += await dirSize(join(this.tempRoot, entry.name));
    }
    return total;
  }

  async freeBytes(): Promise<number | null> {
    try {
      const info = await statfs(this.tempRoot);
      return info.bavail * info.bsize;
    } catch {
      return null;
    }
  }

  /**
   * Reserve quota before accepting bytes. Fails closed when the free-disk
   * reserve cannot be verified.
   */
  async checkCapacity(expectedBytes: number): Promise<CapacityCheck | { ok: false; code: CapacityFailureCode }> {
    const usage = await this.tempUsageBytes();
    if (usage + expectedBytes > LIMITS.maxTempBytes) {
      return { ok: false, code: "TEMP_QUOTA_EXCEEDED" };
    }
    const free = await this.freeBytes();
    if (free === null || free - expectedBytes < LIMITS.minFreeBytes) {
      return { ok: false, code: "DISK_RESERVE_EXHAUSTED" };
    }
    return { ok: true };
  }

  /** Abort in-flight native work as soon as aggregate temp or disk limits are crossed. */
  async assertRuntimeCapacity(additionalBytes = 0): Promise<void> {
    const capacity = await this.checkCapacity(additionalBytes);
    if (!capacity.ok) {
      throw new CompressionError(
        capacity.code,
        "Temporary storage capacity was exhausted during native processing."
      );
    }
  }

  /**
   * Publish a validated output for session-bound download. Evicts the oldest
   * idle output at the two-output cap; active transfers are never removed.
   */
  async retainOutput(options: {
    sessionId: string;
    jobDir: string;
    outputPath: string;
    pageCount: number;
    /** Overrides the default TTL (fill outputs retain longer). */
    ttlMs?: number;
  }): Promise<RetainedOutput> {
    const fileStat = await stat(options.outputPath);
    if (fileStat.size > LIMITS.maxOutputBytes) {
      throw new Error("OUTPUT_TOO_LARGE");
    }
    if (this.retained.size >= LIMITS.maxRetainedOutputs) {
      const oldestIdle = [...this.retained.values()]
        .filter((candidate) => !candidate.leased)
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldestIdle) throw new Error(RETAINED_OUTPUT_CAPACITY);
      await this.deleteRetained(oldestIdle.handle);
    }

    const at = this.now();
    const record: RetainedOutput = {
      handle: randomHandle(),
      sessionId: options.sessionId,
      jobDir: options.jobDir,
      outputPath: options.outputPath,
      bytes: fileStat.size,
      pageCount: options.pageCount,
      createdAt: at,
      expiresAt: at + (options.ttlMs ?? this.outputTtlMs),
      leased: false,
      deleteAfterRelease: false
    };
    this.retained.set(record.handle, record);
    return record;
  }

  retainedCount(): number {
    return this.retained.size;
  }

  peekRetained(handle: string): RetainedOutput | undefined {
    return this.retained.get(handle);
  }

  /** Atomically lease one transfer for the owning session. */
  lease(handle: string, sessionId: string): { outcome: LeaseOutcome; record?: RetainedOutput } {
    const record = this.retained.get(handle);
    if (!record) return { outcome: "not_found" };
    if (record.sessionId !== sessionId) return { outcome: "forbidden" };
    if (record.expiresAt <= this.now()) {
      if (record.leased) {
        record.deleteAfterRelease = true;
        return { outcome: "busy" };
      }
      this.deleteRetainedSync(record);
      return { outcome: "expired" };
    }
    if (record.leased) return { outcome: "busy" };
    record.leased = true;
    return { outcome: "leased", record };
  }

  /** Release a lease after a failed transfer so one retry stays possible. */
  release(handle: string, sessionId: string): boolean {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    record.leased = false;
    if (record.deleteAfterRelease || record.expiresAt <= this.now()) {
      this.deleteRetainedSync(record);
    }
    return true;
  }

  /** Consume an output after a completed response. */
  async consume(handle: string, sessionId: string): Promise<boolean> {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    await this.deleteRetained(handle);
    return true;
  }

  /**
   * Synchronously consume an output at the `finish` transfer boundary.
   * The record leaves the map before asynchronous directory cleanup, so a
   * trailing `close` can never release the lease back for a replay. Returns
   * false when the handle is unknown or owned by another session.
   */
  consumeSync(handle: string, sessionId: string): boolean {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    this.deleteRetainedSync(record);
    return true;
  }

  /** Explicit discard of a session-bound output. */
  async discard(handle: string, sessionId: string): Promise<boolean> {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    await this.deleteRetained(handle);
    return true;
  }

  async sweepExpired(): Promise<void> {
    const at = this.now();
    for (const [handle, record] of this.retained) {
      if (record.expiresAt > at) continue;
      if (record.leased) {
        record.deleteAfterRelease = true;
      } else {
        await this.deleteRetained(handle);
      }
    }
    await this.retryPendingCleanup();
  }

  /** Remove only owned canonical child directories; ignore the rest. */
  async sweepStartupOrphans(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.tempRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^(job-|pages-|compress-|fill-)[0-9a-f]{32}$/.test(entry.name)) continue;
      const full = join(this.tempRoot, entry.name);
      try {
        const fileStat = await lstat(full);
        if (!fileStat.isDirectory() || fileStat.isSymbolicLink()) continue;
        if (!isOwnedByCurrentUser(fileStat.uid)) continue;
      } catch {
        continue;
      }
      const owned = [...this.retained.values()].some((record) => record.jobDir === full);
      if (!owned) await this.cleanupDirectory(full);
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.retryPendingCleanup();
      return;
    }
    this.closed = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    for (const handle of [...this.retained.keys()]) {
      await this.deleteRetained(handle);
    }
    await this.retryPendingCleanup();
  }

  private async deleteRetained(handle: string): Promise<void> {
    const record = this.retained.get(handle);
    if (!record) return;
    this.retained.delete(handle);
    this.expireFillOutcome(handle);
    await this.cleanupDirectory(record.jobDir);
  }

  private deleteRetainedSync(record: RetainedOutput): void {
    this.retained.delete(record.handle);
    this.expireFillOutcome(record.handle);
    this.pendingCleanup.add(record.jobDir);
    void this.cleanupDirectory(record.jobDir);
  }

  /**
   * A stored fill outcome is replayable only while the output it references
   * is still retained: once the handle is consumed, evicted or swept, the
   * next identical submission resumes instead of answering with a dead link.
   */
  private expireFillOutcome(handle: string): void {
    for (const record of this.fillRecords.values()) {
      if (record.retainedHandle !== handle) continue;
      delete record.outcome;
      delete record.retainedHandle;
    }
  }

  private async cleanupDirectory(dir: string): Promise<void> {
    this.pendingCleanup.add(dir);
    try {
      await this.removeJobDir(dir);
      this.pendingCleanup.delete(dir);
    } catch {
      // Keep the inaccessible directory in retry state for sweep/shutdown.
    }
  }

  private async retryPendingCleanup(): Promise<void> {
    for (const dir of [...this.pendingCleanup]) {
      await this.cleanupDirectory(dir);
    }
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      const entryStat = await lstat(full);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        total += await dirSize(full);
      } else if (entryStat.isFile()) {
        total += entryStat.size;
      }
    } catch {
      continue;
    }
  }
  return total;
}
