# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Form filling

### Form inventory

The authoritative description of every fillable target a document exposes, produced once and consumed identically by every surface so that a plan built by a person and a plan built by an agent describe the same things.

It is a join of two readings of the same document: one tool supplies the semantics (display name, field type, required and read-only flags, choice options, current value) and the other supplies the addressing and geometry. Where the two disagree, the semantic reading wins. A surface that cannot perform the join asks for the inventory rather than deriving a second one of its own.

### Form plan

The approval-bound description of what is to be written into a document, and the only path by which values from an agent reach one.

A plan carries its own source and destination bindings, the overwrite decision, the burn-in decision, a single-use nonce, and its entries. Because the destination and the overwrite decision live inside the plan, no command-line option can redirect an approval. Approval digests are taken over the plan's exact bytes rather than over a parsed object, so its serialization is canonical.

### Field

One logical fillable target in a document, addressed by its own identifier and owning the full set of widgets that draw it.

A field may be a non-terminal parent that groups other fields, in which case it is never directly fillable. A field may be marked computed, meaning it carries the document's own calculation or formatting actions; those actions never run here, so a computed field keeps whatever value is written into it. Fields marked as password or hidden are never proposed by an agent.

### Widget

The drawn instance of a field on a particular page, carrying its page number and its rectangle.

A field can own several widgets, including widgets on different pages, and writing a field means writing every widget it owns so that none is left showing a stale value. Field identifiers and widget identifiers are therefore distinct: one field, one identifier, many widgets each with their own.

### Document-derived text

Any string read out of a document — a field's display name, a tooltip, a choice option — treated as untrusted data rather than as instruction.

Such a string is stripped of control and format characters, capped in length without splitting a character, and explicitly marked as document-derived wherever it is emitted, so that a consumer cannot mistake it for text the project authored. The marking is part of the value, not a convention the reader is trusted to remember.

### Entry status

The state of a single entry in a form plan, distinguishing a question nobody has answered yet from one the person deliberately left alone.

An entry is unknown before anything is proposed, proposed once an agent has suggested a value, answered once a value is approved, and skipped once the person decides not to touch the field. Answered and skipped are terminal; unknown and proposed are not, and applying a plan is refused while any entry is non-terminal. The two terminal states differ at the write: answered writes its approved value to every widget of the field, and an empty answered value clears the field, while skipped writes nothing at all and leaves whatever the source held. Validation is idempotent and re-emits only the entries that are still outstanding.

### Burn-in

Turning filled values into ordinary page content so that no viewer treats them as editable form fields any more.

Burn-in is optional, because keeping fields editable is a legitimate outcome, and it is available afterwards as an operation of its own so that choosing to keep them editable is never a dead end. It is not reversible: once values are page content, the fields are gone.

## Document admission

### Active content

Anything in a document that can act rather than merely be displayed, which every operation classifies before touching the document.

Classification is an allowlist over action types rather than a list of forbidden strings, and it records not only what an action is but where it sits, because an action reachable only from a form field is a different risk from the same action reachable from the document as a whole. An enumeration that cannot be completed is a refusal, never an admission.

### Field-bound

Describes an action that is reachable only through the form field tree and not through the document at large.

The distinction is what lets filling accept an ordinary interactive form while every other operation still refuses it. Determining it requires ownership-aware traversal: a widget is reachable from the document root through the page tree and through the form dictionary, so a traversal that follows those edges would find every field action reachable from the root and conclude that nothing is field-bound.
