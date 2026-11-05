"use strict";

const DEFAULT = { width: 400, height: 480, zoom: 1.25, pinned: true, autoOpen: true };
const ZOOMS = [1, 1.25, 1.5];
const SIZES = Object.freeze({
  standard: Object.freeze({ width: 400, height: 480 }),
  large: Object.freeze({ width: 520, height: 620 }),
  extra: Object.freeze({ width: 640, height: 760 }),
});

function valid(value) {
  if (!value || ![1, 2].includes(value.version)
    || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)
    || Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000) throw new Error("invalid-hud-layout");
  if (value.version === 2 && (!Number.isSafeInteger(value.width) || value.width < 320 || value.width > 1600
    || !Number.isSafeInteger(value.height) || value.height < 300 || value.height > 1200
    || typeof value.manual !== "boolean" || !ZOOMS.includes(value.zoom)
    || (value.pinned !== undefined && typeof value.pinned !== "boolean")
    || (value.autoOpen !== undefined && typeof value.autoOpen !== "boolean")
    || (value.sizeMode !== undefined && !["custom", ...Object.keys(SIZES)].includes(value.sizeMode))
    || (value.freeWidth !== undefined || value.freeHeight !== undefined)
      && (!Number.isSafeInteger(value.freeWidth) || value.freeWidth < 320 || value.freeWidth > 1600
        || !Number.isSafeInteger(value.freeHeight) || value.freeHeight < 300 || value.freeHeight > 1200)))
    throw new Error("invalid-hud-layout");
}
function sizeMode(value) {
  return value.sizeMode || Object.keys(SIZES).find(key => SIZES[key].width === value.width
    && SIZES[key].height === value.height) || "custom";
}
function read(value) {
  return value?.version === 2 ? { pinned: true, autoOpen: true, ...value } : value?.version === 1
    ? { version: 2, x: value.x, y: value.y, width: DEFAULT.width, height: DEFAULT.height,
      manual: true, zoom: DEFAULT.zoom, pinned: true, autoOpen: true }
    : { version: 2, x: 0, y: 0, ...DEFAULT, manual: false };
}
function clamp(bounds, area) {
  const width = Math.min(bounds.width, Math.max(320, area.width - 20));
  const height = Math.min(bounds.height, Math.max(300, area.height - 20));
  return { x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)), width, height };
}
function gripBounds(start, origin, cursor, area) {
  const maxWidth = Math.max(320, Math.min(1600, area.x + area.width - start.x));
  const maxHeight = Math.max(300, Math.min(1200, area.y + area.height - start.y));
  return { x: start.x, y: start.y,
    width: Math.max(320, Math.min(start.width + cursor.x - origin.x, maxWidth)),
    height: Math.max(300, Math.min(start.height + cursor.y - origin.y, maxHeight)) };
}
function intersects(a, b) {
  return !!b && a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}
function automatic(pet, area, size, other) {
  const w = size.width, h = size.height, gap = 10;
  const candidates = [
    { x: pet.x + pet.width + gap, y: pet.y },
    { x: pet.x - w - gap, y: pet.y },
    ...(other ? [
      { x: other.x + other.width + gap, y: other.y },
      { x: other.x - w - gap, y: other.y },
      { x: other.x, y: other.y + other.height + gap },
      { x: other.x, y: other.y - h - gap },
    ] : []),
  ];
  for (const point of candidates) {
    const bounds = { ...point, width: w, height: h };
    if (bounds.x >= area.x && bounds.y >= area.y
      && bounds.x + w <= area.x + area.width && bounds.y + h <= area.y + area.height
      && !intersects(bounds, other)) return bounds;
  }
  return clamp({ ...candidates[0], width: w, height: h }, area);
}
module.exports = { DEFAULT, ZOOMS, SIZES, valid, read, sizeMode, clamp, gripBounds, automatic };
