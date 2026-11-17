/**
 * Character grid from a layout. Each cell holds, per net, a direction mask (N, S, E, W). A net is one
 * drawn connection set: `t:<parent>` (stem and elbows to tree children), `l:<target>` (lane, its source
 * departures and the arrival). Glyph text and vector paths derive from the same masks.
 *
 * Glyph per cell: one net → box glyph of its mask. Several nets → union mask, except a pure crossing
 * (each net's mask is exactly N|S or exactly E|W, both present), which renders `GlyphSet.cross`.
 */
import { Layout } from './layout';
import { NodeKey } from './model';
import { E, GlyphSet, N, S, W } from './style';

export interface Mark {
  row: number;
  col: number;
  ch: string;
  net?: string;
  role: 'arrowE' | 'arrowW' | 'top' | 'mid' | 'bot' | 'one';
}

export interface LabelSpan {
  row: number;
  col: number;
  text: string;
  key: NodeKey;
  kind: 'node' | 'container';
}

export interface Net {
  kind: 'tree' | 'lane';
  key: NodeKey;            // tree: parent; lane: target
  members: NodeKey[];      // tree: children; lane: sources
}

export interface Grid {
  width: number;
  height: number;
  cells: Map<number, Map<string, number>>;
  marks: Mark[];
  labels: LabelSpan[];
  nets: Map<string, Net>;
  conflicts: number;       // edge cells inside label spans; 0 by construction
}

const STRIDE = 1 << 16;
export const cellId = (r: number, c: number) => r * STRIDE + c;
export const cellRC = (id: number): [number, number] => [Math.floor(id / STRIDE), id % STRIDE];

export function buildGrid(L: Layout, opts: { arrow: boolean }): Grid {
  const cells = new Map<number, Map<string, number>>();
  const marks: Mark[] = [];
  const nets = new Map<string, Net>();
  const add = (r: number, c: number, net: string, m: number) => {
    const id = cellId(r, c);
    let cell = cells.get(id);
    if (!cell) cells.set(id, (cell = new Map()));
    cell.set(net, (cell.get(net) ?? 0) | m);
  };
  const hline = (r: number, c0: number, c1: number, net: string) => {
    for (let c = c0; c <= c1; c++) add(r, c, net, E | W);
  };

  // tree nets
  for (const [p, kids] of L.children) {
    if (!kids.length) continue;
    const net = `t:${p}`;
    nets.set(net, { kind: 'tree', key: p, members: kids });
    const cp = L.rows[L.rowOf.get(p)!].col;
    const childRows = new Set(kids.map((k) => L.rowOf.get(k)!));
    const last = Math.max(...childRows);
    for (let r = L.rowOf.get(p)! + 1; r <= last; r++) {
      add(r, cp, net, N | (r < last ? S : 0) | (childRows.has(r) ? E : 0));
    }
    for (const k of kids) {
      const r = L.rowOf.get(k)!;
      const ck = L.rows[r].col;
      hline(r, cp + 1, ck - 3, net);
      if (opts.arrow) {
        add(r, ck - 2, net, W);
        marks.push({ row: r, col: ck - 2, ch: '>', net, role: 'arrowE' });
      } else add(r, ck - 2, net, E | W);
    }
  }

  // lane nets
  for (const lane of L.lanes) {
    const net = `l:${lane.target}`;
    nets.set(net, { kind: 'lane', key: lane.target, members: lane.sources.map((s) => s.key) });
    const srcRows = new Set(lane.sources.map((s) => s.row));
    for (let r = lane.lo; r <= lane.hi; r++) {
      add(r, lane.col, net, (r > lane.lo ? N : 0) | (r < lane.hi ? S : 0) | (srcRows.has(r) || r === lane.hi ? W : 0));
    }
    for (const s of lane.sources) {
      const row = L.rows[s.row];
      if (s.port) {
        add(s.row, row.col, net, N | E);
        hline(s.row, row.col + 1, lane.col - 1, net);
      } else hline(s.row, row.end + 1, lane.col - 1, net);
    }
    const t = L.rows[lane.hi];
    add(lane.hi, t.end + 1, net, E);
    marks.push({ row: lane.hi, col: t.end + 1, ch: '<', net, role: 'arrowW' });
    hline(lane.hi, t.end + 2, lane.col - 1, net);
  }

  // labels and brackets
  const labels: LabelSpan[] = [];
  L.rows.forEach((row, r) => {
    if (row.kind === 'node') labels.push({ row: r, col: row.col, text: row.text, key: row.key, kind: 'node' });
  });
  for (const b of L.brackets) {
    if (b.lo === b.hi) marks.push({ row: b.lo, col: b.col, ch: ']', role: 'one' });
    else {
      for (let r = b.lo; r <= b.hi; r++) {
        const role = r === b.lo ? 'top' : r === b.hi ? 'bot' : 'mid';
        marks.push({ row: r, col: b.col, ch: '', role });
      }
    }
    labels.push({ row: Math.floor((b.lo + b.hi) / 2), col: b.col + 2, text: b.label, key: b.key, kind: 'container' });
  }

  let conflicts = 0;
  for (const l of labels) {
    for (let c = l.col; c < l.col + l.text.length; c++) if (cells.has(cellId(l.row, c))) conflicts++;
  }
  return { width: L.width, height: L.rows.length, cells, marks, labels, nets, conflicts };
}

const swapNS = (m: number) => (m & ~(N | S)) | (m & N ? S : 0) | (m & S ? N : 0);

/** Orientation `up`: rows reversed, masks mirrored N ↔ S, bracket ends swapped. */
export function flipGrid(g: Grid): Grid {
  const H = g.height;
  const cells = new Map<number, Map<string, number>>();
  for (const [id, nets] of g.cells) {
    const [r, c] = cellRC(id);
    const m = new Map<string, number>();
    for (const [n, v] of nets) m.set(n, swapNS(v));
    cells.set(cellId(H - 1 - r, c), m);
  }
  const marks = g.marks.map((m) => ({
    ...m,
    row: H - 1 - m.row,
    role: m.role === 'top' ? 'bot' as const : m.role === 'bot' ? 'top' as const : m.role,
  }));
  const labels = g.labels.map((l) => ({ ...l, row: H - 1 - l.row }));
  return { ...g, cells, marks, labels };
}

export function cellGlyph(nets: Map<string, number>, gs: GlyphSet): string {
  if (nets.size === 1) return gs.mask(nets.values().next().value!);
  let union = 0;
  let vert = false, horiz = false, other = false;
  for (const m of nets.values()) {
    union |= m;
    if (m === (N | S)) vert = true;
    else if (m === (E | W)) horiz = true;
    else other = true;
  }
  if (vert && horiz && !other) return gs.cross;
  return gs.mask(union);
}

function markGlyph(m: Mark, gs: GlyphSet): string {
  switch (m.role) {
    case 'top': return gs.bracket.top;
    case 'mid': return gs.bracket.mid;
    case 'bot': return gs.bracket.bot;
    case 'one': return gs.bracket.one;
    default: return m.ch;
  }
}

/** Character matrix with labels; `blankLabels` leaves label cells empty (SVG draws labels apart). */
export function charRows(g: Grid, gs: GlyphSet, blankLabels = false): string[][] {
  const rows = Array.from({ length: g.height }, () => Array<string>(g.width).fill(' '));
  const put = (r: number, c: number, ch: string) => {
    if (r < 0 || r >= g.height) return;
    while (rows[r].length <= c) rows[r].push(' ');
    rows[r][c] = ch;
  };
  for (const [id, nets] of g.cells) {
    const [r, c] = cellRC(id);
    put(r, c, cellGlyph(nets, gs));
  }
  for (const m of g.marks) put(m.row, m.col, markGlyph(m, gs));
  for (const l of g.labels) {
    for (let i = 0; i < l.text.length; i++) put(l.row, l.col + i, blankLabels ? ' ' : l.text[i]);
  }
  return rows;
}

export function toText(g: Grid, gs: GlyphSet): string {
  return charRows(g, gs).map((r) => r.join('').trimEnd()).join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `<pre>` body with labels wrapped in links; `href` returns undefined for unlinked labels. */
export function toHtmlPre(g: Grid, gs: GlyphSet, href: (key: NodeKey) => string | undefined): string {
  const rows = charRows(g, gs, true);
  const byRow = new Map<number, LabelSpan[]>();
  for (const l of g.labels) {
    if (!byRow.has(l.row)) byRow.set(l.row, []);
    byRow.get(l.row)!.push(l);
  }
  const out: string[] = [];
  rows.forEach((chars, r) => {
    const spans = (byRow.get(r) ?? []).sort((a, b) => a.col - b.col);
    let line = '';
    let c = 0;
    for (const s of spans) {
      line += esc(chars.slice(c, s.col).join(''));
      const h = href(s.key);
      line += h ? `<a href="${esc(h)}">${esc(s.text)}</a>` : esc(s.text);
      c = s.col + s.text.length;
    }
    line += esc(chars.slice(c).join('').trimEnd());
    out.push(line.trimEnd());
  });
  return out.join('\n');
}
