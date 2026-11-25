// pdf.js setup + rendering helpers shared by the app and the exporter.
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { dispDims, deltaMatrix, drawAnnot, drawStamps, norm } from './annots.js';

const base = new URL('../', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('lib/pdfjs/pdf.worker.min.mjs', base).href;

const OPTS = {
  cMapUrl: new URL('lib/pdfjs/cmaps/', base).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('lib/pdfjs/standard_fonts/', base).href,
  wasmUrl: new URL('lib/pdfjs/wasm/', base).href,
  iccUrl: new URL('lib/pdfjs/iccs/', base).href,
  isEvalSupported: false,
};

export { pdfjsLib };

// pdf.js takes ownership of the buffer, so always pass a copy.
export function openPdfjs(bytes, password) {
  return pdfjsLib.getDocument({ ...OPTS, data: bytes.slice(), password }).promise;
}

export const totalRot = (p) => norm((p.baseRot || 0) + (p.rot || 0));

// Render a page (without annotations) at `scale` px per point. Returns a canvas.
export async function renderBase(page, src, scale) {
  const r = totalRot(page);
  const [dw, dh] = dispDims(page.w, page.h, r);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(dw * scale));
  canvas.height = Math.max(1, Math.round(dh * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (src) {
    const pg = await src.doc.getPage(page.index + 1);
    const vp = pg.getViewport({ scale: canvas.width / dw, rotation: r });
    await pg.render({ canvasContext: ctx, canvas, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  }
  return canvas;
}

// Paint annotations (+ optional watermark/page numbers) onto ctx, where k = px per point.
export function paintAnnots(ctx, page, k, imgFor, stamps) {
  const r = totalRot(page);
  for (const a of page.annots) {
    const [w0, h0] = dispDims(page.w, page.h, a.r0);
    ctx.setTransform(new DOMMatrix().scale(k, k).multiply(deltaMatrix(r - a.r0, w0, h0)));
    drawAnnot(ctx, a, imgFor);
  }
  if (stamps) {
    const [dw, dh] = dispDims(page.w, page.h, r);
    ctx.setTransform(new DOMMatrix().scale(k, k));
    drawStamps(ctx, stamps.settings, stamps.n, stamps.total, dw, dh);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not read image'));
    img.src = src;
  });
}

export function dataUrlToBytes(url) {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function canvasToBytes(canvas, type = 'image/png', quality) {
  return new Promise((res) =>
    canvas.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), type, quality));
}

// Read any browser-decodable image file -> normalized {dataUrl, w, h, kind}
export async function readImageFile(file, maxDim = 2400) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    let w = img.naturalWidth, h = img.naturalHeight;
    const k = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const keepAlpha = /png|gif|webp|svg/.test(file.type);
    if (!keepAlpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    const kind = keepAlpha ? 'png' : 'jpg';
    return { dataUrl: c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.9), w, h, kind };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function toGray(canvas) {
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    p[i] = p[i + 1] = p[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
}

// pdf.js v6 closes documents through their loading task
export function closePdfjs(doc) {
  try {
    if (doc?.loadingTask?.destroy) doc.loadingTask.destroy();
    else if (doc?.destroy) doc.destroy();
  } catch { /* ignore */ }
}
