// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  screenRectToUser,
  screenToUser,
  userRectToScreen,
  userToScreen,
  viewportSize,
  type PageGeometry
} from "../src/form/geometry.js";

/**
 * Expected values are verified against the pinned pdf.js `PageViewport`
 * (convertToPdfPoint) on a real document, including its Y flip and the
 * centre-of-view-box rotation.
 */

const A4: PageGeometry = {
  viewBox: [0, 0, 595.28, 841.89],
  rotation: 0,
  scale: 1
};

describe("form geometry: user to screen", () => {
  it("flips the Y axis on an unrotated page", () => {
    expect(viewportSize(A4)).toEqual({ width: 595.28, height: 841.89 });
    expect(userToScreen(A4, 0, 0)).toEqual({ x: 0, y: 841.89 });
    expect(userToScreen(A4, 0, 841.89)).toEqual({ x: 0, y: 0 });
    expect(userToScreen(A4, 595.28, 841.89)).toEqual({ x: 595.28, y: 0 });
    expect(userToScreen(A4, 595.28, 0)).toEqual({ x: 595.28, y: 841.89 });
  });

  it("scales by the CSS-pixel factor", () => {
    const zoomed: PageGeometry = { ...A4, scale: 2 };
    expect(viewportSize(zoomed)).toEqual({ width: 1190.56, height: 1683.78 });
    expect(userToScreen(zoomed, 0, 841.89)).toEqual({ x: 0, y: 0 });
    expect(userToScreen(zoomed, 100, 700)).toEqual({ x: 200, y: 283.78 });
  });

  it("rotates 90 degrees about the view-box centre", () => {
    const geo: PageGeometry = { ...A4, rotation: 90 };
    // Verified against pdf.js convertToPdfPoint on a rotated page:
    // screen(x,y) -> user(y,x).
    expect(viewportSize(geo).width).toBeCloseTo(841.89, 5);
    expect(viewportSize(geo).height).toBeCloseTo(595.28, 5);
    expect(screenToUser(geo, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(screenToUser(geo, 841.89, 0)).toEqual({ x: 0, y: 841.89 });
    expect(screenToUser(geo, 0, 595.28)).toEqual({ x: 595.28, y: 0 });
    expect(screenToUser(geo, 841.89, 595.28)).toEqual({ x: 595.28, y: 841.89 });
  });

  it("rotates 180 degrees about the view-box centre", () => {
    const geo: PageGeometry = { ...A4, rotation: 180 };
    expect(screenToUser(geo, 0, 0)).toEqual({ x: 595.28, y: 0 });
    expect(screenToUser(geo, 595.28, 841.89)).toEqual({ x: 0, y: 841.89 });
    expect(userToScreen(geo, 0, 0)).toEqual({ x: 595.28, y: 0 });
  });

  it("rotates 270 degrees about the view-box centre", () => {
    const geo: PageGeometry = { ...A4, rotation: 270 };
    expect(viewportSize(geo).width).toBeCloseTo(841.89, 5);
    expect(screenToUser(geo, 0, 0)).toEqual({ x: 595.28, y: 841.89 });
    expect(screenToUser(geo, 841.89, 595.28)).toEqual({ x: 0, y: 0 });
  });

  it("honours a non-zero crop-box origin", () => {
    const cropped: PageGeometry = {
      viewBox: [10, 20, 605.28, 861.89],
      rotation: 0,
      scale: 1
    };
    // The crop box's lower-left corner is the viewport's bottom-left.
    expect(viewportSize(cropped)).toEqual({ width: 595.28, height: 841.89 });
    expect(userToScreen(cropped, 10, 20)).toEqual({ x: 0, y: 841.89 });
    expect(userToScreen(cropped, 605.28, 861.89)).toEqual({ x: 595.28, y: 0 });
    expect(screenToUser(cropped, 0, 0)).toEqual({ x: 10, y: 861.89 });
    expect(screenToUser(cropped, 0, 841.89)).toEqual({ x: 10, y: 20 });
  });

  it("honours a non-zero crop-box origin on a rotated page", () => {
    const cropped: PageGeometry = {
      viewBox: [10, 20, 605.28, 861.89],
      rotation: 90,
      scale: 1
    };
    // screen(x,y) = (y - 20, x - 10) under the pinned viewport transform.
    expect(userToScreen(cropped, 10, 20)).toEqual({ x: 0, y: 0 });
    expect(userToScreen(cropped, 605.28, 20)).toEqual({ x: 0, y: 595.28 });
    expect(screenToUser(cropped, 0, 0)).toEqual({ x: 10, y: 20 });
    expect(screenToUser(cropped, 841.89, 595.28)).toEqual({ x: 605.28, y: 861.89 });
  });
});

describe("form geometry: rectangles", () => {
  it("maps a user-space rect to a top-left-origin screen rect", () => {
    // Widget rect in user space: lower-left at (50, 700), 120x20.
    const rect = userRectToScreen(A4, { x: 50, y: 700, width: 120, height: 20 });
    expect(rect.left).toBeCloseTo(50, 5);
    expect(rect.top).toBeCloseTo(121.89, 5);
    expect(rect.width).toBeCloseTo(120, 5);
    expect(rect.height).toBeCloseTo(20, 5);
  });

  it("normalizes rect corners across rotations", () => {
    const geo: PageGeometry = { ...A4, rotation: 90 };
    const rect = userRectToScreen(geo, { x: 50, y: 700, width: 120, height: 20 });
    // userToScreen maps (x,y) -> (y,x): the 120-wide rect becomes 120 tall.
    expect(rect.left).toBeCloseTo(700, 5);
    expect(rect.top).toBeCloseTo(50, 5);
    expect(rect.width).toBeCloseTo(20, 5);
    expect(rect.height).toBeCloseTo(120, 5);
  });

  it("round-trips a screen rect through user space", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const geo: PageGeometry = { ...A4, rotation };
      const screen = { left: 40, top: 60, width: 200, height: 30 };
      const user = screenRectToUser(geo, screen);
      const back = userRectToScreen(geo, user);
      expect(back.left).toBeCloseTo(screen.left, 5);
      expect(back.top).toBeCloseTo(screen.top, 5);
      expect(back.width).toBeCloseTo(screen.width, 5);
      expect(back.height).toBeCloseTo(screen.height, 5);
    }
  });

  it("rejects rotations that are not a multiple of 90", () => {
    const skewed: PageGeometry = { ...A4, rotation: 45 };
    expect(() => userToScreen(skewed, 0, 0)).toThrow(/multiple of 90/);
  });
});
