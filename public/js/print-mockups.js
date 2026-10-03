// public/js/print-mockups.js — the artwork editor and order visualizations
// for print products.
//
// Everything here follows one chain:
//   product dimensions -> printable area (the canvas) -> white background
//   -> the customer's artwork, placed with a scale and position -> mockup
// The product decides the canvas; the artwork is only ever placed inside
// it and never changes its size. A placement is
//   { scale, xPercent, yPercent, rotation }
// where scale 1 is the artwork fitted inside the canvas and x/yPercent is
// where the artwork's center sits across / down the canvas. The uploaded
// file itself is never altered.
//
//   PrintMockups.editor   position / scale artwork on its print canvas
//   PrintMockups.room     a poster on a living-room wall (drag to move)
//   PrintMockups.yard     a yard sign next to a person
//   PrintMockups.bag      a mylar pack in its bag color, label on top
//   PrintMockups.sticker  a sticker with its white border and cut line
//
// The scenes are SVG drawn in inches: one SVG unit is one inch, so sizes
// are in true proportion with no scale math. These are approximate
// previews for the customer, not production proofs.

(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const DEFAULT_PLACEMENT = { scale: 1, xPercent: 50, yPercent: 50, rotation: 0 };
  const placementOf = (p) => ({ ...DEFAULT_PLACEMENT, ...(p || {}) });

  // The placeholder shown wherever the customer's artwork will go.
  function placeholder(w, h, label) {
    const fs = Math.max(0.3, Math.min(w, h) / 7);
    return `<rect width="${w}" height="${h}" fill="#CCFF00"/>
      <text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" font-weight="900" font-family="Arial, sans-serif" fill="#000">${esc(label || 'YOUR DESIGN')}</text>`;
  }
  // The artwork as placed: a box `scale` times the canvas, centered on the
  // placement point, with the image fitted inside that box.
  function placedImage(url, w, h, placement, attrs) {
    const p = placementOf(placement);
    const bw = w * p.scale, bh = h * p.scale;
    return `<image ${attrs || ''} href="${esc(url)}" x="${w * p.xPercent / 100 - bw / 2}" y="${h * p.yPercent / 100 - bh / 2}" width="${bw}" height="${bh}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  // A print canvas at (x, y): white background, the placed artwork, clipped to the canvas.
  function printCanvas(x, y, w, h, url, placement, label) {
    return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">
      ${url ? `<rect width="${w}" height="${h}" fill="#FFFFFF"/>${placedImage(url, w, h, placement)}` : placeholder(w, h, label)}
    </svg>`;
  }

  // Drag inside an SVG, reported in SVG units regardless of how large the
  // SVG is drawn on screen.
  function makeDraggable(svg, handle, onMove) {
    let start = null;
    const toSvg = (e) => {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    };
    handle.style.cursor = 'grab';
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (e) => {
      start = toSvg(e);
      handle.setPointerCapture(e.pointerId);
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const now = toSvg(e);
      onMove(now.x - start.x, now.y - start.y);
      start = now;
    });
    const end = () => { start = null; handle.style.cursor = 'grab'; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- editor
  // The one artwork-positioning component every product uses.
  // opts: { w, h (the print canvas, inches), artworkUrl, placement, onChange(placement) }
  function editor(host, opts) {
    const w = opts.w, h = opts.h;
    const pad = Math.max(w, h) * 0.07;
    let p = placementOf(opts.placement);
    let aspect = w / h; // artwork width / height, known once the image loads
    host.innerHTML = `
      <svg viewBox="${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}" role="img" aria-label="Artwork on a ${w} by ${h} inch print area" style="width:100%;max-height:440px;display:block;background:#E3E6E9;border-radius:10px;user-select:none;">
        <rect width="${w}" height="${h}" fill="#FFFFFF"/>
        <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">${placedImage(opts.artworkUrl, w, h, p, 'data-art')}</svg>
        <rect width="${w}" height="${h}" fill="transparent" stroke="#111" stroke-width="${pad * 0.05}" stroke-dasharray="${pad * 0.25} ${pad * 0.2}" data-area/>
        <text x="${w / 2}" y="${h + pad * 0.72}" text-anchor="middle" font-size="${pad * 0.5}" font-family="Arial, sans-serif" fill="#555">${w} × ${h} in print area</text>
      </svg>
      <div class="mock-tools" style="justify-content:center;">
        <button type="button" class="btn btn-outline btn-sm" data-ed="smaller" aria-label="Make artwork smaller">−</button>
        <button type="button" class="btn btn-outline btn-sm" data-ed="larger" aria-label="Make artwork larger">+</button>
        <button type="button" class="btn btn-outline btn-sm" data-ed="centerH">Center ↔</button>
        <button type="button" class="btn btn-outline btn-sm" data-ed="centerV">Center ↕</button>
        <button type="button" class="btn btn-outline btn-sm" data-ed="fit">Fit</button>
        <button type="button" class="btn btn-outline btn-sm" data-ed="fill">Fill</button>
        <button type="button" class="btn btn-outline btn-sm" data-ed="reset">Reset</button>
      </div>`;
    const svg = host.querySelector('svg');
    const img = svg.querySelector('[data-art]');
    const place = () => {
      const bw = w * p.scale, bh = h * p.scale;
      img.setAttribute('width', bw); img.setAttribute('height', bh);
      img.setAttribute('x', w * p.xPercent / 100 - bw / 2);
      img.setAttribute('y', h * p.yPercent / 100 - bh / 2);
    };
    const changed = () => {
      // the artwork's center stays on the canvas, so it can never be dragged out of the print area
      p.scale = clamp(Math.round(p.scale * 1000) / 1000, 0.1, 6);
      p.xPercent = clamp(Math.round(p.xPercent * 10) / 10, 0, 100);
      p.yPercent = clamp(Math.round(p.yPercent * 10) / 10, 0, 100);
      place();
      if (opts.onChange) opts.onChange({ ...p });
    };
    const probe = new Image();
    probe.onload = () => { if (probe.naturalHeight) aspect = probe.naturalWidth / probe.naturalHeight; };
    probe.src = opts.artworkUrl;
    makeDraggable(svg, svg.querySelector('[data-area]'), (dx, dy) => { p.xPercent += dx / w * 100; p.yPercent += dy / h * 100; changed(); });
    host.querySelector('.mock-tools').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ed]');
      if (!btn) return;
      const action = btn.dataset.ed;
      if (action === 'smaller') p.scale /= 1.1;
      if (action === 'larger') p.scale *= 1.1;
      if (action === 'centerH') p.xPercent = 50;
      if (action === 'centerV') p.yPercent = 50;
      if (action === 'fit' || action === 'reset') p = { ...DEFAULT_PLACEMENT };
      // Fill: just large enough to cover the whole canvas (the overflow is cropped)
      if (action === 'fill') { const canvasAspect = w / h; p = { ...DEFAULT_PLACEMENT, scale: Math.max(aspect / canvasAspect, canvasAspect / aspect) }; }
      changed();
    });
  }

  // ------------------------------------------------------------------ room
  // A 10 ft wide wall with an 8 ft ceiling, a 6 ft sofa, a tall plant, a
  // side table and a floor lamp for scale, framed tightly around the sofa
  // so the poster is easy to see. The poster is a flat print on the wall
  // (no frame, mat or shadow) showing the final poster canvas.
  //
  // Its main job is to show how big the poster is, so the poster is drawn
  // POSTER_VISUAL_BOOST times its true size against the room: at strict
  // scale the small sizes are too small to judge. Every size gets the same
  // boost, so the sizes stay in proportion to each other.
  // opts: { w, h (inches), artworkUrl, placement, wall: {x, y} (the poster's
  //         center on the wall, in inches), readonly, onChange(wall) }
  const ROOM = { width: 120, wall: 96, floor: 12 };
  const ROOM_VIEW = { x: 8, y: 0, w: 104, h: 104 }; // the part of the room shown
  const POSTER_VISUAL_BOOST = 1.35;
  function room(host, opts) {
    const w = opts.w * POSTER_VISUAL_BOOST, h = opts.h * POSTER_VISUAL_BOOST; // as drawn
    const limit = (p) => ({
      x: clamp(p.x, ROOM_VIEW.x + w / 2, ROOM_VIEW.x + ROOM_VIEW.w - w / 2),
      y: clamp(p.y, 1 + h / 2, ROOM.wall - h / 2),
    });
    // centered over the sofa, its bottom edge a few inches above the sofa back
    const centered = () => limit({ x: 60, y: 57 - h / 2 });
    let pos = limit(opts.wall && Number.isFinite(opts.wall.x) && opts.wall.x > 0 ? opts.wall : centered());
    host.innerHTML = `<svg viewBox="${ROOM_VIEW.x} ${ROOM_VIEW.y} ${ROOM_VIEW.w} ${ROOM_VIEW.h}" role="img" aria-label="Room preview: a ${opts.w} by ${opts.h} inch poster on a wall above a sofa" style="width:100%;height:auto;display:block;border-radius:10px;user-select:none;">
      <rect width="${ROOM.width}" height="${ROOM.wall}" fill="#ECE7DF"/>
      <rect y="${ROOM.wall}" width="${ROOM.width}" height="${ROOM.floor}" fill="#B89B7A"/>
      <rect y="${ROOM.wall - 4}" width="${ROOM.width}" height="4" fill="#F7F4EF"/>
      <!-- tall plant, about 5 ft -->
      <path d="M16 96 L14 81 H23 L21 96 Z" fill="#B5673F"/>
      <path d="M18.5 81 C17.5 68 12 60 10 47 C15.5 54 17.5 62 18.5 71 C18.5 60 18.5 48 21.5 38 C22.5 50 21.5 62 19.5 73 C21.5 64 25 56 28 51 C26.5 62 23 71 19.5 81 Z" fill="#4F8A5B"/>
      <!-- sofa, 72 in wide, 34 in tall -->
      <rect x="24" y="62" width="72" height="22" rx="4" fill="#5E6B78"/>
      <rect x="21" y="70" width="9" height="22" rx="3" fill="#525E6A"/><rect x="90" y="70" width="9" height="22" rx="3" fill="#525E6A"/>
      <rect x="28" y="76" width="64" height="14" rx="3" fill="#6C7A88"/>
      <rect x="26" y="90" width="3" height="6" fill="#3B3B3B"/><rect x="91" y="90" width="3" height="6" fill="#3B3B3B"/>
      <!-- floor lamp, 62 in tall -->
      <rect x="106.4" y="46" width="1.2" height="49" fill="#3B3B3B"/><ellipse cx="107" cy="95.5" rx="3.4" ry="1" fill="#3B3B3B"/>
      <path d="M102.6 46 L111.4 46 L110.4 34 L103.6 34 Z" fill="#F4E3B5"/>
      <!-- side table, 22 in tall -->
      <rect x="99" y="74" width="12" height="1.6" fill="#6B4F3A"/><rect x="100" y="75.6" width="1.4" height="20.4" fill="#6B4F3A"/><rect x="108.6" y="75.6" width="1.4" height="20.4" fill="#6B4F3A"/>
      <rect x="100.6" y="71.4" width="7" height="1.3" fill="#C4572E"/><rect x="101.2" y="70.1" width="6" height="1.3" fill="#2F5D8A"/>
      <g data-poster>${printCanvas(-w / 2, -h / 2, w, h, opts.artworkUrl, opts.placement, `${opts.w}×${opts.h}`)}</g>
      <text x="60" y="${ROOM.wall + 5.6}" text-anchor="middle" font-size="3.2" font-family="Arial, sans-serif" fill="#3B2F22">${opts.w}×${opts.h} in poster · 6 ft sofa · 8 ft ceiling</text>
    </svg>`;
    const svg = host.querySelector('svg');
    const poster = svg.querySelector('[data-poster]');
    const place = () => poster.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
    place();
    if (!opts.readonly) {
      makeDraggable(svg, poster, (dx, dy) => {
        pos = limit({ x: pos.x + dx, y: pos.y + dy });
        place();
        if (opts.onChange) opts.onChange({ ...pos });
      });
    }
    return {
      center() { pos = centered(); place(); if (opts.onChange) opts.onChange({ ...pos }); },
    };
  }

  // ------------------------------------------------------------------ yard
  // A yard with a 5 ft 8 in person and the sign on an H-stake.
  // opts: { w, h (inches), artworkUrl, placement }
  function yard(host, opts) {
    const w = opts.w, h = opts.h;
    const ground = 100, clearance = 9;
    const sx = 150 - w / 2, sy = ground - clearance - h;
    host.innerHTML = `<svg viewBox="0 0 240 124" role="img" aria-label="Yard preview: a ${w} by ${h} inch sign next to a person" style="width:100%;height:auto;display:block;border-radius:10px;">
      <rect width="240" height="${ground}" fill="#CFE8F7"/>
      <!-- house far in the background (scenery only, not to scale) -->
      <g transform="translate(4 ${ground * 0.45}) scale(0.55)" opacity=".75">
        <path d="M8 ${ground} V52 L44 30 L80 52 V${ground} Z" fill="#E8DCC8"/><path d="M4 54 L44 28 L84 54" fill="none" stroke="#8C5A44" stroke-width="3"/>
        <rect x="36" y="74" width="14" height="26" fill="#8C5A44"/><rect x="16" y="62" width="12" height="12" fill="#B9D7EA"/><rect x="58" y="62" width="12" height="12" fill="#B9D7EA"/>
      </g>
      <!-- shrubs -->
      <ellipse cx="206" cy="${ground - 5}" rx="14" ry="9" fill="#5E9A4F"/><ellipse cx="222" cy="${ground - 4}" rx="11" ry="7" fill="#538A45"/>
      <rect y="${ground}" width="240" height="24" fill="#6FA35A"/>
      <rect y="${ground}" width="240" height="2" fill="#5E8F4B"/>
      <!-- person, 68 in tall -->
      <g fill="#34404B">
        <circle cx="108" cy="${ground - 63.5}" r="4.5"/>
        <rect x="102" y="${ground - 58}" width="12" height="26" rx="4"/>
        <rect x="98.5" y="${ground - 57}" width="3.5" height="24" rx="1.7"/><rect x="114" y="${ground - 57}" width="3.5" height="24" rx="1.7"/>
        <rect x="102.5" y="${ground - 34}" width="5" height="34" rx="2"/><rect x="108.5" y="${ground - 34}" width="5" height="34" rx="2"/>
      </g>
      <!-- H-stake -->
      <rect x="${150 - w * 0.22}" y="${sy + h * 0.2}" width="0.7" height="${h * 0.8 + clearance + 2}" fill="#9AA0A6"/>
      <rect x="${150 + w * 0.22}" y="${sy + h * 0.2}" width="0.7" height="${h * 0.8 + clearance + 2}" fill="#9AA0A6"/>
      ${printCanvas(sx, sy, w, h, opts.artworkUrl, opts.placement, `${w}×${h}`)}
      <rect x="${sx}" y="${sy}" width="${w}" height="${h}" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="0.3"/>
      <text x="108" y="${ground + 12}" text-anchor="middle" font-size="5" font-family="Arial, sans-serif" fill="#fff">5 ft 8 in</text>
      <text x="150" y="${ground + 12}" text-anchor="middle" font-size="5" font-family="Arial, sans-serif" fill="#fff">${w}×${h} in</text>
    </svg>`;
  }

  // ------------------------------------------------------------------- bag
  // A mylar pack, built in layers: the bag shape -> the selected bag color
  // -> the printed label (white) -> the customer's artwork. The label
  // covers nearly the whole face, so the bag color shows as a thin border.
  // The outline (rounded corners, tear notches near the top seal, thin
  // perimeter edge) is drawn here from the bag's dimensions.
  // opts: { w, h (the bag, inches), printW, printH (the label), swatch (a
  //         hex color, or 'silver' | 'gold' | 'holographic'), artworkUrl,
  //         placement, label (placeholder text), blank: no label on this side }
  let bagSeq = 0;
  function bagPath(w, h) {
    const r = w * 0.065, notchY = h * 0.115, n = w * 0.013;
    return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${notchY - n} A${n},${n} 0 0 0 ${w},${notchY + n} V${h - r} Q${w},${h} ${w - r},${h}
      H${r} Q0,${h} 0,${h - r} V${notchY + n} A${n},${n} 0 0 0 0,${notchY - n} V${r} Q0,0 ${r},0 Z`;
  }
  function bagFill(swatch, id) {
    if (swatch === 'holographic') return { fill: `url(#${id}holo)`, defs: `
      <linearGradient id="${id}holo" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#FF8AD8"/><stop offset=".14" stop-color="#B58CFF"/><stop offset=".3" stop-color="#6FD3FF"/><stop offset=".46" stop-color="#7BF5C4"/>
        <stop offset=".62" stop-color="#F6F58A"/><stop offset=".78" stop-color="#FFB37A"/><stop offset=".9" stop-color="#FF8AD8"/><stop offset="1" stop-color="#9FA8FF"/>
      </linearGradient>` };
    if (swatch === 'silver') return { fill: `url(#${id}metal)`, defs: `
      <linearGradient id="${id}metal" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#F4F5F6"/><stop offset=".35" stop-color="#A7ADB3"/><stop offset=".6" stop-color="#E9EBED"/><stop offset="1" stop-color="#8E959C"/>
      </linearGradient>` };
    if (swatch === 'gold') return { fill: `url(#${id}metal)`, defs: `
      <linearGradient id="${id}metal" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#FBEFA6"/><stop offset=".35" stop-color="#C9972B"/><stop offset=".6" stop-color="#F6E27A"/><stop offset="1" stop-color="#A9781C"/>
      </linearGradient>` };
    return { fill: /^#[0-9a-f]{3,8}$/i.test(swatch || '') ? swatch : '#111111', defs: '' };
  }
  function bag(host, opts) {
    const w = opts.w || 4, h = opts.h || 5;
    const lw = Math.min(w, opts.printW || w * 0.906), lh = Math.min(h, opts.printH || h * 0.94);
    const lx = (w - lw) / 2, ly = (h - lh) / 2;
    const pad = Math.max(w, h) * 0.05;
    const id = 'bag' + (++bagSeq);
    const { fill, defs } = bagFill(opts.swatch, id);
    const shiny = ['holographic', 'silver', 'gold'].includes(opts.swatch);
    const edge = w * 0.022; // the thin perimeter edge inside the outline
    host.innerHTML = `<svg viewBox="${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}" role="img" aria-label="${esc(opts.label || 'Pack')} preview" style="width:100%;max-height:440px;display:block;user-select:none;">
      <defs>${defs}
        <linearGradient id="${id}sheen" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0" stop-color="#fff" stop-opacity="${shiny ? 0.55 : 0.16}"/><stop offset=".28" stop-color="#fff" stop-opacity="0"/>
          <stop offset=".62" stop-color="#fff" stop-opacity="${shiny ? 0.35 : 0}"/><stop offset="1" stop-color="#000" stop-opacity=".12"/>
        </linearGradient>
        <clipPath id="${id}label"><rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="${w * 0.03}"/></clipPath>
      </defs>
      <path d="${bagPath(w, h)}" fill="${esc(fill)}" stroke="rgba(0,0,0,.45)" stroke-width="${w * 0.008}"/>
      <path d="${bagPath(w, h)}" fill="url(#${id}sheen)"/>
      <rect x="${edge}" y="${edge}" width="${w - edge * 2}" height="${h - edge * 2}" rx="${w * 0.05}" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="${w * 0.004}"/>
      ${opts.blank ? '' : `<g clip-path="url(#${id}label)">${printCanvas(lx, ly, lw, lh, opts.artworkUrl, opts.placement, opts.label)}</g>
      <rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="${w * 0.03}" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="${w * 0.004}"/>`}
    </svg>`;
  }

  // --------------------------------------------------------------- sticker
  // The sticker as it will be cut: the artwork (as placed on its size), a
  // white border grown outward from the artwork's outer edge, and the cut
  // line around that. Only the OUTSIDE contour is used: holes inside
  // letters and interior gaps are filled in, so the sticker comes off as
  // one piece instead of the cutter tracing every small opening.
  // opts: { w, h (inches), artworkUrl, placement, border (inches) }
  function sticker(host, opts) {
    const box = 300, margin = 36;
    const ppi = box / Math.max(opts.w, opts.h); // screen pixels per inch
    const borderPx = Math.max(0, Number(opts.border) || 0) * ppi;
    const size = box + margin * 2;
    const p = placementOf(opts.placement);
    host.innerHTML = `<div style="max-width:${size}px;margin:0 auto;">
      <canvas width="${size}" height="${size}" role="img" aria-label="Sticker preview with cut line" style="width:100%;height:auto;display:block;border-radius:10px;background:#D9DDE1;"></canvas>
    </div>
    <p style="text-align:center;font-size:12.5px;margin:8px 0 0;"><span style="display:inline-block;width:18px;border-top:2px solid #E6007E;vertical-align:middle;margin-right:6px;"></span>Cut line · ${opts.w}×${opts.h} in${opts.border > 0 ? ` · ${opts.border} in white border` : ' · no border'}</p>`;
    const canvas = host.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const layer = () => { const c = document.createElement('canvas'); c.width = size; c.height = size; return c; };
    const img = new Image();
    img.onload = () => {
      // 1) the artwork as placed inside the sticker's width × height
      const sw = opts.w * ppi, sh = opts.h * ppi;
      const sx = (size - sw) / 2, sy = (size - sh) / 2;
      const bw = sw * p.scale, bh = sh * p.scale;
      const k = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
      const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
      const art = layer();
      const a = art.getContext('2d');
      a.beginPath(); a.rect(sx, sy, sw, sh); a.clip();
      a.drawImage(img, sx + sw * p.xPercent / 100 - dw / 2, sy + sh * p.yPercent / 100 - dh / 2, dw, dh);

      // 2) grow the artwork outward by the border width
      const grown = layer();
      const g = grown.getContext('2d');
      const steps = borderPx > 0 ? 48 : 0;
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        g.drawImage(art, Math.cos(angle) * borderPx, Math.sin(angle) * borderPx);
      }
      g.drawImage(art, 0, 0);

      // 3) keep only the outside contour: flood in from the edges; whatever
      //    the flood can't reach (the artwork and any holes inside it) is the sticker
      const px = g.getImageData(0, 0, size, size).data;
      const outside = new Uint8Array(size * size);
      const stack = [];
      const visit = (i) => { if (!outside[i] && px[i * 4 + 3] < 24) { outside[i] = 1; stack.push(i); } };
      for (let i = 0; i < size; i++) { visit(i); visit((size - 1) * size + i); visit(i * size); visit(i * size + size - 1); }
      while (stack.length) {
        const i = stack.pop(), x = i % size;
        if (x > 0) visit(i - 1);
        if (x < size - 1) visit(i + 1);
        if (i >= size) visit(i - size);
        if (i < size * (size - 1)) visit(i + size);
      }
      const shape = (r, gr, b) => {
        const c = layer();
        const data = c.getContext('2d').createImageData(size, size);
        for (let i = 0; i < outside.length; i++) {
          if (outside[i]) continue;
          data.data[i * 4] = r; data.data[i * 4 + 1] = gr; data.data[i * 4 + 2] = b; data.data[i * 4 + 3] = 255;
        }
        c.getContext('2d').putImageData(data, 0, 0);
        return c;
      };

      // 4) cut line (the shape, slightly larger, in magenta), white backing, artwork
      ctx.clearRect(0, 0, size, size);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(sx, sy, sw, sh); ctx.setLineDash([]);
      const cut = shape(230, 0, 126);
      for (let i = 0; i < 16; i++) { const angle = (i / 16) * Math.PI * 2; ctx.drawImage(cut, Math.cos(angle) * 2, Math.sin(angle) * 2); }
      ctx.drawImage(shape(255, 255, 255), 0, 0);
      ctx.drawImage(art, 0, 0);
    };
    img.src = opts.artworkUrl;
  }

  window.PrintMockups = { editor, room, yard, bag, sticker };
})();
