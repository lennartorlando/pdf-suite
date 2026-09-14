/**
 * Shared benchmark harness (U8, KTD16): the corpus hashing, warmup-plus-
 * percentile measurement, environment metadata, commit discovery, asset
 * hashing and two-budget machinery extracted once from the page-editor
 * benchmark. Both native benchmarks and the browser benchmark are thin
 * operation definitions over this module.
 *
 * Integrity rules the harness enforces:
 * - every recorded measurement carries the environment that produced it
 *   (`collectEnvironment`), including `class`: "hosted-runner" when CI is
 *   set, "local" otherwise;
 * - the `reference-mac` budget is refused under CI, so a hosted-runner
 *   result can never be recorded as satisfying a reference-Mac criterion;
 * - `checkCorpusMatch` refuses to record a result against a corpus whose
 *   hashes do not match the baseline being rewritten.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PERF_DIR = join(ROOT, "tests", "performance");
export const BENCHMARK_DIR = join(ROOT, "docs", "benchmarks");

export const DEFAULT_WARMUPS = 5;
export const DEFAULT_SAMPLES = 20;

/* ------------------------- measurement ------------------------- */

export function percentileStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    samples: sorted.length,
    minMs: +sorted[0].toFixed(2),
    medianMs: +at(0.5).toFixed(2),
    p95Ms: +at(0.95).toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2)
  };
}

export async function measure(fn, label, { warmups = DEFAULT_WARMUPS, samples = DEFAULT_SAMPLES } = {}) {
  for (let i = 0; i < warmups; i += 1) await fn();
  const observed = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await fn();
    observed.push(performance.now() - start);
  }
  return { operation: label, warmups, ...percentileStats(observed) };
}

/* ------------------------- corpus hashing ------------------------- */

export function sha256FileSync(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** {basename: sha256} for every corpus file. */
export function hashCorpusFiles(paths) {
  return Object.fromEntries(paths.map((path) => [path.split("/").pop(), sha256FileSync(path)]));
}

/**
 * Refuse to record a baseline against a changed corpus: every name the
 * recorded map carries must hash identically on disk. A regenerated corpus
 * is opt-in through `--regen-corpora`, which callers pass through.
 */
export function checkCorpusMatch(recorded, actual) {
  if (recorded === undefined || recorded === null) return { ok: true, mismatched: [] };
  const mismatched = Object.keys(recorded).filter((name) => actual[name] !== recorded[name]);
  return { ok: mismatched.length === 0, mismatched };
}

/* ------------------------- environment ------------------------- */

/** Resolve the git dir: a normal `.git` directory or a worktree `.git` pointer file. */
export function resolveGitDir(root) {
  const dotGit = join(root, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (st.isFile()) {
    try {
      const pointer = readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (match) return resolve(root, match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

export function readCommit(root = ROOT) {
  try {
    const gitDir = resolveGitDir(root);
    if (!gitDir) return "unknown (detached workspace; host owns the base commit)";
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref: (.+)$/.exec(head);
    if (match) return readFileSync(join(gitDir, match[1]), "utf8").trim();
    return head;
  } catch {
    return "unknown (detached workspace; host owns the base commit)";
  }
}

export function execCapture(command, args, timeoutMs = 120000) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(`${command} failed`), { stderr: String(stderr) }));
        return;
      }
      resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function qpdfVersion() {
  const { stdout } = await execCapture("qpdf", ["--version"]);
  return (/qpdf version (\d+\.\d+\.\d+)/.exec(stdout) ?? [])[1] ?? "unknown";
}

export async function gsVersion() {
  try {
    const { stdout } = await execCapture("gs", ["--version"]);
    return stdout.split("\n")[0].trim() || "absent";
  } catch {
    return "absent";
  }
}

/**
 * Where the measurement ran. A hosted runner is identified by the CI
 * conventions every common CI system sets; everything else is a local
 * machine. The reference Mac records as "local" and is identified by its
 * hardware class, not by a private identifier.
 */
export function environmentClass(env = process.env) {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true" ? "hosted-runner" : "local";
}

export function hardwareClass() {
  const cpuList = cpus();
  return {
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    note: "Class only; no serial number, UUID, hostname, or account name recorded."
  };
}

/** sha256 of every file under apps/web/dist/assets (built output). */
export function collectAssetHashes() {
  const assetDir = join(ROOT, "apps", "web", "dist", "assets");
  const hashes = {};
  try {
    for (const file of listRecursive(assetDir)) {
      hashes[file] = sha256FileSync(join(assetDir, file));
    }
  } catch {
    return {};
  }
  return hashes;
}

function listRecursive(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRecursive(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * The metadata block every recorded measurement carries. `extra` lets a
 * benchmark attach its own identity (e.g. the browser driver version).
 */
export async function collectEnvironment(extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    commit: readCommit(),
    class: environmentClass(),
    hardwareClass: hardwareClass(),
    os: `${platform()} ${release()}`,
    node: process.version,
    qpdf: await qpdfVersion(),
    ghostscript: await gsVersion(),
    assetHashes: collectAssetHashes(),
    ...extra
  };
}

/* ------------------------- budgets ------------------------- */

export const BUDGET_NAMES = ["reference-mac", "hosted-runner"];

/**
 * Pick the budget this run is measured against. Default: the environment's
 * own class (a hosted runner can only ever record against the hosted-runner
 * budget). `reference-mac` under CI is refused outright, so a hosted-runner
 * result can never be written as reference evidence.
 */
export function resolveBudgetName(argv, env = process.env) {
  for (const arg of argv) {
    const match = /^--budget=([a-z-]+)$/.exec(arg);
    if (match) {
      const name = match[1];
      if (!BUDGET_NAMES.includes(name)) {
        throw new Error(`Unknown --budget=${name}; expected one of ${BUDGET_NAMES.join(", ")}.`);
      }
      if (name === "reference-mac" && environmentClass(env) === "hosted-runner") {
        throw new Error("--budget=reference-mac is refused under CI: a hosted runner can never record reference-Mac evidence.");
      }
      return name;
    }
  }
  return environmentClass(env) === "hosted-runner" ? "hosted-runner" : "reference-mac";
}

/** Pure p95 budget verdict; exported so the gate can be proven fallible. */
export function evaluateBudget(p95Ms, budgetMs) {
  return { p95Ms, budgetMs, withinBudget: p95Ms <= budgetMs };
}

/* ------------------------- baselines ------------------------- */

export function readBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeBaseline(path, document) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
}

export function hasFlag(argv, name) {
  return argv.includes(name);
}

export function invokedDirectly(importMetaUrl) {
  return process.argv[1] === fileURLToPath(importMetaUrl);
}
