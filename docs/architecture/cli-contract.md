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
pdf-compressor forms fields <source.pdf> [--reveal-values] [--json]
pdf-compressor forms validate <plan.json> [--reveal-values] [--json]
pdf-compressor forms apply <plan.json> [--receipt <receipt.json>] [--json]
pdf-compressor forms verify <output.pdf> --plan <plan.json> [--reveal-values] [--json]
pdf-compressor forms clean <plan.json> [--receipt <path>] [--audit <path>] [--json]
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

### `forms`

The agent-facing surface of the form-fill loop. The plan file is the loop's
only durable state; values reach a document only through a plan a person
approved. Field values never appear on stdout by default: `fields` reports
`currentValueDigest` instead of `currentValue`, `validate` reports
`valueDigest`/`textDigest`, and `verify` reports `expectedDigest`/`actualDigest`.
`--reveal-values` opts each command back into verbatim values.

- `fields <source.pdf>` inventories the document's form fields through the
  shared core: stable `fieldId`s, full widget sets, field types, allowed
  values, the readonly/computed/password/hidden flags, and digested current
  values. A field with an opaque name and no tooltip carries no `label`.
- `validate <plan.json>` checks the plan against the document without
  mutating anything and re-emits the `outstanding` entries — the field
  entries still `unknown` or `proposed` — so the interview loop knows exactly
  what remains. It also reports the digests of the exact plan and source
  bytes an approval must bind. Every plan defect that is not "still awaiting
  an answer" refuses.
- `apply <plan.json>` runs an approved plan through the core fill. The
  contract is deliberately narrow: a plan path and an optional `--receipt`
  path. There is no option that influences what is written or where — the
  destination, the overwrite decision, the burn-in decision and every value
  live inside the approved plan. Apply snapshots the plan and source bytes,
  requires a receipt binding both digests plus the plan nonce and a live
  expiry, then claims the nonce in the fixed per-user ledger
  (`~/.pdf-compressor/fill-ledger`) as one atomic exclusive create before the
  write begins. Without a receipt the command mints one interactively after
  rendering every approved value, the resolved destination, the overwrite and
  burn-in decisions and the entry count; in a non-interactive context it
  refuses with `FILL_RECEIPT_REQUIRED`. A plan, receipt and audit record are
  written beside the plan file; the audit binds the digests, the receipt
  identifier, the approval channel, the resolved qpdf path and version, and
  the outcome.
- `verify <output.pdf> --plan <plan.json>` independently reads the delivered
  artifact back and proves every approved entry — field values and appearance
  states on interactive artifacts, burned-in page content otherwise. A
  mismatch fails with `FILL_VERIFY_MISMATCH` and per-entry digested
  expected/actual values.
- `clean <plan.json>` removes the plan, its derived receipt and its audit
  record (`--receipt`/`--audit` override the derived paths). The nonce ledger
  is deliberately not cleaned: a spent approval stays spent.

Signature placements are refused by both `validate` and `apply` with
`FILL_SIGNATURE_FORBIDDEN`: signing is reserved to the person.

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
- `forms fields`: `status`, `source`, `pageCount`, `qpdfVersion`, `warnings`,
  and the `inventory` (values digested unless `--reveal-values`).
- `forms validate`: `status`, `planDigest`, `sourceDigest`, `source`,
  `destination`, `overwrite`, `burnIn`, `nonce`, `entryCount`, `outstanding`,
  redacted `entries`, frozen `placements`, `pageCount`, `qpdfVersion`,
  `warnings`.
- `forms apply`: `status` plus the core fill summary (`outputPath`,
  `outputBytes`, `burnedIn`, `fieldsWritten`, `placementsWritten`,
  `sourceHash`, versions, warnings), `receipt`, and `audit` paths.
- `forms verify`: `status`, `outputPath`, per-entry `fields` and
  `placements` verdicts (digested unless `--reveal-values`), `warnings`.
- `forms clean`: `status`, `removed`, and `failed` paths when any.

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
  signed, or active-content inputs), and the fill refusals
  `FILL_INPUT_TOO_LARGE`, `FILL_PLAN_INCOMPLETE`, `FILL_PLAN_SOURCE_MISMATCH`,
  `FILL_UNKNOWN_FIELD`, `FILL_NOT_FILLABLE`, `FILL_VALUE_INVALID`,
  `FILL_SIGNATURE_FORBIDDEN`, `FILL_RECEIPT_REQUIRED`, `FILL_RECEIPT_INVALID`,
  `FILL_PLAN_CHANGED`, `FILL_SOURCE_CHANGED`, `FILL_RECEIPT_EXPIRED`,
  `FILL_RECEIPT_CONSUMED`, `FILL_VERIFY_MISMATCH`.
- Native/engine: `ENGINE_*`, `INSPECTION_INCOMPLETE`,
  `NATIVE_VERSION_UNSUPPORTED`, `PUBLISH_FAILED`, `FILL_CHILD_OUT_OF_MEMORY`,
  `FILL_APPEARANCE_MISSING`, `FILL_READBACK_FAILED`.
- Plan, inventory, and manifest schema errors carry their own codes
  (`PLAN_*`, `INVENTORY_*`, manifest codes) through the shared `SchemaError`
  base.

## Exit Codes

- `0`: success
- `2`: validation failure — the validation group above plus every
  `SchemaError` code
- `3`: engine or native failure — the native/engine group above
- `4`: cancellation or timeout (`JOB_CANCELLED`, `JOB_TIMEOUT`)
- `64`: usage error

Every core error code has one explicit row in the CLI's exit table and in the
local server's status mapper (KTD17); adding a code without a mapping fails
typecheck and the coverage test.
