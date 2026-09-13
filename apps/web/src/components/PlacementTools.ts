/**
 * Free placements over the page canvas: text, checkmarks and drawn
 * signatures. Placements live in PDF user space (KTD13); the layer maps
 * them to screen rects for display and converts drags back through the same
 * geometry, so a rotated page or a shifted crop box needs no special case.
 */

import {
  screenToUser,
  userRectToScreen,
  type PageGeometry,
  type ScreenRect
} from "../form/geometry.js";
import type { Placement } from "../form/model.js";

export interface PlacementLayerCallbacks {
  /** Commit a moved placement's user-space origin once the drag ends. */
  onMove(id: string, x: number, y: number): void;
  onTextInput(id: string, text: string): void;
  onRemove(id: string): void;
  onSelect(id: string | null): void;
}

export interface PlacementLayerHandle {
  readonly element: HTMLElement;
  update(input: {
    placements: readonly Placement[];
    geometry: PageGeometry;
    page: number;
    selectedId: string | null;
  }): void;
}

/** Drawn signature preview: rect-local strokes scaled into the screen box. */
function signatureNode(placement: Placement, screen: ScreenRect): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${placement.rect.width} ${placement.rect.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.width = `${screen.width}px`;
  svg.style.height = `${screen.height}px`;
  for (const stroke of placement.strokes) {
    if (stroke.length < 4) continue;
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    const points: string[] = [];
    for (let i = 0; i + 1 < stroke.length; i += 2) {
      // Rect-local strokes are in user space (y up); SVG y runs downward.
      points.push(`${stroke[i]},${placement.rect.height - stroke[i + 1]}`);
    }
    polyline.setAttribute("points", points.join(" "));
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", "#1d3a8f");
    polyline.setAttribute("stroke-width", "2");
    polyline.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(polyline);
  }
  return svg;
}

export function createPlacementLayer(callbacks: PlacementLayerCallbacks): PlacementLayerHandle {
  const element = document.createElement("div");
  element.className = "placement-layer";
  let geometry: PageGeometry | null = null;
  let dragging: { id: string; grabX: number; grabY: number; node: HTMLElement } | null = null;
  const currentPlacements = new Map<string, Placement>();

  function layerPoint(event: PointerEvent): { x: number; y: number } {
    const box = element.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function beginDrag(event: PointerEvent, placement: Placement, node: HTMLElement): void {
    if (!geometry) return;
    const point = layerPoint(event);
    const user = screenToUser(geometry, point.x, point.y);
    dragging = { id: placement.id, grabX: user.x - placement.rect.x, grabY: user.y - placement.rect.y, node };
    node.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    callbacks.onSelect(placement.id);
  }

  element.addEventListener("pointermove", (event) => {
    if (!dragging || !geometry) return;
    const point = layerPoint(event);
    const user = screenToUser(geometry, point.x, point.y);
    const x = user.x - dragging.grabX;
    const y = user.y - dragging.grabY;
    const placement = currentPlacements.get(dragging.id);
    if (!placement) return;
    const screen = userRectToScreen(geometry, { ...placement.rect, x, y });
    dragging.node.style.left = `${screen.left}px`;
    dragging.node.style.top = `${screen.top}px`;
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging || !geometry) return;
    const active = dragging;
    dragging = null;
    const point = layerPoint(event);
    const user = screenToUser(geometry, point.x, point.y);
    callbacks.onMove(active.id, user.x - active.grabX, user.y - active.grabY);
  };
  element.addEventListener("pointerup", endDrag);
  element.addEventListener("pointercancel", endDrag);

  return {
    element,
    update(input) {
      geometry = input.geometry;
      currentPlacements.clear();
      element.replaceChildren();
      for (const placement of input.placements) {
        if (placement.page !== input.page) continue;
        currentPlacements.set(placement.id, placement);
        const screen = userRectToScreen(input.geometry, placement.rect);
        const node = document.createElement("div");
        node.className = `placement placement--${placement.kind}`;
        node.style.left = `${screen.left}px`;
        node.style.top = `${screen.top}px`;
        node.style.width = `${screen.width}px`;
        node.style.height = `${screen.height}px`;
        node.dataset.placementId = placement.id;
        if (placement.id === input.selectedId) node.classList.add("placement--selected");

        if (placement.kind === "text") {
          const inputNode = document.createElement("input");
          inputNode.type = "text";
          inputNode.value = placement.text;
          inputNode.setAttribute("aria-label", "Placed text");
          inputNode.addEventListener("input", () => callbacks.onTextInput(placement.id, inputNode.value));
          node.append(inputNode);
        } else if (placement.kind === "checkmark") {
          node.textContent = "✓";
        } else {
          node.append(signatureNode(placement, screen));
        }

        node.addEventListener("pointerdown", (event) => {
          // A press on the text input edits; anywhere else on the box drags.
          if (event.target instanceof HTMLInputElement) {
            callbacks.onSelect(placement.id);
            return;
          }
          beginDrag(event, placement, node);
        });

        if (placement.id === input.selectedId) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "placement-remove";
          remove.textContent = "Remove";
          remove.addEventListener("click", () => callbacks.onRemove(placement.id));
          node.append(remove);
        }
        element.append(node);
      }
    }
  };
}

export interface SignaturePadHandle {
  readonly element: HTMLElement;
  /** Recorded strokes in pad user space (points, y up from the pad bottom). */
  strokes(): readonly (readonly number[])[];
  clear(): void;
  readonly isEmpty: () => boolean;
  destroy(): void;
}

/**
 * A fixed pad the person draws in; pointer points are recorded in the pad's
 * logical size (PDF points, origin bottom-left) so the result lands in the
 * plan's space no matter how the pad is scaled on screen.
 */
export function createSignaturePad(padWidth: number, padHeight: number): SignaturePadHandle {
  const element = document.createElement("div");
  element.className = "signature-pad";
  const canvas = document.createElement("canvas");
  canvas.className = "signature-pad__canvas";
  element.append(canvas);

  const strokes: number[][] = [];
  let active: number[] | null = null;
  let destroyed = false;

  const context = (): CanvasRenderingContext2D | null => {
    try {
      return canvas.getContext("2d");
    } catch {
      return null;
    }
  };

  function padPoint(event: PointerEvent): { x: number; y: number } {
    const box = canvas.getBoundingClientRect();
    const x = box.width > 0 ? ((event.clientX - box.left) / box.width) * padWidth : 0;
    const yTop = box.height > 0 ? ((event.clientY - box.top) / box.height) * padHeight : 0;
    return { x, y: padHeight - yTop };
  }

  function paint(): void {
    const ctx = context();
    if (!ctx) return;
    const scaleX = canvas.width / padWidth;
    const scaleY = canvas.height / padHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#1d3a8f";
    ctx.lineWidth = 2;
    for (const stroke of strokes) {
      if (stroke.length < 4) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0] * scaleX, (padHeight - stroke[1]) * scaleY);
      for (let i = 2; i + 1 < stroke.length; i += 2) {
        ctx.lineTo(stroke[i] * scaleX, (padHeight - stroke[i + 1]) * scaleY);
      }
      ctx.stroke();
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (destroyed) return;
    canvas.setPointerCapture?.(event.pointerId);
    const point = padPoint(event);
    active = [point.x, point.y];
    strokes.push(active);
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!active || destroyed) return;
    const point = padPoint(event);
    active.push(point.x, point.y);
    paint();
  });
  const finish = (): void => {
    active = null;
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  return {
    element,
    strokes: () => strokes.map((stroke) => [...stroke]),
    isEmpty: () => strokes.length === 0,
    clear() {
      strokes.length = 0;
      paint();
    },
    destroy() {
      destroyed = true;
      canvas.width = 0;
      canvas.height = 0;
    }
  };
}
