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
import { cellRC, charRows, EdgePath, Grid, LabelSpan } from '../core/grid';
import { ancestors, isContainer, NodeKey } from '../core/model';
import { buildScene, Scene, siblingsOf, unitAnchor, unitMembers } from '../core/scene';
import { Curve, E, glyphSet, N, S, Style, W } from '../core/style';
import { Direction, excludedBy, globToRegExp, Order, parseDoc, ROOTS, serializeDoc, ViewDoc } from '../core/viewdoc';

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
let selectedCall: { from: NodeKey; to: NodeKey } | undefined;   // drawn direction
let busy = false;
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

function maskPaths(g: Grid): Map<string, string> {
  const segs = new Map<string, string[]>();
  for (const [id, nets] of g.cells) {
    const [r, c] = cellRC(id);
    const x = (c + 0.5) * cw, y = (r + 0.5) * ch;
    for (const [net, m] of nets) {
      let a = segs.get(net);
      if (!a) segs.set(net, (a = []));
      if (m & N) a.push(`M${x},${y}V${r * ch}`);
      if (m & S) a.push(`M${x},${y}V${(r + 1) * ch}`);
      if (m & E) a.push(`M${x},${y}H${(c + 1) * cw}`);
      if (m & W) a.push(`M${x},${y}H${c * cw}`);
    }
  }
  return new Map([...segs].map(([k, v]) => [k, v.join('')]));
}

/** One call as an SVG path: polyline with rounded corners, sigmoid S-curves, or a B-spline. */
function curvePath(p: EdgePath, curve: Curve): string {
  const pts = p.pts.map(([x, y]) => [X(x), Y(y)] as [number, number]);
  if (curve === 'spline') return line().curve(curveBasis)(pts) ?? '';
  if (curve === 'sigmoid') {
    const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
    if (p.start === 'S') {
      // from under the caller: vertical start, horizontal end
      return `M${x0},${y0}C${x0},${y1} ${x0},${y1} ${x1},${y1}`;
    }
    const dx = Math.max(cw * 2, Math.abs(x1 - x0) / 2);
    const c2 = p.arrive === 'E' ? x1 - dx : x1 + dx;
    return `M${x0},${y0}C${x0 + dx},${y0} ${c2},${y1} ${x1},${y1}`;
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
    if (mode === 'vector') gf.append('rect').attr('class', 'frame').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 4);
  }

  const ge = root.append('g').attr('class', 'edges');
  if (mode === 'glyph') {
    const sy = Math.max(1, style.font.lineHeight / 1.15);
    const cells: { r: number; c: number; t: string }[] = [];
    charRows(g, gs, true).forEach((row, r) => row.forEach((t, c) => { if (t !== ' ') cells.push({ r, c, t }); }));
    ge.selectAll('text').data(cells).join('text')
      .attr('transform', (d) => `translate(${d.c * cw},${(d.r + 0.5) * ch})${VERTICAL.has(d.t) ? ` scale(1,${sy})` : ''}`)
      .text((d) => d.t);
  } else if (curve === 'orthogonal') {
    for (const [net, d] of maskPaths(g)) ge.append('path').attr('class', 'net').attr('data-net', net).attr('d', d);
    for (const [id, nets] of g.cells) {
      let u = 0, pure = nets.size > 1;
      for (const m of nets.values()) { u |= m; if (m !== (N | S) && m !== (E | W)) pure = false; }
      if (popcount(u) >= 3 && !pure) {
        const [r, c] = cellRC(id);
        ge.append('circle').attr('class', 'joint').attr('cx', (c + 0.5) * cw).attr('cy', (r + 0.5) * ch).attr('r', 1.8);
      }
    }
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
  root.append('g').attr('class', 'hits').selectAll('path').data(g.paths).join('path')
    .attr('d', (p) => callD(p))
    .attr('data-vscode-context', (p) => JSON.stringify({ webviewSection: 'edge', key: p.from, to: p.to, preventDefaultContextMenuItems: true }))
    .on('mouseenter', (_ev, p) => highlightCall(p))
    .on('mouseleave', () => highlight(focusKey))
    .on('click', (ev: MouseEvent, p) => { ev.stopPropagation(); selectedCall = { from: p.from, to: p.to }; highlight(focusKey); status(); })
    .on('dblclick', (ev: MouseEvent, p) => { ev.stopPropagation(); runCmd('callSubtree', p.from, undefined, p.to); })
    .append('title').text((p) => callTitle(p));

  // labels
  const gl = root.append('g').attr('class', 'labels');
  const nodes = gl.selectAll<SVGGElement, LabelSpan>('g').data(g.labels.filter((l) => l.kind === 'node')).join('g')
    .attr('class', (d) => labelClass(d))
    .attr('transform', (d) => `translate(${d.col * cw},${d.row * ch})`)
    .attr('data-vscode-context', (d) => JSON.stringify({
      webviewSection: sc.vg.nodes.get(d.key)?.collapsed ? 'collapsed' : 'node',
      key: d.key, unit: d.key, preventDefaultContextMenuItems: true,
    }));
  nodes.append('rect').attr('class', 'hit').attr('x', -2).attr('y', 0).attr('width', (d) => d.text.length * cw + 4).attr('height', ch).attr('rx', 2);
  nodes.append('text').attr('y', ch / 2).each(function (d) {
    const hid = sc.hiddenOf.get(d.key);
    const badge = hid ? ` +${hid.length}` : '';
    const t = select(this);
    t.append('tspan').text(badge ? d.text.slice(0, d.text.length - badge.length) : d.text);
    if (badge) {
      t.append('tspan').attr('class', 'badge').text(badge)
        .on('click', (ev: MouseEvent) => { ev.stopPropagation(); api.postMessage({ type: 'hiddenNeighbors', key: d.key, keys: hid }); });
    }
  });
  nodes.append('title').text((d) => tooltip(d));
  nodes
    .on('click', (ev: MouseEvent, d) => {
      ev.stopPropagation();
      if (ev.shiftKey) { selected.has(d.key) ? selected.delete(d.key) : selected.add(d.key); }
      else { selected = new Set([d.key]); api.postMessage({ type: 'open', key: d.key }); }
      setFocus(d.key);
    })
    .on('dblclick', (ev: MouseEvent, d) => {
      ev.stopPropagation();
      if (sc.vg.nodes.get(d.key)?.collapsed) commit((x) => { x.view.collapsed = x.view.collapsed.filter((c) => c !== d.key); });
      else if (ev.shiftKey) api.postMessage({ type: 'expand', key: d.key, dir: 'both' });
      else toggleFold(d.key);
    })
    .on('mouseenter', (_ev, d) => highlight(d.key))
    .on('mouseleave', () => highlight(focusKey));
  nodes.call(dragUnit((d) => d.key) as any);

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
  heads.append('title').text((d) => `${d.text}\ndrag to move · double click to collapse${doc!.view.lock[d.key] ? ' · locked' : ''}`);
  heads.on('dblclick', (ev: MouseEvent, d) => {
    ev.stopPropagation();
    commit((x) => { if (!x.view.collapsed.includes(d.key.slice(4))) x.view.collapsed.push(d.key.slice(4)); });
  });
  heads.call(dragUnit((d) => d.key) as any);

  root.append('g').attr('class', 'drag');
  svg.on('click', () => { selected.clear(); selectedCall = undefined; setFocus(undefined); });
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

function highlightCall(p: { from: NodeKey; to: NodeKey }) {
  const ov = root.select('.overlay');
  ov.selectAll('path.hl').remove();
  for (const q of scene!.grid.paths) if (q.from === p.from && q.to === p.to) ov.append('path').attr('class', 'hl').attr('d', callD(q));
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
  if (sc.folds.has(d.key)) cls.push('folded');
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
  if (hid) lines.push(`hidden: ${hid.map((k) => scene!.graph.nodes[k]?.name ?? k).join(', ')} (click +${hid.length} to unhide)`);
  const fold = scene!.folds.get(d.key);
  if (fold) lines.push(`folded: ${fold.length} below (double click to unfold)`);
  else if ((scene!.drawn.out.get(d.key) ?? []).length) lines.push('double click to fold what lies below');
  else lines.push('double click to expand through the language server');
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
  if (!scene || !doc) return;
  if (doc.view.folded.includes(key)) { commit((x) => { x.view.folded = x.view.folded.filter((f) => f !== key); }); return; }
  if ((scene.drawn.out.get(key) ?? []).length) { commit((x) => { x.view.folded.push(key); }); return; }
  api.postMessage({ type: 'expand', key });
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

function runCmd(cmd: string, key?: NodeKey, unit?: string, to?: NodeKey) {
  if (!scene || !doc) return;
  const k = key ?? focusKey;
  const call = key && to ? { from: key, to } : selectedCall;
  switch (cmd) {
    case 'callSubtree': if (call) isolate(new Set([call.from, ...reachDrawn(call.to, 'down')])); return;
    case 'callPath': if (call) isolate(new Set([...reachDrawn(call.from, 'up'), ...reachDrawn(call.to, 'down')])); return;
    case 'callSite': {
      if (!call) return;
      const { caller, callee } = asCall(call);
      const e = scene.vg.edges.find((x) => x.from === caller && x.to === callee);
      api.postMessage({ type: 'openAt', key: caller, line: e && e.line < Number.MAX_SAFE_INTEGER ? e.line : undefined });
      return;
    }
    case 'callee': if (call) api.postMessage({ type: 'open', key: asCall(call).callee }); return;
    case 'resetLayout': commit((x) => { x.view.offset = {}; x.view.lock = {}; x.view.sibling = {}; }); fit(); return;
    case 'showAll': commit((x) => { x.view.hidden = []; x.view.folded = []; x.view.collapsed = []; }); return;
    case 'lock': if (unit ?? k) lockUnit(unit ?? k!); return;
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
    case 'clearSelection': selected.clear(); selectedCall = undefined; break;
    case 'showHidden': {
      const hid = k ? scene.hiddenOf.get(k) : undefined;
      if (k && hid) api.postMessage({ type: 'hiddenNeighbors', key: k, keys: hid });
      return;
    }
    case 'rearrange': commit((x) => { x.view.offset = {}; }); return;
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
  if (selectedCall) for (const p of scene.grid.paths) if (p.from === selectedCall.from && p.to === selectedCall.to) draw(p, 'call');
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
    case 'Enter': if (k) api.postMessage({ type: 'open', key: k }); break;
    case 'e': case ' ': if (k) api.postMessage({ type: 'expand', key: k, dir: ev.shiftKey ? 'both' : undefined }); break;
    case 'ArrowLeft': case 'c': if (k) collapseInnermost(k); break;
    case 'ArrowRight': if (k && scene?.vg.nodes.get(k)?.collapsed) commit((d) => { d.view.collapsed = d.view.collapsed.filter((x) => x !== k); }); break;
    case 'h': case 'Delete': runCmd('hideSelection'); break;
    case 'i': runCmd('isolate'); break;
    case 'Escape': runCmd('clearSelection'); break;
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

// ---- toolbar and status -------------------------------------------------------------------------
type Btn = { label: string; title: string; on?: boolean; act: () => void };
type Group = { caption?: string; items: Btn[] };

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

function toolbar() {
  if (!doc || !style) return;
  const v = doc.view;
  const mode = v.edges ?? style.edges.mode;
  const curve = v.curve ?? style.edges.curve;
  const rule = v.parentRule ?? style.grid.parentRule;
  const boxes = v.boxes ?? style.boxes.enabled;
  const groups: Group[] = [
    { items: [{ label: '⟳ rebuild', title: 'rebuild from the language server (r)', act: () => api.postMessage({ type: 'refresh' }) }] },
    { caption: 'traverse', items: (['in', 'out', 'both'] as Direction[]).map((d) => ({
      label: d === 'in' ? 'callers' : d === 'out' ? 'callees' : 'both', title: `follow ${d === 'in' ? 'incoming' : d === 'out' ? 'outgoing' : 'incoming and outgoing'} calls from the seeds`,
      on: v.direction === d, act: () => commit((x) => { x.view.direction = d; }, true),
    })) },
    { caption: 'depth', items: [
      { label: '−', title: 'depth − 1', act: () => commit((x) => { x.view.depth = Math.max(1, x.view.depth - 1); }, true) },
      { label: String(v.depth), title: 'hop limit from the seeds', act: () => {} },
      { label: '+', title: 'depth + 1', act: () => commit((x) => { x.view.depth += 1; }, true) },
    ] },
    { caption: 'order', items: (['callers', 'callees'] as Order[]).map((o) => ({
      label: o === 'callers' ? 'callers on top' : 'callees on top',
      title: o === 'callers' ? 'caller above, └─> to the callee (o)' : 'callee above, └── to its callers, as VS Code call hierarchy (o)',
      on: v.order === o, act: () => commit((x) => { x.view.order = o; }),
    })) },
    { caption: 'namespaces', items: [{ label: boxes ? 'boxes on' : 'boxes off', title: 'namespace boxes (b)', on: boxes,
      act: () => commit((x) => { x.view.boxes = !boxes; }) }] },
    { caption: 'edges', items: [
      ...(['glyph', 'vector'] as const).map((m) => ({ label: m, title: 'glyph: UTF box drawing; vector: SVG lines (g)', on: mode === m,
        act: () => commit((x) => { x.view.edges = m; }) })),
      ...(mode === 'vector' ? (['orthogonal', 'rounded', 'sigmoid', 'spline'] as Curve[]).map((c) => ({ label: c, title: 'curve style', on: curve === c,
        act: () => commit((x) => { x.view.curve = c; }) })) : []),
    ] },
    { caption: 'tree', items: (['dfs', 'nearest'] as const).map((m) => ({ label: m, title: 'tree parent rule', on: rule === m,
      act: () => commit((x) => { x.view.parentRule = m; }) })) },
    { caption: 'arrange', items: [
      { label: 'fit', title: 'fit to window (0)', act: fit },
      { label: 'reset layout', title: 'drop every move, lock and sibling order', act: () => runCmd('resetLayout') },
      { label: `re-arrange ${Object.keys(v.offset).length}`, title: 'drop the moves of unlocked nodes and boxes; locked ones stay', act: () => runCmd('rearrange') },
      { label: `unlock ${Object.keys(v.lock).length}`, title: 'unlock every locked node and box', act: () => runCmd('unlockAll') },
      { label: `show all ${v.hidden.length + v.folded.length + v.collapsed.length}`, title: 'unhide, unfold, and expand collapsed containers', act: () => runCmd('showAll') },
    ] },
  ];
  const fl = folders();
  if (fl.length) {
    groups.push({ caption: 'folders', items: fl.map((f) => ({ label: f.label, title: `${f.path}: ${f.excluded ? 'excluded, click to include' : 'included, click to exclude'}`,
      on: !f.excluded, act: () => commit((x) => {
        if (f.excluded) {
          if (x.view.exclude.includes(f.path)) x.view.exclude = x.view.exclude.filter((p) => p !== f.path);
          else x.view.include.push(f.path);
        } else {
          x.view.include = x.view.include.filter((p) => p !== f.path);
          x.view.exclude.push(f.path);
        }
      }, true) })) });
  }
  groups.push({ items: [
    { label: 'export', title: 'ASCII export to .gaffy/export (x)', act: () => api.postMessage({ type: 'export' }) },
    { label: 'style', title: 'edit .gaffy/style.json', act: () => api.postMessage({ type: 'editStyle' }) },
  ] });

  const bar = select('#toolbar');
  bar.selectAll('*').remove();
  groups.forEach((grp, i) => {
    if (i) bar.append('span').attr('class', 'sep');
    if (grp.caption) bar.append('span').attr('class', 'caption').text(`${grp.caption}:`);
    for (const b of grp.items) bar.append('button').attr('class', b.on ? 'on' : null).attr('title', b.title).text(b.label).on('click', () => b.act());
  });
}

function status() {
  const el = select('#status');
  if (!scene || !doc) { el.text(busy ? 'building…' : ''); return; }
  const parts = [`${scene.vg.nodes.size} nodes`, `${scene.vg.edges.length} calls`];
  if (selected.size) parts.push(`${selected.size} selected`);
  if (selectedCall) {
    const { caller, callee } = asCall(selectedCall);
    parts.push(`call ${scene.graph.nodes[caller]?.name ?? caller}() → ${scene.graph.nodes[callee]?.name ?? callee}()`);
  }
  if (scene.grid.unrouted) parts.push(`${scene.grid.unrouted} calls unrouted`);
  if (doc.truncated) parts.push('truncated at gaffy.maxNodes');
  if (busy) parts.push('building…');
  else if (doc.updated) parts.push(`built ${new Date(doc.updated).toLocaleString()}`);
  parts.push('click open · shift+click select · dblclick fold or expand · drag move · right-click menu · keys ↑↓ Enter e f c h i k u o g b r 0 x Esc');
  el.text(parts.join(' · '));
}

function showError(msg: string) {
  root.selectAll('*').remove();
  root.append('text').attr('class', 'empty').attr('x', 0).attr('y', 16).text(msg);
}

// last statement: every module-level binding exists before the host answers
api.postMessage({ type: 'ready' });
