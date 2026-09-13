import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Ship the pinned pdf.js runtime assets from the app's own origin (KTD19).
 * The renderer resolves `wasmUrl`, `standardFontDataUrl` and `iccUrl` as
 * directory prefixes; emitted files land under `assets/pdfjs/` and are
 * discovered by scripts/check-editor-bundle.mjs against the lazy budget.
 * quickjs-eval (scripting) and the predefined CMaps are deliberately not
 * emitted: scripting is disabled and the worker falls back without them.
 */
const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));
const ASSET_PREFIX = "assets/pdfjs/";

const EMIT_DIRS: Record<string, RegExp | undefined> = {
  wasm: /^quickjs-eval\./,
  standard_fonts: undefined,
  iccs: undefined
};

function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-local-assets",
    buildStart() {
      for (const [dir, skip] of Object.entries(EMIT_DIRS)) {
        for (const file of readdirSync(join(PDFJS_DIR, dir))) {
          if (skip?.test(file)) continue;
          this.emitFile({
            type: "asset",
            fileName: `${ASSET_PREFIX}${dir}/${file}`,
            source: readFileSync(join(PDFJS_DIR, dir, file))
          });
        }
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith(`/${ASSET_PREFIX}`)) {
          next();
          return;
        }
        const rel = url.slice(ASSET_PREFIX.length + 1);
        if (rel.includes("..")) {
          res.statusCode = 403;
          res.end();
          return;
        }
        try {
          const body = readFileSync(join(PDFJS_DIR, rel));
          res.setHeader("content-type", url.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [pdfjsAssets()]
});
