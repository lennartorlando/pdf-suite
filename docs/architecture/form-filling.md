# Architecture: PDF Form Filling and Signing

Fill a document's existing form fields and place text, checkmarks and a
drawn signature on pages that have none, by hand in the browser or through
an agent whose values reach a document only through a plan the person
approved. Annotating, correcting body text and cryptographic signing remain
out of scope.

## Contracts

- Browser-safe schemas: `@pdf-compressor/core/form-inventory` and
  `@pdf-compressor/core/form-plan` (closed parsers, version constants,
  opaque source/destination bindings, placement rectangles in PDF user
  space: points, crop-box origin, pre-rotation). Every string read out of a
  document is a `DocumentText`: capped, control-character-stripped and
  marked `documentDerived`.
- Node core: `inventoryFormFields`, `checkFormPlan`, `fillForm`,
  `verifyFormFill` and `burnInForm` in `packages/core/src/forms.ts`.
- CLI: the `forms` family (`fields`, `validate`, `apply`, `verify`,
  `clean`, `burn-in`), documented in
  [`cli-contract.md`](cli-contract.md).
- Server: `POST /api/forms/inventory` and `POST /api/forms/fill`
  (`apps/local-server/src/routes/fill.ts`), session-bound on the existing
  loopback boundary; the route rebinds the plan's opaque `upload`/`download`
  locators to job-private paths.
- Agent: `.claude/skills/fill-pdf/SKILL.md` encodes the inventory,
  interview, approval, apply and verify loop. This deliberately reverses
  the page-editing plan's decision to ship no prompts: the agent path is a
  first-class product path, and the skill improves quality only, because
  the command contract enforces every safety property on its own.

## Data flow

The inventory is a server-authoritative join: qpdf carries the semantics
(names, types, flags, options, values), the pinned PDF.js carries the
addressing and geometry (identifiers, rectangles, on-state names, limits),
and qpdf wins disagreements, so a plan built in the browser and a plan
built by an agent describe the same thing.

Values reach a document only through a plan file. `forms validate` checks
the plan against the source and re-emits the outstanding (non-terminal)
entries. Approval mints a receipt binding the plan nonce, the digests of
the exact plan and source bytes, and a bounded expiry; `forms apply`
snapshots those bytes, claims the nonce as one atomic exclusive create in
the fixed per-user ledger, then fills inside a bounded child process and
ends with a revision-collapsing qpdf rewrite, so no superseded value
survives into the delivered file. `forms verify` reads the artifact back
independently of the writer. The browser posts the same plan shape to the
loopback fill route, and approving a loaded plan in the fill surface mints
the same receipt over the derived plan and source bytes as a downloaded
file.

## Boundaries

- qpdf (>= 12.4.1) is required for filling; `pdfjs-dist` stays
  exact-pinned. The fill engine runs as a bounded child with a heap cap, a
  timeout, an output-size budget and process-group termination.
- Approval is tamper-evident, not tamper-proof: the receipt carries no
  secret, the executable search path is forwarded to child processes, and
  the ledger's only unremovable bound is the expiry window. The gate
  defends against an agent that errs or drifts, not against a hostile
  local process.
- Signing is reserved to the person: `validate` and `apply` refuse a plan
  carrying a signature placement (`FILL_SIGNATURE_FORBIDDEN`), and the
  browser surface drops signature entries from a loaded plan.
- Admission: every XFA document is refused (`INPUT_XFA`); a document that
  opens with an empty user password is decrypted first and delivered
  unencrypted; a signature field holding a value and any
  document-modification signature stay blocked. Field-bound actions are
  admissible for filling and stripped from the delivered file;
  catalog-scoped active content refuses everywhere.
- Compression refuses a document that carries form fields. `forms burn-in`
  flattens a filled interactive artifact afterwards, so keeping fields
  editable is never a dead end.
- Personal-data files: the plan, its `.receipt.json`, its `.audit.json`
  and the decrypted working copy are owner-readable only; `forms clean`
  removes the first three. The nonce ledger under
  `~/.pdf-compressor/fill-ledger` is never cleaned: a spent approval stays
  spent. Machine-readable output digests values unless the caller passes
  `--reveal-values`.

## Budgets and evidence

- Entry, placement, value, label and option caps live in
  `packages/core/src/form-plan.ts` and `form-inventory.ts`; the fill source
  and plan byte bounds (`FILL_MAX_*`) and the child's resource contract
  live in `packages/core/src/forms.ts`; server caps live in
  `apps/local-server/src/jobs.ts` (`LIMITS`), with fill output retained for
  thirty minutes.
- Bundle budgets SC1/SC2 are enforced by `scripts/check-editor-bundle.mjs`;
  the fill surface is a lazy chunk and its renderer WebAssembly modules are
  discovered into the lazy budget.
- Fill timing is measured by `scripts/benchmark-form-filling.mjs` into
  `docs/benchmarks/form-filling-baseline.json` (SC5: the 100-field core
  fill plus readback p95). Browser criteria (SC3 cold open, SC4 input
  latency, the scanned-page render under the production content policy)
  are measured by `scripts/benchmark-browser.mjs` into the same baseline's
  `browser` section. Both run on the shared harness of
  `scripts/benchmark-harness.mjs`; every recorded number carries the
  environment that produced it, and hosted-runner results use a separate
  regression budget that can never satisfy the reference-Mac criteria.
