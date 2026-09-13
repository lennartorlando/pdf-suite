/// <reference types="vite/client" />

// pdfjs-dist ships no per-file declarations for the minified browser build;
// the entry point below is the same module `main` resolves, typed via the
// package's declared types entry.
declare module "pdfjs-dist/build/pdf.min.mjs" {
  export * from "pdfjs-dist/types/src/pdf.js";
}
