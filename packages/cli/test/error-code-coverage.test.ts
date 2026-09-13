import { describe, expect, it } from "vitest";
import { COMPRESSION_ERROR_CODES, CompressionError } from "@pdf-compressor/core";
import { FORM_PLAN_ERROR_CODES, FormPlanError, type FormPlanErrorCode } from "@pdf-compressor/core/form-plan";
import {
  FORM_INVENTORY_ERROR_CODES,
  FormInventoryError,
  type FormInventoryErrorCode
} from "@pdf-compressor/core/form-inventory";
import {
  PAGE_MANIFEST_ERROR_CODES,
  PageManifestError,
  type PageManifestErrorCode
} from "@pdf-compressor/core/page-manifest";
import { exitCodeByErrorCode, exitCodeFor, exitCodes } from "../src/output.js";
import { sanitizeExportError } from "../../../apps/local-server/src/routes/edit.js";

/**
 * KTD17: both error surfaces are keyed off the shared unions, so a code added
 * to the core without a mapping fails here and at typecheck — neither surface
 * may fall through to a generic bucket.
 */
describe("error code coverage (KTD17)", () => {
  it("maps every core error code to an explicit, non-default exit class", () => {
    expect(Object.keys(exitCodeByErrorCode).sort()).toEqual([...COMPRESSION_ERROR_CODES].sort());
    for (const code of COMPRESSION_ERROR_CODES) {
      const error = new CompressionError(code, "coverage probe");
      expect(exitCodeFor(error)).toBe(exitCodeByErrorCode[code]);
      expect(exitCodeFor(error)).not.toBe(exitCodes.usage);
    }
  });

  it("maps every core error code to a route status that keeps its code", () => {
    for (const code of COMPRESSION_ERROR_CODES) {
      const mapped = sanitizeExportError(new CompressionError(code, "coverage probe"));
      expect(mapped.code).toBe(code);
      expect(mapped.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("maps every schema error code to a validation exit and a 400 route status", () => {
    const families: readonly { codes: readonly string[]; make: (code: string) => Error }[] = [
      { codes: FORM_PLAN_ERROR_CODES, make: (code) => new FormPlanError(code as FormPlanErrorCode, "probe") },
      {
        codes: FORM_INVENTORY_ERROR_CODES,
        make: (code) => new FormInventoryError(code as FormInventoryErrorCode, "probe")
      },
      {
        codes: PAGE_MANIFEST_ERROR_CODES,
        make: (code) => new PageManifestError(code as PageManifestErrorCode, "probe")
      }
    ];
    for (const { codes, make } of families) {
      for (const code of codes) {
        const error = make(code);
        expect(exitCodeFor(error)).toBe(exitCodes.validationFailure);
        expect(sanitizeExportError(error)).toEqual({ status: 400, code });
      }
    }
  });
});
