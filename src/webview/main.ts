/**
 * Webview renderer. Receives the view text and style from the host, runs the core pipeline
 * (quotient, layout, grid) and draws the grid with D3:
 *   glyph mode:  one <text> per edge cell (box-drawing glyphs at exact cell positions)
 *   vector mode: one <path> per net from the same direction masks, joints as dots, arrowheads
 * Local changes (collapse, hide, reorder, flip, modes) commit a new document text to the host.
 */
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { cellRC, charRows, Grid, LabelSpan } from '../core/grid';
import { ancestors, isContainer, mergeGraphs, NodeKey } from '../core/model';
import { buildScene, Scene, siblingsOf } from '../core/scene';
import { E, glyphSet, N, S, Style, W } from '../core/style';
import { Direction, parseDoc, ROOTS, serializeDoc, ViewDoc } from '../core/viewdoc';

interface VsApi { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsApi;
const api = acquireVsCodeApi();

let text = '';
let name = 'view';
let doc: ViewDoc | undefined;
let style: Style | undefined;
let styleText = '';
let scene: Scene | undefined;
let netPaths = new Map<string, string>();
let focusKey: NodeKey | undefined = api.getState()?.focus;
let busy = false;
let cw = 8;
let ch = 16;
let placed = false;

const svg = select<SVGSVGElement, unknown>('#graph');
const root = svg.append('g').attr('class', 'root');
const zoomer = zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.08, 8])
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
    const st = JSON.stringify(m.style);
    if (m.text === text && st === styleText && doc) { status(); return; }
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
  }
});
api.postMessage({ type: 'ready' });

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

function vectorPaths(g: Grid): Map<string, string> {
  const segs = new Map<string, string[]>();
  for (const [id, nets] of g.cells) {
    const [r, c] = cellRC(id);
    const x = (c + 0.5) * cw;
    const y = (r + 0.5) * ch;
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

const gridRow = (r: number) => (doc?.view.orientation === 'up' && scene ? scene.grid.height - 1 - r : r);

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
  const gs = glyphSet(style);
  netPaths = vectorPaths(g);

  root.selectAll('*').remove();
  root.attr('class', `root mode-${mode}`)
    .style('font-family', style.font.family)
    .style('font-size', `${style.font.size}px`);

  if (!g.labels.length) {
    root.append('text').attr('class', 'empty').attr('x', 0).attr('y', ch)
      .text(doc.view.seeds.length ? 'building…' : 'empty view: run "gaffy: Graph Callers / Callees" from an editor context menu');
  }

  // container boxes behind everything
  if (style.container.boxes) {
    const gb = root.append('g').attr('class', 'boxes');
    for (const b of sc.layout.brackets) {
      let c0 = Infinity, c1 = 0;
      for (let r = b.lo; r <= b.hi; r++) {
        const row = sc.layout.rows[r];
        if (row.kind !== 'node') continue;
        c0 = Math.min(c0, row.col);
        c1 = Math.max(c1, row.end);
      }
      const r0 = Math.min(gridRow(b.lo), gridRow(b.hi));
      const r1 = Math.max(gridRow(b.lo), gridRow(b.hi));
      gb.append('rect').attr('x', (c0 - 0.5) * cw).attr('y', r0 * ch + 1)
        .attr('width', (c1 - c0 + 1) * cw).attr('height', (r1 - r0 + 1) * ch - 2).attr('rx', 3);
    }
  }

  const ge = root.append('g').attr('class', 'edges');
  if (mode === 'glyph') {
    // box-drawing glyphs span about 1.15 em; rows taller than that would leave gaps in vertical strokes,
    // so glyphs with a vertical stroke stretch vertically to the row height
    const sy = Math.max(1, style.font.lineHeight / 1.15);
    const cells: { r: number; c: number; t: string }[] = [];
    charRows(g, gs, true).forEach((row, r) => row.forEach((t, c) => { if (t !== ' ') cells.push({ r, c, t }); }));
    ge.selectAll('text').data(cells).join('text')
      .attr('transform', (d) => `translate(${d.c * cw},${(d.r + 0.5) * ch})${VERTICAL.has(d.t) ? ` scale(1,${sy})` : ''}`)
      .text((d) => d.t);
  } else {
    for (const [net, d] of netPaths) {
      ge.append('path').attr('class', `net ${net[0] === 't' ? 'tree' : 'lane'}`).attr('data-net', net).attr('d', d);
    }
    for (const [id, nets] of g.cells) {
      if (nets.size < 2 && popcount(nets.values().next().value!) < 3) continue;
      let u = 0, pure = true;
      for (const m of nets.values()) { u |= m; if (m !== (N | S) && m !== (E | W)) pure = false; }
      if (popcount(u) >= 3 && !(pure && nets.size > 1)) {
        const [r, c] = cellRC(id);
        ge.append('circle').attr('class', 'joint').attr('cx', (c + 0.5) * cw).attr('cy', (r + 0.5) * ch).attr('r', 1.8);
      }
    }
    for (const m of g.marks) {
      const x = (m.col + 0.5) * cw, y = (m.row + 0.5) * ch, a = ch * 0.22;
      if (m.role === 'arrowE') ge.append('path').attr('class', 'arrow').attr('d', `M${x - a},${y - a}L${x + a},${y}L${x - a},${y + a}Z`);
      else if (m.role === 'arrowW') ge.append('path').attr('class', 'arrow').attr('d', `M${x + a},${y - a}L${x - a},${y}L${x + a},${y + a}Z`);
      else ge.append('text').attr('x', m.col * cw).attr('y', y)
        .text(m.role === 'top' ? gs.bracket.top : m.role === 'bot' ? gs.bracket.bot : m.role === 'mid' ? gs.bracket.mid : gs.bracket.one);
    }
  }
  root.append('g').attr('class', 'overlay');

  const gl = root.append('g').attr('class', 'labels');
  const labels = gl.selectAll<SVGGElement, LabelSpan>('g').data(g.labels).join('g')
    .attr('class', (d) => labelClass(d))
    .attr('transform', (d) => `translate(${d.col * cw},${d.row * ch})`)
    .attr('data-vscode-context', (d) => JSON.stringify({
      webviewSection: d.kind === 'container' ? 'container' : sc.vg.nodes.get(d.key)?.collapsed ? 'collapsed' : 'node',
      key: d.key,
      preventDefaultContextMenuItems: true,
    }));
  labels.append('rect').attr('class', 'hit').attr('x', -2).attr('y', 0)
    .attr('width', (d) => d.text.length * cw + 4).attr('height', ch).attr('rx', 2);
  labels.append('text').attr('y', ch / 2).text((d) => d.text);
  labels.append('title').text((d) => tooltip(d));

  labels
    .on('click', (ev: MouseEvent, d) => {
      ev.stopPropagation();
      setFocus(d.key);
      if (d.kind === 'container') commit((x) => { if (!x.view.collapsed.includes(d.key)) x.view.collapsed.push(d.key); });
      else api.postMessage({ type: 'open', key: d.key });
    })
    .on('dblclick', (ev: MouseEvent, d) => {
      ev.stopPropagation();
      if (d.kind !== 'node') return;
      if (sc.vg.nodes.get(d.key)?.collapsed) commit((x) => { x.view.collapsed = x.view.collapsed.filter((c) => c !== d.key); });
      else api.postMessage({ type: 'expand', key: d.key, dir: ev.shiftKey ? 'both' : undefined });
    })
    .on('mouseenter', (_ev, d) => highlight(d.key))
    .on('mouseleave', () => highlight(focusKey));

  labels.filter((d) => d.kind === 'node').call(
    drag<SVGGElement, LabelSpan>()
      .clickDistance(4)
      .on('drag', function (ev, d) {
        select(this).attr('transform', `translate(${d.col * cw},${d.row * ch + ev.y - ev.subject.y})`);
      })
      .on('end', function (ev, d) {
        const rows = Math.round((ev.y - ev.subject.y) / ch);
        if (rows) reorder(d.key, d.row + rows);
        else select(this).attr('transform', `translate(${d.col * cw},${d.row * ch})`);
      }) as any,
  );

  svg.on('click', () => setFocus(undefined));
  if (!placed) placeView();
  highlight(focusKey);
  toolbar();
  status();
}

const VERTICAL = new Set('│├┤┌┐└┘┬┴┼⌉⌋|+`');

function popcount(m: number) { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; }

function labelClass(d: LabelSpan): string {
  const sc = scene!;
  const v = sc.vg.nodes.get(d.key);
  const cls = ['label', d.kind];
  if (sc.seeds.has(d.key)) cls.push('seed');
  if (v?.collapsed) cls.push('collapsed');
  if (v?.node?.external) cls.push('external');
  const s = sc.status.get(d.key);
  if (s) cls.push(`st-${s}`);
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
  const s = scene!.status.get(d.key);
  if (s) lines.push(s);
  return lines.join('\n');
}

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
  root.selectAll<SVGGElement, LabelSpan>('.labels g').classed('focus', (d) => d.key === key);
  highlight(key);
}

function highlight(key: NodeKey | undefined) {
  root.selectAll('.labels g').classed('hl-in', false).classed('hl-out', false);
  root.selectAll('.edges path.net').classed('hl', false);
  const ov = root.select('.overlay');
  ov.selectAll('*').remove();
  if (!key || !scene) return;
  const L = scene.layout;
  const nets = new Set([`t:${key}`, `l:${key}`]);
  const p = L.parent.get(key);
  if (p) nets.add(`t:${p}`);
  for (const lane of L.lanes) if (lane.sources.some((s) => s.key === key)) nets.add(`l:${lane.target}`);
  const callers = new Set((scene.vg.inc.get(key) ?? []).map((e) => e.from));
  const callees = new Set((scene.vg.out.get(key) ?? []).map((e) => e.to));
  root.selectAll<SVGGElement, LabelSpan>('.labels g')
    .classed('hl-in', (d) => d.kind === 'node' && callers.has(d.key))
    .classed('hl-out', (d) => d.kind === 'node' && callees.has(d.key));
  if ((doc?.view.edges ?? style?.edges.mode) === 'vector') {
    root.selectAll<SVGPathElement, unknown>('.edges path.net').classed('hl', function () {
      return nets.has(this.getAttribute('data-net') ?? '');
    });
  } else {
    // glyph mode: only the stems and lanes of the hovered vertex, drawn over the glyphs
    for (const n of nets) {
      const d = netPaths.get(n);
      if (d) ov.append('path').attr('d', d);
    }
  }
}

// ---- edits --------------------------------------------------------------------------------------
function reorder(key: NodeKey, targetRow: number) {
  if (!scene) return;
  const L = scene.layout;
  const { slot, list } = siblingsOf(L, key);
  const display = list.map((k) => ({ k, r: gridRow(L.rowOf.get(k)!) })).filter((x) => x.k !== key).sort((a, b) => a.r - b.r);
  const i = display.filter((x) => x.r < targetRow).length;
  display.splice(i, 0, { k: key, r: targetRow });
  let next = display.map((x) => x.k);
  if (doc!.view.orientation === 'up') next = next.reverse();
  if (next.join('\n') === list.join('\n')) { render(); return; }
  commit((d) => { d.view.order[slot ?? ROOTS] = next; });
}

function collapseInnermost(key: NodeKey) {
  if (!doc || !scene) return;
  const nodes = mergeGraphs(doc.ghosts, doc.graph).nodes;
  const c = ancestors(nodes, key).find((a) => isContainer(nodes[a]) && !doc!.view.collapsed.includes(a));
  if (c) commit((d) => { d.view.collapsed.push(c); });
}

function moveFocus(delta: number) {
  if (!scene) return;
  const nodes = scene.grid.labels.filter((l) => l.kind === 'node').sort((a, b) => a.row - b.row);
  if (!nodes.length) return;
  const i = nodes.findIndex((l) => l.key === focusKey);
  const j = i < 0 ? 0 : Math.max(0, Math.min(nodes.length - 1, i + delta));
  setFocus(nodes[j].key);
  // keep the focused row in view
  const el = svg.node()!;
  const t = (api.getState()?.t ?? [12, 12, 1]) as number[];
  const y = nodes[j].row * ch * t[2] + t[1];
  if (y < 0 || y > el.clientHeight - ch * t[2]) {
    svg.call(zoomer.translateBy, 0, (el.clientHeight / 2 - y) / t[2]);
  }
}

function moveSibling(delta: -1 | 1) {
  if (!scene || !focusKey) return;
  const r = gridRow(scene.layout.rowOf.get(focusKey) ?? -1);
  if (r < 0) return;
  const { list } = siblingsOf(scene.layout, focusKey);
  const rows = list.map((k) => gridRow(scene!.layout.rowOf.get(k)!)).sort((a, b) => a - b);
  const i = rows.indexOf(r);
  const j = i + delta;
  if (j < 0 || j >= rows.length) return;
  reorder(focusKey, delta < 0 ? rows[j] : rows[j] + 1);
}

svg.on('keydown', (ev: KeyboardEvent) => {
  if (!doc) return;
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
    case 'h': if (k) commit((d) => { d.view.hidden.push(k); }); break;
    case 'u': commit((d) => { d.view.hidden = []; }); break;
    case 'f': commit((d) => { d.view.orientation = d.view.orientation === 'up' ? 'down' : 'up'; }); break;
    case 'g': commit((d) => { d.view.edges = (d.view.edges ?? style!.edges.mode) === 'glyph' ? 'vector' : 'glyph'; }); break;
    case 'l': commit((d) => { d.view.labels = (d.view.labels ?? style!.labels.mode) === 'full' ? 'relative' : 'full'; }); break;
    case 'r': api.postMessage({ type: 'refresh' }); break;
    case '0': fit(); break;
    case 'x': api.postMessage({ type: 'export' }); break;
    default: return;
  }
  ev.preventDefault();
});

// ---- toolbar and status -------------------------------------------------------------------------
type Btn = { label: string; title: string; on?: boolean; act: () => void };

function toolbar() {
  if (!doc || !style) return;
  const v = doc.view;
  const mode = v.edges ?? style.edges.mode;
  const labels = v.labels ?? style.labels.mode;
  const rule = v.parentRule ?? style.grid.parentRule;
  const groups: Btn[][] = [
    [{ label: '⟳', title: 'rebuild from the language server (r)', act: () => api.postMessage({ type: 'refresh' }) }],
    (['in', 'out', 'both'] as Direction[]).map((d) => ({
      label: d === 'in' ? 'callers' : d === 'out' ? 'callees' : 'both', title: `traverse ${d} from the seeds`,
      on: v.direction === d, act: () => commit((x) => { x.view.direction = d; }, true),
    })),
    [
      { label: '−', title: 'depth − 1', act: () => commit((x) => { x.view.depth = Math.max(1, x.view.depth - 1); }, true) },
      { label: `depth ${v.depth}`, title: 'hop limit from the seeds', act: () => {} },
      { label: '+', title: 'depth + 1', act: () => commit((x) => { x.view.depth += 1; }, true) },
    ],
    [{ label: v.orientation === 'up' ? '⇡ callees top' : '⇣ callers top', title: 'flip orientation (f)',
      act: () => commit((x) => { x.view.orientation = x.view.orientation === 'up' ? 'down' : 'up'; }) }],
    (['glyph', 'vector'] as const).map((m) => ({ label: m, title: 'edge rendering (g)', on: mode === m,
      act: () => commit((x) => { x.view.edges = m; }) })),
    (['full', 'relative'] as const).map((m) => ({ label: m, title: 'label mode (l)', on: labels === m,
      act: () => commit((x) => { x.view.labels = m; }) })),
    (['dfs', 'nearest'] as const).map((m) => ({ label: m, title: 'tree parent rule', on: rule === m,
      act: () => commit((x) => { x.view.parentRule = m; }) })),
    [
      { label: 'fit', title: 'fit to window (0)', act: fit },
      { label: `unhide ${v.hidden.length}`, title: 'unhide all (u)', act: () => commit((x) => { x.view.hidden = []; }) },
      { label: `expand ${v.collapsed.length}`, title: 'expand all collapsed containers', act: () => commit((x) => { x.view.collapsed = []; }) },
      { label: 'export', title: 'ASCII export to .gaffy/export (x)', act: () => api.postMessage({ type: 'export' }) },
      { label: 'style', title: 'edit .gaffy/style.json', act: () => api.postMessage({ type: 'editStyle' }) },
    ],
  ];
  const bar = select('#toolbar');
  bar.selectAll('*').remove();
  groups.forEach((grp, i) => {
    if (i) bar.append('span').attr('class', 'sep');
    for (const b of grp) {
      bar.append('button').attr('class', b.on ? 'on' : null).attr('title', b.title).text(b.label)
        .on('click', () => b.act());
    }
  });
}

function status() {
  const el = select('#status');
  if (!scene || !doc) { el.text(busy ? 'building…' : ''); return; }
  const parts = [
    `${scene.vg.nodes.size} nodes`, `${scene.vg.edges.length} edges`, `${scene.layout.lanes.length} lanes`,
  ];
  const st = [...scene.status.values()];
  for (const s of ['ADD', 'MOD', 'REMOVE']) {
    const n = st.filter((x) => x === s).length;
    if (n) parts.push(`${n} ${s}`);
  }
  if (doc.truncated) parts.push('truncated at gaffy.maxNodes');
  if (busy) parts.push('building…');
  else if (doc.updated) parts.push(`built ${new Date(doc.updated).toLocaleString()}`);
  parts.push('click open · dblclick expand · drag reorder · right-click menu · keys ↑↓ Enter e c h u f g l r 0 x');
  el.text(parts.join(' · '));
}

function showError(msg: string) {
  root.selectAll('*').remove();
  root.append('text').attr('class', 'empty').attr('x', 0).attr('y', 16).text(msg);
}

