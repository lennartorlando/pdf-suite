# Benchmark Corpora

Deterministic, generated, redistributable synthetic PDFs. No private data.

- `corpus-20.pdf`, `corpus-100.pdf`, `corpus-500.pdf`: 20, 100, and 500
  pages. Each page has a distinct MediaBox width and marker label so page
  order survives assembly checks.
- `form-100.pdf`: 100 text fields across 4 pages (SC5 form-fill corpus).
- `form-200.pdf`: 200 fields across 8 pages; every tenth field is a
  checkbox.
- `form-8page-2mb.pdf`: 8 pages, ~2 MiB deterministic padding, fields and
  checkboxes (cold-open corpus).
- `scanned-form-icc.pdf`: one page carrying a CMYK image with an embedded
  ICCBased profile plus one text field; forces PDF.js onto its qcms
  WebAssembly path so the browser benchmark proves the production content
  policy admits it.
- Regenerate exactly:
  `node scripts/benchmark-page-editor.mjs --regen-corpora` and
  `node scripts/benchmark-form-filling.mjs --regen-corpora`.
- Measured results and environment metadata live in
  `docs/benchmarks/page-editor-baseline.json` and
  `docs/benchmarks/form-filling-baseline.json`. Raw repeated benchmark
  logs are not committed; only the baseline summaries are.
