# Dependency Licenses

The project starts with AGPL-3.0-or-later to keep the repository compatible with AGPL-licensed PDF engine options.

## Runtime PDF Tools

| Tool | Purpose | License posture |
|---|---|---|
| qpdf | Lossless structural optimization and page assembly | Permissive upstream licensing; suitable for conservative optimization. |
| Ghostscript | `pdfwrite` lossy compression profiles | AGPL/commercial upstream licensing; bundling or tight distribution must honor AGPL obligations. |
| OCRmyPDF | Local searchable-text pipeline and PDF orchestration | MPL-2.0 upstream; calls local qpdf, Ghostscript, Tesseract, and related tools whose licenses must be reviewed for distribution. |
| Tesseract OCR | German and English text recognition | Apache-2.0 upstream; language data is installed separately. |

## Bundled JavaScript Dependencies

| Package | Version | Purpose | License |
|---|---|---|---|
| `pdfjs-dist` | 6.3.289 (exact pin) | Lazy local thumbnail rendering with a version-matched worker, plus the bounded fill child that writes filled/signed documents in Node; declared in both the core and web manifests (~35 MB unpacked) | Apache-2.0 |
| `@napi-rs/canvas` | 1.0.8 (transitive) | Optional `pdfjs-dist` native canvas dependency, resolved in the lockfile with platform binaries; unused by the Node fill child, which has no canvas — image stamping is deferred | MIT |
| `@fastify/busboy` | 3.2.2 (exact pin) | Streaming multipart parser for the page-export route; no file-sized buffers | MIT |

## Current Distribution Decision

The app calls local binaries by name and reports `ENGINE_UNAVAILABLE` when they are missing.
It does not bundle PDF engine binaries yet.

Before distributing installers or a desktop app, revisit whether binaries are bundled, downloaded, or user-installed.
