'use strict';

// Both canvases are at the native screenshot resolution and displayed at 100%,
// so the live preview and the committed drawing share one coordinate system
// (no "jump"). Mouse input is in CSS px; multiply by `scale` at draw time.
const contentCanvas = document.getElementById('content'); // screenshot + committed annotations
const uiCanvas = document.getElementById('ui');           // dim mask, selection, handles, preview
const cctx = contentCanvas.getContext('2d');
const uctx = uiCanvas.getContext('2d');

const hint = document.getElementById('hint');
const dims = document.getElementById('dims');
const toolbar = document.getElementById('toolbar');

let img = null;
let scale = 1; // native px per CSS px
let readySent = false;

let phase = 'selecting'; // 'selecting' | 'annotating'
let sel = null;          // { x, y, w, h } in CSS px

let activeTool = 'pen';
let color = '#ff3b30';
let width = 4;

const annotations = [];
let draft = null;

let dragging = false;
let dragStart = null;
let moving = null; // { mode:'sel', lastX, lastY } | { mode:'resize', h:'nw'|... }

const HANDLE_TOL = 9; // CSS px

// ---------------------------------------------------------------------------
window.snapshot.onInit(({ dataURL }) => {
  resetState();
  img = new Image();
  img.onload = () => {
    sizeCanvases();
    redrawContent();
    redrawUI();
    readySent = true;
    window.snapshot.ready(); // tell main to show + focus the window
  };
  img.src = dataURL;
});

// Window is reused across captures — wipe everything when it's hidden.
window.snapshot.onReset(() => resetState());

// System-wide shortcuts (registered by main while the overlay is open) route
// the critical actions here — works even if the window lacks keyboard focus.
window.snapshot.onAction((action) => {
  if (action === 'copy') doCopy();
  else if (action === 'save') doSave();
  else if (action === 'undo') undo();
  else if (action === 'close') window.snapshot.close();
});

function resetState() {
  phase = 'selecting';
  sel = null;
  draft = null;
  moving = null;
  dragging = false;
  annotations.length = 0;
  cancelTextInput();
  toolbar.classList.remove('show');
  hint.classList.remove('hidden');
  dims.style.display = 'none';
  document.body.classList.remove('tool-move', 'tool-text');
  uiCanvas.style.cursor = '';
  setTool('pen');
  if (img) { redrawContent(); redrawUI(); }
}

function sizeCanvases() {
  const W = window.innerWidth;
  contentCanvas.width = img.naturalWidth;
  contentCanvas.height = img.naturalHeight;
  uiCanvas.width = img.naturalWidth;
  uiCanvas.height = img.naturalHeight;
  scale = contentCanvas.width / W;
}

window.addEventListener('resize', () => {
  if (!img) return;
  sizeCanvases();
  redrawContent();
  redrawUI();
  if (phase === 'annotating') showToolbar();
});

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function drawAnnotation(ctx, a) {
  const s = scale;
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = Math.max(1, a.width * s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (a.tool === 'pen') {
    const pts = a.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * s, pts[0].y * s, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * s, pts[0].y * s);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * s, pts[i].y * s);
      ctx.stroke();
    }
  } else if (a.tool === 'line') {
    ctx.beginPath();
    ctx.moveTo(a.x0 * s, a.y0 * s);
    ctx.lineTo(a.x1 * s, a.y1 * s);
    ctx.stroke();
  } else if (a.tool === 'arrow') {
    drawArrow(ctx, a.x0 * s, a.y0 * s, a.x1 * s, a.y1 * s, a.width * s);
  } else if (a.tool === 'rect') {
    ctx.strokeRect(Math.min(a.x0, a.x1) * s, Math.min(a.y0, a.y1) * s,
      Math.abs(a.x1 - a.x0) * s, Math.abs(a.y1 - a.y0) * s);
  } else if (a.tool === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(((a.x0 + a.x1) / 2) * s, ((a.y0 + a.y1) / 2) * s,
      (Math.abs(a.x1 - a.x0) / 2) * s, (Math.abs(a.y1 - a.y0) / 2) * s, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (a.tool === 'text') {
    const size = a.size * s;
    ctx.font = `600 ${size}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size / 8);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.strokeText(a.text, a.x * s, a.y * s);
    ctx.fillStyle = a.color;
    ctx.fillText(a.text, a.x * s, a.y * s);
  }
  ctx.restore();
}

function drawArrow(ctx, x0, y0, x1, y1, w) {
  const head = Math.max(10, w * 3.2);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - Math.cos(ang) * head * 0.6, y1 - Math.sin(ang) * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(ang - Math.PI / 7), y1 - head * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(x1 - head * Math.cos(ang + Math.PI / 7), y1 - head * Math.sin(ang + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
function redrawContent() {
  if (!img) return;
  cctx.clearRect(0, 0, contentCanvas.width, contentCanvas.height);
  cctx.drawImage(img, 0, 0, contentCanvas.width, contentCanvas.height);
  cctx.save();
  if (sel) {
    cctx.beginPath();
    cctx.rect(sel.x * scale, sel.y * scale, sel.w * scale, sel.h * scale);
    cctx.clip();
  }
  for (const a of annotations) drawAnnotation(cctx, a);
  cctx.restore();
}

function handlePoints() {
  const l = sel.x, t = sel.y, r = sel.x + sel.w, b = sel.y + sel.h;
  const mx = sel.x + sel.w / 2, my = sel.y + sel.h / 2;
  return {
    nw: [l, t], n: [mx, t], ne: [r, t], e: [r, my],
    se: [r, b], s: [mx, b], sw: [l, b], w: [l, my],
  };
}

function redrawUI() {
  const s = scale;
  uctx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);
  uctx.fillStyle = 'rgba(0,0,0,0.45)';
  uctx.fillRect(0, 0, uiCanvas.width, uiCanvas.height);

  if (sel && sel.w > 0 && sel.h > 0) {
    uctx.clearRect(sel.x * s, sel.y * s, sel.w * s, sel.h * s);
    uctx.strokeStyle = '#2f6fed';
    uctx.lineWidth = Math.max(1, 1.5 * s);
    uctx.strokeRect(sel.x * s, sel.y * s, sel.w * s, sel.h * s);

    // Resize handles (visible & interactive only with the move tool).
    if (phase === 'annotating' && activeTool === 'move') {
      const hp = handlePoints();
      const hs = 4 * s;
      for (const k in hp) {
        const [cx, cy] = hp[k];
        uctx.fillStyle = '#ffffff';
        uctx.fillRect(cx * s - hs, cy * s - hs, hs * 2, hs * 2);
        uctx.strokeStyle = '#2f6fed';
        uctx.lineWidth = Math.max(1, 1.5 * s);
        uctx.strokeRect(cx * s - hs, cy * s - hs, hs * 2, hs * 2);
      }
    }

    if (draft) {
      uctx.save();
      uctx.beginPath();
      uctx.rect(sel.x * s, sel.y * s, sel.w * s, sel.h * s);
      uctx.clip();
      drawAnnotation(uctx, draft);
      uctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
function updateDims() {
  if (!sel || sel.w < 1 || sel.h < 1) { dims.style.display = 'none'; return; }
  dims.style.display = 'block';
  dims.textContent = `${Math.round(sel.w * scale)} × ${Math.round(sel.h * scale)}`;
  let by = sel.y - 26;
  if (by < 4) by = sel.y + 6;
  dims.style.left = sel.x + 'px';
  dims.style.top = by + 'px';
}

function showToolbar() {
  toolbar.classList.add('show');
  const W = window.innerWidth, H = window.innerHeight;
  const tw = toolbar.offsetWidth, th = toolbar.offsetHeight;
  let left = Math.max(8, Math.min(sel.x + sel.w - tw, W - tw - 8));
  let top = sel.y + sel.h + 12;
  if (top + th > H - 8) top = sel.y - th - 12;
  if (top < 8) top = 8;
  toolbar.style.left = left + 'px';
  toolbar.style.top = top + 'px';
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function insideSel(x, y) {
  return sel && x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h;
}
function clampToSel(p) {
  return {
    x: Math.max(sel.x, Math.min(p.x, sel.x + sel.w)),
    y: Math.max(sel.y, Math.min(p.y, sel.y + sel.h)),
  };
}
function normRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
function handleAt(x, y) {
  if (!sel) return null;
  const hp = handlePoints();
  for (const k in hp) {
    const [cx, cy] = hp[k];
    if (Math.abs(x - cx) <= HANDLE_TOL && Math.abs(y - cy) <= HANDLE_TOL) return k;
  }
  return null;
}
function cursorFor(h) {
  if (h === 'nw' || h === 'se') return 'nwse-resize';
  if (h === 'ne' || h === 'sw') return 'nesw-resize';
  if (h === 'n' || h === 's') return 'ns-resize';
  return 'ew-resize';
}
function resizeSel(h, x, y) {
  const W = window.innerWidth, H = window.innerHeight;
  let l = sel.x, t = sel.y, r = sel.x + sel.w, b = sel.y + sel.h;
  const mx = Math.max(0, Math.min(x, W));
  const my = Math.max(0, Math.min(y, H));
  if (h.includes('w')) l = mx;
  if (h.includes('e')) r = mx;
  if (h.includes('n')) t = my;
  if (h.includes('s')) b = my;
  let nx = Math.min(l, r), nw = Math.abs(r - l);
  let ny = Math.min(t, b), nh = Math.abs(b - t);
  nw = Math.max(10, nw); nh = Math.max(10, nh);
  sel = { x: nx, y: ny, w: nw, h: nh };
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------
uiCanvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  window.snapshot.activate(); // this is the screen the user is working on
  const x = e.clientX, y = e.clientY;

  if (phase === 'selecting') {
    dragging = true;
    dragStart = { x, y };
    sel = { x, y, w: 0, h: 0 };
    hint.classList.add('hidden');
    return;
  }

  if (activeTool === 'move') {
    const h = handleAt(x, y);
    if (h) {
      moving = { mode: 'resize', h };
      dragging = true;
    } else if (insideSel(x, y)) {
      moving = { mode: 'sel', lastX: x, lastY: y };
      dragging = true;
    }
    return;
  }

  if (activeTool === 'text') {
    if (insideSel(x, y)) startTextInput(x, y);
    return;
  }

  if (!insideSel(x, y)) return;
  dragging = true;
  dragStart = { x, y };
  if (activeTool === 'pen') draft = { tool: 'pen', color, width, points: [{ x, y }] };
  else draft = { tool: activeTool, color, width, x0: x, y0: y, x1: x, y1: y };
  redrawUI();
});

uiCanvas.addEventListener('mousemove', (e) => {
  // Hover cursor for the move tool (resize handles / move).
  if (!dragging && phase === 'annotating' && activeTool === 'move') {
    const h = handleAt(e.clientX, e.clientY);
    uiCanvas.style.cursor = h ? cursorFor(h) : (insideSel(e.clientX, e.clientY) ? 'move' : 'default');
  }
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const x = e.clientX, y = e.clientY;

  if (phase === 'selecting') {
    sel = normRect(dragStart.x, dragStart.y, x, y);
    updateDims();
    redrawUI();
    return;
  }

  if (moving) {
    if (moving.mode === 'resize') {
      resizeSel(moving.h, x, y);
    } else {
      const W = window.innerWidth, H = window.innerHeight;
      let dx = x - moving.lastX, dy = y - moving.lastY;
      const nx = Math.max(0, Math.min(sel.x + dx, W - sel.w));
      const ny = Math.max(0, Math.min(sel.y + dy, H - sel.h));
      sel.x = nx; sel.y = ny;
      moving.lastX = x; moving.lastY = y;
    }
    updateDims();
    showToolbar();
    redrawContent();
    redrawUI();
    return;
  }

  if (draft) {
    if (draft.tool === 'pen') draft.points.push(clampToSel({ x, y }));
    else { const c = clampToSel({ x, y }); draft.x1 = c.x; draft.y1 = c.y; }
    redrawUI();
  }
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;

  if (moving) {
    moving = null;
    redrawContent();
    redrawUI();
    return;
  }

  if (phase === 'selecting') {
    if (!sel || sel.w < 5 || sel.h < 5) {
      sel = null;
      hint.classList.remove('hidden');
      dims.style.display = 'none';
      redrawUI();
      return;
    }
    phase = 'annotating';
    updateDims();
    redrawUI();
    showToolbar();
    return;
  }

  if (draft) {
    const isShape = draft.tool !== 'pen';
    if (isShape && Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0) < 3) {
      draft = null;
      redrawUI();
      return;
    }
    annotations.push(draft);
    draft = null;
    redrawContent();
    redrawUI();
  }
});

// ---------------------------------------------------------------------------
// Text tool
// ---------------------------------------------------------------------------
let textInput = null;
function startTextInput(x, y) {
  finishTextInput();
  const size = Math.max(14, width * 4.5);
  textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.spellcheck = false;
  Object.assign(textInput.style, {
    position: 'absolute', left: x + 'px', top: y + 'px', zIndex: 60,
    font: `600 ${size}px -apple-system, "Segoe UI", Roboto, sans-serif`,
    lineHeight: size + 'px', color: color, background: 'rgba(0,0,0,.25)',
    border: '1px dashed rgba(255,255,255,.7)', outline: 'none',
    padding: '0 3px', margin: '0', minWidth: '30px', caretColor: color,
  });
  textInput._pos = { x, y, size };
  document.body.appendChild(textInput);
  setTimeout(() => textInput && textInput.focus(), 0);
  textInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); finishTextInput(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelTextInput(); }
  });
  textInput.addEventListener('blur', () => finishTextInput());
}
function finishTextInput() {
  if (!textInput) return;
  const val = textInput.value.trim();
  const pos = textInput._pos;
  const el = textInput;
  textInput = null;
  el.remove();
  if (val) {
    annotations.push({ tool: 'text', color, size: pos.size, x: pos.x, y: pos.y + 2, text: val });
    redrawContent();
    redrawUI();
  }
}
function cancelTextInput() {
  if (!textInput) return;
  const el = textInput; textInput = null; el.remove();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function buildExportDataURL() {
  finishTextInput();
  const ex = document.createElement('canvas');
  ex.width = Math.max(1, Math.round(sel.w * scale));
  ex.height = Math.max(1, Math.round(sel.h * scale));
  ex.getContext('2d').drawImage(
    contentCanvas,
    Math.round(sel.x * scale), Math.round(sel.y * scale), ex.width, ex.height,
    0, 0, ex.width, ex.height
  );
  return ex.toDataURL('image/png');
}
async function doSave() { if (sel) await window.snapshot.save(buildExportDataURL()); }
function doCopy() { if (sel) window.snapshot.copy(buildExportDataURL()); }

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
const toolButtons = document.querySelectorAll('.tool[data-tool]');
function setTool(t) {
  activeTool = t;
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  document.body.classList.toggle('tool-text', t === 'text');
  document.body.classList.toggle('tool-move', t === 'move');
  if (t !== 'move') uiCanvas.style.cursor = '';
  redrawUI();
}
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#2f6fed', '#af52de', '#ffffff', '#000000'];
const paletteEl = document.getElementById('palette');
PALETTE.forEach((c, i) => {
  const sw = document.createElement('button');
  sw.className = 'swatch' + (i === 0 ? ' active' : '');
  sw.style.background = c;
  sw.title = c;
  sw.addEventListener('click', () => {
    color = c;
    document.querySelectorAll('.swatch').forEach((el) => el.classList.remove('active'));
    sw.classList.add('active');
    if (textInput) { textInput.style.color = c; textInput.style.caretColor = c; }
  });
  paletteEl.appendChild(sw);
});

const WIDTHS = [2, 4, 7];
const widthsEl = document.getElementById('widths');
WIDTHS.forEach((w) => {
  const b = document.createElement('button');
  b.className = 'wbtn' + (w === width ? ' active' : '');
  b.title = w + 'px';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const d = Math.min(18, 4 + w * 1.6);
  dot.style.width = d + 'px';
  dot.style.height = d + 'px';
  b.appendChild(dot);
  b.addEventListener('click', () => {
    width = w;
    document.querySelectorAll('.wbtn').forEach((el) => el.classList.remove('active'));
    b.classList.add('active');
  });
  widthsEl.appendChild(b);
});

document.getElementById('undo').addEventListener('click', undo);
document.getElementById('save').addEventListener('click', doSave);
document.getElementById('copy').addEventListener('click', doCopy);
toolbar.addEventListener('mousedown', (e) => e.stopPropagation());

function undo() {
  if (annotations.length) {
    annotations.pop();
    redrawContent();
    redrawUI();
  }
}

// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (textInput) return;
  if (e.key === 'Escape') { window.snapshot.close(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); doCopy(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); return; }
  if (phase !== 'annotating') return;
  const map = { v: 'move', p: 'pen', a: 'arrow', r: 'rect', o: 'ellipse', l: 'line', t: 'text' };
  const t = map[e.key.toLowerCase()];
  if (t) setTool(t);
});

setTool('pen');
