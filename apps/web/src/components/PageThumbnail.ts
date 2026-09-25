export interface ThumbnailCallbacks {
  onMove(index: number, direction: -1 | 1): void;
  onRotate(index: number): void;
  onDelete(index: number): void;
  onToggleSelect(index: number, selected: boolean): void;
  onFocus(index: number): void;
}

export interface ThumbnailData {
  index: number;
  sourceName: string;
  pageNumber: number;
  rotation: number;
  selected: boolean;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
}

export interface ThumbnailHandle {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  update(data: ThumbnailData): void;
}

/**
 * One page card: canvas thumbnail, selection checkbox, and pointer plus
 * keyboard-accessible move/rotate/delete controls (native buttons, so tab,
 * enter, and space work without a drag-and-drop dependency).
 */
export function createPageThumbnail(data: ThumbnailData, callbacks: ThumbnailCallbacks): ThumbnailHandle {
  const card = document.createElement("li");
  card.className = "thumb";
  card.setAttribute("role", "listitem");

  const label = document.createElement("label");
  label.className = "thumb__select";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = data.selected;
  checkbox.disabled = data.disabled;
  checkbox.setAttribute("aria-label", `Select page ${data.index + 1}`);
  checkbox.addEventListener("change", () => {
    callbacks.onToggleSelect(data.index, checkbox.checked);
  });
  checkbox.addEventListener("focus", () => {
    callbacks.onFocus(data.index);
  });

  const caption = document.createElement("span");
  caption.className = "thumb__caption";

  label.append(checkbox, caption);

  const canvas = document.createElement("canvas");
  canvas.className = "thumb__canvas";
  canvas.setAttribute("role", "img");

  const rotationNote = document.createElement("p");
  rotationNote.className = "thumb__rotation";

  const controls = document.createElement("div");
  controls.className = "thumb__controls";

  const moveLeft = document.createElement("button");
  moveLeft.type = "button";
  moveLeft.textContent = "←";
  moveLeft.title = "Move earlier";
  moveLeft.setAttribute("aria-label", `Move page ${data.index + 1} earlier`);
  moveLeft.addEventListener("click", () => callbacks.onMove(data.index, -1));

  const moveRight = document.createElement("button");
  moveRight.type = "button";
  moveRight.textContent = "→";
  moveRight.title = "Move later";
  moveRight.setAttribute("aria-label", `Move page ${data.index + 1} later`);
  moveRight.addEventListener("click", () => callbacks.onMove(data.index, 1));

  const rotate = document.createElement("button");
  rotate.type = "button";
  rotate.textContent = "⟳";
  rotate.title = "Rotate 90° clockwise";
  rotate.setAttribute("aria-label", `Rotate page ${data.index + 1} clockwise`);
  rotate.addEventListener("click", () => callbacks.onRotate(data.index));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "✕";
  remove.title = "Delete page";
  remove.setAttribute("aria-label", `Delete page ${data.index + 1}`);
  remove.addEventListener("click", () => callbacks.onDelete(data.index));

  controls.append(moveLeft, moveRight, rotate, remove);
  card.append(label, canvas, rotationNote, controls);

  function render(next: ThumbnailData): void {
    card.classList.toggle("thumb--selected", next.selected);
    card.classList.toggle("thumb--rot90", next.rotation === 90);
    card.classList.toggle("thumb--rot180", next.rotation === 180);
    card.classList.toggle("thumb--rot270", next.rotation === 270);
    const text = `${next.index + 1} · ${next.sourceName} · p${next.pageNumber}`;
    caption.textContent = text;
    caption.title = text;
    canvas.setAttribute("aria-label", `Page ${next.index + 1} from ${next.sourceName}`);
    rotationNote.textContent = next.rotation === 0 ? "" : `Rotated ${next.rotation}° clockwise`;
    rotationNote.hidden = next.rotation === 0;
    checkbox.checked = next.selected;
    checkbox.disabled = next.disabled;
    checkbox.setAttribute("aria-label", `Select page ${next.index + 1}`);
    moveLeft.disabled = next.disabled || next.isFirst;
    moveRight.disabled = next.disabled || next.isLast;
    rotate.disabled = next.disabled;
    remove.disabled = next.disabled;
  }

  render(data);
  return { element: card, canvas, update: render };
}
