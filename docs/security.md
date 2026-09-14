# Security

## Local Trust Boundary

The local server binds to `127.0.0.1` by default. It is not intended to be exposed as a LAN or internet service.

Every API route enforces the literal loopback boundary and request
context (Host, Origin, fetch metadata) before body consumption. Every
route except token issuance requires a short-lived launch token bound to
its browser session; download handles are session-bound, leased to one
transfer, and consumed after the first completed download.

## File Handling

- The original input path is never overwritten; export always creates a
  new PDF and source hashes stay unchanged across all terminal states.
- Temporary job directories are isolated per job with fixed caps on
  uploads, outputs, pages, runtime, retained artifacts, and aggregate
  storage.
- Validation rejects non-PDF files, encrypted PDFs, signed PDFs, and
  active content (JavaScript, open/additional/launch actions,
  submit/import, rich media, embedded files) before any mutation on the
  compression and page-export paths.
- Form filling is narrower and more permissive by design: a document that
  opens with an empty password is decrypted first, field-bound actions are
  admissible and stripped from the delivered file, and catalog-scoped
  active content, XFA and modification signatures still refuse. Values
  reach a document only through an approved plan bound to a single-use
  receipt; the delivered output is unencrypted.
- Compression and page-export errors return local error codes rather than
  partial success; no partial output is downloadable.

## External Tools

The shared core calls local PDF tools through adapter modules with
argument arrays (no shell), closed stdin, a minimal environment, and
process-group termination.

- `qpdf` (>= 12.4.1, required) performs inspection and the single
  page-selection assembly mutation per export. Form filling is a separate
  pipeline with its own bounded passes: admission, appearance generation
  and rewrite, revision collapse, and strict validation.
- Ghostscript (>= 10.07.1, optional) creates post-assembly compression
  candidates that only win when smaller and valid.
- OCRmyPDF (>= 17.0.0, optional) and Tesseract add a searchable text layer.
  They run in the job's private working and temporary directory. Only `deu`
  and `eng` are accepted, and requested language data must be installed.

Versions below a declared floor fail closed. Native parsing still runs with
the user account's filesystem authority unless packaging adds OS
isolation; upstream parser/resource-exhaustion fixes are pending a later
release.

## Reporting Vulnerabilities

Please report security issues through GitHub Security Advisories when available, or by opening a minimal public issue that does not include private PDFs, document content, credentials, or exploit payloads.
