// public/js/placement.js
// Design placement on a flat garment photo. Shared by the customer builder
// (interactive editor), the quote page and the admin (read-only previews,
// plus the per-garment print-area calibrator).
//
// Everything is worked out in real inches. A garment's photo is calibrated
// by one box per view: where the Standard (11 in wide) print area sits on
// the photo. From that we know how many inches the photo spans, so a design
// shown "8 in wide" really is 8 inches against the garment, and every other
// print area (bigger sizes, left chest, upper back) is derived from it.
//
// This is a visual guide for the customer and for pre-production. The shop
// still reviews artwork and sends the official mockup.

(function () {
// Printable area for each size, in inches (width x max height). Standard,
  // Large and Oversized are the customer's Design Size choices for full front
  // and back prints; Chest and Upper Back are the one size those placements
  // come in. `scale` only changes how big the dashed box is drawn on the
  // photo (1.09 = 9% bigger); the inches the customer reads stay the same.
  // The owner can change all of these in Settings > Layout; setSizes() applies them.
  const DESIGN_SIZES = {
    standard: { label: 'Standard', wIn: 11, hIn: 14, scale: 1.09 },
    large: { label: 'Large Graphic', wIn: 13, hIn: 16, scale: 1 },
    oversized: { label: 'Oversized', wIn: 15.5, hIn: 18, scale: 1.06 },
    chest: { label: 'Chest', wIn: 4, hIn: 4, scale: 1 },
    upperBack: { label: 'Upper Back', wIn: 11, hIn: 4, scale: 1 },
  };
  function setSizes(sizes) {
    for (const key of Object.keys(DESIGN_SIZES)) {
      const s = sizes && sizes[key];
      if (s && Number(s.wIn) > 0 && Number(s.hIn) > 0) { DESIGN_SIZES[key].wIn = Number(s.wIn); DESIGN_SIZES[key].hIn = Number(s.hIn); }
      if (s && Number(s.scale) > 0) DESIGN_SIZES[key].scale = Number(s.scale);
    }
  }
  // How a typical supplier flat photo is scaled and where prints start, as
  // fractions of the photo: horizontal center, top edge of a full print, and
  // how wide 11 inches is (the scale every size is drawn from).
  const DEFAULT_VIEWS = {
    front: { cx: 0.5, top: 0.21, w11: 0.29 },
    back: { cx: 0.5, top: 0.16, w11: 0.29 },
  };
  // Print locations that can be previewed. `full` areas grow with the chosen
  // Design Size; the rest are fixed boxes placed relative to the Standard box
  // (offsets in inches from its top-center; the wearer's left is the photo's right).
  const LOCATIONS = {
    front: { view: 'front', full: true },
    back: { view: 'back', full: true },
    left_chest: { view: 'front', size: 'chest', dxIn: 4, dyIn: 1 },
    right_chest: { view: 'front', size: 'chest', dxIn: -4, dyIn: 1 },
    upper_back: { view: 'back', size: 'upperBack', dxIn: 0, dyIn: -1.5 },
  };
  /** The single size a fixed placement (chest, upper back) comes in, or null for full prints. */
  function fixedSizeFor(locationCode) {
    const loc = LOCATIONS[locationCode];
    return loc && !loc.full ? DESIGN_SIZES[loc.size] : null;
  }
  const MIN_DESIGN_IN = 1;
  const NUDGE_IN = 0.25;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  const fmtIn = (v) => `${(Math.round(v * 4) / 4).toString()} in`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function supports(locationCode) { return !!LOCATIONS[locationCode]; }
  function viewFor(locationCode) { return LOCATIONS[locationCode] ? LOCATIONS[locationCode].view : null; }
  function isPreviewableFile(f) { return !!f && /^image\//.test(f.mimeType || f.mime_type || ''); }

  /** Photo for a view, from a color's front photo. Supplier photos follow
   * a naming pattern (…_f_fm.jpg front, …_b_fm.jpg back; _fl is the large
   * version); any other photo can only show the front. */
  function viewImageUrl(frontUrl, view) {
    if (!frontUrl) return null;
    const m = /^(.*)_f_f[ml](\.\w+)$/.exec(frontUrl);
    if (m) return `${m[1]}_${view === 'back' ? 'b' : 'f'}_fl${m[2]}`;
    return view === 'front' ? frontUrl : null;
  }

  function viewConfig(garmentMockup, view) {
    const saved = garmentMockup && garmentMockup[view];
    const d = DEFAULT_VIEWS[view];
    const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : fallback);
    return saved ? { cx: num(saved.cx, d.cx, 0, 1), top: num(saved.top, d.top, 0, 1), w11: num(saved.w11, d.w11, 0.05, 1) } : { ...d };
  }

  /** The print area for a location + design size, as fractions of the photo
   * (x, y, w, h) plus its size in inches. `aspect` is photo height / width. */
  function zoneFor(locationCode, designSize, garmentMockup, aspect) {
    let loc = LOCATIONS[locationCode];
    if (!loc) return null;
    // The front print done "Chest" size sits in the left-chest area.
    if (loc.full && designSize === 'chest') loc = LOCATIONS.left_chest;
    const cfg = viewConfig(garmentMockup, loc.view);
    const perIn = cfg.w11 / 11;             // fraction of photo WIDTH per inch
    const perInY = perIn / (aspect || 1.25); // fraction of photo HEIGHT per inch
    const size = loc.full ? (['standard', 'large', 'oversized'].includes(designSize) ? DESIGN_SIZES[designSize] : DESIGN_SIZES.standard) : DESIGN_SIZES[loc.size];
    const wIn = size.wIn;
    const hIn = size.hIn;
    const cx = cfg.cx + (loc.dxIn || 0) * perIn;
    const top = cfg.top + (loc.dyIn || 0) * perInY;
    const k = size.scale || 1; // box drawn bigger or smaller on the photo; its inches are unchanged
    return {
      x: cx - (wIn * perIn * k) / 2, y: top, w: wIn * perIn * k, h: hIn * perInY * k, wIn, hIn,
      label: `${size.label} print area, up to ${size.wIn} in wide`,
    };
  }

  /** Keep a design inside its print area. `p` = { wIn, xIn, yIn } (top-left
   * offset inside the area), `artAspect` = artwork height / width. */
  function fitPlacement(p, zone, artAspect) {
    const maxW = Math.min(zone.wIn, zone.hIn / artAspect);
    const first = !p || !Number.isFinite(p.wIn);
    const wIn = clamp(first ? maxW : p.wIn, Math.min(MIN_DESIGN_IN, maxW), maxW);
    const hIn = wIn * artAspect;
    return {
      wIn: round2(wIn),
      xIn: round2(clamp(first || !Number.isFinite(p.xIn) ? (zone.wIn - wIn) / 2 : p.xIn, 0, zone.wIn - wIn)),
      yIn: round2(clamp(first || !Number.isFinite(p.yIn) ? 0 : p.yIn, 0, zone.hIn - hIn)),
    };
  }

  function stageHtml(imageUrl, zone, artworkUrl, design, opts) {
    const pct = (v) => `${(v * 100).toFixed(3)}%`;
    return `<div class="pl-stage${opts && opts.interactive ? ' pl-interactive' : ''}">
      <img class="pl-garment" src="${esc(imageUrl)}" alt="" draggable="false">
      <div class="pl-zone" style="left:${pct(zone.x)};top:${pct(zone.y)};width:${pct(zone.w)};height:${pct(zone.h)};">
        ${artworkUrl ? `<img class="pl-art" src="${esc(artworkUrl)}" alt="Your design" draggable="false" ${opts && opts.interactive ? 'tabindex="0"' : ''}
          style="left:${pct(design.x)};top:${pct(design.y)};width:${pct(design.w)};height:${pct(design.h)};">` : ''}
      </div>
    </div>`;
  }

  /** Read-only preview from a saved placement record (see snapshot()). */
  function renderStatic(container, saved) {
    if (!saved || !saved.imageUrl || !saved.zone || !saved.design) { container.innerHTML = ''; return; }
    const z = saved.zone, d = saved.design;
    // design is stored relative to the photo; the stage wants it relative to the zone
    const rel = { x: (d.x - z.x) / z.w, y: (d.y - z.y) / z.h, w: d.w / z.w, h: d.h / z.h };
    container.innerHTML = stageHtml(saved.imageUrl, z, saved.artworkUrl, rel) + detailsHtml(saved);
  }

  /** Design details under a saved preview: placement, size, position, file. */
  function detailsHtml(saved) {
    const rows = [];
    const row = (label, value) => { if (value) rows.push(`<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`); };
    const where = [saved.locationName, saved.areaLabel ? saved.areaLabel.replace(/ print area.*$/, '') + ' print area' : ''].filter(Boolean).join(', ');
    row('Placement', where + (saved.colorName ? ` (shown on ${saved.colorName})` : ''));
    if (Number.isFinite(Number(saved.widthIn))) row('Design size', `${fmtIn(saved.widthIn)} wide x ${fmtIn(saved.heightIn)} tall`);
    if (Number.isFinite(Number(saved.zoneWidthIn))) row('Print area', `up to ${fmtIn(saved.zoneWidthIn)} wide x ${fmtIn(saved.zoneHeightIn)} tall`);
    row('Position', position(saved));
    row('File', [saved.fileName, saved.fileType ? `(${saved.fileType})` : ''].filter(Boolean).join(' '));
    return `<dl class="pl-details">${rows.join('')}</dl>`;
  }
  function position(saved) {
    if (!Number.isFinite(Number(saved.fromLeftIn))) return '';
    const left = Number(saved.fromLeftIn), right = Number(saved.zoneWidthIn) - left - Number(saved.widthIn);
    const top = Number(saved.fromTopIn);
    const side = Math.abs(left - right) < 0.3 ? 'centered left to right'
      : left < 0.13 ? 'against the left edge' : right < 0.13 ? 'against the right edge' : `${fmtIn(left)} from the left edge`;
    const down = top < 0.13 ? 'at the top of the print area' : `${fmtIn(top)} below the top of the print area`;
    return `${down}, ${side}`;
  }

  function describe(saved) {
    if (!saved || !Number.isFinite(Number(saved.widthIn))) return '';
    return `${fmtIn(saved.widthIn)} wide x ${fmtIn(saved.heightIn)} tall, ${position(saved)}`;
  }

  /**
   * Interactive editor. opts: { locationCode, locationName, designSize,
   * garmentMockup, colors: [{ name, hex, imageUrl }], colorName, artworkUrl,
   * placement: { wIn, xIn, yIn }, onChange(record) }.
   * Calls onChange with a full saved record after every change.
   */
  function mountEditor(container, opts) {
    const view = viewFor(opts.locationCode);
    const colors = (opts.colors || []).map(c => ({ ...c, viewUrl: viewImageUrl(c.imageUrl, view) })).filter(c => c.viewUrl);
    if (!view || !colors.length) {
      container.innerHTML = `<p class="muted pl-note">A preview isn't available for this ${view === 'back' ? 'side of the' : ''} garment. We'll place your design using your notes.</p>`;
      return;
    }
    let color = colors.find(c => c.name === opts.colorName) || colors[0];
    let placement = opts.placement || null;
    let zone = null, artAspect = null, photoAspect = null;

    container.innerHTML = `
      <div class="pl-editor">
        <div class="pl-stage-wrap"></div>
        <div class="pl-controls">
          <div class="pl-title">Preview your design</div>
          ${colors.length > 1 ? `<div class="pl-colors" role="group" aria-label="Garment color for the preview">${colors.map(c =>
            `<button type="button" class="pl-color" data-color="${esc(c.name)}" title="${esc(c.name)}" aria-label="Show on ${esc(c.name)}" style="background:${esc(c.hex || '#ccc')};"></button>`).join('')}</div>` : ''}
          <label class="pl-size-label">Design width <span class="pl-readout"></span>
            <input type="range" class="pl-size" min="1" max="11" step="0.25" aria-label="Design width in inches"></label>
          <div class="pl-nudge" role="group" aria-label="Move the design">
            <button type="button" data-nudge="0,-1" aria-label="Move up">↑</button>
            <button type="button" data-nudge="-1,0" aria-label="Move left">←</button>
            <button type="button" data-center aria-label="Center left to right">Center</button>
            <button type="button" data-nudge="1,0" aria-label="Move right">→</button>
            <button type="button" data-nudge="0,1" aria-label="Move down">↓</button>
          </div>
          <p class="muted pl-hint"></p>
        </div>
      </div>`;
    const wrap = container.querySelector('.pl-stage-wrap');
    const slider = container.querySelector('.pl-size');
    const readout = container.querySelector('.pl-readout');
    const hint = container.querySelector('.pl-hint');
    const full = LOCATIONS[opts.locationCode].full;
    hint.textContent = `Drag your design to move it, or use the arrows. It stays inside the dashed print area.` +
      (full && opts.canChangeSize !== false ? ' Need it bigger? Choose a larger Design Size above.' : '');

    function record() {
      const perInX = zone.w / zone.wIn, perInY = zone.h / zone.hIn;
      const hIn = placement.wIn * artAspect;
      return {
        locationCode: opts.locationCode, locationName: opts.locationName || '', view, colorName: color.name,
        imageUrl: color.viewUrl, artworkUrl: opts.artworkUrl, designSize: full ? (opts.designSize || 'standard') : null,
        areaLabel: zone.label, fileName: opts.fileName || '', fileType: opts.fileType || '',
        zone: { x: zone.x, y: zone.y, w: zone.w, h: zone.h },
        design: { x: zone.x + placement.xIn * perInX, y: zone.y + placement.yIn * perInY, w: placement.wIn * perInX, h: hIn * perInY },
        widthIn: placement.wIn, heightIn: round2(hIn), zoneWidthIn: zone.wIn, zoneHeightIn: zone.hIn,
        fromLeftIn: placement.xIn, fromTopIn: placement.yIn,
        wIn: placement.wIn, xIn: placement.xIn, yIn: placement.yIn, // lets the editor restore itself
      };
    }
    function draw(notify) {
      placement = fitPlacement(placement, zone, artAspect);
      const hIn = placement.wIn * artAspect;
      const art = wrap.querySelector('.pl-art');
      art.style.left = `${(placement.xIn / zone.wIn) * 100}%`;
      art.style.top = `${(placement.yIn / zone.hIn) * 100}%`;
      art.style.width = `${(placement.wIn / zone.wIn) * 100}%`;
      art.style.height = `${(hIn / zone.hIn) * 100}%`;
      slider.max = String(Math.floor(Math.min(zone.wIn, zone.hIn / artAspect) * 4) / 4);
      slider.value = String(placement.wIn);
      readout.textContent = `${fmtIn(placement.wIn)} wide x ${fmtIn(hIn)} tall`;
      wrap.querySelector('.pl-zone').setAttribute('title', zone.label);
      if (notify && opts.onChange) opts.onChange(record());
    }
    function build() {
      if (!photoAspect || !artAspect) return;
      zone = zoneFor(opts.locationCode, opts.designSize, opts.garmentMockup, photoAspect);
      wrap.innerHTML = stageHtml(color.viewUrl, zone, opts.artworkUrl, { x: 0, y: 0, w: 1, h: 1 }, { interactive: true })
        + `<div class="pl-caption">${esc(zone.label)}</div>`;
      container.querySelectorAll('.pl-color').forEach(b => b.classList.toggle('selected', b.dataset.color === color.name));
      bindDrag();
      draw(true);
    }
    function bindDrag() {
      const art = wrap.querySelector('.pl-art');
      const zoneEl = wrap.querySelector('.pl-zone');
      let start = null;
      art.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        art.setPointerCapture(e.pointerId);
        start = { x: e.clientX, y: e.clientY, xIn: placement.xIn, yIn: placement.yIn };
        art.classList.add('pl-dragging');
      });
      art.addEventListener('pointermove', (e) => {
        if (!start) return;
        const r = zoneEl.getBoundingClientRect();
        placement = { ...placement, xIn: start.xIn + ((e.clientX - start.x) / r.width) * zone.wIn, yIn: start.yIn + ((e.clientY - start.y) / r.height) * zone.hIn };
        draw(false);
      });
      const end = () => { if (!start) return; start = null; art.classList.remove('pl-dragging'); draw(true); };
      art.addEventListener('pointerup', end);
      art.addEventListener('pointercancel', end);
      art.addEventListener('keydown', (e) => {
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!d) return;
        e.preventDefault();
        placement = { ...placement, xIn: placement.xIn + d[0] * NUDGE_IN, yIn: placement.yIn + d[1] * NUDGE_IN };
        draw(true);
      });
    }
    slider.addEventListener('input', () => {
      if (!zone) return;
      // grow and shrink around the design's own center
      const oldW = placement.wIn, newW = Number(slider.value);
      placement = { wIn: newW, xIn: placement.xIn + (oldW - newW) / 2, yIn: placement.yIn + ((oldW - newW) * artAspect) / 2 };
      draw(true);
    });
    container.querySelectorAll('[data-nudge]').forEach(b => b.addEventListener('click', () => {
      if (!zone) return;
      const [dx, dy] = b.dataset.nudge.split(',').map(Number);
      placement = { ...placement, xIn: placement.xIn + dx * NUDGE_IN, yIn: placement.yIn + dy * NUDGE_IN };
      draw(true);
    }));
    container.querySelector('[data-center]').addEventListener('click', () => {
      if (!zone) return;
      placement = { ...placement, xIn: (zone.wIn - placement.wIn) / 2 };
      draw(true);
    });
    container.querySelectorAll('.pl-color').forEach(b => b.addEventListener('click', () => {
      color = colors.find(c => c.name === b.dataset.color) || color;
      loadPhoto();
    }));

    function loadPhoto() {
      const img = new Image();
      img.onload = () => { photoAspect = img.naturalHeight / img.naturalWidth; build(); };
      img.onerror = () => { wrap.innerHTML = `<p class="muted pl-note">The garment photo couldn't be loaded, so there is no preview. We'll place your design using your notes.</p>`; };
      img.src = color.viewUrl;
    }
    const art = new Image();
    art.onload = () => { artAspect = (art.naturalHeight || 1) / (art.naturalWidth || 1); build(); };
    art.onerror = () => { container.innerHTML = `<p class="muted pl-note">This file can't be previewed on the garment. We'll still receive it.</p>`; };
    art.src = opts.artworkUrl;
    loadPhoto();
  }

  /**
   * Admin: set where the Standard (11 in wide) print area sits on a garment
   * photo. opts: { imageUrl, view, config: { cx, top, w11 }, onChange(config) }.
   */
  function mountCalibrator(container, opts) {
    let cfg = viewConfig({ [opts.view]: opts.config }, opts.view);
    container.innerHTML = `<div class="pl-stage-wrap"></div>
      <label class="pl-size-label">Print area width on the photo
        <input type="range" class="pl-cal-width" min="0.12" max="0.6" step="0.005" aria-label="Print area width"></label>`;
    const wrap = container.querySelector('.pl-stage-wrap');
    const slider = container.querySelector('.pl-cal-width');
    const img = new Image();
    img.onload = () => {
      const aspect = img.naturalHeight / img.naturalWidth;
      const zone = () => zoneFor(opts.view, 'standard', { [opts.view]: cfg }, aspect);
      function draw(notify) {
        const z = zone();
        cfg.cx = clamp(cfg.cx, z.w / 2, 1 - z.w / 2);
        cfg.top = clamp(cfg.top, 0, Math.max(0, 1 - z.h));
        const zz = zone();
        const el = wrap.querySelector('.pl-zone');
        el.style.left = `${zz.x * 100}%`; el.style.top = `${zz.y * 100}%`; el.style.width = `${zz.w * 100}%`; el.style.height = `${zz.h * 100}%`;
        slider.value = String(cfg.w11);
        if (notify && opts.onChange) opts.onChange({ cx: round2(cfg.cx * 100) / 100, top: round2(cfg.top * 100) / 100, w11: round2(cfg.w11 * 100) / 100 });
      }
      wrap.innerHTML = stageHtml(opts.imageUrl, zone(), null, null, { interactive: true })
        + `<div class="pl-caption">Standard print area: ${DESIGN_SIZES.standard.wIn} in wide x ${DESIGN_SIZES.standard.hIn} in tall. Drag the box; the larger sizes and chest areas follow it.</div>`;
      const el = wrap.querySelector('.pl-zone');
      el.classList.add('pl-zone-movable');
      let start = null;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); start = { x: e.clientX, y: e.clientY, cx: cfg.cx, top: cfg.top }; });
      el.addEventListener('pointermove', (e) => {
        if (!start) return;
        const r = wrap.querySelector('.pl-stage').getBoundingClientRect();
        cfg.cx = start.cx + (e.clientX - start.x) / r.width;
        cfg.top = start.top + (e.clientY - start.y) / r.height;
        draw(false);
      });
      const end = () => { if (start) { start = null; draw(true); } };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      slider.addEventListener('input', () => { cfg.w11 = Number(slider.value); draw(true); });
      draw(false);
    };
    img.onerror = () => { container.innerHTML = '<p class="muted pl-note">No photo for this side of the garment.</p>'; };
    img.src = opts.imageUrl;
  }

  window.Placement = { DESIGN_SIZES, setSizes, fixedSizeFor, DEFAULT_VIEWS, supports, viewFor, viewImageUrl, isPreviewableFile, zoneFor, fitPlacement, mountEditor, renderStatic, describe, mountCalibrator, viewConfig };
})();
