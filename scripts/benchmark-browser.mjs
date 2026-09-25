#!/usr/bin/env node
/**
 * U8 browser benchmark (SC3, SC4, SC8): drives the BUILT app in a real
 * browser (Puppeteer, the feature's single permitted development
 * dependency) against the real loopback server serving apps/web/dist under
 * the production content policy. No jsdom, no fake canvas.
 *
 * Measured on the form corpus (tests/performance/form-corpora.mjs):
 * - cold open of the 8-page 2 MiB reference form to first painted page and
 *   first editable field (SC3),
 * - typing, checkbox toggling and placement dragging on the 200-field form
 *   (SC4; the in-page dispatch timing isolates the app's own work and the
 *   run asserts zero /api/ requests fired during the gesture windows),
 * - export click to downloadable-result (browser-side fill overhead),
 * - the scanned ICC fixture rendering under the production CSP, with the
 *   qcms WebAssembly fetch proven same-origin (R2 for scanned documents;
 *   if it fails this script fails plainly, no workaround),
 * - page-editor cold open to first painted thumbnail, a 100-thumbnail
 *   rotate gesture, and export-to-downloadable (the page-editor browser
 *   evidence the U6 baseline left unverified for want of a driver).
 *
 * Two budget classes: `reference-mac` (SC3/SC4 evidence) and
 * `hosted-runner` (CI regression). The reference-mac budget is refused
 * under CI. Writes the `browser` section of form-filling-baseline.json and
 * page-editor-baseline.json, preserving the sibling sections each file's
 * other owner produced.
 */
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BENCHMARK_DIR,
  checkCorpusMatch,
  collectEnvironment,
  environmentClass,
  hasFlag,
  hashCorpusFiles,
  invokedDirectly,
  percentileStats,
  readBaseline,
  resolveBudgetName,
  writeBaseline
} from "./benchmark-harness.mjs";
import { ensurePageEditorCorpora } from "./benchmark-page-editor.mjs";
import { ensureFormCorpora } from "../tests/performance/form-corpora.mjs";

const FORM_BASELINE = join(BENCHMARK_DIR, "form-filling-baseline.json");
const EDITOR_BASELINE = join(BENCHMARK_DIR, "page-editor-baseline.json");

/** SC3/SC4 budgets per environment class; hosted runners get headroom. */
export const BROWSER_BUDGETS_MS = {
  "reference-mac": { coldOpen: 1500, typeInput: 50, checkboxToggle: 50, dragMove: 50, dragCommit: 250 },
  "hosted-runner": { coldOpen: 10000, typeInput: 300, checkboxToggle: 300, dragMove: 300, dragCommit: 1500 }
};

export const BROWSER_GATE_METRICS = ["coldOpen", "typeInput", "checkboxToggle", "dragMove", "dragCommit"];

/** Pure gate verdict; exported so tests can prove an impossible budget fails. */
export function evaluateBrowserGate(metric, p95Ms, budgetName) {
  const budgetMs = BROWSER_BUDGETS_MS[budgetName]?.[metric];
  if (budgetMs === undefined) {
    throw new Error(`Unknown browser gate "${metric}" for budget class "${budgetName}".`);
  }
  return { metric, p95Ms, budgetMs, budgetName, withinBudget: p95Ms <= budgetMs };
}

const COLD_OPEN_SAMPLES = 10;
const GESTURE_SAMPLES = 20;
const EXPORT_SAMPLES = 8;

/* In-page probes run in the built app. Kept as string-free function bodies
 * so page.evaluate ships them verbatim. */

/** First page painted (any opaque pixel) AND an editable field input present. */
function probePageReady() {
  const canvas = document.querySelector("canvas.fill-canvas");
  const editable = document.querySelector(".field-box input, .field-box textarea, .field-box select");
  if (!canvas || !editable || canvas.width === 0 || canvas.height === 0) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return true;
  }
  return false;
}

/** Scanned render proof: the gradient image must produce varied pixels. */
function probeScannedPainted() {
  const canvas = document.querySelector("canvas.fill-canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4096) {
    if (data[i + 3] === 0) continue;
    colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    if (colors.size > 8) return true;
  }
  return false;
}

function probeThumbPainted() {
  const canvas = document.querySelector("canvas.thumb__canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return true;
  }
  return false;
}

/** Wait for a button with exact text, then click it (fails loudly when absent). */
async function clickButton(page, text) {
  await page.waitForFunction(
    (wanted) => [...document.querySelectorAll("button")].some((b) => b.textContent === wanted),
    { polling: 50 },
    text
  );
  await page.evaluate((wanted) => {
    [...document.querySelectorAll("button")].find((b) => b.textContent === wanted)?.click();
  }, text);
}

/** Tool-rail buttons carry an icon plus label ("✓Check"); match on the label. */
async function clickToolButton(page, label) {
  await page.waitForFunction(
    (wanted) => [...document.querySelectorAll(".fill-tools button")].some((b) => b.textContent.endsWith(wanted)),
    { polling: 50 },
    label
  );
  await page.evaluate((wanted) => {
    [...document.querySelectorAll(".fill-tools button")].find((b) => b.textContent.endsWith(wanted))?.click();
  }, label);
}

async function openFillSurface(page, base, pdfPath) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await clickButton(page, "Fill and sign");
  await page.waitForSelector('.fill-pick input[type="file"]');
  const input = await page.$('.fill-pick input[type="file"]');
  await input.uploadFile(pdfPath);
}

async function openEditorSurface(page, base, pdfPath) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await clickButton(page, "Edit pages");
  await page.waitForSelector('.page-editor input[type="file"]');
  const input = await page.$('.page-editor input[type="file"]');
  await input.uploadFile(pdfPath);
}

async function newContextPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  return { context, page };
}

if (invokedDirectly(import.meta.url)) {
  // Built-app and driver imports stay inside the main block: importing this
  // module for its pure gate functions must not require a build or a browser.
  const { default: puppeteer } = await import("puppeteer");
  const { createReadyLocalServer, PRODUCTION_CSP } = await import("../apps/local-server/dist/server.js");

  const regen = hasFlag(process.argv, "--regen-corpora");
  const budgetName = resolveBudgetName(process.argv);
  const formCorpora = ensureFormCorpora(regen);
  const editorCorpora = ensurePageEditorCorpora(regen);
  const formHashes = hashCorpusFiles([...formCorpora.values()]);
  const editorHashes = hashCorpusFiles(editorCorpora);

  for (const [baselinePath, hashes] of [
    [FORM_BASELINE, formHashes],
    [EDITOR_BASELINE, editorHashes]
  ]) {
    const prior = readBaseline(baselinePath);
    if (!regen && prior?.corpusHashes) {
      const match = checkCorpusMatch(prior.corpusHashes, hashes);
      if (!match.ok) {
        console.error(
          `benchmark-browser: FAIL: corpus hashes changed for ${baselinePath.split("/").pop()} ` +
            `(${match.mismatched.join(", ")}); regenerate with --regen-corpora if intentional.`
        );
        process.exit(1);
      }
    }
  }

  const handle = await createReadyLocalServer();
  await new Promise((resolveListen, rejectListen) => {
    handle.server.once("error", rejectListen);
    handle.server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = handle.server.address();
  const base = `http://127.0.0.1:${port}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: environmentClass() === "hosted-runner" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []
  });
  const chromeVersion = await browser.version();

  const failures = [];
  const gate = (metric, stats) => {
    const verdict = evaluateBrowserGate(metric, stats.p95Ms, budgetName);
    if (!verdict.withinBudget) failures.push(`${metric}: p95 ${stats.p95Ms}ms over ${budgetName} budget ${verdict.budgetMs}ms`);
    return verdict;
  };

  const formResults = {};
  const editorResults = {};
  let scannedIcc = null;
  let requestsDuringGestures = -1;
  try {
    /* ------------------- SC3: form cold open ------------------- */
    {
      const samples = [];
      for (let i = 0; i < COLD_OPEN_SAMPLES; i += 1) {
        const { context, page } = await newContextPage(browser);
        try {
          const t0 = performance.now();
          await page.goto(base, { waitUntil: "domcontentloaded" });
          await clickButton(page, "Fill and sign");
          await page.waitForSelector('.fill-pick input[type="file"]');
          const input = await page.$('.fill-pick input[type="file"]');
          await input.uploadFile(formCorpora.get("form-8page-2mb.pdf"));
          await page.waitForFunction(probePageReady, { polling: 100 });
          samples.push(performance.now() - t0);
        } finally {
          await context.close();
        }
      }
      const stats = { operation: "cold-open-form-8page-2mb", ...percentileStats(samples) };
      formResults.coldOpen = { ...stats, gate: gate("coldOpen", stats) };
    }

    /* ------------- SC4: input latency on the 200-field form ------------- */
    {
      const { context, page } = await newContextPage(browser);
      try {
        await openFillSurface(page, base, formCorpora.get("form-200.pdf"));
        await page.waitForFunction(probePageReady, { polling: 100 });

        /* Real pointer input through the browser's hit testing: a click at
         * an element's on-screen coordinates must reach it, which fails when
         * a covering layer swallows the pointer (the surface layers sit on
         * top of the canvas and the hit layer in the same stacking
         * context). The timed gesture loops below keep dispatching in-page
         * because SC4 budgets the app's own work, not protocol overhead. */
        const clickablePoint = async (selector) => {
          const handle = await page.waitForSelector(selector);
          await handle.evaluate((node) => node.scrollIntoView({ block: "center" }));
          const rect = await handle.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          });
          return rect;
        };
        // A paper point no interactive element covers; requires the empty
        // areas of the surface layers to be transparent to the pointer.
        const freeHitPoint = () => {
          const layer = document.querySelector(".hit-layer");
          if (!layer || layer.hidden) return null;
          layer.scrollIntoView({ block: "center" });
          const box = layer.getBoundingClientRect();
          for (const fy of [0.5, 0.85, 0.15, 0.7, 0.3]) {
            for (const fx of [0.5, 0.2, 0.8, 0.35, 0.65]) {
              const x = box.left + box.width * fx;
              const y = box.top + box.height * fy;
              if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) continue;
              if (document.elementFromPoint(x, y) === layer) return { x, y };
            }
          }
          return null;
        };
        try {
          const point = await clickablePoint('.field-box input[type="text"], .field-box textarea');
          await page.mouse.click(point.x, point.y);
          await page.keyboard.type("probe-real");
          const typed = await page.evaluate(() => document.activeElement?.value ?? "");
          if (typed !== "probe-real") {
            failures.push(`real pointer typing did not reach the field input (got ${JSON.stringify(typed)})`);
          }
        } catch (error) {
          failures.push(`real pointer text-field fill failed: ${error.message}`);
        }
        try {
          const checkboxSelector = '.field-box input[type="checkbox"]';
          const point = await clickablePoint(checkboxSelector);
          const before = await page.evaluate((sel) => document.querySelector(sel)?.checked, checkboxSelector);
          await page.mouse.click(point.x, point.y);
          const after = await page.evaluate((sel) => document.querySelector(sel)?.checked, checkboxSelector);
          if (before === after) failures.push("real pointer click did not toggle the checkbox");
        } catch (error) {
          failures.push(`real pointer checkbox click failed: ${error.message}`);
        }

        // A checkmark placement gives the drag measurements a target, and a
        // text placement proves the Text tool lands where the person clicks;
        // both are created by real pointer clicks on the page.
        for (const [tool, placementClass] of [["Check", ".placement--checkmark"], ["Text", ".placement--text"]]) {
          try {
            await clickToolButton(page, tool);
            const point = await page.evaluate(freeHitPoint);
            if (!point) throw new Error("no point on the page reaches the hit layer");
            await page.mouse.click(point.x, point.y);
            await page.waitForSelector(placementClass, { timeout: 5000 });
          } catch (error) {
            failures.push(`real pointer ${tool.toLowerCase()} placement failed: ${error.message}`);
          }
        }
        await clickToolButton(page, "Fields");

        const apiRequests = [];
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
        });

        formResults.typeInput = {
          operation: "type-200-field",
          ...percentileStats(
            await page.evaluate((rounds) => {
              const input = document.querySelector('.field-box input[type="text"], .field-box textarea');
              const out = [];
              for (let i = 0; i < rounds; i += 1) {
                input.value = `probe-${i}`;
                const t0 = performance.now();
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
                out.push(performance.now() - t0);
              }
              return out;
            }, GESTURE_SAMPLES)
          ),
          samples: GESTURE_SAMPLES
        };
        formResults.typeInput.gate = gate("typeInput", formResults.typeInput);

        formResults.checkboxToggle = {
          operation: "checkbox-200-field",
          ...percentileStats(
            await page.evaluate((rounds) => {
              const input = document.querySelector('.field-box input[type="checkbox"]');
              const out = [];
              for (let i = 0; i < rounds; i += 1) {
                input.checked = !input.checked;
                const t0 = performance.now();
                input.dispatchEvent(new Event("change", { bubbles: true }));
                out.push(performance.now() - t0);
              }
              return out;
            }, GESTURE_SAMPLES)
          ),
          samples: GESTURE_SAMPLES
        };
        formResults.checkboxToggle.gate = gate("checkboxToggle", formResults.checkboxToggle);

        const drag = await page.evaluate((rounds) => {
          // Synthetic pointer events carry no active pointer id, so the
          // layer's setPointerCapture call would throw NotFoundError before
          // the drag path runs. The shim is applied outside the timed
          // windows and changes nothing about the measured move/commit work.
          const proto = Element.prototype;
          const original = proto.setPointerCapture;
          proto.setPointerCapture = function noop() {};
          const layer = document.querySelector(".placement-layer");
          const moves = [];
          const commits = [];
          try {
            for (let i = 0; i < rounds; i += 1) {
              // Each commit rebuilds the layer's children; re-query the node.
              const node = layer.querySelector(".placement");
              if (!node) break;
              const box = node.getBoundingClientRect();
              const x = box.left + 2;
              const y = box.top + 2;
              node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
              const t0 = performance.now();
              layer.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + 6 + i, clientY: y + 6, pointerId: 1 }));
              moves.push(performance.now() - t0);
              const t1 = performance.now();
              layer.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + 6 + i, clientY: y + 6, pointerId: 1 }));
              commits.push(performance.now() - t1);
            }
          } finally {
            proto.setPointerCapture = original;
          }
          return { moves, commits };
        }, GESTURE_SAMPLES);
        if (drag.moves.length === 0 || drag.commits.length === 0) {
          failures.push("no placement exists to drag; drag gesture windows not measured");
        } else {
          formResults.dragMove = { operation: "drag-move-200-field", ...percentileStats(drag.moves) };
          formResults.dragMove.gate = gate("dragMove", formResults.dragMove);
          formResults.dragCommit = { operation: "drag-commit-200-field", ...percentileStats(drag.commits) };
          formResults.dragCommit.gate = gate("dragCommit", formResults.dragCommit);
        }

        requestsDuringGestures = apiRequests.length;

        /* -------- browser-to-downloadable overhead (SC5 surface) -------- */
        formResults.exportToDownloadable = {
          operation: "export-to-downloadable-200-field",
          ...percentileStats(
            await page.evaluate(async (rounds) => {
              const times = [];
              for (let i = 0; i < rounds; i += 1) {
                const t0 = performance.now();
                [...document.querySelectorAll("button")].find((b) => b.textContent === "Create PDF")?.click();
                await new Promise((resolve, reject) => {
                  const deadline = Date.now() + 60000;
                  const poll = () => {
                    if ([...document.querySelectorAll("a.button")].some((a) => a.textContent === "Download filled PDF")) {
                      resolve();
                      return;
                    }
                    const error = document.querySelector(".fill-panel .error");
                    if (error) {
                      reject(new Error(`fill refused: ${error.textContent}`));
                      return;
                    }
                    if (Date.now() > deadline) {
                      reject(new Error("export timed out"));
                      return;
                    }
                    setTimeout(poll, 50);
                  };
                  poll();
                });
                times.push(performance.now() - t0);
              }
              return times;
            }, EXPORT_SAMPLES)
          ),
          samples: EXPORT_SAMPLES,
          note: "Export click to downloadable link; includes the loopback fill and result fetch. Ungated: SC5's budget is on the core path."
        };
      } finally {
        await context.close();
      }
    }

    /* -------- R2: scanned ICC page under the production CSP -------- */
    {
      const { context, page } = await newContextPage(browser);
      try {
        const wasmRequests = [];
        let documentCsp = null;
        page.on("request", (request) => {
          if (request.url().endsWith(".wasm")) wasmRequests.push(request.url());
        });
        page.on("response", (response) => {
          if (response.url() === `${base}/`) documentCsp = response.headers()["content-security-policy"] ?? null;
        });
        // The qcms module is fetched inside the pdf.js worker, whose
        // requests do not surface on the page target. Attach a CDP session
        // to the worker target as soon as it appears so the fetch is
        // observed before the page render reaches the ICC image.
        const workerWatch = browser
          .waitForTarget((target) => target.type() === "worker", { timeout: 30000 })
          .then((target) => target.createCDPSession())
          .then(async (workerSession) => {
            workerSession.on("Network.requestWillBeSent", (event) => {
              if (event.request.url.endsWith(".wasm")) wasmRequests.push(event.request.url);
            });
            await workerSession.send("Network.enable");
            return workerSession;
          })
          .catch(() => null);
        let rendered = false;
        let failure = null;
        try {
          await openFillSurface(page, base, formCorpora.get("scanned-form-icc.pdf"));
          await workerWatch;
          await page.waitForFunction(probeScannedPainted, { polling: 150, timeout: 30000 });
          rendered = true;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        const sameOrigin = wasmRequests.filter((url) => url.startsWith(base));
        scannedIcc = {
          rendered,
          failure,
          cspMatchesProduction: documentCsp === PRODUCTION_CSP,
          wasmRequestsSameOrigin: sameOrigin,
          wasmRequestsForeign: wasmRequests.filter((url) => !url.startsWith(base)),
          note: "Scanned ICC page in a real browser under the production content policy. Failure here means R2 is unsatisfied for scanned documents."
        };
        if (!rendered || documentCsp !== PRODUCTION_CSP || sameOrigin.length === 0 || scannedIcc.wasmRequestsForeign.length > 0) {
          failures.push(
            `scanned ICC render under production CSP failed (rendered=${rendered}, cspMatch=${documentCsp === PRODUCTION_CSP}, ` +
              `sameOriginWasm=${sameOrigin.length}, foreignWasm=${scannedIcc.wasmRequestsForeign.length}): ${failure ?? "no same-origin wasm fetch observed"}`
          );
        }
      } finally {
        await context.close();
      }
    }

    /* ------------- page-editor browser evidence (U6 leftovers) ------------- */
    {
      const corpus20 = editorCorpora.find((p) => p.endsWith("corpus-20.pdf"));
      const corpus100 = editorCorpora.find((p) => p.endsWith("corpus-100.pdf"));
      const samples = [];
      for (let i = 0; i < COLD_OPEN_SAMPLES; i += 1) {
        const { context, page } = await newContextPage(browser);
        try {
          const t0 = performance.now();
          await openEditorSurface(page, base, corpus20);
          await page.waitForFunction(probeThumbPainted, { polling: 100 });
          samples.push(performance.now() - t0);
        } finally {
          await context.close();
        }
      }
      const stats = { operation: "cold-open-page-editor-corpus-20", ...percentileStats(samples) };
      editorResults.coldOpen = { ...stats, gate: gate("coldOpen", stats) };

      const { context, page } = await newContextPage(browser);
      try {
        await openEditorSurface(page, base, corpus100);
        await page.waitForFunction(probeThumbPainted, { polling: 100 });
        // Select all, then measure the rotate-selected gesture: the real
        // click-to-model-update path over 100 thumbnails. The button is
        // re-found per round because a re-render may replace it.
        await clickButton(page, "Select all");
        editorResults.rotateGesture = {
          operation: "rotate-selected-100-thumbs",
          ...percentileStats(
            await page.evaluate((rounds) => {
              const out = [];
              for (let i = 0; i < rounds; i += 1) {
                const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "⟳ Rotate selected");
                const t0 = performance.now();
                button.click();
                out.push(performance.now() - t0);
              }
              return out;
            }, GESTURE_SAMPLES)
          )
        };

        editorResults.exportToDownloadable = {
          operation: "export-to-downloadable-corpus-20",
          ...percentileStats(
            await (async () => {
              const single = await newContextPage(browser);
              try {
                await openEditorSurface(single.page, base, corpus20);
                await single.page.waitForFunction(probeThumbPainted, { polling: 100 });
                return await single.page.evaluate(async (rounds) => {
                  const times = [];
                  for (let i = 0; i < rounds; i += 1) {
                    const t0 = performance.now();
                    [...document.querySelectorAll("button")].find((b) => b.textContent === "Export PDF")?.click();
                    await new Promise((resolve, reject) => {
                      const deadline = Date.now() + 60000;
                      const poll = () => {
                        if ([...document.querySelectorAll("a.button")].some((a) => a.textContent === "Download PDF")) {
                          resolve();
                          return;
                        }
                        const error = document.querySelector(".page-editor .error:not(:empty)");
                        if (error) {
                          reject(new Error(`export failed: ${error.textContent}`));
                          return;
                        }
                        if (Date.now() > deadline) {
                          reject(new Error("export timed out"));
                          return;
                        }
                        setTimeout(poll, 50);
                      };
                      poll();
                    });
                    times.push(performance.now() - t0);
                  }
                  return times;
                }, EXPORT_SAMPLES);
              } finally {
                await single.context.close();
              }
            })()
          ),
          samples: EXPORT_SAMPLES
        };

        /* A long, unbreakable file name must not push the thumbnail's canvas
         * and controls past the card's border (the card's grid column took
         * the caption's min-content width). Layout regression check, ungated. */
        const longNamePath = join(tmpdir(), "SEPA_Lastschrift_Mandat_251030_webB.pdf");
        await copyFile(corpus20, longNamePath);
        const { context: longNameContext, page: longNamePage } = await newContextPage(browser);
        try {
          await openEditorSurface(longNamePage, base, longNamePath);
          await longNamePage.waitForFunction(probeThumbPainted, { polling: 100 });
          const overflow = await longNamePage.evaluate(() => {
            const bad = [];
            for (const card of document.querySelectorAll(".thumb")) {
              for (const child of card.querySelectorAll(".thumb__canvas, .thumb__controls")) {
                if (child.offsetWidth > card.offsetWidth) {
                  bad.push(`${child.className} ${child.offsetWidth}px overflows card ${card.offsetWidth}px`);
                }
              }
            }
            return bad;
          });
          for (const item of overflow.slice(0, 5)) {
            failures.push(`thumbnail card overflowed by a long file name: ${item}`);
          }
        } finally {
          await longNameContext.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    handle.server.close();
    await handle.jobs.shutdown();
  }

  const environment = await collectEnvironment({ chrome: chromeVersion, puppeteer: "25.9.0" });
  const browserSection = {
    ...environment,
    budgetClass: budgetName,
    corpusHashes: formHashes,
    method: {
      coldOpenSamples: COLD_OPEN_SAMPLES,
      gestureSamples: GESTURE_SAMPLES,
      exportSamples: EXPORT_SAMPLES,
      note: "Gesture timing wraps the real in-page event dispatch; protocol overhead is excluded because SC4 budgets the app's own work. Zero /api/ requests fired during gesture windows is asserted."
    },
    requestsDuringGestures,
    results: formResults,
    scannedIcc
  };
  const editorBrowserSection = {
    ...environment,
    budgetClass: budgetName,
    corpusHashes: editorHashes,
    results: editorResults
  };

  const priorForm = readBaseline(FORM_BASELINE) ?? {};
  writeBaseline(FORM_BASELINE, { ...priorForm, browser: browserSection });
  const priorEditor = readBaseline(EDITOR_BASELINE) ?? {};
  writeBaseline(EDITOR_BASELINE, { ...priorEditor, browser: editorBrowserSection });

  console.log(
    `benchmark-browser: ${environment.class} (${environment.os}, ${environment.hardwareClass.cpuModel}), ` +
      `budget ${budgetName}, ${chromeVersion}`
  );
  for (const [name, entry] of Object.entries(formResults)) {
    console.log(`  form ${name}: p95 ${entry.p95Ms}ms${entry.gate ? ` (${entry.gate.withinBudget ? "within" : "OVER"} ${entry.gate.budgetMs}ms)` : ""}`);
  }
  console.log(`  gestures fired ${requestsDuringGestures} /api/ requests (must be 0)`);
  console.log(
    `  scanned-icc: rendered=${scannedIcc.rendered}, cspMatch=${scannedIcc.cspMatchesProduction}, ` +
      `same-origin wasm fetches=${scannedIcc.wasmRequestsSameOrigin.length}, foreign=${scannedIcc.wasmRequestsForeign.length}`
  );
  for (const [name, entry] of Object.entries(editorResults)) {
    console.log(`  editor ${name}: p95 ${entry.p95Ms}ms${entry.gate ? ` (${entry.gate.withinBudget ? "within" : "OVER"} ${entry.gate.budgetMs}ms)` : ""}`);
  }
  if (requestsDuringGestures !== 0) failures.push(`${requestsDuringGestures} /api/ requests fired during gesture windows`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`benchmark-browser: FAIL: ${failure}`);
    process.exit(1);
  }
}
