/**
 * Webview renderer. Receives the view text, style and exclude globs from the host, runs the core
 * pipeline (quotient, boxes, placement, routing) and draws the grid with D3:
 *   glyph mode:  one <text> per edge or frame cell (box-drawing glyphs at exact cell positions)
 *   vector mode: frames as rectangles; calls as paths, orthogonal from the grid masks or curved
 *                through each call's polyline (`edges.curve`: rounded, sigmoid, spline)
 * Local changes (moves, locks, collapse, hide, order, modes) commit a new document text to the host.
 */
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { curveBasis, line } from 'd3-shape';
import { zoom, zoomIdentity } from 'd3-zoom';
import { cellId, cellRC, charRows, EdgePath, Grid, LabelSpan } from '../core/grid';
import { ancestors, isContainer, NodeKey } from '../core/model';
import { buildScene, isStub, Scene, siblingsOf, unitAnchor, unitMembers } from '../core/scene';
import { Curve, E, glyphSet, N, S, Style, W } from '../core/style';
import { Direction, excludedBy, globToRegExp, OpenSide, Order, parseDoc, ROOTS, serializeDoc, ViewDoc } from '../core/viewdoc';
import { opens, seedSide, within } from '../core/reveal';

interface VsApi { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsApi;
const api = acquireVsCodeApi();

let text = '';
let name = 'view';
let doc: ViewDoc | undefined;
let style: Style | undefined;
let styleText = '';
let excludeGlobs: string[] = [];
let scene: Scene | undefined;
let focusKey: NodeKey | undefined = api.getState()?.focus;
let selected = new Set<NodeKey>();
const callKey = (p: { from: NodeKey; to: NodeKey }) => `${p.from}\u0000${p.to}`;
let selCalls = new Set<string>();     // selected calls, drawn direction, callKey
let optsOpen = false;                 // options pulldown
let anchor: { key: NodeKey; at?: [number, number] } | undefined;   // vertex kept at its screen position when the layout changes
let busy = false;
let note = '';                         // host note in the status line (language server not ready, unresolved answers)
let cw = 8;
let ch = 16;
let placed = false;

const svg = select<SVGSVGElement, unknown>('#graph');
const root = svg.append('g').attr('class', 'root');
const zoomer = zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.08, 8])
  // wheel zooms anywhere; dragging pans only from the background (labels and headers drag units)
  .filter((ev: Event) => ev.type === 'wheel' || (!(ev as MouseEvent).button && !(ev.target as Element).closest?.('.labels g, .heads g')))
  .on('zoom', (ev) => {
    root.attr('transform', ev.transform.toString());
    saveState({ t: [ev.transform.x, ev.transform.y, ev.transform.k] });
  });
svg.call(zoomer).on('dblclick.zoom', null);

function saveState(patch: Record<string, unknown>) {
  api.setState({ ...(api.getState() ?? {}), ...patch });
}

// ---- host messages ------------------------------------------------------------------------------
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'state') {
    busy = !!m.busy;
    excludeGlobs = m.exclude ?? excludeGlobs;
    const st = JSON.stringify(m.style);
    if (m.text === text && st === styleText && doc) { status(); toolbar(); return; }
    text = m.text;
    name = m.name ?? name;
    styleText = st;
    style = m.style;
    try {
      doc = parseDoc(text, name);
    } catch (e) {
      showError(`invalid .gaffy JSON: ${(e as Error).message}`);
      return;
    }
    render();
  } else if (m.type === 'busy') {
    busy = !!m.busy;
    banner(busy ? 'building' : undefined);
    status();
  } else if (m.type === 'progress') {
    banner(m.text);
  } else if (m.type === 'note') {
    note = m.text ?? '';
    status();
  } else if (m.type === 'cmd') {
    runCmd(m.cmd, m.key, m.unit, m.to);
  }
});

function commit(mut: (d: ViewDoc) => void, rebuild = false) {
  if (!doc) return;
  const d = structuredClone(doc);
  mut(d);
  doc = d;
  text = serializeDoc(d);
  render();
  api.postMessage({ type: 'edit', text, rebuild });
}

// ---- geometry -----------------------------------------------------------------------------------
function measure(st: Style) {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${st.font.size}px ${st.font.family}`;
  cw = ctx.measureText('M'.repeat(64)).width / 64 || st.font.size * 0.6;
  ch = Math.round(st.font.size * st.font.lineHeight);
}

function applyColors(st: Style) {
  const s = document.documentElement.style;
  for (const [k, v] of Object.entries(st.colors)) s.setProperty(`--g-${k}`, v);
  s.setProperty('--g-ew', String(st.edges.width));
}

const X = (x: number) => x * cw;
const Y = (y: number) => y * ch;

const DIRS = [[-1, 0, N], [1, 0, S], [0, 1, E], [0, -1, W]] as const;   // dr, dc, bit
const OPPOSITE: Record<number, number> = { [N]: S, [S]: N, [E]: W, [W]: E };

/**
 * Orthogonal vector paths per net from the grid masks.
 * Crossing of two calls (one cell, one net running N|S, another E|W): the horizontal line hops over
 * the vertical one with a half circle. Junction (three or more directions within one net): each branch
 * bends into the root-side direction with a quarter curve, the flow direction (towards the callee for
 * call nets, away from the caller for tree stems); the straight-through branch stays straight.
 */
function maskPaths(g: Grid): Map<string, string> {
  const byNet = new Map<string, Map<number, number>>();
  for (const [id, nets] of g.cells) for (const [net, m] of nets) {
    let c = byNet.get(net);
    if (!c) byNet.set(net, (c = new Map()));
    c.set(id, m);
  }
  const out = new Map<string, string>();
  const hop = Math.min(cw, ch) * 0.35;
  for (const [net, cells] of byNet) {
    // distance from the root along connected masks
    const dist = new Map<number, number>();
    const root = g.roots.get(net);
    if (root !== undefined && cells.has(root)) {
      dist.set(root, 0);
      const q = [root];
      while (q.length) {
        const id = q.shift()!;
        const [r, c] = cellRC(id);
        const m = cells.get(id)!;
        for (const [dr, dc, bit] of DIRS) {
          if (!(m & bit)) continue;
          const nid = cellId(r + dr, c + dc);
          const nm = cells.get(nid);
          if (nm === undefined || !(nm & OPPOSITE[bit]) || dist.has(nid)) continue;
          dist.set(nid, dist.get(id)! + 1);
          q.push(nid);
        }
      }
    }
    const segs: string[] = [];
    for (const [id, m] of cells) {
      const [r, c] = cellRC(id);
      const x = (c + 0.5) * cw, y = (r + 0.5) * ch;
      const edge = (bit: number): [number, number] =>
        bit === N ? [x, r * ch] : bit === S ? [x, (r + 1) * ch] : bit === E ? [(c + 1) * cw, y] : [c * cw, y];
      // a crossing: some net runs N|S, another E|W, none turns or joins here
      const others = g.cells.get(id)!;
      let hasV = false, hasH = false, plain = true;
      for (const om of others.values()) {
        if (om === (N | S)) hasV = true;
        else if (om === (E | W)) hasH = true;
        else plain = false;
      }
      if (hasV && hasH && plain && m === (E | W)) {
        segs.push(`M${c * cw},${y}H${x - hop}A${hop},${hop} 0 0 1 ${x + hop},${y}H${(c + 1) * cw}`);
        continue;
      }
      if (popcount(m) >= 3 && dist.has(id)) {
        const d0 = dist.get(id)!;
        let rootSide = 0;
        for (const [dr, dc, bit] of DIRS) {
          const nd = dist.get(cellId(r + dr, c + dc));
          if ((m & bit) && nd !== undefined && nd < d0) rootSide = bit;
        }
        if (rootSide) {
          const [rx, ry] = edge(rootSide);
          for (const [, , bit] of DIRS) {
            if (!(m & bit) || bit === rootSide) continue;
            const [ex, ey] = edge(bit);
            segs.push(bit === OPPOSITE[rootSide] ? `M${ex},${ey}L${rx},${ry}` : `M${ex},${ey}Q${x},${y} ${rx},${ry}`);
          }
          continue;
        }
      }
      for (const [, , bit] of DIRS) if (m & bit) { const [ex, ey] = edge(bit); segs.push(`M${x},${y}L${ex},${ey}`); }
    }
    out.set(net, segs.join(''));
  }
  return out;
}

/** One call as an SVG path: polyline with rounded corners, sigmoid S-curves, or a B-spline. */
function curvePath(p: EdgePath, curve: Curve): string {
  const pts = p.pts.map(([x, y]) => [X(x), Y(y)] as [number, number]);
  if (curve === 'spline') return line().curve(curveBasis)(pts) ?? '';
  if (curve === 'sigmoid') {
    // straight lead-out of `edges.lead` cells, cubic S, straight lead-in; `edges.tension` sets how far the
    // control points reach along the leads (0: sharp, 1: wide)
    const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
    const L = style!.edges.lead, t = style!.edges.tension;
    const vertical = p.start !== 'E';
    const sy = p.start === 'N' ? -1 : 1;
    const a: [number, number] = vertical ? [x0, y0 + sy * L * ch * 0.5] : [x0 + L * cw, y0];
    const b: [number, number] = p.arrive === 'E' ? [x1 - L * cw, y1] : [x1 + L * cw, y1];
    const kx = Math.max(cw, t * Math.abs(b[0] - a[0]));
    const ky = Math.max(ch * 0.5, t * Math.abs(b[1] - a[1]));
    const c1 = vertical ? [a[0], a[1] + sy * ky] : [a[0] + kx, a[1]];
    const c2 = p.arrive === 'E' ? [b[0] - kx, b[1]] : [b[0] + kx, b[1]];
    return `M${x0},${y0}L${a[0]},${a[1]}C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${b[0]},${b[1]}L${x1},${y1}`;
  }
  // rounded corners
  const r = Math.min(cw, ch) * 0.9;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
    const k = Math.min(r, l1 / 2, l2 / 2);
    const p1 = [bx - ((bx - ax) / (l1 || 1)) * k, by - ((by - ay) / (l1 || 1)) * k];
    const p2 = [bx + ((cx - bx) / (l2 || 1)) * k, by + ((cy - by) / (l2 || 1)) * k];
    d += `L${p1[0]},${p1[1]}Q${bx},${by} ${p2[0]},${p2[1]}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${last[0]},${last[1]}`;
}

function hue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ---- render -------------------------------------------------------------------------------------
function render() {
  if (!doc || !style) return;
  measure(style);
  applyColors(style);
  try {
    scene = buildScene(doc, style);
  } catch (e) {
    showError(`layout failed: ${(e as Error).message}`);
    return;
  }
  const sc = scene;
  const g = sc.grid;
  const grows = doc.view.arrange === 'grow';
  const above: 'up' | 'down' = sc.below === 'down' ? 'up' : 'down';
  // the vertex last opened, closed or removed keeps its screen position: the view shifts by its move
  if (anchor && placed) {
    const p = sc.placement.pos.get(anchor.key);
    if (p) {
      if (anchor.at && (p.col !== anchor.at[0] || p.row !== anchor.at[1])) {
        svg.call(zoomer.translateBy, -(p.col - anchor.at[0]) * cw, -(p.row - anchor.at[1]) * ch);
      }
      anchor.at = [p.col, p.row];
    }
  }
  const mode = doc.view.edges ?? style.edges.mode;
  const curve = doc.view.curve ?? style.edges.curve;
  const gs = glyphSet(style);
  for (const k of [...selected]) if (!sc.vg.nodes.has(k)) selected.delete(k);

  root.selectAll('*').remove();
  root.attr('class', `root mode-${mode}`).style('font-family', style.font.family).style('font-size', `${style.font.size}px`);

  if (!g.labels.length) {
    root.append('text').attr('class', 'empty').attr('x', 0).attr('y', ch)
      .text(doc.view.seeds.length ? 'building…' : 'empty view: right click a function > gaffy > New View…');
  }

  // frames: hue fill (optional), vector rectangles
  const gf = root.append('g').attr('class', 'frames');
  for (const f of g.frames) {
    const x = X(f.c0 + 0.5), y = Y(f.r0 + 0.5), w = X(f.c1 - f.c0), h = Y(f.r1 - f.r0);
    if (style.boxes.fill === 'hue') {
      gf.append('rect').attr('class', 'fill').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 4)
        .style('fill', `hsl(${hue(f.box.key)}, 55%, 50%)`).style('fill-opacity', style.boxes.alpha);
    }
    if (mode === 'vector') {
      const line = style.boxes.line;
      const dash = line === 'dashed' ? '6 4' : line === 'dotted' ? '1.5 3' : null;
      const rx = line === 'solid' || line === 'double' ? 2 : 6;
      gf.append('rect').attr('class', 'frame').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', rx).attr('stroke-dasharray', dash);
      if (line === 'double') gf.append('rect').attr('class', 'frame').attr('x', x + 3).attr('y', y + 3).attr('width', w - 6).attr('height', h - 6).attr('rx', rx);
    }
  }

  const ge = root.append('g').attr('class', 'edges');
  if (mode === 'glyph') {
    const sy = Math.max(1, style.font.lineHeight / 1.15);
    const cells: { r: number; c: number; t: string }[] = [];
    charRows(g, gs, true, false).forEach((row, r) => row.forEach((t, c) => { if (t !== ' ') cells.push({ r, c, t }); }));
    ge.selectAll('text').data(cells).join('text')
      .attr('transform', (d) => `translate(${d.c * cw},${(d.r + 0.5) * ch})${VERTICAL.has(d.t) ? ` scale(1,${sy})` : ''}`)
      .text((d) => d.t);
  } else if (curve === 'orthogonal') {
    for (const [net, d] of maskPaths(g)) ge.append('path').attr('class', 'net').attr('data-net', net).attr('d', d);
    for (const m of g.marks) arrowhead(ge, m.col + 0.5, m.row + 0.5, m.role === 'arrowE' ? 1 : m.role === 'arrowW' ? -1 : 0);
  } else {
    for (const p of g.paths) {
      ge.append('path').attr('class', 'net').attr('data-from', p.from).attr('data-to', p.to).attr('d', curvePath(p, curve));
      if (style.edges.arrow && doc.view.order !== 'callees') {
        const [x, y] = p.pts[p.pts.length - 1];
        arrowhead(ge, x - (p.arrive === 'E' ? 0.5 : -0.5), y, p.arrive === 'E' ? 1 : -1);
      }
    }
  }
  root.append('g').attr('class', 'overlay');

  // calls: wide transparent hit paths; hover highlights, click selects, double click shows only what lies below
  // calls: wide transparent hit paths. A click gathers every call through the clicked cell, so a click on
  // a shared line (fork, merge) takes all calls on it. Shift adds or removes; double click isolates.
  root.append('g').attr('class', 'hits').selectAll('path').data(g.paths).join('path')
    .attr('d', (p) => callD(p))
    .attr('data-vscode-context', (p) => JSON.stringify(isStub(p.to)
      ? { webviewSection: 'canvas', preventDefaultContextMenuItems: true }
      : { webviewSection: 'edge', key: p.from, to: p.to, preventDefaultContextMenuItems: true }))
    .on('mousemove', (ev: MouseEvent, p) => highlightCalls(callsAt(ev, p)))
    .on('mouseleave', () => highlight(focusKey))
    .on('click', (ev: MouseEvent, p) => {
      ev.stopPropagation();
      // a marker row's elbow opens that side, like its `>`
      if (isStub(p.to)) { markerClick(p.from, sc.below); return; }
      if (grows && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && closeAt(ev, p)) return;
      const hit = callsAt(ev, p).map(callKey);
      if (ev.shiftKey) {
        const all = hit.every((x) => selCalls.has(x));
        for (const x of hit) all ? selCalls.delete(x) : selCalls.add(x);
      } else selCalls = new Set(hit);
      highlight(focusKey);
      toolbar();
      status();
    })
    .on('dblclick', (ev: MouseEvent, p) => {
      ev.stopPropagation();
      if (isStub(p.to)) return;
      const hit = callsAt(ev, p);
      const sel = hit.some((c) => selCalls.has(callKey(c))) ? [...selCalls].map(unkey) : hit;
      isolateCalls(sel);
    })
    .append('title').text((p) => (isStub(p.to) ? markerTitle(sc.below) : callTitle(p)));

  // labels
  const gl = root.append('g').attr('class', 'labels');
  const nodes = gl.selectAll<SVGGElement, LabelSpan>('g').data(g.labels.filter((l) => l.kind === 'node' && !isStub(l.key))).join('g')
    .attr('class', (d) => labelClass(d))
    .attr('transform', (d) => `translate(${d.col * cw},${d.row * ch})`)
    .attr('data-vscode-context', (d) => JSON.stringify({
      webviewSection: sc.vg.nodes.get(d.key)?.collapsed ? 'collapsed' : 'node',
      key: d.key, unit: d.key, preventDefaultContextMenuItems: true,
    }));
  nodes.append('rect').attr('class', 'hit').attr('x', -2).attr('y', 0).attr('width', (d) => d.text.length * cw + 4).attr('height', ch).attr('rx', 2);
  nodes.append('text').attr('y', ch / 2).each(function (d) {
    const dec = sc.decor.get(d.key) ?? { pre: '', post: '', badge: '' };
    const base = d.text.slice(dec.pre.length, d.text.length - dec.post.length - dec.badge.length);
    const t = select(this);
    if (dec.pre) {
      t.append('tspan').attr('class', 'twisty').text(dec.pre)
        .on('click', (ev: MouseEvent) => { ev.stopPropagation(); if (grows) markerClick(d.key, above); else twisty(d.key, 'up'); })
        .append('title').text(grows ? markerTitle(above) : 'open what calls this');
    }
    t.append('tspan').text(base);
    if (dec.post) t.append('tspan').attr('class', dec.post.includes('▸') ? 'twisty' : null).text(dec.post)
      .on('click', (ev: MouseEvent) => { if (dec.post.includes('▸')) { ev.stopPropagation(); twisty(d.key, 'down'); } });
    if (dec.badge) t.append('tspan').attr('class', 'badge').text(dec.badge)
      .on('click', (ev: MouseEvent) => { ev.stopPropagation(); api.postMessage({ type: 'hiddenNeighbors', key: d.key, keys: sc.hiddenOf.get(d.key) }); });
  });
  // automatic arrangement: open sides show a closing twisty on hover, ▾ after the label closes its calls, ▴ before it its callers
  if (!grows) nodes.each(function (d) {
    const g0 = select(this);
    const dec = sc.decor.get(d.key);
    if ((sc.vg.out.get(d.key) ?? []).length && !dec?.post.includes('▸')) {
      g0.append('text').attr('class', 'twisty open').attr('x', d.text.length * cw + cw * 0.4).attr('y', ch / 2).text('▾')
        .on('click', (ev: MouseEvent) => { ev.stopPropagation(); twisty(d.key, 'down'); })
        .append('title').text('close what this calls');
    }
    if ((sc.vg.inc.get(d.key) ?? []).length && !dec?.pre) {
      g0.append('text').attr('class', 'twisty open').attr('x', -cw * 1.2).attr('y', ch / 2).text('▴')
        .on('click', (ev: MouseEvent) => { ev.stopPropagation(); twisty(d.key, 'up'); })
        .append('title').text('close what calls this');
    }
  });
  nodes.append('title').text((d) => tooltip(d));
  nodes
    .on('click', (ev: MouseEvent, d) => {
      ev.stopPropagation();
      if (ev.shiftKey) { selected.has(d.key) ? selected.delete(d.key) : selected.add(d.key); }
      else { selected = new Set([d.key]); selCalls.clear(); api.postMessage({ type: 'open', key: d.key }); }
      setFocus(d.key);
      toolbar();
      status();
    })
    .on('dblclick', (ev: MouseEvent, d) => {
      ev.stopPropagation();
      if (sc.vg.nodes.get(d.key)?.collapsed) commit((x) => { x.view.collapsed = x.view.collapsed.filter((c) => c !== d.key); });
      else if (ev.shiftKey) api.postMessage({ type: 'expand', key: d.key, dir: 'both' });
      else if (grows) {
        if (effSide(d.key) !== 'none') { anchorAt(d.key); commit((x) => { x.view.open = { ...(x.view.open ?? {}), [d.key]: 'none' }; }); }
        else for (const s0 of ['down', 'up'] as const) if (sc.hasMore(d.key, s0)) setSide(d.key, s0, true);
      } else toggleFold(d.key);
    })
    .on('mouseenter', (_ev, d) => highlight(d.key))
    .on('mouseleave', () => highlight(focusKey));
  nodes.call(dragUnit((d) => d.key) as any);

  // marker rows `└─>>`: the second `>` (the elbow is a path above); opens or restores the side placed below
  root.append('g').attr('class', 'markers').selectAll('text').data(g.markers).join('text')
    .attr('class', 'marker')
    .attr('x', (m) => m.col * cw).attr('y', (m) => (m.row + 0.5) * ch)
    .text((m) => m.text)
    .on('click', (ev: MouseEvent, m) => { ev.stopPropagation(); markerClick(m.key, m.side); })
    .append('title').text((m) => markerTitle(m.side));

  // frame headers
  const gh = root.append('g').attr('class', 'heads');
  const heads = gh.selectAll<SVGGElement, LabelSpan>('g').data(g.labels.filter((l) => l.kind === 'box')).join('g')
    .attr('class', (d) => `head${doc!.view.lock[d.key] ? ' locked' : ''}`)
    .attr('transform', (d) => `translate(${d.col * cw},${d.row * ch})`)
    .attr('data-vscode-context', (d) => JSON.stringify({
      webviewSection: 'box', key: d.key.slice(4), unit: d.key, preventDefaultContextMenuItems: true,
    }));
  heads.append('rect').attr('class', 'hit').attr('x', -cw).attr('y', 0).attr('width', (d) => (d.text.length + 2) * cw).attr('height', ch);
  heads.append('text').attr('y', ch / 2).text((d) => d.text);
  heads.append('title').text((d) => `${d.text}\nclick select its functions (Delete removes them) · drag to move · double click to collapse${doc!.view.lock[d.key] ? ' · locked' : ''}`);
  // click a box header: select its functions (Delete removes them)
  heads.on('click', (ev: MouseEvent, d) => {
    ev.stopPropagation();
    const members = unitMembers(sc, d.key).filter((k) => !isStub(k) && sc.vg.nodes.has(k));
    if (ev.shiftKey) for (const k of members) selected.add(k);
    else { selected = new Set(members); selCalls.clear(); }
    setFocus(focusKey);
    toolbar();
    status();
  });
  heads.on('dblclick', (ev: MouseEvent, d) => {
    ev.stopPropagation();
    commit((x) => { if (!x.view.collapsed.includes(d.key.slice(4))) x.view.collapsed.push(d.key.slice(4)); });
  });
  heads.call(dragUnit((d) => d.key) as any);

  root.append('g').attr('class', 'drag');
  svg.on('click', () => { selected.clear(); selCalls.clear(); optsOpen = false; toolbar(); setFocus(undefined); });
  if (!placed) placeView();
  highlight(focusKey);
  toolbar();
  status();
}

const VERTICAL = new Set('│├┤┌┐└┘┬┴┼|+`');

/** Path data of one call in the current edge style. */
function callD(p: EdgePath): string {
  const curve = doc!.view.curve ?? style!.edges.curve;
  const vector = (doc!.view.edges ?? style!.edges.mode) === 'vector';
  return vector && curve !== 'orthogonal' ? curvePath(p, curve) : `M${p.pts.map(([x, y]) => `${X(x)},${Y(y)}`).join('L')}`;
}

/** Call direction of a drawn connection: under order `callees` the drawn graph is reversed. */
function asCall(p: { from: NodeKey; to: NodeKey }): { caller: NodeKey; callee: NodeKey } {
  return doc!.view.order === 'callees' ? { caller: p.to, callee: p.from } : { caller: p.from, callee: p.to };
}

function callTitle(p: EdgePath): string {
  const { caller, callee } = asCall(p);
  const name = (k: NodeKey) => scene!.graph.nodes[k]?.name ?? k;
  return `${name(caller)}() → ${name(callee)}()\nclick select · double click: show only what lies below · right click: more`;
}

/** Side of a vertex: open entry, or the traversal side for a seed without one. */
function sideOf(k: NodeKey): OpenSide | undefined {
  return doc!.view.open?.[k] ?? (doc!.view.seeds.includes(k) ? seedSide(doc!.view.direction) : undefined);
}

/** Open sides of a vertex as drawn: its entry limited to the sides it may open (seeds both, others their reveal side). */
function effSide(k: NodeKey): OpenSide {
  return within(sideOf(k), scene?.rev.allowed.get(k) ?? 'both');
}

/** Keep `k` at its screen position through the next layouts. */
function anchorAt(k: NodeKey) {
  const p = scene?.placement.pos.get(k);
  anchor = { key: k, at: p ? [p.col, p.row] : undefined };
}

/**
 * Open or close one side of a vertex; opening a side without data asks the language server. `restore`
 * also brings back the hidden neighbors and cut calls of that side.
 */
function setSide(k: NodeKey, side: 'up' | 'down', on: boolean, restore = false) {
  if (!doc || !scene) return;
  anchorAt(k);
  const cur = effSide(k);
  const up = side === 'up' ? on : opens(cur, 'up');
  const down = side === 'down' ? on : opens(cur, 'down');
  const next: OpenSide = up && down ? 'both' : up ? 'up' : down ? 'down' : 'none';
  const nb = new Set(doc.graph.edges.filter((e) => (side === 'down' ? e.from === k : e.to === k)).map((e) => (side === 'down' ? e.to : e.from)));
  commit((x) => {
    x.view.open = { ...(x.view.open ?? {}), [k]: next };
    if (!restore) return;
    x.view.hidden = x.view.hidden.filter((h) => !nb.has(h));
    const cut = (x.view.cut ?? []).filter(([a, b]) => !(side === 'down' ? a === k : b === k));
    if (cut.length) x.view.cut = cut; else delete x.view.cut;
  });
  const ex = doc.explored?.[k];
  const dir = side === 'down' ? 'out' : 'in';
  if (on && ex !== dir && ex !== 'both') api.postMessage({ type: 'expand', key: k, dir });
}

/** A marker (`>> ` before a label, `└─>>` row below it): open that side with everything removed from it. */
function markerClick(k: NodeKey, side: 'up' | 'down') {
  setSide(k, side, true, true);
}

function markerTitle(side: 'up' | 'down'): string {
  return `${side === 'up' ? 'callers' : 'calls'} not on screen: click to show them (also removed ones)`;
}

/** Stable arrangement: an arrowhead closes the callers of the vertex it points at; a line closes its caller's calls. */
function closeAt(ev: MouseEvent, p: EdgePath): boolean {
  const t = (root.node() as SVGGElement).getScreenCTM();
  if (!t) return false;
  const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(t.inverse());
  const r = Math.floor(pt.y / ch), c = Math.floor(pt.x / cw);
  const head = scene!.grid.arrowTo.get(cellId(r, c)) ?? scene!.grid.arrowTo.get(cellId(r, c + 1)) ?? scene!.grid.arrowTo.get(cellId(r, c - 1));
  const call = asCall(p);
  if (head !== undefined) {
    // the arrow points at a callee under order `callers`: its callers side is `up`
    if (opens(effSide(head), 'up')) { setSide(head, 'up', false); return true; }
    if (head === call.callee && opens(effSide(call.caller), 'down')) { setSide(call.caller, 'down', false); return true; }
    return false;
  }
  if (opens(effSide(call.caller), 'down')) { setSide(call.caller, 'down', false); return true; }
  if (opens(effSide(call.callee), 'up')) { setSide(call.callee, 'up', false); return true; }
  return false;
}

const unkey = (k: string) => { const [from, to] = k.split('\u0000'); return { from, to }; };

/** Calls through the grid cell under the pointer; the hit path alone when none matches (curved styles). */
function callsAt(ev: MouseEvent, p: EdgePath): EdgePath[] {
  const t = (root.node() as SVGGElement).getScreenCTM();
  if (!t) return [p];
  const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(t.inverse());
  const id = cellId(Math.floor(pt.y / ch), Math.floor(pt.x / cw));
  const at = scene!.grid.paths.filter((q) => !isStub(q.to) && q.cells.includes(id));
  return at.length ? at : [p];
}

function highlightCalls(ps: { from: NodeKey; to: NodeKey }[]) {
  const ov = root.select('.overlay');
  ov.selectAll('path.hl').remove();
  const want = new Set(ps.map(callKey));
  for (const q of scene!.grid.paths) if (want.has(callKey(q))) ov.append('path').attr('class', 'hl').attr('d', callD(q));
}

/** Keep each call's caller and what lies below its callee in the drawn graph; hide the rest. */
function isolateCalls(calls: { from: NodeKey; to: NodeKey }[]) {
  if (!calls.length) return;
  const keep = new Set<NodeKey>();
  for (const c of calls) { keep.add(c.from); for (const k of reachDrawn(c.to, 'down')) keep.add(k); }
  selCalls.clear();
  isolate(keep);
}

/** Open or close one side of a vertex: unfold, fold, or ask the language server for that side. */
function twisty(key: NodeKey, side: 'up' | 'down') {
  if (!scene || !doc) return;
  if (doc.view.fold[key] === side) { commit((x) => { delete x.view.fold[key]; }); return; }
  const shown = side === 'down' ? scene.vg.out.get(key) : scene.vg.inc.get(key);
  if (shown?.length) { commit((x) => { x.view.fold[key] = side; }); return; }
  api.postMessage({ type: 'expand', key, dir: side === 'down' ? 'out' : 'in' });
}

/** Vertices reachable along the drawn graph: down = what lies below, up = what lies above. */
function reachDrawn(start: NodeKey, dir: 'up' | 'down'): Set<NodeKey> {
  const sc = scene!;
  const out = new Set([start]);
  const q = [start];
  while (q.length) {
    const k = q.pop()!;
    const next = dir === 'down' ? (sc.drawn.out.get(k) ?? []).map((e) => e.to) : (sc.drawn.inc.get(k) ?? []).map((e) => e.from);
    for (const n of next) if (!out.has(n)) { out.add(n); q.push(n); }
  }
  return out;
}

function isolate(keep: Set<NodeKey>) {
  const drop = [...scene!.vg.nodes.keys()].filter((x) => !keep.has(x));
  commit((x) => { for (const s of drop) if (!x.view.hidden.includes(s)) x.view.hidden.push(s); });
}

function popcount(m: number) { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; }

function arrowhead(gr: { append: (name: string) => any }, cx: number, cy: number, dir: number) {
  if (!dir) return;
  const x = cx * cw, y = cy * ch, a = ch * 0.22;
  gr.append('path').attr('class', 'arrow')
    .attr('d', dir > 0 ? `M${x - a},${y - a}L${x + a},${y}L${x - a},${y + a}Z` : `M${x + a},${y - a}L${x - a},${y}L${x + a},${y + a}Z`);
}

function labelClass(d: LabelSpan): string {
  const sc = scene!;
  const v = sc.vg.nodes.get(d.key);
  const cls = ['label'];
  if (sc.seeds.has(d.key)) cls.push('seed');
  if (v?.collapsed) cls.push('collapsed');
  if (v?.node?.external) cls.push('external');
  if (doc!.view.lock[d.key]) cls.push('locked');
  if (doc!.view.fold[d.key]) cls.push('folded');
  if (selected.has(d.key)) cls.push('sel');
  if (d.key === focusKey) cls.push('focus');
  return cls.join(' ');
}

function tooltip(d: LabelSpan): string {
  const n = scene!.graph.nodes[d.key];
  if (!n) return d.key;
  const v = scene!.vg.nodes.get(d.key);
  const lines = [n.qual ? `${n.module}.${n.qual}` : n.module];
  if (n.path) lines.push(`${n.path}${n.line !== undefined ? `:${n.line + 1}` : ''}`);
  if (n.detail) lines.push(n.detail);
  if (v?.collapsed) lines.push(`${v.members} definitions, ${v.internal} internal calls`);
  const hid = scene!.hiddenOf.get(d.key);
  if (hid) lines.push(`hidden: ${hid.map((k) => scene!.graph.nodes[k]?.name ?? k).join(', ')}${doc!.view.arrange === 'grow' ? '' : ` (click +${hid.length} to unhide)`}`);
  const fold = scene!.folds.get(d.key);
  if (fold) lines.push(`folded: ${fold.length} ${doc!.view.fold[d.key] === 'up' ? 'callers' : 'calls'} (click ${doc!.view.fold[d.key] === 'up' ? '◂' : '▸'} to open)`);
  lines.push(doc!.view.arrange === 'grow'
    ? '>> or └─>> show what is not on screen · arrowhead or line: close · double click: open or close · Delete: remove the selection'
    : '◂ open callers · ▸ open calls · hover: ▴ ▾ close them · double click: open or close');
  if (doc!.view.lock[d.key]) lines.push('locked');
  return lines.join('\n');
}

// ---- dragging units ------------------------------------------------------------------------------
function dragUnit(unitOf: (d: LabelSpan) => string) {
  let box: { x: number; y: number; w: number; h: number } | undefined;
  return drag<SVGGElement, LabelSpan>()
    // the default subject is the datum, which has no x, y: pointer position instead
    .subject((ev) => ({ x: ev.x, y: ev.y }))
    .clickDistance(4)
    .on('start', (_ev, d) => {
      const sc = scene!;
      const unit = unitOf(d);
      if (unit.startsWith('box:')) {
        const f = sc.placement.frames.find((x) => x.unit === unit)!;
        box = { x: X(f.c0), y: Y(f.r0), w: X(f.c1 - f.c0 + 1), h: Y(f.r1 - f.r0 + 1) };
      } else {
        let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
        for (const k of unitMembers(sc, unit)) {
          const p = sc.placement.pos.get(k);
          if (!p) continue;
          c0 = Math.min(c0, p.col); r0 = Math.min(r0, p.row);
          c1 = Math.max(c1, sc.placement.end.get(k)!); r1 = Math.max(r1, p.row);
        }
        box = { x: X(c0), y: Y(r0), w: X(c1 - c0), h: Y(r1 - r0 + 1) };
      }
    })
    .on('drag', (ev) => {
      if (!box) return;
      const o = root.select('.drag');
      o.selectAll('*').remove();
      o.append('rect').attr('x', box.x + ev.x - ev.subject.x).attr('y', box.y + ev.y - ev.subject.y)
        .attr('width', box.w).attr('height', box.h).attr('rx', 3);
    })
    .on('end', (ev, d) => {
      root.select('.drag').selectAll('*').remove();
      const dc = Math.round((ev.x - ev.subject.x) / cw), dr = Math.round((ev.y - ev.subject.y) / ch);
      box = undefined;
      if (!dc && !dr) return;
      const unit = unitOf(d);
      anchor = undefined;   // a moved unit is not pulled back to its old screen position
      commit((x) => {
        const lock = x.view.lock[unit];
        if (lock) x.view.lock[unit] = [lock[0] + dc, lock[1] + dr];
        else {
          const o = x.view.offset[unit] ?? [0, 0];
          x.view.offset[unit] = [o[0] + dc, o[1] + dr];
        }
      });
    });
}

/** Fold or unfold a vertex; a vertex with nothing below it expands through the language server instead. */
function toggleFold(key: NodeKey) {
  if (!doc) return;
  twisty(key, doc.view.direction === 'in' ? 'up' : 'down');
}

function lockUnit(unit: string) {
  if (!scene || !doc) return;
  const at = unitAnchor(scene, unit);
  if (!at) return;
  commit((x) => { x.view.lock[unit] = at; delete x.view.offset[unit]; });
}

function unlockUnit(unit: string) {
  if (!scene || !doc || !doc.view.lock[unit]) return;
  const here = unitAnchor(scene, unit)!;
  // keep the unit where it is: its offset becomes the distance to its computed place
  const probe = structuredClone(doc);
  delete probe.view.lock[unit];
  delete probe.view.offset[unit];
  const auto = unitAnchor(buildScene(probe, style!), unit);
  commit((x) => {
    delete x.view.lock[unit];
    if (auto && (here[0] !== auto[0] || here[1] !== auto[1])) x.view.offset[unit] = [here[0] - auto[0], here[1] - auto[1]];
  });
}

// ---- selection and paths ------------------------------------------------------------------------
function reach(start: NodeKey, dir: 'up' | 'down'): Set<NodeKey> {
  const sc = scene!;
  const out = new Set([start]);
  const q = [start];
  while (q.length) {
    const k = q.pop()!;
    const next = dir === 'down' ? (sc.vg.out.get(k) ?? []).map((e) => e.to) : (sc.vg.inc.get(k) ?? []).map((e) => e.from);
    for (const n of next) if (!out.has(n)) { out.add(n); q.push(n); }
  }
  return out;
}

/** Auto views rebuild from the seeds after a reset; stable views keep their data. */
const x0 = (d: ViewDoc) => d.view.arrange !== 'grow';

function runCmd(cmd: string, key?: NodeKey, unit?: string, to?: NodeKey) {
  if (!scene || !doc) return;
  const k = key ?? focusKey;
  const call = key && to ? { from: key, to } : selCalls.size ? unkey([...selCalls][0]) : undefined;
  switch (cmd) {
    case 'callSubtree': {
      // the clicked call, or the whole selection when the clicked call is part of it
      const calls = call && !selCalls.has(callKey(call)) ? [call] : [...selCalls].map(unkey);
      isolateCalls(calls.length ? calls : call ? [call] : []);
      return;
    }
    case 'callPath': if (call) isolate(new Set([...reachDrawn(call.from, 'up'), ...reachDrawn(call.to, 'down')])); return;
    case 'isolateSelection': {
      if (selCalls.size) isolateCalls([...selCalls].map(unkey));
      else if (selected.size) isolate(new Set(selected));
      return;
    }
    case 'resetView':
      commit((x) => {
        Object.assign(x.view, { expanded: {}, hidden: [], fold: {}, collapsed: [], offset: {}, lock: {}, sibling: {}, group: [], ungroup: [], straight: [] });
        delete x.view.cut;
        if (x.view.arrange === 'grow') x.view.open = {};
      }, x0(doc));
      anchor = undefined;
      fit();
      return;
    case 'callSite': {
      if (!call) return;
      const { caller, callee } = asCall(call);
      const e = scene.vg.edges.find((x) => x.from === caller && x.to === callee);
      api.postMessage({ type: 'openAt', key: caller, line: e && e.line < Number.MAX_SAFE_INTEGER ? e.line : undefined });
      return;
    }
    case 'callee': if (call) api.postMessage({ type: 'open', key: asCall(call).callee }); return;
    case 'resetLayout': commit((x) => { x.view.offset = {}; x.view.lock = {}; x.view.sibling = {}; x.view.straight = []; }); anchor = undefined; fit(); return;
    case 'showAll': commit((x) => { x.view.hidden = []; delete x.view.cut; }); return;
    case 'lock': if (unit ?? k) lockUnit(unit ?? k!); return;
    case 'openUp': if (k) setSide(k, 'up', true); return;
    case 'openDown': if (k) setSide(k, 'down', true); return;
    case 'closeUp': if (k) setSide(k, 'up', false); return;
    case 'closeDown': if (k) setSide(k, 'down', false); return;
    case 'straighten': {
      // route this call (or the selected calls) before all others
      const calls = call ? [callKey(call)] : [...selCalls];
      commit((x) => { x.view.straight = [...new Set([...calls, ...(x.view.straight ?? [])])]; });
      return;
    }
    case 'remove': {
      // stable arrangement: selected calls are cut (their branch goes unless shown through another call),
      // selected functions hidden; the caller or the opener keeps its screen position
      if (doc.view.arrange === 'grow' && selCalls.size) {
        const calls = [...selCalls].map(unkey).filter((c) => !isStub(c.to)).map(asCall);
        if (!calls.length) return;
        anchorAt(calls[0].caller);
        selCalls.clear();
        commit((x) => {
          const have = new Set((x.view.cut ?? []).map(([a, b]) => callKey({ from: a, to: b })));
          x.view.cut = [...(x.view.cut ?? []), ...calls.filter((c) => !have.has(callKey({ from: c.caller, to: c.callee })))
            .map((c) => [c.caller, c.callee] as [NodeKey, NodeKey])];
        });
        return;
      }
      const first = selected.size ? [...selected][0] : k;
      const by = first ? scene.rev.opener.get(first)?.by : undefined;
      if (by) anchorAt(by);
      runCmd('hideSelection');
      return;
    }
    case 'fold': if (k) toggleFold(k); return;
    case 'unlock': if (unit ?? k) unlockUnit(unit ?? k!); return;
    case 'upstream': if (k) selected = reach(k, 'up'); break;
    case 'downstream': if (k) selected = reach(k, 'down'); break;
    case 'through': if (k) selected = new Set([...reach(k, 'up'), ...reach(k, 'down')]); break;
    case 'between': {
      const [a, b] = [...selected];
      if (a && b) {
        const ab = [...reach(a, 'down')].filter((x) => reach(b, 'up').has(x));
        const ba = [...reach(b, 'down')].filter((x) => reach(a, 'up').has(x));
        selected = new Set([...ab, ...ba, a, b]);
      }
      break;
    }
    case 'hideSelection': {
      const sel = selected.size ? [...selected] : k ? [k] : [];
      selected.clear();
      commit((x) => { for (const s of sel) if (!x.view.hidden.includes(s)) x.view.hidden.push(s); });
      return;
    }
    case 'isolate': {
      const keep = selected.size ? selected : new Set(k ? [k] : []);
      const drop = [...scene.vg.nodes.keys()].filter((x) => !keep.has(x));
      commit((x) => { for (const s of drop) if (!x.view.hidden.includes(s)) x.view.hidden.push(s); });
      return;
    }
    case 'clearSelection': selected.clear(); selCalls.clear(); break;
    case 'showHidden': {
      const hid = k ? scene.hiddenOf.get(k) : undefined;
      if (k && hid) api.postMessage({ type: 'hiddenNeighbors', key: k, keys: hid });
      return;
    }
    case 'rearrange':
      // selected nodes only, else every unlocked move
      commit((x) => {
        if (selected.size) for (const k of selected) delete x.view.offset[k];
        else x.view.offset = {};
      });
      return;
    case 'unlockAll': commit((x) => { x.view.lock = {}; }); return;
  }
  render();
}

// ---- view placement ------------------------------------------------------------------------------
function placeView() {
  const t = api.getState()?.t as [number, number, number] | undefined;
  if (t) svg.call(zoomer.transform, zoomIdentity.translate(t[0], t[1]).scale(t[2]));
  else fit();
  placed = true;
}

function fit() {
  if (!scene) return;
  const el = svg.node()!;
  const w = el.clientWidth || 800, h = el.clientHeight || 600;
  const gw = Math.max(1, scene.grid.width * cw), gh = Math.max(1, scene.grid.height * ch);
  const k = Math.max(0.1, Math.min(1.25, (w - 24) / gw, (h - 24) / gh));
  svg.call(zoomer.transform, zoomIdentity.translate(12, 12).scale(k));
}

function setFocus(key: NodeKey | undefined) {
  focusKey = key;
  saveState({ focus: key });
  root.selectAll<SVGGElement, LabelSpan>('.labels g')
    .classed('focus', (d) => d.key === key)
    .classed('sel', (d) => selected.has(d.key));
  highlight(key);
}

function highlight(key: NodeKey | undefined) {
  const ov = root.select('.overlay');
  ov.selectAll('*').remove();
  root.selectAll('.labels g').classed('hl-in', false).classed('hl-out', false);
  if (!scene) return;
  const curve = doc!.view.curve ?? style!.edges.curve;
  const draw = (p: EdgePath, cls: string) => ov.append('path').attr('class', cls)
    .attr('d', curve === 'orthogonal' || (doc!.view.edges ?? style!.edges.mode) === 'glyph'
      ? `M${p.pts.map(([x, y]) => `${X(x)},${Y(y)}`).join('L')}` : curvePath(p, curve));
  // selection: calls with both ends selected, and the selected call
  if (selected.size > 1) for (const p of scene.grid.paths) if (selected.has(p.from) && selected.has(p.to)) draw(p, 'sel');
  for (const p of scene.grid.paths) if (selCalls.has(callKey(p))) draw(p, 'call');
  if (!key) return;
  for (const p of scene.grid.paths) if (p.from === key || p.to === key) draw(p, 'hl');
  const callers = new Set((scene.vg.inc.get(key) ?? []).map((e) => e.from));
  const callees = new Set((scene.vg.out.get(key) ?? []).map((e) => e.to));
  root.selectAll<SVGGElement, LabelSpan>('.labels g')
    .classed('hl-in', (d) => callers.has(d.key))
    .classed('hl-out', (d) => callees.has(d.key));
}

// ---- keyboard -----------------------------------------------------------------------------------
function moveFocus(delta: number) {
  if (!scene) return;
  const nodes = scene.grid.labels.filter((l) => l.kind === 'node').sort((a, b) => a.row - b.row || a.col - b.col);
  if (!nodes.length) return;
  const i = nodes.findIndex((l) => l.key === focusKey);
  const j = i < 0 ? 0 : Math.max(0, Math.min(nodes.length - 1, i + delta));
  selected = new Set([nodes[j].key]);
  setFocus(nodes[j].key);
}

function moveSibling(delta: -1 | 1) {
  if (!scene || !focusKey) return;
  const { slot, list } = siblingsOf(scene, focusKey);
  const i = list.indexOf(focusKey);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  commit((d) => { d.view.sibling[slot ?? ROOTS] = next; });
}

function collapseInnermost(key: NodeKey) {
  if (!doc) return;
  const nodes = doc.graph.nodes;
  const c = ancestors(nodes, key).find((a) => isContainer(nodes[a]) && !doc!.view.collapsed.includes(a));
  if (c) commit((d) => { d.view.collapsed.push(c); });
}

svg.on('keydown', (ev: KeyboardEvent) => {
  if (!doc || !style) return;
  const k = focusKey;
  const key = ev.key;
  if (ev.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) { moveSibling(key === 'ArrowUp' ? -1 : 1); ev.preventDefault(); return; }
  switch (key) {
    case 'ArrowDown': moveFocus(1); break;
    case 'ArrowUp': moveFocus(-1); break;
    case 'Enter':
      if (selCalls.size || selected.size > 1) runCmd('isolateSelection');
      else if (k) api.postMessage({ type: 'open', key: k });
      break;
    case 'e': case ' ': if (k) api.postMessage({ type: 'expand', key: k, dir: ev.shiftKey ? 'both' : undefined }); break;
    case 'ArrowLeft': case 'c': if (k) collapseInnermost(k); break;
    case 'ArrowRight': if (k && scene?.vg.nodes.get(k)?.collapsed) commit((d) => { d.view.collapsed = d.view.collapsed.filter((x) => x !== k); }); break;
    case 'Delete': case 'Backspace': runCmd('remove'); break;
    case 'h': runCmd('hideSelection'); break;
    case 'i': runCmd('isolate'); break;
    case 'Escape':
      // a selection first, then everything hidden or removed
      if (selected.size || selCalls.size) runCmd('clearSelection');
      else if (doc.view.hidden.length || doc.view.cut?.length) runCmd('showAll');
      break;
    case 'k': if (k) runCmd(doc.view.lock[k] ? 'unlock' : 'lock', k, k); break;
    case 'f': if (k) toggleFold(k); break;
    case 'u': commit((d) => { d.view.hidden = []; }); break;
    case 'o': commit((d) => { d.view.order = d.view.order === 'callees' ? 'callers' : 'callees'; }); break;
    case 'g': commit((d) => { d.view.edges = (d.view.edges ?? style!.edges.mode) === 'glyph' ? 'vector' : 'glyph'; }); break;
    case 'b': commit((d) => { d.view.boxes = !(d.view.boxes ?? style!.boxes.enabled); }); break;
    case 'r': api.postMessage({ type: 'refresh' }); break;
    case '0': fit(); break;
    case 'x': api.postMessage({ type: 'export' }); break;
    default: return;
  }
  ev.preventDefault();
});

// ---- toolbar and options pulldown ----------------------------------------------------------------
// Plain HTML built with d3-selection: buttons in the bar, a pulldown panel of checkable items.
type Btn = { label: string; title: string; on?: boolean; act: () => void; disabled?: boolean };
type Section = { caption: string; items: Btn[]; radio?: boolean };

function folders(): { path: string; label: string; excluded: boolean }[] {
  if (!doc) return [];
  const ex = excludedBy(doc.view, excludeGlobs.map(globToRegExp));
  const dirs = Object.values(doc.graph.nodes).filter((n) => n.path && !isContainer(n)).map((n) => n.path!.split('/').slice(0, -1));
  if (!dirs.length && !doc.view.exclude.length && !doc.view.include.length) return [];
  let prefix = dirs[0] ?? [];
  for (const d of dirs) { let i = 0; while (i < prefix.length && i < d.length && prefix[i] === d[i]) i++; prefix = prefix.slice(0, i); }
  const set = new Set<string>();
  for (const d of dirs) if (d.length > prefix.length) set.add([...prefix, d[prefix.length]].join('/'));
  for (const p of [...doc.view.exclude, ...doc.view.include]) set.add(p);
  return [...set].sort().map((p) => ({ path: p, label: p.split('/').pop()!, excluded: ex(`${p}/x`) }));
}

/** Traverse checkmarks: `in` and `out` independent; unchecking a side drops its expansions and folds. */
function setTraverse(side: 'in' | 'out', on: boolean) {
  const grows = doc!.view.arrange === 'grow';
  commit((x) => {
    const has = { in: x.view.direction !== 'out', out: x.view.direction !== 'in' };
    has[side] = on;
    if (!has.in && !has.out) return;
    x.view.direction = has.in && has.out ? 'both' : has.in ? 'in' : 'out';
    if (!on) {
      for (const [k, d] of Object.entries(x.view.expanded)) {
        if (d === side) delete x.view.expanded[k];
        else if (d === 'both') x.view.expanded[k] = side === 'in' ? 'out' : 'in';
      }
      for (const [k, f] of Object.entries(x.view.fold)) if ((f === 'up') === (side === 'in')) delete x.view.fold[k];
    }
  }, !grows);
  // stable views: a seed opening a side without data asks the language server
  if (grows && on) for (const s0 of doc!.view.seeds) {
    const ex = doc!.explored?.[s0];
    if (ex !== side && ex !== 'both') api.postMessage({ type: 'expand', key: s0, dir: side });
  }
}

function toolbar() {
  if (!doc || !style) return;
  const v = doc.view;
  const mode = v.edges ?? style.edges.mode;
  const curve = v.curve ?? style.edges.curve;
  const rule = v.parentRule ?? style.grid.parentRule;
  const boxes = v.boxes ?? style.boxes.enabled;
  const removed = v.hidden.length + (v.cut?.length ?? 0);
  const isolated = removed > 0;
  const canIsolate = selCalls.size > 0 || selected.size > 0;

  const bar: Btn[] = [
    isolated
      ? { label: `Show all (${removed})`, title: 'show every hidden function and removed call (Esc)', on: true, act: () => runCmd('showAll') }
      : { label: 'Isolate', title: 'show only the selected calls or functions (Enter)', disabled: !canIsolate, act: () => runCmd('isolateSelection') },
    ...(v.arrange === 'grow' ? [] : [
      { label: '−', title: 'depth − 1', act: () => commit((x) => { x.view.depth = Math.max(1, x.view.depth - 1); }, true) },
      { label: `depth ${v.depth}`, title: 'hop limit from the seeds', act: () => {} },
      { label: '+', title: 'depth + 1', act: () => commit((x) => { x.view.depth += 1; }, true) },
    ]),
    { label: 'fit', title: 'fit to window (0)', act: fit },
  ];
  const fl = folders();
  const sections: Section[] = [
    { caption: 'Traverse', items: [
      { label: 'Upstream callers', title: 'follow incoming calls from the seeds', on: v.direction !== 'out', act: () => setTraverse('in', v.direction === 'out') },
      { label: 'Calls downstream', title: 'follow outgoing calls from the seeds', on: v.direction !== 'in', act: () => setTraverse('out', v.direction === 'in') },
    ] },
    { caption: 'Layout', radio: true, items: [
      { label: 'One layer at a time', title: '>> and └─>> open a side; an arrowhead or a line closes it; Delete removes the selection; the function opened stays in place on screen', on: v.arrange === 'grow',
        act: () => commit((x) => { x.view.arrange = 'grow'; x.view.open ??= {}; }) },
      { label: 'Automatic: full layout', title: 'the whole graph to the depth limit, laid out again on every change', on: v.arrange !== 'grow',
        act: () => commit((x) => { x.view.arrange = 'auto'; }, true) },
    ] },
    { caption: 'Order', radio: true, items: (['callers', 'callees'] as Order[]).map((o) => ({
      label: o === 'callers' ? 'Callers on top' : 'Callees on top (VS Code call hierarchy)', title: 'which end of each call sits on top (o)',
      on: v.order === o, act: () => commit((x) => { x.view.order = o; }),
    })) },
    { caption: 'Namespaces', items: [
      { label: 'Group namespaces', title: 'boxes per package and folder (b); right click a box or function to group or ungroup one', on: boxes,
        act: () => commit((x) => { x.view.boxes = !boxes; }) },
      ...(v.group.length || v.ungroup.length ? [{ label: `Reset grouping (${v.group.length + v.ungroup.length})`, title: 'drop per-box group and ungroup choices',
        act: () => commit((x) => { x.view.group = []; x.view.ungroup = []; }) }] : []),
    ] },
    { caption: 'Edges', radio: true, items: (['glyph', 'vector'] as const).map((m) => ({
      label: m === 'glyph' ? 'Glyphs (UTF box drawing)' : 'Vector', title: 'edge drawing (g)', on: mode === m, act: () => commit((x) => { x.view.edges = m; }),
    })) },
    ...(mode === 'vector' ? [{ caption: 'Curve', radio: true, items: (['orthogonal', 'rounded', 'sigmoid', 'spline'] as Curve[]).map((c) => ({
      label: c, title: 'curve style of vector edges', on: curve === c, act: () => commit((x) => { x.view.curve = c; }),
    })) } as Section] : []),
    { caption: 'Tree parent', radio: true, items: (['dfs', 'nearest'] as const).map((m) => ({
      label: m === 'dfs' ? 'First caller found (dfs)' : 'Nearest caller above', title: 'which caller a shared function hangs under', on: rule === m,
      act: () => commit((x) => { x.view.parentRule = m; }) })) },
    { caption: 'Arrange', items: [
      v.arrange === 'grow'
        ? { label: 'Reset view', title: 'back to the seeds and their first layer: close every side, drop hidden and removed, collapsed, moves, locks, grouping', act: () => runCmd('resetView') }
        : { label: 'Reset view', title: 'back to the seeds, direction and depth: drop expansions, folds, hidden, collapsed, moves, locks, grouping', act: () => runCmd('resetView') },
      { label: 'Reset layout', title: 'drop every move, lock, sibling order and straightened call', act: () => runCmd('resetLayout') },
      { label: selected.size ? `Re-arrange selected (${selected.size})` : `Re-arrange (${Object.keys(v.offset).length})`,
        title: 'drop the moves of the selected functions, or of every unlocked item', act: () => runCmd('rearrange') },
      { label: `Unlock all (${Object.keys(v.lock).length})`, title: 'unlock every locked function and box', act: () => runCmd('unlockAll') },
      { label: `Expand collapsed (${v.collapsed.length})`, title: 'expand every collapsed container', act: () => commit((x) => { x.view.collapsed = []; }) },
      v.arrange === 'grow'
        ? { label: `Straightened calls (${(v.straight ?? []).length}): clear`, title: 'route every call in the usual order again', act: () => commit((x) => { x.view.straight = []; }) }
        : { label: `Open folds (${Object.keys(v.fold).length})`, title: 'open every folded function', act: () => commit((x) => { x.view.fold = {}; }) },
    ] },
    ...(fl.length ? [{ caption: 'Folders', items: fl.map((f) => ({
      label: f.label, title: `${f.path}: ${f.excluded ? 'excluded, click to include' : 'included, click to exclude'}`, on: !f.excluded,
      act: () => commit((x) => {
        if (f.excluded) {
          if (x.view.exclude.includes(f.path)) x.view.exclude = x.view.exclude.filter((p) => p !== f.path);
          else x.view.include.push(f.path);
        } else {
          x.view.include = x.view.include.filter((p) => p !== f.path);
          x.view.exclude.push(f.path);
        }
      }, true) })) } as Section] : []),
    { caption: 'File', items: [
      { label: 'Ask the language server again', title: v.arrange === 'grow'
        ? 'calls of the functions on screen from the language server; the others when a side opens onto them. Unanswered functions keep their calls (r)'
        : 'from the cache at once, then every function from the language server. Unanswered functions keep their calls (r)',
      act: () => api.postMessage({ type: 'refresh' }) },
      { label: 'Export ASCII', title: '.gaffy/<symbol>_<commit>.md and .txt, then _2, _3 (x)', act: () => api.postMessage({ type: 'export' }) },
      { label: 'Edit style.json', title: '.gaffy/style.json', act: () => api.postMessage({ type: 'editStyle' }) },
    ] },
  ];

  const tb = select('#toolbar');
  tb.selectAll('*').remove();
  for (const b of bar) {
    tb.append('button').attr('class', b.on ? 'on' : null).attr('title', b.title).property('disabled', !!b.disabled).text(b.label)
      .on('click', (ev: MouseEvent) => { ev.stopPropagation(); b.act(); });
  }
  const wrap = tb.append('span').attr('class', 'opts');
  wrap.append('button').attr('class', optsOpen ? 'on' : null).text('☰ Options ▾').attr('title', 'traverse, order, namespaces, edges, arrange, folders')
    .on('click', (ev: MouseEvent) => { ev.stopPropagation(); optsOpen = !optsOpen; toolbar(); });
  if (optsOpen) {
    const panel = wrap.append('div').attr('class', 'panel').on('click', (ev: MouseEvent) => ev.stopPropagation());
    for (const sec of sections) {
      panel.append('div').attr('class', 'caption').text(sec.caption);
      for (const it of sec.items) {
        const row = panel.append('div').attr('class', 'item').attr('title', it.title).on('click', () => it.act());
        row.append('span').attr('class', 'check').text(it.on === undefined ? '' : it.on ? (sec.radio ? '●' : '✓') : (sec.radio ? '○' : ''));
        row.append('span').text(it.label);
      }
    }
  }
}

document.addEventListener('click', () => { if (optsOpen) { optsOpen = false; toolbar(); } });

function status() {
  const el = select('#status');
  if (!scene || !doc) { el.text(busy ? 'building…' : ''); return; }
  const parts = [`${scene.vg.nodes.size} nodes`, `${scene.vg.edges.length} calls`];
  if (selected.size) parts.push(`${selected.size} selected`);
  if (selCalls.size === 1) {
    const { caller, callee } = asCall(unkey([...selCalls][0]));
    parts.push(`call ${scene.graph.nodes[caller]?.name ?? caller}() → ${scene.graph.nodes[callee]?.name ?? callee}()`);
  } else if (selCalls.size) parts.push(`${selCalls.size} calls selected (Enter: isolate)`);
  if (scene.grid.unrouted) parts.push(`${scene.grid.unrouted} calls unrouted`);
  if (doc.truncated) parts.push('truncated at gaffy.maxNodes');
  if (note) parts.push(note);
  if (busy) parts.push('building…');
  else if (doc.updated) parts.push(`built ${new Date(doc.updated).toLocaleString()}`);
  parts.push(doc.view.arrange === 'grow'
    ? '>> └─>> open · arrowhead or line: close · ctrl/shift+click select · Delete remove · dblclick toggle · drag move · right-click menu'
    : 'click open · shift+click select · dblclick fold or expand · drag move · right-click menu · keys ↑↓ Enter e f c h i k u o g b r 0 x Esc');
  el.text(parts.join(' · '));
}

/** Progress line over the graph while a build runs. */
function banner(text: string | undefined) {
  const b = select('#banner');
  b.classed('on', !!text && busy).text(text ? `⟳ ${text}` : '');
}

function showError(msg: string) {
  root.selectAll('*').remove();
  root.append('text').attr('class', 'empty').attr('x', 0).attr('y', 16).text(msg);
}

// last statement: every module-level binding exists before the host answers
api.postMessage({ type: 'ready' });
