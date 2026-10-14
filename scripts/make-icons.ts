// Renders the app icons into public/icons with no dependencies: a shu (vermilion)
// seal with a white 学 drawn from its KanjiVG stroke paths. Each stroke is
// flattened to a polyline and stamped as anti-aliased round brush dots into a
// coverage buffer; the PNGs are encoded by hand with node:zlib.
//
//   node scripts/make-icons.ts
//
// Stroke data for 学 from KanjiVG, (C) Ulrich Apel, CC BY-SA 3.0
// (https://kanjivg.tagaini.net).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

type Rgb = readonly [number, number, number];
type Point = readonly [number, number];

const SHU: Rgb = [0xb3, 0x34, 0x1c];
const WHITE: Rgb = [0xff, 0xff, 0xff];

/** 学 (U+5B66), KanjiVG 109×109 box, in stroke order. */
const GAKU = [
  'M29.5,17.25c3.5,3,6.5,7.25,7.75,9.75',
  'M49,12c1.25,2,4.75,8.25,5.25,11.5',
  'M75,11c0.25,1.75-0.12,2.75-0.75,4.25c-1.29,3.1-4.25,7.38-6.5,9.75',
  'M21.25,33.75c-0.12,4.75-2,12.5-3.75,16.25',
  'M23.5,36.5c17-1.62,42.38-5.5,60-5.75c9.5-0.13,4.12,5.12,0,9',
  'M37.25,46.5c1,0.25,3.75,0.25,5.5-0.25s18.25-4,20-4s2.75,0.75,1,2.25S54.5,53.5,53,54.75',
  'M50.75,55.75c4,8.75,7.18,24.67,1.75,38c-2.75,6.75-7.75,1.25-9.75-2',
  'M15.75,67.75c1.75,1,4.64,1.36,7.5,1c15.88-2,44.43-6.25,61.37-5.5c2.5,0.11,4.72,0.25,6.39,1',
];

/** Brush width in KanjiVG units: bolder than KanjiVG's own 3 so the mark reads at 32 px. */
const STROKE_WIDTH = 7.5;

interface IconSpec {
  file: string;
  size: number;
  /** Corner radius as a fraction of the size; 0 = full-bleed square (the OS applies its own mask). */
  corner: number;
  /** Size of the inked glyph's longer side as a fraction of the icon. */
  glyph: number;
}

const ICONS: IconSpec[] = [
  { file: 'icon-192.png', size: 192, corner: 0.22, glyph: 0.6 },
  { file: 'icon-512.png', size: 512, corner: 0.22, glyph: 0.6 },
  // Maskable icons must keep the mark inside the central 80 % circle.
  { file: 'icon-maskable-512.png', size: 512, corner: 0, glyph: 0.48 },
  // iOS rounds the corners itself and shows transparency as black, so this one is opaque.
  { file: 'apple-touch-icon.png', size: 180, corner: 0, glyph: 0.58 },
];

// ---------------------------------------------------------------------------
// SVG path flattening (the subset of path syntax KanjiVG uses, plus the rest of
// the line/curve commands for safety).
// ---------------------------------------------------------------------------

const TOKEN_RE = /[MmLlHhVvCcSsQqTtZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };

/** Flattens a path into polylines (one per subpath) in path units. */
function flattenPath(d: string, tolerance = 0.25): Point[][] {
  const tokens = d.match(TOKEN_RE) ?? [];
  const lines: Point[][] = [];
  let current: Point[] = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  // Reflection points for the smooth S/T commands.
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let cmd = '';
  let i = 0;

  const num = () => Number(tokens[i++]);
  const curve = (pts: Point[]) => {
    // Subdivide by control-polygon length so long curves stay smooth.
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const steps = Math.max(2, Math.ceil(len / tolerance));
    for (let s = 1; s <= steps; s++) current.push(bezierPoint(pts, s / steps));
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error(`Path must start with a command: ${d}`);
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    if (upper === 'Z') {
      current.push([startX, startY]);
      x = startX; y = startY;
      lastCubic = lastQuad = null;
      continue;
    }
    if (i + ARG_COUNT[upper] > tokens.length) throw new Error(`Truncated path: ${d}`);
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (upper) {
      case 'M': {
        if (current.length > 1) lines.push(current);
        x = ox + num(); y = oy + num();
        startX = x; startY = y;
        current = [[x, y]];
        // Further coordinate pairs after a moveto are implicit linetos.
        cmd = rel ? 'l' : 'L';
        lastCubic = lastQuad = null;
        break;
      }
      case 'L': x = ox + num(); y = oy + num(); current.push([x, y]); lastCubic = lastQuad = null; break;
      case 'H': x = ox + num(); current.push([x, y]); lastCubic = lastQuad = null; break;
      case 'V': y = oy + num(); current.push([x, y]); lastCubic = lastQuad = null; break;
      case 'C': {
        const c1: Point = [ox + num(), oy + num()];
        const c2: Point = [ox + num(), oy + num()];
        const end: Point = [ox + num(), oy + num()];
        curve([[x, y], c1, c2, end]);
        lastCubic = c2; lastQuad = null;
        [x, y] = end;
        break;
      }
      case 'S': {
        const c1: Point = lastCubic ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]] : [x, y];
        const c2: Point = [ox + num(), oy + num()];
        const end: Point = [ox + num(), oy + num()];
        curve([[x, y], c1, c2, end]);
        lastCubic = c2; lastQuad = null;
        [x, y] = end;
        break;
      }
      case 'Q': {
        const c: Point = [ox + num(), oy + num()];
        const end: Point = [ox + num(), oy + num()];
        curve([[x, y], c, end]);
        lastQuad = c; lastCubic = null;
        [x, y] = end;
        break;
      }
      case 'T': {
        const c: Point = lastQuad ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]] : [x, y];
        const end: Point = [ox + num(), oy + num()];
        curve([[x, y], c, end]);
        lastQuad = c; lastCubic = null;
        [x, y] = end;
        break;
      }
      default:
        throw new Error(`Unsupported path command "${cmd}" in ${d}`);
    }
  }
  if (current.length > 1) lines.push(current);
  return lines;
}

/** De Casteljau evaluation for a quadratic or cubic Bézier. */
function bezierPoint(pts: Point[], t: number): Point {
  let level = pts.map((p) => [p[0], p[1]] as [number, number]);
  while (level.length > 1) {
    level = level.slice(1).map((p, k) => [
      level[k][0] + (p[0] - level[k][0]) * t,
      level[k][1] + (p[1] - level[k][1]) * t,
    ]);
  }
  return level[0];
}

// ---------------------------------------------------------------------------
// Rasterizing
// ---------------------------------------------------------------------------

interface Placement { scale: number; dx: number; dy: number }

/** Scales and centers the inked bounding box of the strokes (not the 109 box) in the icon. */
function placeGlyph(polylines: Point[][], size: number, glyphFraction: number): Placement {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of polylines) {
    for (const [px, py] of line) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  const half = STROKE_WIDTH / 2;
  minX -= half; minY -= half; maxX += half; maxY += half;
  const scale = (glyphFraction * size) / Math.max(maxX - minX, maxY - minY);
  return {
    scale,
    dx: size / 2 - ((minX + maxX) / 2) * scale,
    dy: size / 2 - ((minY + maxY) / 2) * scale,
  };
}

/** Coverage (0..1) of the strokes, stamped as round dots every quarter pixel. */
function strokeCoverage(polylines: Point[][], size: number, at: Placement): Float32Array {
  const cov = new Float32Array(size * size);
  const r = (STROKE_WIDTH / 2) * at.scale;
  const stamp = (cx: number, cy: number) => {
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(size - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(size - 1, Math.ceil(cy + r + 1));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // Distance from the pixel centre to the dot gives a one-pixel anti-aliased edge.
        const c = r + 0.5 - Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
        if (c <= 0) continue;
        const idx = py * size + px;
        // max() rather than summing, so overlapping dots don't build up a darker seam.
        cov[idx] = Math.max(cov[idx], Math.min(1, c));
      }
    }
  };
  for (const line of polylines) {
    const pts = line.map(([px, py]) => [px * at.scale + at.dx, py * at.scale + at.dy] as const);
    stamp(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1];
      const [bx, by] = pts[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.25));
      for (let s = 1; s <= steps; s++) stamp(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
    }
  }
  return cov;
}

/** Coverage of the rounded-square background via its signed distance field. */
function backgroundCoverage(px: number, py: number, size: number, radius: number): number {
  if (radius <= 0) return 1;
  const half = size / 2;
  const qx = Math.abs(px + 0.5 - half) - (half - radius);
  const qy = Math.abs(py + 0.5 - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const sd = outside + Math.min(Math.max(qx, qy), 0) - radius;
  return Math.max(0, Math.min(1, 0.5 - sd));
}

/** RGBA pixels, straight alpha. */
function renderIcon(spec: IconSpec, polylines: Point[][]): Uint8Array {
  const { size } = spec;
  const ink = strokeCoverage(polylines, size, placeGlyph(polylines, size, spec.glyph));
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = py * size + px;
      const a = backgroundCoverage(px, py, size, spec.corner * size);
      const t = ink[idx];
      for (let ch = 0; ch < 3; ch++) out[idx * 4 + ch] = Math.round(SHU[ch] + (WHITE[ch] - SHU[ch]) * t);
      out[idx * 4 + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes RGBA pixels; drops the alpha channel when the image is fully opaque. */
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  let opaque = true;
  for (let k = 3; k < rgba.length; k += 4) if (rgba[k] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none (deflate does well enough on flat-colour art)
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = row + 1 + x * channels;
      for (let ch = 0; ch < channels; ch++) raw[dst + ch] = rgba[src + ch];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: RGB or RGBA
  // compression, filter and interlace methods stay 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

function renderSvg(polylines: Point[][]): string {
  const size = 512;
  const at = placeGlyph(polylines, size, 0.6);
  const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`,
    `  <rect width="${size}" height="${size}" rx="${n(size * 0.22)}" fill="${hex(SHU)}"/>`,
    `  <g transform="translate(${n(at.dx)} ${n(at.dy)}) scale(${n(at.scale)})" fill="none" stroke="${hex(WHITE)}"`,
    `     stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">`,
    ...GAKU.map((d) => `    <path d="${d}"/>`),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });
const polylines = GAKU.flatMap((d) => flattenPath(d));

for (const spec of ICONS) {
  const png = encodePng(renderIcon(spec, polylines), spec.size, spec.size);
  writeFileSync(join(outDir, spec.file), png);
  console.log(`wrote public/icons/${spec.file} (${spec.size}×${spec.size}, ${png.length} bytes)`);
}
writeFileSync(join(outDir, 'icon.svg'), renderSvg(polylines));
console.log('wrote public/icons/icon.svg');
