# Contributing

Thanks for helping build PDF Compressor.

## Scope

The app covers local PDF compression, page-level editing (preview,
reorder, rotate, delete, merge, selection export), local OCR, and form
filling and signing (fields, text, checkmarks, drawn signatures) through
the shared core.

Please keep issues and pull requests aligned with:

- local web app compression, page-editing, and form-filling flows
- shared compression, page-assembly, and fill core
- CLI support for agents and automation (`compress`, `inspect`,
  `assemble`, `ocr`, `forms`)
- privacy, security, and license clarity

Content editing, redaction, cryptographic signing, persistent projects,
desktop packaging, and cloud features are deferred.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Test Fixtures

Use synthetic or explicitly redistributable PDFs only. Do not commit private documents.
