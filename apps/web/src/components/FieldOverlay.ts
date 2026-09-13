/**
 * Ordinary HTML inputs positioned over the page canvas from the inventory's
 * widget rectangles (KTD11). Inputs own their DOM value between rebuilds so
 * typing never triggers a re-render; the model is the only place a keystroke
 * goes, and no fetch or worker call happens per keystroke.
 */

import type { FormFieldEntry } from "@pdf-compressor/core/form-inventory";
import { userRectToScreen, type PageGeometry } from "../form/geometry.js";
import { onValue, radioValue, type FieldState } from "../form/model.js";

export interface FieldOverlayCallbacks {
  onTextInput(fieldId: string, value: string): void;
  onToggleCheckbox(fieldId: string): void;
  onChooseOption(fieldId: string, value: string): void;
  onFieldFocus(fieldId: string | null): void;
}

export interface FieldOverlayHandle {
  readonly element: HTMLElement;
  /** Rebuild inputs for the fields whose widgets land on the given page. */
  update(input: {
    fields: readonly FormFieldEntry[];
    geometry: PageGeometry;
    page: number;
    values: Readonly<Record<string, FieldState>>;
  }): void;
  /** Focus the input for a field on the current page; false when absent. */
  focusField(fieldId: string): boolean;
}

function displayValue(value: string): string {
  return value === "Off" ? "" : value;
}

function buildInput(
  field: FormFieldEntry,
  widgetIndex: number,
  value: FieldState | undefined,
  callbacks: FieldOverlayCallbacks
): HTMLElement | null {
  const wrap = document.createElement("div");
  wrap.className = "field-box";
  if (field.computed) wrap.classList.add("field-box--computed");
  if (field.hidden) return null;

  const current = displayValue(value?.value ?? "");
  switch (field.type) {
    case "text": {
      const input = field.multiline
        ? document.createElement("textarea")
        : document.createElement("input");
      if (input instanceof HTMLInputElement) input.type = field.password ? "password" : "text";
      input.value = current;
      if (field.maxLength !== undefined) input.maxLength = field.maxLength;
      input.disabled = field.readOnly;
      input.setAttribute("aria-label", field.label?.text.text ?? field.fieldId);
      input.addEventListener("input", () => callbacks.onTextInput(field.fieldId, input.value));
      input.addEventListener("focus", () => callbacks.onFieldFocus(field.fieldId));
      input.addEventListener("blur", () => callbacks.onFieldFocus(null));
      wrap.append(input);
      break;
    }
    case "checkbox": {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value?.value === onValue(field);
      input.disabled = field.readOnly;
      input.setAttribute("aria-label", field.label?.text.text ?? field.fieldId);
      input.addEventListener("change", () => callbacks.onToggleCheckbox(field.fieldId));
      input.addEventListener("focus", () => callbacks.onFieldFocus(field.fieldId));
      input.addEventListener("blur", () => callbacks.onFieldFocus(null));
      wrap.append(input);
      break;
    }
    case "radio": {
      const input = document.createElement("input");
      input.type = "radio";
      input.name = field.fieldId;
      const option = radioValue(field, widgetIndex);
      input.checked = value?.value === option;
      input.disabled = field.readOnly;
      input.setAttribute("aria-label", `${field.label?.text.text ?? field.fieldId} ${option}`);
      input.addEventListener("change", () => callbacks.onChooseOption(field.fieldId, option));
      input.addEventListener("focus", () => callbacks.onFieldFocus(field.fieldId));
      input.addEventListener("blur", () => callbacks.onFieldFocus(null));
      wrap.append(input);
      break;
    }
    case "choice": {
      const select = document.createElement("select");
      for (const option of field.allowedValues ?? []) {
        const node = document.createElement("option");
        node.value = option.text;
        node.textContent = option.text;
        select.append(node);
      }
      select.value = current;
      select.disabled = field.readOnly;
      select.setAttribute("aria-label", field.label?.text.text ?? field.fieldId);
      select.addEventListener("change", () => callbacks.onChooseOption(field.fieldId, select.value));
      select.addEventListener("focus", () => callbacks.onFieldFocus(field.fieldId));
      select.addEventListener("blur", () => callbacks.onFieldFocus(null));
      wrap.append(select);
      break;
    }
    default: {
      // Signature fields, groups and other non-fillable entries render as a
      // dashed marker so the person still sees where they sit.
      wrap.classList.add("field-box--marker");
      wrap.textContent = field.type === "signature" ? "Signature field" : "";
      break;
    }
  }
  return wrap;
}

export function createFieldOverlay(callbacks: FieldOverlayCallbacks): FieldOverlayHandle {
  const element = document.createElement("div");
  element.className = "overlay-layer";
  const inputs = new Map<string, HTMLElement[]>();
  let currentPage = -1;

  return {
    element,
    update(input) {
      element.replaceChildren();
      inputs.clear();
      currentPage = input.page;
      for (const field of input.fields) {
        field.widgets.forEach((widget, index) => {
          if (widget.page !== input.page) return;
          const node = buildInput(field, index, input.values[field.fieldId], callbacks);
          if (!node) return;
          const rect = userRectToScreen(input.geometry, widget.rect);
          node.style.left = `${rect.left}px`;
          node.style.top = `${rect.top}px`;
          node.style.width = `${rect.width}px`;
          node.style.height = `${rect.height}px`;
          node.dataset.fieldId = field.fieldId;
          element.append(node);
          const list = inputs.get(field.fieldId) ?? [];
          list.push(node);
          inputs.set(field.fieldId, list);
        });
      }
    },
    focusField(fieldId) {
      if (currentPage < 0) return false;
      const target = inputs.get(fieldId)?.[0]?.querySelector("input, textarea, select");
      if (target instanceof HTMLElement) {
        target.focus();
        return true;
      }
      return false;
    }
  };
}
