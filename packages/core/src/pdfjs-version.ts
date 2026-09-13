/**
 * Browser-safe PDF.js renderer pin (no Node imports).
 *
 * Single source of truth for the exact `pdfjs-dist` release shared by the
 * Node fill child, the browser preview and the lazy fill renderer. The
 * `check-native-versions` gate asserts this constant, both package manifests
 * and the installed package agree, so the pin cannot drift between the two
 * consumers or silently float with a lockfile update.
 */
export const PDFJS_PINNED_VERSION = "6.3.289";
