export interface WindowRectangle { x: number, y: number, width: number, height: number }

export function restoreWindowBounds(bounds: WindowRectangle | undefined, workAreas: WindowRectangle[]) {
  if (bounds == null || workAreas.length === 0) return {};
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every((value) => Number.isFinite(value)) || bounds.width <= 0 || bounds.height <= 0) return {};
  const overlap = (area: WindowRectangle) => Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
    * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  const distance = (area: WindowRectangle) => Math.max(area.x - bounds.x, 0, bounds.x - (area.x + area.width)) ** 2
    + Math.max(area.y - bounds.y, 0, bounds.y - (area.y + area.height)) ** 2;
  const area = workAreas.reduce((best, candidate) => (overlap(candidate) > overlap(best)
    || (overlap(candidate) === overlap(best) && distance(candidate) < distance(best)) ? candidate : best));
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  };
}
