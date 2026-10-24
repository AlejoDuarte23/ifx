type ScreenPoint = { x: number; y: number };

/** Drafting marks in screen pixels; endpoints have already been projected from fixed model positions. */
export function dimensionLayout(start: ScreenPoint, end: ScreenPoint, labelWidth: number, scale = 1) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 1e-6) return null;
  const dx = (end.x - start.x) / length, dy = (end.y - start.y) / length;
  const at = (p: ScreenPoint, along: number, across = 0) => ({ x: p.x + dx * along - dy * across, y: p.y + dy * along + dx * across });
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  // Keep the same layout at every zoom: no outward-arrow or raised-label mode.
  const gap = Math.min(labelWidth / 2 + 5 * scale, length * 0.4);
  const lines = [start, at(middle, -gap), at(middle, gap), end];
  const arrows = [start, end].map((tip, index) => {
    const along = (index === 0 ? 1 : -1) * Math.min(8 * scale, length * 0.2);
    return [tip, at(tip, along, Math.abs(along) * 0.275), at(tip, along, -Math.abs(along) * 0.275)];
  });
  const radians = angle * Math.PI / 180;
  const label = middle;
  // Bounds account for the rotated label, so grids and other labels avoid it.
  const bounds = { ...label, width: Math.abs(Math.cos(radians)) * labelWidth + Math.abs(Math.sin(radians)) * 16 * scale,
    height: Math.abs(Math.sin(radians)) * labelWidth + Math.abs(Math.cos(radians)) * 16 * scale };
  return { lines, arrows, angle, label, bounds };
}

export function dimensionWitness(from: ScreenPoint, to: ScreenPoint, scale = 1) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < 1) return null;
  const dx = (to.x - from.x) / length, dy = (to.y - from.y) / length;
  const gap = Math.min(4 * scale, length / 2);
  return { x1: from.x + dx * gap, y1: from.y + dy * gap, x2: to.x + dx * 5 * scale, y2: to.y + dy * 5 * scale };
}
