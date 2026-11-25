// Annotation model: geometry, drawing, hit-testing, moving and resizing.
// Every annotation stores coordinates in PDF points, in the page orientation
// it was created in (a.r0 = total page rotation at creation time).

export const LH = 1.25;      // line height multiplier for text
export const BASE = 0.925;   // baseline offset (fraction of font size) inside a line box

export const FONTS = {
  'Helvetica':      { css: 'Helvetica, Arial, sans-serif', weight: 'normal', std: 'Helvetica', label: 'Sans' },
  'Helvetica-Bold': { css: 'Helvetica, Arial, sans-serif', weight: 'bold', std: 'HelveticaBold', label: 'Sans Bold' },
  'Times-Roman':    { css: '"Times New Roman", Times, serif', weight: 'normal', std: 'TimesRoman', label: 'Serif' },
  'Times-Bold':     { css: '"Times New Roman", Times, serif', weight: 'bold', std: 'TimesRomanBold', label: 'Serif Bold' },
  'Courier':        { css: '"Courier New", Courier, monospace', weight: 'normal', std: 'Courier', label: 'Mono' },
};

export const fontCss = (name, size) => {
  const f = FONTS[name] || FONTS.Helvetica;
  return `${f.weight} ${size}px ${f.css}`;
};

const mctx = document.createElement('canvas').getContext('2d');
export function measure(text, font, size) {
  mctx.font = fontCss(font, size);
  return mctx.measureText(text).width;
}

// ---------- rotation geometry ----------

export const norm = (r) => ((r % 360) + 360) % 360;
export const dispDims = (w, h, r) => (norm(r) % 180 === 0 ? [w, h] : [h, w]);

// Maps coordinates in a page displayed at rotation r0 to the same page displayed
// at rotation r0+delta. w0,h0 = display size at r0.
export function deltaMatrix(delta, w0, h0) {
  const m = new DOMMatrix();
  switch (norm(delta)) {
    case 90: return m.translate(h0, 0).rotate(90);
    case 180: return m.translate(w0, h0).rotate(180);
    case 270: return m.translate(0, w0).rotate(-90);
    default: return m;
  }
}

// Display point (u,v from top-left, points) at rotation r0 -> PDF user space.
export function toPdf(geo, r0, u, v) {
  const W = geo.w, H = geo.h;
  let x, y;
  switch (norm(r0)) {
    case 90: x = v; y = u; break;
    case 180: x = W - u; y = v; break;
    case 270: x = W - v; y = H - u; break;
    default: x = u; y = H - v;
  }
  return { x: x + (geo.ox || 0), y: y + (geo.oy || 0) };
}

// ---------- geometry of annotations ----------

export const textLines = (a) => String(a.text ?? '').split('\n');
const arrowHead = (a) => Math.max(8, a.width * 3.5);

export function bbox(a) {
  switch (a.type) {
    case 'text': {
      const lines = textLines(a);
      const w = Math.max(6, ...lines.map((l) => measure(l, a.font, a.fontSize)));
      return { x: a.x, y: a.y, w, h: lines.length * a.fontSize * LH };
    }
    case 'stamp': {
      const fs = a.fontSize, pad = fs * 0.45;
      const tw = measure(a.text, 'Helvetica-Bold', fs);
      return { x: a.x, y: a.y, w: tw + pad * 2, h: fs * 1.2 + pad * 2 };
    }
    case 'pen': {
      const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
      const hw = a.width / 2;
      const x = Math.min(...xs) - hw, y = Math.min(...ys) - hw;
      return { x, y, w: Math.max(...xs) + hw - x, h: Math.max(...ys) + hw - y };
    }
    case 'shape': {
      const ext = a.width / 2 + (a.kind === 'arrow' ? arrowHead(a) : 0);
      const x = Math.min(a.x1, a.x2) - ext, y = Math.min(a.y1, a.y2) - ext;
      return { x, y, w: Math.abs(a.x2 - a.x1) + ext * 2, h: Math.abs(a.y2 - a.y1) + ext * 2 };
    }
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

export function hit(a, x, y, tol = 4) {
  const b = bbox(a);
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}

export function move(a, dx, dy) {
  if (a.type === 'pen') a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
  else if (a.type === 'shape') { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; }
  else { a.x += dx; a.y += dy; }
}

// Resize "orig" (whose box was ob) so its box becomes nw x nh, anchored at top-left.
export function resized(orig, ob, nw, nh) {
  const a = structuredClone(orig);
  nw = Math.max(6, nw); nh = Math.max(6, nh);
  const sx = nw / ob.w, sy = nh / ob.h;
  const mapX = (x) => ob.x + (x - ob.x) * sx;
  const mapY = (y) => ob.y + (y - ob.y) * sy;
  switch (a.type) {
    case 'text': case 'stamp':
      a.fontSize = Math.max(4, Math.min(300, orig.fontSize * sx)); break;
    case 'image':
      a.w = orig.w * sx; a.h = orig.h * sx; break;
    case 'pen':
      a.points = orig.points.map(([x, y]) => [mapX(x), mapY(y)]); break;
    case 'shape':
      a.x1 = mapX(orig.x1); a.x2 = mapX(orig.x2); a.y1 = mapY(orig.y1); a.y2 = mapY(orig.y2); break;
    default:
      a.w = Math.max(4, orig.w + (nw - ob.w)); a.h = Math.max(4, orig.h + (nh - ob.h));
  }
  return a;
}

// ---------- drawing ----------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// imgFor(id) -> HTMLImageElement (may still be loading)
export function drawAnnot(ctx, a, imgFor) {
  ctx.save();
  switch (a.type) {
    case 'text': {
      ctx.fillStyle = a.color;
      ctx.font = fontCss(a.font, a.fontSize);
      ctx.textBaseline = 'alphabetic';
      textLines(a).forEach((l, i) => ctx.fillText(l, a.x, a.y + i * a.fontSize * LH + a.fontSize * BASE));
      break;
    }
    case 'stamp': {
      const b = bbox(a), fs = a.fontSize, lw = Math.max(1.5, fs * 0.12);
      ctx.strokeStyle = ctx.fillStyle = a.color;
      ctx.lineWidth = lw;
      roundRect(ctx, b.x + lw / 2, b.y + lw / 2, b.w - lw, b.h - lw, fs * 0.3);
      ctx.stroke();
      ctx.font = fontCss('Helvetica-Bold', fs);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.text, b.x + b.w / 2, b.y + b.h / 2 + fs * 0.05);
      break;
    }
    case 'pen': {
      ctx.globalAlpha = a.opacity ?? 1;
      if (a.hl) ctx.globalCompositeOperation = 'multiply';
      ctx.strokeStyle = ctx.fillStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = a.points;
      if (pts.length === 1) {
        ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], a.width / 2, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0], last[1]);
        ctx.stroke();
      }
      break;
    }
    case 'shape': {
      ctx.strokeStyle = ctx.fillStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      const w = Math.abs(a.x2 - a.x1), h = Math.abs(a.y2 - a.y1);
      if (a.kind === 'rect') {
        ctx.beginPath(); ctx.rect(x, y, w, h);
        if (a.fill) ctx.fill(); else ctx.stroke();
      } else if (a.kind === 'ellipse') {
        ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        if (a.fill) ctx.fill(); else ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
        if (a.kind === 'arrow') {
          const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), s = arrowHead(a);
          ctx.beginPath();
          ctx.moveTo(a.x2 + Math.cos(ang) * s * 0.3, a.y2 + Math.sin(ang) * s * 0.3);
          ctx.lineTo(a.x2 - Math.cos(ang - 0.45) * s, a.y2 - Math.sin(ang - 0.45) * s);
          ctx.lineTo(a.x2 - Math.cos(ang + 0.45) * s, a.y2 - Math.sin(ang + 0.45) * s);
          ctx.closePath(); ctx.fill();
        }
      }
      break;
    }
    case 'box':
      ctx.fillStyle = a.fill || '#ffffff';
      ctx.fillRect(a.x, a.y, a.w, a.h);
      break;
    case 'redact':
      ctx.fillStyle = '#000000';
      ctx.fillRect(a.x, a.y, a.w, a.h);
      break;
    case 'image': {
      const img = imgFor && imgFor(a.img);
      if (img && img.complete && img.naturalWidth) ctx.drawImage(img, a.x, a.y, a.w, a.h);
      else { ctx.strokeStyle = '#999'; ctx.setLineDash([4, 4]); ctx.strokeRect(a.x, a.y, a.w, a.h); }
      break;
    }
  }
  ctx.restore();
}

// ---------- page-wide stamps (watermark + page numbers) in display space ----------

export function pageNumberText(cfg, n, total) {
  return String(cfg.format || '{n}').replaceAll('{n}', n).replaceAll('{total}', total);
}

// Returns {u, v (baseline), tw} in display space for the page number label.
export function pageNumberPos(cfg, text, dw, dh, widthFn) {
  const fs = cfg.size || 11;
  const tw = widthFn(text, fs);
  const m = Math.max(18, fs * 1.6);
  const [vert, horiz] = (cfg.pos || 'bottom-center').split('-');
  const v = vert === 'top' ? m + fs * 0.8 : dh - m;
  const u = horiz === 'left' ? m : horiz === 'right' ? dw - m - tw : (dw - tw) / 2;
  return { u, v, tw };
}

export function drawStamps(ctx, settings, n, total, dw, dh) {
  const wm = settings.watermark;
  if (wm && wm.text) {
    ctx.save();
    ctx.globalAlpha = wm.opacity ?? 0.2;
    ctx.fillStyle = wm.color || '#888888';
    ctx.font = fontCss('Helvetica-Bold', wm.size || 60);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(dw / 2, dh / 2);
    ctx.rotate(-((wm.angle ?? 45) * Math.PI) / 180);
    ctx.fillText(wm.text, 0, 0);
    ctx.restore();
  }
  const pn = settings.pageNumbers;
  if (pn) {
    const text = pageNumberText(pn, n, total);
    const pos = pageNumberPos(pn, text, dw, dh, (t, s) => measure(t, 'Helvetica', s));
    ctx.save();
    ctx.fillStyle = pn.color || '#111111';
    ctx.font = fontCss('Helvetica', pn.size || 11);
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, pos.u, pos.v);
    ctx.restore();
  }
}
