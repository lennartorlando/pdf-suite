#!/usr/bin/env node
/**
 * U6 native-version gate (KTD10).
 *
 * Single source of truth: packages/core/src/native-floors.ts, read here
 * from the built browser-safe `@pdf-compressor/core/native-floors` output
 * (packages/core/dist/native-floors.js). No values are duplicated in this
 * file; when the core has not been built this gate fails with a clear
 * rebuild instruction instead of checking against stale constants.
 *
 * Behavior: parse actual `qpdf --version`, `gs --version`, and optional
 * `ocrmypdf --version` output
 * robustly, require qpdf, treat Ghostscript as optional (missing gs only
 * disables compression), and fail closed below either floor.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_FLOORS = join(HERE, "..", "packages", "core", "dist", "native-floors.js");
const BUILT_PDFJS_PIN = join(HERE, "..", "packages", "core", "dist", "pdfjs-version.js");

function fail(message) {
  console.error(`check-native-versions: FAIL: ${message}`);
  process.exit(1);
}

for (const built of [BUILT_FLOORS, BUILT_PDFJS_PIN]) {
  if (!existsSync(built)) {
    fail(
      `built version constants are missing at ${built.slice(HERE.length + 1)}; ` +
        "run `npm run build` (or `npm run typecheck`) first so this gate reads the single source of truth."
    );
  }
}

let QPDF_SECURITY_FLOOR;
let GHOSTSCRIPT_SECURITY_FLOOR;
let OCRMY_PDF_FEATURE_FLOOR;
let PDFJS_PINNED_VERSION;
try {
  const floors = await import(pathToFileURL(BUILT_FLOORS).href);
  QPDF_SECURITY_FLOOR = floors.QPDF_SECURITY_FLOOR;
  GHOSTSCRIPT_SECURITY_FLOOR = floors.GHOSTSCRIPT_SECURITY_FLOOR;
  OCRMY_PDF_FEATURE_FLOOR = floors.OCRMY_PDF_FEATURE_FLOOR;
  const pin = await import(pathToFileURL(BUILT_PDFJS_PIN).href);
  PDFJS_PINNED_VERSION = pin.PDFJS_PINNED_VERSION;
} catch (error) {
  fail(
    `could not import built version constants (${error instanceof Error ? error.message : String(error)}); ` +
      "run `npm run build` first."
  );
}
if (
  typeof QPDF_SECURITY_FLOOR !== "string" ||
  typeof GHOSTSCRIPT_SECURITY_FLOOR !== "string" ||
  typeof OCRMY_PDF_FEATURE_FLOOR !== "string" ||
  typeof PDFJS_PINNED_VERSION !== "string"
) {
  fail("built version constants did not export all required version strings.");
}

function parseTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTuples(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** qpdf prints e.g. "qpdf version 12.4.1\n..."; match the version triple. */
export function parseQpdfVersion(output) {
  const match = /qpdf version (\d+\.\d+\.\d+)/.exec(String(output));
  return match ? match[1] : null;
}

/** gs --version prints a bare version on the first line, e.g. "10.07.1". */
export function parseGhostscriptVersion(output) {
  const first = String(output).split("\n")[0]?.trim() ?? "";
  return parseTuple(first) ? first : null;
}

/** OCRmyPDF writes messages to stderr, but older packages may use stdout. */
export function parseOcrMyPdfVersion(stdout, stderr = "") {
  for (const output of [stderr, stdout]) {
    const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(String(output).trim());
    if (match) return match[1];
  }
  return null;
}

export function meetsFloor(found, floor) {
  const a = parseTuple(found);
  const b = parseTuple(floor);
  return a !== null && b !== null && compareTuples(a, b) >= 0;
}

export function floors() {
  return { QPDF_SECURITY_FLOOR, GHOSTSCRIPT_SECURITY_FLOOR, OCRMY_PDF_FEATURE_FLOOR };
}

export function pdfjsPin() {
  return PDFJS_PINNED_VERSION;
}

/**
 * The renderer pin must agree across the owned constant, both package
 * manifests and the installed package: there is no bundler pinning
 * resolution, so any drift means two consumers silently run different
 * renderers. Exact pins only.
 */
export function evaluatePdfjsPin({ constant, coreDependency, webDependency, installedVersion }) {
  const problems = [];
  if (coreDependency !== constant) {
    problems.push(
      `packages/core/package.json declares pdfjs-dist ${JSON.stringify(coreDependency ?? null)}; expected the exact pin ${constant}.`
    );
  }
  if (webDependency !== constant) {
    problems.push(
      `apps/web/package.json declares pdfjs-dist ${JSON.stringify(webDependency ?? null)}; expected the exact pin ${constant}.`
    );
  }
  if (installedVersion !== constant) {
    problems.push(
      `installed pdfjs-dist is ${JSON.stringify(installedVersion ?? null)}; expected the exact pin ${constant}.`
    );
  }
  return { ok: problems.length === 0, problems };
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? error.message) });
        return;
      }
      resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const qpdf = await run("qpdf", ["--version"]);
  if (!qpdf.ok) {
    console.error("check-native-versions: FAIL: qpdf is required for page export but was not found.");
    process.exit(1);
  }
  const qpdfVersion = parseQpdfVersion(qpdf.stdout);
  if (!qpdfVersion) {
    console.error("check-native-versions: FAIL: could not parse qpdf version output; failing closed.");
    process.exit(1);
  }
  console.log(`check-native-versions: qpdf ${qpdfVersion} (floor ${QPDF_SECURITY_FLOOR})`);
  if (!meetsFloor(qpdfVersion, QPDF_SECURITY_FLOOR)) {
    console.error(`check-native-versions: FAIL: qpdf ${qpdfVersion} is below the security floor ${QPDF_SECURITY_FLOOR}.`);
    process.exit(1);
  }

  const gs = await run("gs", ["--version"]);
  if (!gs.ok) {
    console.log("check-native-versions: Ghostscript not found; compression stays disabled (optional).");
  } else {
    const gsVersion = parseGhostscriptVersion(gs.stdout);
    if (!gsVersion) {
      console.error("check-native-versions: FAIL: could not parse Ghostscript version output; failing closed.");
      process.exit(1);
    }
    console.log(`check-native-versions: Ghostscript ${gsVersion} (floor ${GHOSTSCRIPT_SECURITY_FLOOR})`);
    if (!meetsFloor(gsVersion, GHOSTSCRIPT_SECURITY_FLOOR)) {
      console.error(
        `check-native-versions: FAIL: Ghostscript ${gsVersion} is below the security floor ${GHOSTSCRIPT_SECURITY_FLOOR}.`
      );
      process.exit(1);
    }
  }

  const ocrmypdf = await run("ocrmypdf", ["--version"]);
  if (!ocrmypdf.ok) {
    console.log("check-native-versions: OCRmyPDF not found; OCR stays disabled (optional).");
  } else {
    const ocrVersion = parseOcrMyPdfVersion(ocrmypdf.stdout, ocrmypdf.stderr);
    if (!ocrVersion) {
      console.error("check-native-versions: FAIL: could not parse OCRmyPDF version output; failing closed.");
      process.exit(1);
    }
    console.log(`check-native-versions: OCRmyPDF ${ocrVersion} (floor ${OCRMY_PDF_FEATURE_FLOOR})`);
    if (!meetsFloor(ocrVersion, OCRMY_PDF_FEATURE_FLOOR)) {
      console.error(
        `check-native-versions: FAIL: OCRmyPDF ${ocrVersion} is below the feature floor ${OCRMY_PDF_FEATURE_FLOOR}.`
      );
      process.exit(1);
    }
  }

  const readManifest = (relative) => JSON.parse(readFileSync(join(HERE, "..", relative), "utf8"));
  const require = createRequire(import.meta.url);
  let installedPdfjs = null;
  try {
    installedPdfjs = JSON.parse(
      readFileSync(require.resolve("pdfjs-dist/package.json"), "utf8")
    ).version;
  } catch {
    fail("pdfjs-dist is not installed; run `npm install` first.");
  }
  const pin = evaluatePdfjsPin({
    constant: PDFJS_PINNED_VERSION,
    coreDependency: readManifest("packages/core/package.json")["dependencies"]?.["pdfjs-dist"],
    webDependency: readManifest("apps/web/package.json")["dependencies"]?.["pdfjs-dist"],
    installedVersion: installedPdfjs
  });
  if (!pin.ok) {
    for (const problem of pin.problems) {
      console.error(`check-native-versions: FAIL: ${problem}`);
    }
    process.exit(1);
  }
  console.log(`check-native-versions: pdfjs-dist ${installedPdfjs} (pin ${PDFJS_PINNED_VERSION})`);

  console.log("check-native-versions: PASS");
}
