/**
 * Pure coordinate conversion between PDF user space and screen space for the
 * fill surface (KTD13). User space is expressed in PDF points with its origin
 * at the crop box's lower-left corner before page rotation; screen space is
 * CSS pixels with the origin at the viewport's top-left corner.
 *
 * The transform mirrors `PageViewport` in the pinned pdfjs-dist release: the
 * page rotates about the centre of its view box and the vertical axis flips,
 * so overlay rectangles and placement drags land exactly where the renderer
 * draws them. Keeping the math pure lets tests pin rotation and non-zero
 * crop-box origins without a canvas.
 */

export interface PageGeometry {
  /** Page view box in unrotated user space: [x1, y1, x2, y2]. */
  readonly viewBox: readonly [number, number, number, number];
  /** Page rotation in degrees; must be a multiple of 90. */
  readonly rotation: number;
  /** CSS pixels per PDF point. */
  readonly scale: number;
}

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface UserRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ViewportTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** CSS pixel dimensions of the page viewport at this scale. */
export function viewportSize(geometry: PageGeometry): { width: number; height: number } {
  const transform = viewportTransform(geometry);
  return { width: transform.pageWidth, height: transform.pageHeight };
}

/**
 * The viewport transform for one page, matching pdf.js `PageViewport`:
 * screen.x = a*scale*x + c*scale*y + e and likewise for y.
 */
function viewportTransform(
  geometry: PageGeometry
): ViewportTransform & { pageWidth: number; pageHeight: number } {
  const [x1, y1, x2, y2] = geometry.viewBox;
  const rotation = normalizeRotation(geometry.rotation);
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;
  let a: number;
  let b: number;
  let c: number;
  let d: number;
  switch (rotation) {
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  let offsetX: number;
  let offsetY: number;
  let pageWidth: number;
  let pageHeight: number;
  if (a === 0) {
    offsetX = Math.abs(centerY - y1) * geometry.scale;
    offsetY = Math.abs(centerX - x1) * geometry.scale;
    pageWidth = (y2 - y1) * geometry.scale;
    pageHeight = (x2 - x1) * geometry.scale;
  } else {
    offsetX = Math.abs(centerX - x1) * geometry.scale;
    offsetY = Math.abs(centerY - y1) * geometry.scale;
    pageWidth = (x2 - x1) * geometry.scale;
    pageHeight = (y2 - y1) * geometry.scale;
  }
  return {
    a,
    b,
    c,
    d,
    e: offsetX - a * geometry.scale * centerX - c * geometry.scale * centerY,
    f: offsetY - b * geometry.scale * centerX - d * geometry.scale * centerY,
    pageWidth,
    pageHeight
  };
}

function normalizeRotation(rotation: number): number {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized % 90 !== 0) {
    throw new Error(`Page rotation ${rotation} is not a multiple of 90 degrees.`);
  }
  return normalized;
}

/** Collapse -0 so callers and tests compare coordinates cleanly. */
function clean(value: number): number {
  return value + 0;
}

/** Convert one user-space point to a screen-space point. */
export function userToScreen(
  geometry: PageGeometry,
  x: number,
  y: number
): { x: number; y: number } {
  const t = viewportTransform(geometry);
  return {
    x: clean(t.a * geometry.scale * x + t.c * geometry.scale * y + t.e),
    y: clean(t.b * geometry.scale * x + t.d * geometry.scale * y + t.f)
  };
}

/** Convert one screen-space point to a user-space point. */
export function screenToUser(
  geometry: PageGeometry,
  x: number,
  y: number
): { x: number; y: number } {
  const t = viewportTransform(geometry);
  const s = geometry.scale;
  const px = x - t.e;
  const py = y - t.f;
  const determinant = (t.a * t.d - t.b * t.c) * s * s;
  return {
    x: clean((t.d * s * px - t.c * s * py) / determinant),
    y: clean((-t.b * s * px + t.a * s * py) / determinant)
  };
}

/**
 * Convert a user-space rectangle (lower-left origin) to the screen-space
 * rectangle (top-left origin) that bounds it. Rotation and the Y flip can
 * swap or invert axes, so both corners are mapped and normalized.
 */
export function userRectToScreen(geometry: PageGeometry, rect: UserRect): ScreenRect {
  const first = userToScreen(geometry, rect.x, rect.y);
  const second = userToScreen(geometry, rect.x + rect.width, rect.y + rect.height);
  return {
    left: Math.min(first.x, second.x),
    top: Math.min(first.y, second.y),
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y)
  };
}

/** Convert a screen-space rectangle (top-left origin) back to user space. */
export function screenRectToUser(geometry: PageGeometry, rect: ScreenRect): UserRect {
  const first = screenToUser(geometry, rect.left, rect.top);
  const second = screenToUser(geometry, rect.left + rect.width, rect.top + rect.height);
  return {
    x: Math.min(first.x, second.x),
    y: Math.min(first.y, second.y),
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y)
  };
}
