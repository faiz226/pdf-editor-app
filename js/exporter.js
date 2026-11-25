// Builds the final PDF with pdf-lib from the editor state.
import {
  FONTS, LH, BASE, bbox, textLines, toPdf, dispDims, drawAnnot, drawStamps,
  pageNumberText, pageNumberPos, fontCss,
} from './annots.js';
import {
  renderBase, paintAnnots, totalRot, loadImage, dataUrlToBytes, canvasToBytes, openPdfjs, closePdfjs, toGray,
} from './core.js';

const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;

export function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Render one annotation to a PNG (used for drawings, shapes, stamps, non-Latin text).
async function rasterAnnot(a, imgFor) {
  const b = bbox(a), pad = 2;
  const box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  const k = Math.min(4, 4096 / Math.max(box.w, box.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(box.w * k));
  c.height = Math.max(1, Math.ceil(box.h * k));
  const ctx = c.getContext('2d');
  ctx.scale(k, k);
  ctx.translate(-box.x, -box.y);
  drawAnnot(ctx, a, imgFor);
  return { bytes: await canvasToBytes(c), box };
}

/**
 * state: { sources, pages, images, settings }
 * opts.pages: subset/order of pages to export (defaults to all)
 */
export async function buildPdf(state, opts = {}) {
  const pages = opts.pages || state.pages;
  const progress = opts.onProgress || (() => {});
  const out = await PDFDocument.create();
  const fonts = new Map();
  const getFont = async (name) => {
    const key = (FONTS[name] || FONTS.Helvetica).std;
    if (!fonts.has(key)) fonts.set(key, await out.embedFont(StandardFonts[key]));
    return fonts.get(key);
  };

  // Preload every image used, so canvas rasterizing has them ready.
  const imgEls = new Map();
  for (const p of pages) for (const a of p.annots) {
    if (a.type === 'image' && !imgEls.has(a.img)) imgEls.set(a.img, await loadImage(state.images[a.img]));
  }
  const imgFor = (id) => imgEls.get(id);
  const embedded = new Map();
  const embedImage = async (id) => {
    if (!embedded.has(id)) {
      const url = state.images[id];
      const bytes = dataUrlToBytes(url);
      embedded.set(id, url.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes));
    }
    return embedded.get(id);
  };

  // Batch-copy pages per source so shared resources (fonts, images) are not duplicated.
  const srcById = new Map(state.sources.map((s) => [s.id, s]));
  const needs = new Map();
  for (const p of pages) {
    if (p.src == null || p.annots.some((a) => a.type === 'redact')) continue;
    if (!needs.has(p.src)) needs.set(p.src, new Set());
    needs.get(p.src).add(p.index);
  }
  const libs = new Map();
  const firstCopy = new Map(); // `${src}:${index}` -> PDFPage (unused yet)
  for (const [srcId, idxSet] of needs) {
    const lib = await PDFDocument.load(srcById.get(srcId).bytes, { updateMetadata: false });
    libs.set(srcId, lib);
    const idx = [...idxSet];
    const copied = await out.copyPages(lib, idx);
    idx.forEach((i, n) => firstCopy.set(`${srcId}:${i}`, copied[n]));
  }

  const total = pages.length;
  const start = state.settings.pageNumbers?.start ?? 1;

  for (let i = 0; i < pages.length; i++) {
    progress(i, total);
    const page = pages[i];
    const r = totalRot(page);
    const [dw, dh] = dispDims(page.w, page.h, r);
    let pdfPage, geo, rr;

    if (page.annots.some((a) => a.type === 'redact')) {
      // Secure redaction: flatten the whole page to an image so hidden content is removed.
      const canvas = await renderBase(page, srcById.get(page.src), 2.5);
      paintAnnots(canvas.getContext('2d'), page, canvas.width / dw, imgFor, null);
      const img = await out.embedJpg(await canvasToBytes(canvas, 'image/jpeg', 0.9));
      pdfPage = out.addPage([dw, dh]);
      pdfPage.drawImage(img, { x: 0, y: 0, width: dw, height: dh });
      geo = { w: dw, h: dh, ox: 0, oy: 0 };
      rr = 0;
    } else {
      if (page.src == null) {
        pdfPage = out.addPage([page.w, page.h]);
      } else {
        const key = `${page.src}:${page.index}`;
        pdfPage = firstCopy.get(key);
        if (pdfPage) firstCopy.delete(key);
        else [pdfPage] = await out.copyPages(libs.get(page.src), [page.index]); // duplicated page
        out.addPage(pdfPage);
      }
      pdfPage.setRotation(degrees(r));
      geo = { w: page.w, h: page.h, ox: page.ox || 0, oy: page.oy || 0 };
      rr = r;
      for (const a of page.annots) await drawAnnotPdf(pdfPage, geo, a, { getFont, embedImage, imgFor, out });
    }

    await drawStampsPdf(pdfPage, geo, rr, dw, dh, state.settings, i + start, total + start - 1, { getFont, out });
  }

  const m = state.settings.meta || {};
  if (m.title) out.setTitle(m.title);
  if (m.author) out.setAuthor(m.author);
  if (m.subject) out.setSubject(m.subject);
  if (m.keywords) out.setKeywords(m.keywords.split(',').map((s) => s.trim()).filter(Boolean));
  out.setProducer('PDF Editor (pdf-lib)');
  out.setCreator('PDF Editor');
  progress(total, total);
  return out.save({ useObjectStreams: true });
}

async function placeImage(pdfPage, geo, r0, img, box, opacity) {
  const p = toPdf(geo, r0, box.x, box.y + box.h);
  pdfPage.drawImage(img, { x: p.x, y: p.y, width: box.w, height: box.h, rotate: degrees(r0), opacity });
}

async function drawAnnotPdf(pdfPage, geo, a, ctx) {
  const { getFont, embedImage, imgFor, out } = ctx;
  if (a.type === 'text') {
    const font = await getFont(a.font);
    const lines = textLines(a);
    let vectorOk = true;
    try { lines.forEach((l) => font.widthOfTextAtSize(l, a.fontSize)); } catch { vectorOk = false; }
    if (vectorOk) {
      lines.forEach((l, i) => {
        if (!l) return;
        const p = toPdf(geo, a.r0, a.x, a.y + i * a.fontSize * LH + a.fontSize * BASE);
        pdfPage.drawText(l, { x: p.x, y: p.y, size: a.fontSize, font, color: hexToRgb(a.color), rotate: degrees(a.r0) });
      });
      return;
    }
  }
  if (a.type === 'image') {
    return placeImage(pdfPage, geo, a.r0, await embedImage(a.img), bbox(a));
  }
  if (a.type === 'box') {
    const p = toPdf(geo, a.r0, a.x, a.y + a.h);
    pdfPage.drawRectangle({ x: p.x, y: p.y, width: a.w, height: a.h, color: hexToRgb(a.fill || '#ffffff'), rotate: degrees(a.r0) });
    return;
  }
  // Everything else (pen, highlight, shapes, stamps, non-Latin text) -> high-res PNG
  const { bytes, box } = await rasterAnnot(a, imgFor);
  await placeImage(pdfPage, geo, a.r0, await out.embedPng(bytes), box);
}

async function drawStampsPdf(pdfPage, geo, r, dw, dh, settings, n, total, { getFont, out }) {
  const wm = settings.watermark;
  if (wm && wm.text) {
    const font = await getFont('Helvetica-Bold');
    const size = wm.size || 60;
    let tw = null;
    try { tw = font.widthOfTextAtSize(wm.text, size); } catch { tw = null; }
    if (tw != null) {
      const c = toPdf(geo, r, dw / 2, dh / 2);
      const th = ((r + (wm.angle ?? 45)) * Math.PI) / 180;
      const ox = -tw / 2, oy = -size * 0.35;
      pdfPage.drawText(wm.text, {
        x: c.x + ox * Math.cos(th) - oy * Math.sin(th),
        y: c.y + ox * Math.sin(th) + oy * Math.cos(th),
        size, font, color: hexToRgb(wm.color || '#888888'), opacity: wm.opacity ?? 0.2,
        rotate: degrees(r + (wm.angle ?? 45)),
      });
    } else {
      // Non-Latin watermark: raster the layer
      const k = 2, cv = document.createElement('canvas');
      cv.width = Math.ceil(dw * k); cv.height = Math.ceil(dh * k);
      const cx = cv.getContext('2d'); cx.scale(k, k);
      drawStamps(cx, { watermark: wm }, 0, 0, dw, dh);
      const img = await out.embedPng(await canvasToBytes(cv));
      await placeImage(pdfPage, geo, r, img, { x: 0, y: 0, w: dw, h: dh });
    }
  }
  const pn = settings.pageNumbers;
  if (pn) {
    const font = await getFont('Helvetica');
    const text = pageNumberText(pn, n, total);
    const size = pn.size || 11;
    try {
      const pos = pageNumberPos(pn, text, dw, dh, (t, s) => font.widthOfTextAtSize(t, s));
      const p = toPdf(geo, r, pos.u, pos.v);
      pdfPage.drawText(text, { x: p.x, y: p.y, size, font, color: hexToRgb(pn.color || '#111111'), rotate: degrees(r) });
    } catch {
      const fake = { type: 'text', text, font: 'Helvetica', fontSize: size, color: pn.color || '#111', r0: r, x: 0, y: 0 };
      const pos = pageNumberPos(pn, text, dw, dh, (t, s) => {
        const c = document.createElement('canvas').getContext('2d'); c.font = fontCss('Helvetica', s); return c.measureText(t).width;
      });
      fake.x = pos.u; fake.y = pos.v - size * BASE;
      const { bytes, box } = await rasterAnnot(fake);
      await placeImage(pdfPage, geo, r, await out.embedPng(bytes), box);
    }
  }
}

// Rasterize every page of a pdf.js document into a new image-only PDF.
export async function rasterizeDoc(doc, { dpi = 110, quality = 0.7, gray = false, onProgress } = {}) {
  const out = await PDFDocument.create();
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress && onProgress(i - 1, doc.numPages);
    const pg = await doc.getPage(i);
    const vp1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    if (gray) toGray(c);
    const img = await out.embedJpg(await canvasToBytes(c, 'image/jpeg', quality));
    const p = out.addPage([vp1.width, vp1.height]);
    p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    pg.cleanup();
  }
  return out.save();
}

export async function compressPdf(bytes, opts) {
  const doc = await openPdfjs(bytes);
  try { return await rasterizeDoc(doc, opts); } finally { closePdfjs(doc); }
}

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

// images: [{dataUrl, w, h}] -> PDF bytes
export async function imagesToPdf(images, { size = 'fit', margin = 0 } = {}) {
  const out = await PDFDocument.create();
  for (const im of images) {
    const bytes = dataUrlToBytes(im.dataUrl);
    const img = im.dataUrl.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    let pw, ph;
    if (size === 'fit') { pw = im.w * 0.75 + margin * 2; ph = im.h * 0.75 + margin * 2; }
    else {
      [pw, ph] = SIZES[size];
      if (im.w > im.h) [pw, ph] = [ph, pw];
    }
    const aw = pw - margin * 2, ah = ph - margin * 2;
    const k = Math.min(aw / im.w, ah / im.h);
    const w = im.w * k, h = im.h * k;
    const p = out.addPage([pw, ph]);
    p.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return out.save();
}
