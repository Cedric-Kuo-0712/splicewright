export type Matrix2 = { a: number; b: number; c: number; d: number };
export type SampleGeometry = {
  point: { x: number; y: number };
  rect: { left: number; top: number; width: number; height: number };
  canvas: { width: number; height: number; clientWidth: number; clientHeight: number };
  fit: "contain" | "cover";
  transform: Matrix2;
};

/** Map a screen point through the item's transform and uniform preview zoom into source-canvas pixels. */
export function mapSamplePoint({ point, rect, canvas, fit, transform }: SampleGeometry, ancestorScale = 1) {
  if (!(ancestorScale > 0) || !canvas.width || !canvas.height || !canvas.clientWidth || !canvas.clientHeight) return null;
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return null;
  const dx = (point.x - (rect.left + rect.width / 2)) / ancestorScale;
  const dy = (point.y - (rect.top + rect.height / 2)) / ancestorScale;
  const x = (transform.d * dx - transform.c * dy) / determinant;
  const y = (-transform.b * dx + transform.a * dy) / determinant;
  const scale = (fit === "cover" ? Math.max : Math.min)(canvas.clientWidth / canvas.width, canvas.clientHeight / canvas.height);
  const offsetX = (canvas.clientWidth - canvas.width * scale) / 2;
  const offsetY = (canvas.clientHeight - canvas.height * scale) / 2;
  const pixelX = Math.floor((x + canvas.clientWidth / 2 - offsetX) / scale);
  const pixelY = Math.floor((y + canvas.clientHeight / 2 - offsetY) / scale);
  return pixelX < 0 || pixelY < 0 || pixelX >= canvas.width || pixelY >= canvas.height ? null : { x: pixelX, y: pixelY };
}

export function multiplyMatrix(outer: Matrix2, inner: Matrix2): Matrix2 {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
  };
}

/** WebGL readPixels returns premultiplied RGB; 2D getImageData returns straight RGB. */
export function sampledRgb(rgba: ArrayLike<number>, premultiplied: boolean): [number, number, number] | null {
  const alpha = rgba[3] ?? 0;
  if (alpha <= 0) return null;
  const scale = premultiplied ? 255 / alpha : 1;
  return [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round((rgba[i] ?? 0) * scale)))) as [number, number, number];
}
