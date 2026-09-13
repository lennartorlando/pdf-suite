/**
 * Shared base for the browser-safe closed schemas.
 *
 * The page manifest, the form plan and the form inventory are parsed on both
 * sides of the loopback boundary, so their errors share one code-carrying
 * base class: the CLI exit-code mapper and the route status mapper match the
 * base rather than a growing list of error classes (KTD17). This module also
 * owns the few primitives every closed schema enforces identically, so the
 * rules cannot drift between modules. No Node imports: browser code loads
 * these modules directly.
 */

export class SchemaError<C extends string = string> extends Error {
  constructor(
    public readonly code: C,
    message: string
  ) {
    super(message);
    this.name = "SchemaError";
  }
}

/**
 * Control and format characters (Unicode categories Cc and Cf). Strings a
 * schema carries — values, locators, labels — may never contain them: values
 * are written into documents and rendered verbatim in the approval display,
 * and document-derived strings are shown to people and agents (R27, R35).
 */
export const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/gu;

const CONTROL_CHARACTER_TEST = /[\p{Cc}\p{Cf}]/u;

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTER_TEST.test(value);
}

/**
 * Fillable-target identifier: the canonical indirect reference "N G R" built
 * from the object number and generation of the field dictionary or widget
 * annotation (KTD5). Both inspection tools can produce it, so identifiers
 * round-trip between the two tools and between the two surfaces.
 */
export const OBJECT_REFERENCE_PATTERN = /^[0-9]{1,10} [0-9]{1,5} R$/;

export function isObjectReference(value: unknown): value is string {
  return typeof value === "string" && OBJECT_REFERENCE_PATTERN.test(value);
}

/**
 * Rectangle in PDF user space: x/y is the lower-left corner of the
 * rectangle, in points, in the space whose origin is the lower-left corner
 * of the page's crop box before any page rotation (KTD13).
 */
export interface PdfRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Length in Unicode code points, so caps never split a surrogate pair. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Container nesting depth of a JSON-shaped value; scalars contribute
 * nothing. A bare object or array has depth 1. Iterative with a visited set
 * so cyclic or deeply nested input terminates instead of overflowing.
 */
export function jsonDepth(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  let deepest = 0;
  const seen = new Set<unknown>();
  const stack: { node: object; depth: number }[] = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: object; depth: number };
    if (seen.has(node)) continue;
    seen.add(node);
    if (depth > deepest) deepest = depth;
    for (const child of Object.values(node)) {
      if (typeof child === "object" && child !== null) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return deepest;
}
