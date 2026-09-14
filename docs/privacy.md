# Privacy

PDF Compressor is local-first.

## Default Data Flow

- The web app talks to a loopback server on the same machine.
- PDF bytes are sent to that local server only.
- No default cloud upload, telemetry endpoint, account system, or third-party document storage exists.
- The CLI reads local files and writes local output paths supplied by the user or agent.

## Temporary Files

Compression, page-export, OCR, and form-fill jobs use isolated temporary directories.

- The local server streams each uploaded source once into a private
  per-job workspace and never buffers complete multipart uploads in memory.
- The shared core creates its own per-job workspace for intermediate output.
- OCRmyPDF and Tesseract receive a private working directory and `TMPDIR`;
  OCR text and intermediate images stay inside the server-owned job directory,
  count toward its live storage limits, and are deleted with that workspace.
- Source input files written by the local server are removed after every
  terminal state; only the validated output is retained.
- A session-bound output survives interrupted downloads for one retry but
  is consumed after the first completed download, explicit discard, or a
  short TTL (10 minutes). Cancelled and failed jobs remove their workspace.

## Form-Fill Artifacts

The fill loop's durable state holds the values a person approved, so it is
treated as personal data:

- The plan file, its `.receipt.json` approval receipt, its `.audit.json`
  record, and the decrypted working copy inside a job workspace are written
  owner-readable only (mode 0600).
- `pdf-compressor forms clean <plan.json>` removes the plan, receipt and
  audit files; the per-user nonce ledger under
  `~/.pdf-compressor/fill-ledger` is deliberately kept so a spent approval
  stays spent.
- Command output digests field values by default; `--reveal-values` opts
  back into verbatim values.
- A form document that opens with an empty password is decrypted for
  filling and the filled output is delivered unencrypted.

## What Is Not Collected

- No document content leaves the machine by default.
- No PDF metadata is retained in app storage after a job.
- No analytics or telemetry library is configured.
- No account identifier, email address, or user profile is required.

## Known Limits

- Native PDF tools such as `qpdf` (>= 12.4.1, required for page export)
  or Ghostscript (>= 10.07.1, optional for compression), and OCRmyPDF >= 17
  with the selected Tesseract languages (optional for OCR), must be installed
  on the user's machine until binary distribution is decided.
- Compression and page export reject password-protected, signed, and
  active-content PDFs rather than decrypting, repairing, or sanitizing
  them. Form filling admits a document that opens with an empty password
  (it is decrypted and delivered unencrypted) and strips field-level
  actions from the delivered file; catalog-scoped active content, XFA and
  modification-signed documents stay refused everywhere.
- Page assembly preserves form fields and their values (verified against
  the supported qpdf floor); bookmarks, tags, and custom page labels may
  not survive and surface as compatibility warnings.
- Desktop packaging is deferred.
