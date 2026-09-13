# CLI Contract

The CLI exposes the same shared compression, page, and OCR core used by the local web app.
`inspect`, `assemble`, and `ocr` call shared core primitives directly. The CLI adds no validation, inspection, OCR, or assembly
behavior of its own and no orchestration layer.

## Commands

```bash
pdf-compressor compress input.pdf --output output.pdf --profile balanced --json
pdf-compressor inspect a.pdf [b.pdf ...] --json
pdf-compressor assemble --source a=a.pdf --source b=b.pdf --manifest manifest.json --output out.pdf [--ocr] [--ocr-language deu+eng] [--no-ocr-rotate-pages] [--compression balanced] [--overwrite] [--json]
pdf-compressor ocr input.pdf --output output.pdf [--language deu+eng] [--no-rotate-pages] [--overwrite] [--json]
pdf-compressor capabilities [--json]
```

### `inspect`

Inspects one or more local PDFs read-only through the shared core.

- Positional args are source paths in order. Source IDs are stable and
  positional: the first path is `source-1`, the second `source-2`, and so on.
- Relative paths are resolved against the invocation working directory before
  the shared core runs, because native tools execute from a private working
  directory.
- Success JSON contains `status`, the shared `qpdfVersion`, and one entry per
  source with `id`, `path`, `pageCount`, `pdfVersion`, `qpdfVersion`,
  `encrypted`, `signed`, `activeContent`, `compatWarnings`, and `warnings`.
- `activeContent` entries are `<kind>@<scope>` strings reported by the shared
  reachability classifier: `kind` is the action subtype verbatim (`/URI`,
  `/JavaScript`, `/SubmitForm`, `/ResetForm`, ...), a structural class
  (`rich-media`, `embedded-files`), or `action` for an action reference that
  could not be classified; `scope` is `catalog` or `field`. `/GoTo` is the
  only action subtype never reported. An inspection that cannot enumerate the
  object graph fails with `INSPECTION_INCOMPLETE` rather than reporting an
  empty list.

### `assemble`

Assembles a JSON page manifest into a new PDF through the shared core.

- `--source <id>=<path>` is repeatable and owns the invocation-local binding
  between manifest `sourceId` values and local files. Source, manifest, and
  output paths are resolved against the invocation working directory before
  the shared core runs.
- `--manifest` points at a `{ version: 1, pages: [...] }` manifest file using
  the browser-safe `@pdf-compressor/core/page-manifest` contract.
- `--output` is the destination. An existing destination fails with
  `OUTPUT_EXISTS` unless `--overwrite` is passed. Overwrite never applies to a
  destination that aliases a source; a destination created mid-export still
  fails closed via the core no-clobber publication.
- `--compression conservative|balanced|aggressive` optionally applies an
  existing compression profile after assembly, with the same smaller-wins and
  `no_gain` fallback as the shared core.
- Success JSON is the core `AssemblySummary`: `status`, `outputPath`,
  `pageCount`, `outputBytes`, `engine`, `qpdfVersion`, optional
  `ghostscriptVersion`, `warnings`, `compatWarnings`, and per-source
  `sourceHashes`.
- `--ocr` runs the same mandatory OCR step used by the web app after qpdf
  assembly. When requested,
  OCR failure never falls back to an image-only output.
- Compression profiles are not applied to OCR exports because lossy processing
  can reduce recognition quality or invalidate the searchable-text contract;
  the summary reports `no_gain` and a warning when both are selected.
- `--ocr-language` accepts `deu`, `eng`, or `deu+eng`; `--no-ocr-rotate-pages`
  disables automatic cardinal rotation. OCR-specific flags require `--ocr`.

### `ocr`

Adds a searchable text layer to one local PDF through the shared `ocrPdf`
core primitive. Defaults are `deu+eng` and automatic page rotation. OCRmyPDF
runs in skip mode, so pages that already contain text are preserved. Automatic
rotation also requires Tesseract's `osd` orientation data. The
destination has the same no-clobber and explicit `--overwrite` contract as
the other file-producing commands.

### `capabilities`

Probes qpdf, Ghostscript, OCRmyPDF, Tesseract, and installed Tesseract
languages without modifying files. Missing optional tools are reported as
`available: false`; cancellation and timeout remain command failures.

## Profiles

- `conservative`
- `balanced`
- `aggressive`

## JSON Output

When `--json` is set, stdout is reserved for exactly one JSON object.
Human-readable progress and warnings belong on stderr; with `--json`, stderr
stays empty and diagnostics travel inside the JSON payload.

Successful output includes `ok: true` plus the command payload:

- `compress`: `status`, `inputPath`, `outputPath`, `profile`,
  `originalBytes`, `outputBytes`, `reductionBytes`, `reductionPercent`,
  `outputSmaller`, `engine`, `warnings`.
- `inspect`: `status`, `qpdfVersion`, `sources` (see above).
- `assemble`: `status`, `outputPath`, `pageCount`, `outputBytes`, `engine`,
  `qpdfVersion`, `ghostscriptVersion` (when used), `warnings`,
  `compatWarnings`, `sourceHashes`, and `ocr` metadata when OCR is selected.
- `ocr`: `status`, input/output paths, output size, OCRmyPDF and Tesseract
  versions, languages, rotation choice, and warnings.
- `capabilities`: independent availability/version entries for qpdf,
  Ghostscript, OCRmyPDF, and Tesseract plus installed OCR languages.

Failures include:

- `ok`
- `code`
- `message`

## Error Codes

Machine-readable `code` values come from the shared core (`CompressionError`
codes plus the browser-safe manifest codes mapped to `MANIFEST_INVALID`,
`MANIFEST_INVALID_PAGE`, or `MANIFEST_INVALID_ROTATION`):

- Validation: `INPUT_*`, `OUTPUT_*`, `MANIFEST_*`, `OCR_LANGUAGE_UNAVAILABLE`,
  `OCR_OPTIONS_INVALID` (unknown source, duplicate
  source, bad page, bad rotation, empty manifest, existing output, encrypted,
  signed, or active-content inputs).
- Native/engine: `ENGINE_*`, `INSPECTION_INCOMPLETE`,
  `NATIVE_VERSION_UNSUPPORTED`, `PUBLISH_FAILED`.

## Exit Codes

- `0`: success
- `2`: validation failure (`INPUT_*`, `OUTPUT_*`, `MANIFEST_*`,
  `OCR_LANGUAGE_UNAVAILABLE`, `OCR_OPTIONS_INVALID`)
- `3`: engine or native failure (`ENGINE_*`, `INSPECTION_INCOMPLETE`,
  `NATIVE_VERSION_UNSUPPORTED`, `PUBLISH_FAILED`)
- `4`: cancellation or timeout (`JOB_CANCELLED`, `JOB_TIMEOUT`)
- `64`: usage error
