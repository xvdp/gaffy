/** @xvdp
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
import { ancestors, GNode, isContainer, NodeKey, visible } from '../core/model';
import { buildScene, isStub, Scene, siblingsOf, unitAnchor, unitMembers } from '../core/scene';
import { Curve, E, glyphSet, N, S, Style, W } from '../core/style';
import { collapsedUnit, Depth, dropMovesWithin, excludedBy, globMatcher, isStandard, OpenSide, parseDoc, PathTest, ROOTS, serializeDoc, ViewDoc } from '../core/viewdoc';
import { opens, seedSide, within } from '../core/reveal';

interface VsApi { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsApi;
const api = acquireVsCodeApi();

let text = '';
let dragging = false;          // a unit is being dragged: no settling of moved units meanwhile
let name = 'view';
let doc: ViewDoc | undefined;
let style: Style | undefined;
let styleText = '';
let excludeGlobs: string[] = [];
let excludes: PathTest[] = [];        // `gaffy.exclude` globs as path tests, for buildScene
let settings = { includeExternal: false, includeStandardLibrary: false, saveViews: false, untitled: false, trace: false };   // VS Code settings (Options; `trace`: gaffy.trace)
/** External code drawn (scene.ts `Outside`): from the settings above. */
const outside = () => ({ external: settings.includeExternal, standard: settings.includeStandardLibrary });
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
    // wheel zooms anywhere; dragging pans only from the background (labels and headers drag units;
    // Shift+drag on the background draws a selection window)
    .filter((ev: Event) => ev.type === 'wheel' || (!(ev as MouseEvent).button && !(ev as MouseEvent).shiftKey
        && !(ev.target as Element).closest?.('.labels g, .heads g')))
    .on('zoom', (ev) => {
        root.attr('transform', ev.transform.toString());
        saveState({ t: [ev.transform.x, ev.transform.y, ev.transform.k] });
    });
svg.call(zoomer).on('dblclick.zoom', null);

// ---- selection window: Shift+drag on the background selects every function whose label it touches ----
let band: { x0: number; y0: number; x1: number; y1: number } | undefined;
let bandEnded = false;
const rootPoint = (ev: MouseEvent): [number, number] => {
    const t = (root.node() as SVGGElement).getScreenCTM();
    if (!t) return [0, 0];
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(t.inverse());
    return [p.x, p.y];
};
svg.on('mousedown.band', (ev: MouseEvent) => {
    if (!ev.shiftKey || ev.button || (ev.target as Element).closest?.('.labels g, .heads g, .markers, .arrowhits')) return;
    ev.preventDefault();
    const [x, y] = rootPoint(ev);
    band = { x0: x, y0: y, x1: x, y1: y };
});
window.addEventListener('mousemove', (ev) => {
    if (!band) return;
    [band.x1, band.y1] = rootPoint(ev);
    const o = root.select('.drag');
    o.selectAll('*').remove();
    o.append('rect').attr('class', 'band').attr('x', Math.min(band.x0, band.x1)).attr('y', Math.min(band.y0, band.y1))
        .attr('width', Math.abs(band.x1 - band.x0)).attr('height', Math.abs(band.y1 - band.y0));
});
window.addEventListener('mouseup', () => {
    if (!band || !scene) { band = undefined; return; }
    const b = band;
    band = undefined;
    root.select('.drag').selectAll('*').remove();
    const [xa, xb] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)], [ya, yb] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
    if (xb - xa < 3 && yb - ya < 3) return;
    bandEnded = true;
    for (const l of scene.grid.labels) {
        if (l.kind !== 'node' || isStub(l.key)) continue;
        const x0 = l.col * cw, x1 = (l.col + l.text.length) * cw, y0 = l.row * ch, y1 = y0 + ch;
        if (x1 >= xa && x0 <= xb && y1 >= ya && y0 <= yb) selected.add(l.key);
    }
    selCalls.clear();
    setFocus(focusKey);
    toolbar();
    status();
});

function saveState(patch: Record<string, unknown>) {
    api.setState({ ...(api.getState() ?? {}), ...patch });
}

// ---- host messages ------------------------------------------------------------------------------
window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'state') {
        busy = !!m.busy;
        // a changed setting or gaffy.exclude redraws at once, with the same document
        const was = JSON.stringify([settings, excludeGlobs]);
        excludeGlobs = m.exclude ?? excludeGlobs;
        excludes = excludeGlobs.map(globMatcher);
        settings = m.settings ?? settings;
        pageContext();
        if (JSON.stringify([settings, excludeGlobs]) !== was && doc) { render(); }
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
        // a context menu entry: the right click that opened the menu gave the cell
        cause = { event: `menu ${m.cmd}`, target: m.key ?? cause.target, cell: cause.event === 'contextmenu' ? cause.cell : undefined };
        runCmd(m.cmd, m.key, m.unit, m.to);
    }
});

function commit(mut: (d: ViewDoc) => void) {
    if (!doc) return;
    const d = structuredClone(doc);
    mut(d);
    doc = d;
    text = serializeDoc(d);
    const before = settings.trace ? cells(scene) : undefined;
    render();
    api.postMessage({ type: 'edit', text, ...(before ? { cause, moved: movedCells(before, cells(scene)) } : {}) });
}

// ---- trace (setting gaffy.trace): why each edit happened, and what moved; the host appends it to .gaffy/trace/ ----
/** The user event an edit answers (type, target key or text, grid cell [row, column]) and the functions that acted. */
interface Cause { event?: string; target?: string; cell?: [number, number]; fn?: string; args?: unknown }
let cause: Cause = {};
/** Names a function acting on the current event; nested ones chain (`runCmd:remove › runCmd:hideSelection`). */
function why(fn: string, args?: unknown) {
    cause = { ...cause, fn: cause.fn ? `${cause.fn} › ${fn}` : fn, ...(args !== undefined ? { args } : {}) };
}
// every user event starts a new cause, captured before the handlers run
for (const type of ['click', 'dblclick', 'mousedown', 'contextmenu', 'keydown'] as const) {
    document.addEventListener(type, (ev) => {
        const el = (ev.target as Element | null)?.closest?.('.labels g, .heads g, .markers text, .arrowhits rect, .hits path, button, tspan, .row') ?? undefined;
        const d = (el as { __data__?: { key?: string; from?: string; to?: string } } | undefined)?.__data__;
        const target = d?.key ?? (d?.from && d?.to ? `${d.from} → ${d.to}` : el?.textContent?.trim().slice(0, 60) || undefined);
        let cell: [number, number] | undefined;
        if (ev instanceof MouseEvent && ch && cw) { const [x, y] = rootPoint(ev); cell = [Math.floor(y / ch), Math.floor(x / cw)]; }
        cause = { event: ev instanceof KeyboardEvent ? `key ${ev.altKey ? 'Alt+' : ''}${ev.key}` : type, target, cell };
    }, true);
}
/** Grid cells of labels (vertex keys) and frames (box units): [row, column]. */
function cells(sc: Scene | undefined): Map<string, [number, number]> {
    const m = new Map<string, [number, number]>();
    if (!sc) return m;
    for (const [k, p] of sc.placement.pos) if (!isStub(k)) m.set(k, [p.row, p.col]);
    for (const f of sc.placement.frames) m.set(f.unit, [f.r0, f.c0]);
    return m;
}
/** Labels and frames whose cell changed: [key, before, after] (before or after null when it appeared or left). */
function movedCells(a: Map<string, [number, number]>, b: Map<string, [number, number]>) {
    const out: [string, [number, number] | null, [number, number] | null][] = [];
    for (const [k, p] of a) { const q = b.get(k); if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push([k, p, q ?? null]); }
    for (const [k, q] of b) if (!a.has(k)) out.push([k, null, q]);
    return out.slice(0, 2000);
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

/** Radius of a hop: a horizontal call line over a vertical one it crosses (orthogonal and rounded edges). */
const hopRadius = () => Math.min(cw, ch) * 0.525;

/** A crossing cell: some net runs N|S, another E|W, none turns or joins there. */
function crossing(nets: Map<string, number>): boolean {
    let hasV = false, hasH = false;
    for (const om of nets.values()) {
        if (om === (N | S)) hasV = true;
        else if (om === (E | W)) hasH = true;
        else return false;
    }
    return hasV && hasH;
}

/**
 * Orthogonal vector paths per net from the grid masks, without the cells only implicit calls or only calls
 * across languages pass (`Grid.kinds`): those calls are drawn whole (`curvePath`), since a dash pattern restarts
 * on every subpath and per-cell pieces shorter than a dash would draw solid.
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
    const hop = hopRadius();
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
            if (g.kinds.has(id)) continue;
            const [r, c] = cellRC(id);
            const x = (c + 0.5) * cw, y = (r + 0.5) * ch;
            const edge = (bit: number): [number, number] =>
                bit === N ? [x, r * ch] : bit === S ? [x, (r + 1) * ch] : bit === E ? [(c + 1) * cw, y] : [c * cw, y];
            if (m === (E | W) && crossing(g.cells.get(id)!)) {
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

/** One call as an SVG path: polyline with rounded corners (square for orthogonal) and hops, sigmoid S-curves, or a B-spline. */
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
    // rounded corners (orthogonal: square); a horizontal run hops over the vertical lines it crosses (`crossing`)
    const r = curve === 'orthogonal' ? 0 : Math.min(cw, ch) * 0.9;
    const hop = hopRadius();
    const g = scene?.grid;
    const hops = !g ? [] : p.cells.filter((id) => g.cells.get(id)?.get(p.net) === (E | W) && crossing(g.cells.get(id)!))
        .map((id) => { const [hr, hc] = cellRC(id); return [(hc + 0.5) * cw, (hr + 0.5) * ch]; });
    let d = `M${pts[0][0]},${pts[0][1]}`;
    let cur = pts[0];
    const to = (x: number, y: number) => {
        const dir = Math.sign(x - cur[0]);
        if (dir && Math.abs(y - cur[1]) < 1e-6) {
            for (const [hx] of hops.filter(([hx, hy]) => Math.abs(hy - y) < 1e-6 && (hx - cur[0]) * dir > hop && (x - hx) * dir > hop)
                .sort((a, b) => (a[0] - b[0]) * dir)) {
                d += `L${hx - dir * hop},${y}A${hop},${hop} 0 0 ${dir > 0 ? 1 : 0} ${hx + dir * hop},${y}`;
            }
        }
        d += `L${x},${y}`;
        cur = [x, y];
    };
    for (let i = 1; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
        const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
        const k = Math.min(r, l1 / 2, l2 / 2);
        const p1 = [bx - ((bx - ax) / (l1 || 1)) * k, by - ((by - ay) / (l1 || 1)) * k];
        const p2 = [bx + ((cx - bx) / (l2 || 1)) * k, by + ((cy - by) / (l2 || 1)) * k];
        to(p1[0], p1[1]);
        d += `Q${bx},${by} ${p2[0]},${p2[1]}`;
        cur = [p2[0], p2[1]];
    }
    const last = pts[pts.length - 1];
    to(last[0], last[1]);
    return d;
}

function hue(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return h % 360;
}

// ---- render -------------------------------------------------------------------------------------
/** Menu context of the whole page: `unsaved` shows right click > Save, `tight` checks right click > Tight Boxes. */
/** Context keys of the canvas menu (package.json `when`): checkmarks of the toggles, a selection for Re-arrange. */
function pageContext() {
    const tight = doc?.view.tight ?? style?.boxes.tight ?? true;
    const boxes = doc?.view.boxes ?? style?.boxes.enabled ?? true;
    document.body.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'canvas', preventDefaultContextMenuItems: true,
        unsaved: settings.untitled, tight, boxes, selected: selected.size > 0 }));
}

function render() {
    pageContext();
    if (!doc || !style) return;
    measure(style);
    applyColors(style);
    try {
        scene = buildScene(doc, style, excludes, outside());
    } catch (e) {
        showError(`layout failed: ${(e as Error).message}`);
        return;
    }
    const sc = scene;
    const g = sc.grid;
    const grows = doc.view.arrange === 'grow';
    // the vertex last opened, closed or removed keeps its name at its screen position: the view shifts by
    // the name's move (a `>> ` prefix that appears or goes moves the label start, not the name)
    if (anchor && placed) {
        const at = nameCell(sc, anchor.key);
        if (at) {
            if (anchor.at && (at[0] !== anchor.at[0] || at[1] !== anchor.at[1])) {
                svg.call(zoomer.translateBy, -(at[0] - anchor.at[0]) * cw, -(at[1] - anchor.at[1]) * ch);
            }
            anchor.at = at;
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
            .text(busy ? 'building…' : doc.view.seeds.length
                ? 'nothing on screen: the seeds are hidden, in an excluded folder, or not resolved yet (Show all, Options > Folders, Refresh)'
                : 'empty view: right click a function > gaffy > New View…');
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
        // implicit calls and calls across languages: whole, dotted and dash-dot (their cells are not in the masks)
        for (const p of g.paths) if (!p.fallback && (implicitOf(p) || viaOf(p))) ge.append('path').attr('class', edgeClass(p)).attr('d', curvePath(p, 'orthogonal'));
        for (const m of g.marks) arrowhead(ge, m.col + 0.5, m.row + 0.5, m.role === 'arrowE' ? 1 : m.role === 'arrowW' ? -1 : 0);
    } else {
        for (const p of g.paths) {
            if (p.fallback) continue;
            ge.append('path').attr('class', edgeClass(p)).attr('data-from', p.from).attr('data-to', p.to).attr('d', curvePath(p, curve));
            if (style.edges.arrow) {
                const [x, y] = p.pts[p.pts.length - 1];
                arrowhead(ge, x - (p.arrive === 'E' ? 0.5 : -0.5), y, p.arrive === 'E' ? 1 : -1);
            }
        }
    }
    // calls without a route: dashed, over everything, still with their arrowhead
    for (const p of g.paths.filter((q) => q.fallback)) {
        ge.append('path').attr('class', 'net fallback').attr('d', `M${p.pts.map(([x, y]) => `${X(x)},${Y(y)}`).join('L')}`);
        const [x, y] = p.pts[p.pts.length - 1];
        arrowhead(ge, x - (p.arrive === 'E' ? 0.5 : -0.5), y, p.arrive === 'E' ? 1 : -1);
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
            // a marker row's elbow opens that side, like its `>`; a line only selects (arrowheads close, below)
            if (isStub(p.to)) { markerClick(p.from, 'down'); return; }
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
        .append('title').text((p) => (isStub(p.to) ? markerTitle(p.from, 'down') : callTitle(p)));

    // arrowheads (one layer at a time): the arrowhead cell and the blank before the name close the level the
    // arrow points into; hovering shows which
    if (grows) {
        const heads = [...g.arrowTo].map(([id, to]) => {
            const [r, c] = cellRC(id);
            const p = sc.placement.pos.get(to);
            const into = !!p && c < p.col;                    // `─> name` (from the left) or `name <─` (at its end)
            return { r, c0: into ? c : c - 1, to, cell: id, act: closingOf(sc, to, id) };
        }).filter((h) => h.act && !isStub(h.to));
        root.append('g').attr('class', 'arrowhits').selectAll('rect').data(heads).join('rect')
            .attr('x', (h) => h.c0 * cw).attr('y', (h) => h.r * ch).attr('width', 2 * cw).attr('height', ch).attr('rx', 2)
            .on('mouseenter', (_ev, h) => highlightCalls(sc.grid.paths.filter((q) => q.to === h.to && q.cells.includes(h.cell))))
            .on('mouseleave', () => highlight(focusKey))
            .on('click', (ev: MouseEvent, h) => { ev.stopPropagation(); h.act!.run(); })
            .append('title').text((h) => h.act!.title);
    }

    // labels
    const gl = root.append('g').attr('class', 'labels');
    const nodes = gl.selectAll<SVGGElement, LabelSpan>('g').data(g.labels.filter((l) => l.kind === 'node' && !isStub(l.key))).join('g')
        .attr('class', (d) => labelClass(d))
        .attr('transform', (d) => `translate(${d.col * cw},${d.row * ch})`)
        .attr('data-vscode-context', (d) => JSON.stringify({
            webviewSection: sc.vg.nodes.get(d.key)?.collapsed ? 'collapsed' : 'node',
            key: d.key, unit: vertexUnit(d.key), oneLayer: grows, preventDefaultContextMenuItems: true,
        }));
    nodes.append('rect').attr('class', 'hit').attr('x', -2).attr('y', 0).attr('width', (d) => d.text.length * cw + 4).attr('height', ch).attr('rx', 2);
    nodes.append('text').attr('y', ch / 2).each(function (d) {
        const dec = sc.decor.get(d.key) ?? { pre: '', post: '' };
        const base = d.text.slice(dec.pre.length, d.text.length - dec.post.length);
        const t = select(this);
        if (dec.pre) {
            t.append('tspan').attr('class', markerLive(d.key, 'up') ? 'twisty' : 'twisty off').text(dec.pre)
                .on('click', (ev: MouseEvent) => { ev.stopPropagation(); markerClick(d.key, 'up'); })
                .append('title').text(markerTitle(d.key, 'up'));
        }
        t.append('tspan').text(base);
        if (dec.post) t.append('tspan').text(dec.post);
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
            if (sc.vg.nodes.get(d.key)?.collapsed) { why('expand', { key: d.key }); anchorAt(d.key); commit((x) => { x.view.collapsed = x.view.collapsed.filter((c) => c !== d.key); }); }
            else if (grows) toggleSides(d.key);
        })
        .on('mouseenter', (_ev, d) => highlight(d.key))
        .on('mouseleave', () => highlight(focusKey));
    nodes.call(dragUnit((d) => vertexUnit(d.key)) as any);

    // marker rows `└─>>`: the second `>` (the elbow is a path above); opens or restores the side placed below
    root.append('g').attr('class', 'markers').selectAll('text').data(g.markers).join('text')
        .attr('class', 'marker')
        .attr('x', (m) => m.col * cw).attr('y', (m) => (m.row + 0.5) * ch)
        .text((m) => m.text)
        .attr('class', (m) => (markerLive(m.key, m.side) ? 'marker' : 'marker off'))
        .on('click', (ev: MouseEvent, m) => { ev.stopPropagation(); markerClick(m.key, m.side); })
        .append('title').text((m) => markerTitle(m.key, m.side));

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
        why('collapse', { key: d.key.slice(4) });
        commit((x) => { if (!x.view.collapsed.includes(d.key.slice(4))) x.view.collapsed.push(d.key.slice(4)); });
    });
    heads.call(dragUnit((d) => d.key) as any);

    root.append('g').attr('class', 'drag');
    // a background click clears the selection; not the click that ends a selection window, nor a Shift+click
    svg.on('click', (ev: MouseEvent) => {
        if (bandEnded || ev.shiftKey) { bandEnded = false; return; }
        selected.clear(); selCalls.clear(); optsOpen = false; toolbar(); setFocus(undefined);
    });
    if (!placed) placeView();
    highlight(focusKey);
    toolbar();
    status();
    setTimeout(afterRender, 0);
}

/**
 * After the picture changed (a side opened, data arrived, a depth changed), once per document state:
 * 1. A moved function whose callers were just opened hands its move to its new tree parent, so the caller
 *    sits right above it (`prev()` then `└─> fun()`) instead of at the parent's unmoved place.
 * 2. The scene drew moved units the picture grew into at the nearest clean spot (settle.ts, scene
 *    `offsets`): the view keeps those offsets, so what is saved is what is drawn. At most 3 such saves in a
 *    row; any other change starts the count again.
 */
let settledFor = '';
let settleStreak = 0;
let adopt: { key: NodeKey; renders: number } | undefined;
function afterRender() {
    if (!doc || !scene || !style || dragging) return;
    const sc = scene;
    if (adopt) {
        const k = adopt.key;
        const p = sc.placement.blockOf.get(k)?.L.parent.get(k);
        const off = doc.view.offset[k];
        if (p && off && !doc.view.offset[p] && !doc.view.lock[p] && !doc.view.lock[k] && sc.rev.opener.get(p)?.by === k) {
            adopt = undefined;
            cause = { event: 'auto', fn: 'afterRender:adopt', args: { from: k, to: p } };
            commit((x) => { x.view.offset[p] = off; delete x.view.offset[k]; });
            return;
        }
        if (++adopt.renders > 6) adopt = undefined;      // no caller became its parent: nothing to hand over
    }
    if (text === settledFor || settleStreak >= 3) return;
    settledFor = text;
    if (sc.offsets === doc.view.offset) { settleStreak = 0; return; }
    settleStreak++;
    const settled = structuredClone(sc.offsets);
    cause = { event: 'auto', fn: 'afterRender:settle', args: { round: settleStreak } };
    commit((x) => { x.view.offset = settled; });
}

const VERTICAL = new Set('│├┤┌┐└┘┬┴┼|+`┊:');

/** Path data of one call in the current edge style. */
function callD(p: EdgePath): string {
    const curve = doc!.view.curve ?? style!.edges.curve;
    const vector = (doc!.view.edges ?? style!.edges.mode) === 'vector';
    return vector && curve !== 'orthogonal' ? curvePath(p, curve) : `M${p.pts.map(([x, y]) => `${X(x)},${Y(y)}`).join('L')}`;
}

/** Caller and callee of a drawn connection (drawn in call direction). */
function asCall(p: { from: NodeKey; to: NodeKey }): { caller: NodeKey; callee: NodeKey } {
    return { caller: p.from, callee: p.to };
}

/** Binding layer of a call across languages (`pybind11: src/ext.cpp:42`), from the stored edge. */
function viaOf(p: { from: NodeKey; to: NodeKey }): string | undefined {
    return doc?.graph.edges.find((e) => e.from === p.from && e.to === p.to)?.via;
}

/** Implicit call (construction, instance call), from the stored edge. */
function implicitOf(p: { from: NodeKey; to: NodeKey }): string | undefined {
    return doc?.graph.edges.find((e) => e.from === p.from && e.to === p.to)?.implicit;
}

/** Path class: calls across languages dash-dot, implicit calls dotted. */
const edgeClass = (p: { from: NodeKey; to: NodeKey }) => (viaOf(p) ? 'net bridge' : implicitOf(p) ? 'net implicit' : 'net');

/** Tooltip line of an implicit call. */
function implicitTitle(kind: string | undefined, callee: NodeKey): string {
    if (kind === 'construction') return '\nimplicit: runs when the class is constructed';
    if (kind === 'instance call') {
        return scene!.graph.nodes[callee]?.name === 'forward'
            ? '\nimplicit: an instance called, nn.Module.__call__ runs forward'
            : '\nimplicit: an instance called runs __call__';
    }
    return '';
}

function callTitle(p: EdgePath): string {
    const { caller, callee } = asCall(p);
    const name = (k: NodeKey) => visible(scene!.graph.nodes[k]?.name ?? k);
    const via = viaOf(p);
    return `${name(caller)}() → ${name(callee)}()${via ? `\nacross languages, via ${via}` : ''}${implicitTitle(implicitOf(p), callee)}\nclick select · double click: show only what lies below · right click: more`;
}

/** Side of a vertex: open entry, or the traversal side for a seed without one. */
function sideOf(k: NodeKey): OpenSide | undefined {
    return doc!.view.open?.[k] ?? (doc!.view.seeds.includes(k) ? seedSide(doc!.view.direction) : undefined);
}

/** Open sides of a vertex as drawn: its entry limited to the sides it may open (seeds both, others their reveal side). */
function effSide(k: NodeKey): OpenSide {
    return within(sideOf(k), scene?.rev.allowed.get(k) ?? 'both');
}

/** Cell of the first character of a vertex's name: label start plus its `>> ` prefix. */
function nameCell(sc: Scene, k: NodeKey): [number, number] | undefined {
    const p = sc.placement.pos.get(k);
    return p ? [p.col + (sc.decor.get(k)?.pre.length ?? 0), p.row] : undefined;
}

/** Keep `k`'s name at its screen position through the next layouts. */
function anchorAt(k: NodeKey) {
    anchor = { key: k, at: scene ? nameCell(scene, k) : undefined };
}

/** Double click, one layer at a time: close both sides, or open every side that has more. */
function toggleSides(k: NodeKey) {
    why('toggleSides', { key: k });
    if (effSide(k) !== 'none') { anchorAt(k); commit((x) => { x.view.open = { ...(x.view.open ?? {}), [k]: 'none' }; }); }
    else for (const s0 of ['down', 'up'] as const) if (scene!.hasMore(k, s0)) setSide(k, s0, true);
}

/**
 * Open or close one side of a vertex; opening a side without data asks the language server. `restore`
 * also brings back the hidden neighbors and cut calls of that side.
 */
function setSide(k: NodeKey, side: 'up' | 'down', on: boolean, restore = false) {
    if (!doc || !scene || doc.view.arrange !== 'grow') return;   // full views: the call depths decide
    why('setSide', { key: k, side, on, restore });
    anchorAt(k);
    // a moved function opening its callers: the caller that becomes its tree parent takes its move (afterRender)
    if (on && side === 'up' && doc.view.offset[k]) adopt = { key: k, renders: 0 };
    settleStreak = 0;
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

/** A side `k` opens one layer at a time (the direction rule allows it). */
const opensHere = (k: NodeKey, side: 'up' | 'down') => doc?.view.arrange === 'grow' && opens(scene?.rev.allowed.get(k), side);
/** Whether a marker acts: it opens its side (one layer at a time), or brings back hidden neighbors (both layouts). */
const markerLive = (k: NodeKey, side: 'up' | 'down') => opensHere(k, side) || !!scene?.hiddenOn(k, side).length;

/**
 * A marker (`>> ` before a label, `└─>>` row below it). One layer at a time, on a side the function opens:
 * open that side with everything removed from it. Otherwise (full layout, or a side the direction rule
 * does not open), bring back the hidden neighbors and removed calls of that side.
 */
function markerClick(k: NodeKey, side: 'up' | 'down') {
    why('markerClick', { key: k, side });
    if (opensHere(k, side)) { setSide(k, side, true, true); return; }
    restoreHidden(k, side);
}

/**
 * Hidden neighbors of `k` on one side back on screen, with the hidden functions on their way from the
 * seeds (otherwise they would stay off screen); removed calls between `k` and them restored. `k` keeps its
 * place. Further hidden functions beyond them keep their marker, one layer at a time.
 */
function restoreHidden(k: NodeKey, side: 'up' | 'down') {
    if (!scene || !doc) return;
    why('restoreHidden', { key: k, side });
    const back = scene.hiddenOn(k, side);
    if (!back.length) return;
    const show = new Set([...back, ...back.flatMap((b) => scene!.hiddenPath(b))]);
    anchorAt(k);
    commit((x) => {
        x.view.hidden = x.view.hidden.filter((h) => !show.has(h));
        const cut = (x.view.cut ?? []).filter(([a, b]) => !(side === 'down' ? a === k && show.has(b) : b === k && show.has(a)));
        if (cut.length) x.view.cut = cut; else delete x.view.cut;
    });
}

function markerTitle(k: NodeKey, side: 'up' | 'down'): string {
    const who = side === 'up' ? 'callers' : 'calls';
    const n = scene?.hiddenOn(k, side).length ?? 0;
    if (opensHere(k, side)) return `${who} not on screen: click to show them (also removed ones)`;
    if (n) return `${n} hidden or removed ${who}: click to show them again`;
    return 'more beyond the call depth: raise it in the toolbar';
}

/**
 * The level an arrowhead into `to` closes: callers shown by `to`'s callers side (incoming level, `to`
 * keeps its place), or the calls side of the caller that showed `to` (outgoing level, that caller keeps
 * its place). Calls between two vertices shown otherwise close `to`'s callers when that side is open.
 */
function closingOf(sc: Scene, to: NodeKey, cell: number): { run: () => void; title: string } | undefined {
    const callers = [...new Set(sc.grid.paths.filter((q) => q.to === to && q.cells.includes(cell)).map((q) => q.from))];
    const op = (k: NodeKey) => sc.rev.opener.get(k);
    const name = (k: NodeKey) => visible(sc.graph.nodes[k]?.name ?? k);
    const up = () => ({ run: () => setSide(to, 'up', false), title: `close the callers of ${name(to)}()` });
    if (opens(effSide(to), 'up') && callers.some((c) => op(c)?.by === to && op(c)?.side === 'up')) return up();
    const by = op(to);
    if (by?.side === 'down' && callers.includes(by.by) && opens(effSide(by.by), 'down')) {
        return { run: () => setSide(by.by, 'down', false), title: `close the calls of ${name(by.by)}()` };
    }
    if (opens(effSide(to), 'up')) return up();
    const c = callers.find((x) => opens(effSide(x), 'down'));
    return c ? { run: () => setSide(c, 'down', false), title: `close the calls of ${name(c)}()` } : undefined;
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
    why('isolateCalls', { calls: calls.length });
    const keep = new Set<NodeKey>();
    for (const c of calls) { keep.add(c.from); for (const k of reachDrawn(c.to, 'down')) keep.add(k); }
    selCalls.clear();
    isolate(keep, calls[0].from);
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

/** Hide everything but `keep` (and its paths from the seeds); `pin` (else the focus, else a kept function) keeps its place on screen. */
function isolate(keep: Set<NodeKey>, pin?: NodeKey) {
    why('isolate', { keep: keep.size, pin });
    const all = withPath(keep);
    const at = [pin, focusKey, ...keep].find((k) => k && keep.has(k) && scene!.placement.pos.has(k));
    if (at) anchorAt(at);
    hide([...scene!.vg.nodes.keys()].filter((x) => !all.has(x)));
}

/**
 * Hide functions; seeds never: they anchor the view (one layer at a time reveals everything from them).
 * Right click > Remove Seed takes a seed out.
 */
function hide(keys: NodeKey[]) {
    why('hide', { keys: keys.length });
    const seeds = new Set(doc!.view.seeds);
    const drop = keys.filter((k) => !seeds.has(k));
    if (drop.length) commit((x) => { for (const s of drop) if (!x.view.hidden.includes(s)) x.view.hidden.push(s); });
}

/** One layer at a time: `keep` plus the functions that reveal them from the seeds, so they stay reachable. */
function withPath(keep: Set<NodeKey>): Set<NodeKey> {
    const out = new Set(keep);
    if (doc!.view.arrange !== 'grow') return out;
    for (const k of keep) for (let o = scene!.rev.opener.get(k); o && !out.has(o.by); o = scene!.rev.opener.get(o.by)) out.add(o.by);
    return out;
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
    if (doc!.view.lock[vertexUnit(d.key)]) cls.push('locked');
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
    if (hid) lines.push(`hidden: ${hid.map((k) => scene!.graph.nodes[k]?.name ?? k).join(', ')}`);
    const lv = scene!.rev.level.get(d.key);
    if (lv) lines.push(`${scene!.rev.allowed.get(d.key) === 'up' ? 'caller' : 'callee'} level ${lv}`);
    lines.push(doc!.view.arrange === 'grow'
        ? '>> or └─>> open a side · an arrowhead closes the level it points into · double click: open or close · Delete: remove the selection'
        : 'full: the call depth buttons choose the levels shown · Delete hides the selection');
    if (doc!.view.lock[vertexUnit(d.key)]) lines.push('locked');
    return lines.map(visible).join('\n');
}

// ---- dragging units ------------------------------------------------------------------------------
/**
 * Units a drag moves: the dragged one; a selected function dragged while others are selected moves them
 * all, each with its tree below (a function under another selected one moves with that one, not twice).
 */
/** Unit a vertex moves and locks as: its key, or `collapsed:<key>` for a collapsed container (viewdoc `collapsedUnit`). */
function vertexUnit(k: NodeKey): string {
    return scene?.vg.nodes.get(k)?.collapsed ? collapsedUnit(k) : k;
}

function topUnits(sc: Scene, keys: Set<NodeKey>): string[] {
    const up = (k: NodeKey) => sc.placement.blockOf.get(k)?.L.parent.get(k) ?? null;
    return [...keys].filter((k) => {
        if (!sc.placement.pos.has(k)) return false;
        for (let p = up(k); p; p = up(p)) if (keys.has(p)) return false;
        return true;
    }).map(vertexUnit);
}

function dragUnit(unitOf: (d: LabelSpan) => string) {
    let box: { x: number; y: number; w: number; h: number } | undefined;
    let units: string[] = [];
    return drag<SVGGElement, LabelSpan>()
        // the default subject is the datum, which has no x, y: pointer position instead
        .subject((ev) => ({ x: ev.x, y: ev.y }))
        .clickDistance(4)
        .on('start', (_ev, d) => {
            dragging = true;
            const sc = scene!;
            const unit = unitOf(d);
            units = !unit.startsWith('box:') && selected.has(d.key) && selected.size > 1 ? topUnits(sc, selected) : [unit];
            let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
            for (const u of units) {
                const f = u.startsWith('box:') ? sc.placement.frames.find((x) => x.unit === u) : undefined;
                if (f) { c0 = Math.min(c0, f.c0); r0 = Math.min(r0, f.r0); c1 = Math.max(c1, f.c1 + 1); r1 = Math.max(r1, f.r1); continue; }
                for (const k of unitMembers(sc, u)) {
                    const p = sc.placement.pos.get(k);
                    if (!p) continue;
                    c0 = Math.min(c0, p.col); r0 = Math.min(r0, p.row);
                    c1 = Math.max(c1, sc.placement.end.get(k)!); r1 = Math.max(r1, p.row);
                }
            }
            box = { x: X(c0), y: Y(r0), w: X(c1 - c0), h: Y(r1 - r0 + 1) };
        })
        .on('drag', (ev) => {
            if (!box) return;
            const o = root.select('.drag');
            o.selectAll('*').remove();
            o.append('rect').attr('x', box.x + ev.x - ev.subject.x).attr('y', box.y + ev.y - ev.subject.y)
                .attr('width', box.w).attr('height', box.h).attr('rx', 3);
        })
        .on('end', (ev) => {
            dragging = false;
            settleStreak = 0;
            root.select('.drag').selectAll('*').remove();
            const dc = Math.round((ev.x - ev.subject.x) / cw), dr = Math.round((ev.y - ev.subject.y) / ch);
            box = undefined;
            if (!dc && !dr) return;
            const sc = scene!;
            // the picture stays still around what moved: the anchor goes to a function that does not move (a
            // unit moved above or left of everything shifts the grid origin, which the anchor compensates)
            const moved = new Set(units.flatMap((u) => unitMembers(sc, u)));
            const still = [...doc!.view.seeds, ...sc.placement.pos.keys()].find((k) => !moved.has(k) && !isStub(k) && sc.placement.pos.has(k));
            if (still) anchorAt(still); else anchor = undefined;
            const [a, b] = settleDrop(units, dc, dr);
            const us = units;
            why('dragUnit', { units: us, drag: [dc, dr], drop: [a, b] });
            commit((x) => { for (const u of us) moveUnit(x, u, a, b); });
            if (!still) svg.call(zoomer.translateBy, a * cw, b * ch);   // everything moved: the same as a pan
        });
}

/** Moves a unit by (dc, dr): its lock when locked, else its offset. */
function moveUnit(x: ViewDoc, unit: string, dc: number, dr: number) {
    const lock = x.view.lock[unit];
    if (lock) x.view.lock[unit] = [lock[0] + dc, lock[1] + dr];
    else {
        const o = x.view.offset[unit] ?? [0, 0];
        x.view.offset[unit] = [o[0] + dc, o[1] + dr];
    }
}

/**
 * Collisions of the labels in `keys`: a label, or the arrowhead and blank cells before it, on a box
 * border; two labels on one row closer than `name() ─> next()` needs (blank, line, arrowhead, blank).
 * Of the frames of `units` (box units and the boxes inside them): another label on their border or inside.
 */
function collisions(sc: Scene, keys: Set<NodeKey>, units: readonly string[] = []): number {
    const border = new Set<number>();
    for (const f of sc.placement.frames) {
        for (let c = f.c0; c <= f.c1; c++) { border.add(cellId(f.r0, c)); border.add(cellId(f.r1, c)); }
        for (let r = f.r0; r <= f.r1; r++) { border.add(cellId(r, f.c0)); border.add(cellId(r, f.c1)); }
    }
    const labels = sc.grid.labels.filter((l) => l.kind === 'node' && !isStub(l.key));
    const byRow = new Map<number, LabelSpan[]>();
    for (const l of labels) { if (!byRow.has(l.row)) byRow.set(l.row, []); byRow.get(l.row)!.push(l); }
    let n = 0;
    for (const l of labels) {
        if (!keys.has(l.key)) continue;
        for (let c = l.col - 2; c < l.col + l.text.length; c++) if (border.has(cellId(l.row, c))) { n++; break; }
        for (const o of byRow.get(l.row)!) {
            if (o === l) continue;
            const [a, b] = o.col < l.col ? [o, l] : [l, o];
            if (b.col - (a.col + a.text.length) < 4) n++;
        }
    }
    // frames that move with the unit: its own box, and boxes whose labels all belong to it
    const own = sc.placement.frames.filter((f) => units.includes(f.unit)
        || labels.some((l) => keys.has(l.key) && l.row > f.r0 && l.row < f.r1 && l.col > f.c0 && l.col < f.c1)
            && labels.every((l) => !(l.row > f.r0 && l.row < f.r1 && l.col > f.c0 && l.col < f.c1) || keys.has(l.key)));
    for (const l of labels) {
        if (keys.has(l.key)) continue;
        if (own.some((f) => l.row >= f.r0 && l.row <= f.r1 && l.col + l.text.length > f.c0 && l.col - 2 <= f.c1)) n++;
    }
    return n;
}

/**
 * Repulsion on drop: when the dropped unit's labels collide (collisions) or a call loses its route, the
 * drop moves on in the drag direction, else sideways, one cell at a time, to the nearest clean spot
 * (at most 12 cells, 1.5 s of layouts); none found: the drop stays where it was let go.
 */
function settleDrop(units: string[], dc: number, dr: number): [number, number] {
    if (!doc || !scene || !style) return [dc, dr];
    const keys = new Set(units.flatMap((u) => unitMembers(scene!, u)));
    const unrouted = scene.grid.unrouted;
    const t0 = performance.now();
    const clean = (a: number, b: number) => {
        const probe = structuredClone(doc!);
        for (const u of units) moveUnit(probe, u, a, b);
        try {
            const sc = buildScene(probe, style!, excludes, outside());
            return sc.grid.unrouted <= unrouted && collisions(sc, keys, units) === 0;
        } catch { return false; }
    };
    if (clean(dc, dr)) return [dc, dr];
    const sx = Math.sign(dc) || 1, sy = Math.sign(dr) || 1;
    for (let k = 1; k <= 12 && performance.now() - t0 < 1500; k++) {
        for (const [a, b] of [[dc + sx * k, dr], [dc, dr + sy * k], [dc, dr - sy * k], [dc - sx * k, dr]] as const) {
            if (clean(a, b)) return [a, b];
        }
    }
    return [dc, dr];
}

function lockUnit(unit: string) {
    if (!scene || !doc) return;
    why('lockUnit', { unit });
    const at = unitAnchor(scene, unit);
    if (!at) return;
    commit((x) => { x.view.lock[unit] = at; delete x.view.offset[unit]; });
}

function unlockUnit(unit: string) {
    if (!scene || !doc || !doc.view.lock[unit]) return;
    why('unlockUnit', { unit });
    const here = unitAnchor(scene, unit)!;
    // keep the unit where it is: its offset becomes the distance to its computed place
    const probe = structuredClone(doc);
    delete probe.view.lock[unit];
    delete probe.view.offset[unit];
    const auto = unitAnchor(buildScene(probe, style!, excludes, outside()), unit);
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

/** A warning from the host (a VS Code notification): what a command lacked. */
function warn(text: string) { api.postMessage({ type: 'warn', text }); }

/** `ok`, or a warning naming what is missing. */
function need(ok: unknown, missing: string): boolean {
    if (!ok) warn(missing);
    return !!ok;
}

function runCmd(cmd: string, key?: NodeKey, unit?: string, to?: NodeKey) {
    if (!scene || !doc) return;
    why(`runCmd:${cmd}`, { key, unit, to });
    const k = key ?? focusKey;
    const call = key && to ? { from: key, to } : selCalls.size ? unkey([...selCalls][0]) : undefined;
    const NO_CALL = `${cmd}: no call: click a line, or right click one`;
    const NO_FN = `${cmd}: no function: click one, or right click it`;
    const NO_SEL = `${cmd}: nothing selected: click functions (Shift adds) or a line`;
    const grows = doc.view.arrange === 'grow';
    switch (cmd) {
        case 'callSubtree': {
            if (!need(call || selCalls.size, NO_CALL)) return;
            // the clicked call, or the whole selection when the clicked call is part of it
            const calls = call && !selCalls.has(callKey(call)) ? [call] : [...selCalls].map(unkey);
            isolateCalls(calls.length ? calls : call ? [call] : []);
            return;
        }
        case 'callPath': if (need(call, NO_CALL)) isolate(new Set([...reachDrawn(call!.from, 'up'), ...reachDrawn(call!.to, 'down')])); return;
        case 'isolateSelection': {
            // the selected calls, else the selected functions, else the function right clicked or focused
            if (!need(selCalls.size || selected.size || k, NO_SEL)) return;
            if (selCalls.size) isolateCalls([...selCalls].map(unkey));
            else isolate(new Set(selected.size ? selected : [k!]));
            return;
        }
        case 'resetView':
            commit((x) => {
                Object.assign(x.view, { hidden: [], collapsed: [], offset: {}, lock: {}, sibling: {}, group: [], ungroup: [], straight: [] });
                delete x.view.cut;
                if (x.view.arrange === 'grow') x.view.open = {};
                else {
                    x.view.depthUp = x.view.direction !== 'out' ? x.view.depth : 0;
                    x.view.depthDown = x.view.direction !== 'in' ? x.view.depth : 0;
                }
            });
            anchor = undefined;
            fit();
            return;
        case 'callSite': {
            if (!need(call, NO_CALL)) return;
            const { caller, callee } = asCall(call!);
            const e = scene.vg.edges.find((x) => x.from === caller && x.to === callee);
            api.postMessage({ type: 'openAt', key: caller, line: e && e.line < Number.MAX_SAFE_INTEGER ? e.line : undefined });
            return;
        }
        case 'callee': if (need(call, NO_CALL)) api.postMessage({ type: 'open', key: asCall(call!).callee }); return;
        case 'resetLayout': commit((x) => { x.view.offset = {}; x.view.lock = {}; x.view.sibling = {}; x.view.straight = []; }); anchor = undefined; fit(); return;
        case 'showAll': commit((x) => { x.view.hidden = []; delete x.view.cut; x.view.collapsed = []; }); return;
        case 'lock': if (need(unit ?? k, NO_FN)) lockUnit(unit ?? k!); return;
        case 'openUp': case 'openDown': case 'closeUp': case 'closeDown':
            if (!need(k, NO_FN) || !need(grows, `${cmd}: one layer at a time only; the full layout shows the call depths of the toolbar`)) return;
            setSide(k!, cmd.endsWith('Up') ? 'up' : 'down', cmd.startsWith('open'));
            return;
        case 'straighten': {
            if (!need(call || selCalls.size, NO_CALL)) return;
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
        case 'unlock':
            if (need(unit ?? k, NO_FN) && need(doc.view.lock[unit ?? k!], `unlock: ${(unit ?? k)!.split('#').pop()} is not locked`)) unlockUnit(unit ?? k!);
            return;
        // callers or callees only: the function itself stays out of the selection
        case 'upstream': if (need(k, NO_FN)) { selected = reach(k!, 'up'); selected.delete(k!); } break;
        case 'downstream': if (need(k, NO_FN)) { selected = reach(k!, 'down'); selected.delete(k!); } break;
        case 'through': if (need(k, NO_FN)) selected = new Set([...reach(k!, 'up'), ...reach(k!, 'down')]); break;
        case 'between': {
            // every function on a call path between any two of the selected functions, in either direction
            const sel = [...selected];
            if (!need(sel.length >= 2, `between: select two or more functions (Shift+click); ${sel.length} selected`)) return;
            const down = new Map(sel.map((a) => [a, reach(a, 'down')] as const));
            const up = new Map(sel.map((a) => [a, reach(a, 'up')] as const));
            const out = new Set(sel);
            for (const a of sel) for (const b of sel) if (a !== b) for (const x of down.get(a)!) if (up.get(b)!.has(x)) out.add(x);
            if (out.size === sel.length) warn(`between: no call path between the ${sel.length} selected functions`);
            selected = out;
            break;
        }
        case 'hideSelection': {
            const sel = selected.size ? [...selected] : k ? [k] : [];
            if (!need(sel.length, NO_SEL)) return;
            selected.clear();
            hide(sel);
            return;
        }
        case 'clearSelection': selected.clear(); selCalls.clear(); break;
        case 'showHidden': {
            const hid = k ? scene.hiddenOf.get(k) : undefined;
            if (need(k, NO_FN) && need(hid, `showHidden: ${k!.split('#').pop()} has no hidden neighbors`)) api.postMessage({ type: 'hiddenNeighbors', key: k, keys: hid });
            return;
        }
        case 'makeSeed':
            // a seed opens both sides; the host asks the language server for the side not asked yet
            if (need(k, NO_FN) && need(!doc.view.seeds.includes(k!), `makeSeed: ${k!.split('#').pop()} is a seed already`)) { anchorAt(k!); commit((x) => { x.view.seeds.push(k!); }); }
            return;
        case 'removeSeed':
            // the last seed stays: without one, a view shows nothing
            if (need(k, NO_FN) && need(doc.view.seeds.includes(k!), `removeSeed: ${k!.split('#').pop()} is not a seed`)
                && need(doc.view.seeds.length > 1, 'removeSeed: the last seed stays (a view without seeds shows nothing)')) {
                anchorAt(k!); commit((x) => { x.view.seeds = x.view.seeds.filter((s0) => s0 !== k); });
            }
            return;
        case 'rearrangeSelection': {
            // the selected functions (else the one right clicked) go back to their computed place: moves and
            // locks dropped; the rest of the picture stays still
            const keys = new Set(selected.size ? selected : k ? [k] : []);
            if (!need(keys.size, NO_SEL)) return;
            const still = [...doc.view.seeds, ...scene.placement.pos.keys()].find((x) => !keys.has(x) && !isStub(x) && scene!.placement.pos.has(x));
            if (still) anchorAt(still);
            commit((x) => { for (const s0 of keys) for (const u of [s0, collapsedUnit(s0)]) { delete x.view.offset[u]; delete x.view.lock[u]; } });
            return;
        }
        case 'rearrange': commit((x) => { x.view.offset = {}; }); return;   // every unlocked move; a selection: 'rearrangeSelection'
        case 'unlockAll': commit((x) => { x.view.lock = {}; }); return;
        case 'expandAll': if (need(doc.view.collapsed.length, `${cmd}: nothing is collapsed`)) commit((x) => { x.view.collapsed = []; }); return;
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
    why('moveSibling', { key: focusKey, delta });
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
    why('collapseInnermost', { key });
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
        case 'e': case ' ': if (k && doc.view.arrange === 'grow') for (const s0 of ['down', 'up'] as const) if (scene?.hasMore(k, s0)) setSide(k, s0, true); break;
        case 'ArrowLeft': case 'c': if (k) collapseInnermost(k); break;
        case 'ArrowRight': if (k && scene?.vg.nodes.get(k)?.collapsed) { why('expand', { key: k }); anchorAt(k); commit((d) => { d.view.collapsed = d.view.collapsed.filter((x) => x !== k); }); } break;
        case 'Delete': case 'Backspace': runCmd('remove'); break;
        case 'h': runCmd('hideSelection'); break;
        case 'a': runCmd(selected.size ? 'rearrangeSelection' : 'rearrange'); break;
        case 'i': runCmd('isolateSelection'); break;
        case 'Escape':
            // a selection first, then everything hidden or removed
            if (selected.size || selCalls.size) runCmd('clearSelection');
            else if (doc.view.hidden.length || doc.view.cut?.length || doc.view.collapsed.length) runCmd('showAll');
            break;
        case 'k': if (k) runCmd(doc.view.lock[vertexUnit(k)] ? 'unlock' : 'lock', k, vertexUnit(k)); break;
        case 'u': commit((d) => { d.view.hidden = []; }); break;
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
type Btn = { label: string; title: string; on?: boolean; act: () => void; disabled?: boolean; text?: boolean };
type Section = { caption: string; items: Btn[]; radio?: boolean };

/** Library roots of external paths (langs.ts `externalPath`): their folders are external code. */
const LIB_ROOT = /^(site-packages|dist-packages|stdlib|python\d+(\.\d+)?|include|library|node_modules)$/;

/**
 * Folders of the functions in the view, one level below their common prefix, with the view's excluded and
 * included folders. External folders only with external code included, standard library folders only with
 * the standard library included (as drawn: scene.ts `excludedKeys`).
 */
function folders(): { path: string; label: string; excluded: boolean }[] {
    if (!doc) return [];
    const ex = excludedBy(doc.view, excludes);
    const shown = (n: GNode) => !n.external || (settings.includeExternal && (settings.includeStandardLibrary || !isStandard(n.path)));
    const all = Object.values(doc.graph.nodes).filter((n) => n.path && !isContainer(n));
    const extTop = new Set(all.filter((n) => n.external).map((n) => n.path!.split('/')[0]));
    const hiddenDir = (p: string) => {
        const top = p.split('/')[0];
        if (!extTop.has(top) && !LIB_ROOT.test(top)) return false;
        return !settings.includeExternal || (!settings.includeStandardLibrary && isStandard(`${p}/x`));
    };
    const dirs = all.filter(shown).map((n) => n.path!.split('/').slice(0, -1));
    if (!dirs.length && !doc.view.exclude.length && !doc.view.include.length) return [];
    let prefix = dirs[0] ?? [];
    for (const d of dirs) { let i = 0; while (i < prefix.length && i < d.length && prefix[i] === d[i]) i++; prefix = prefix.slice(0, i); }
    const set = new Set<string>();
    for (const d of dirs) if (d.length > prefix.length) set.add([...prefix, d[prefix.length]].join('/'));
    for (const p of [...doc.view.exclude, ...doc.view.include]) set.add(p);
    return [...set].filter((p) => !hiddenDir(p)).sort().map((p) => ({ path: p, label: p.split('/').pop()!, excluded: ex(`${p}/x`) }));
}

/** Deepest caller (`up`) or callee (`down`) level on screen. */
function levelOf(side: 'up' | 'down'): number {
    let m = 0;
    for (const [k, l] of scene?.rev.level ?? []) if (scene!.rev.allowed.get(k) === side) m = Math.max(m, l);
    return m;
}

/**
 * Switch between one layer at a time and full, keeping what is on screen: full takes the deepest caller
 * and callee levels shown as its call depths; one layer at a time opens, on each vertex shown, the side
 * that leads one level further within those depths.
 */
function setArrange(to: 'grow' | 'auto') {
    if (!doc || !scene || doc.view.arrange === to) return;
    why('setArrange', { to });
    const rev = scene.rev;
    if (to === 'auto') {
        const up = levelOf('up'), down = levelOf('down');
        commit((x) => { x.view.arrange = 'auto'; x.view.depthUp = up; x.view.depthDown = down; });
        return;
    }
    const v = doc.view;
    const within = (l: number, d: Depth) => d === 'all' || l < d;
    const open: Record<NodeKey, OpenSide> = {};
    for (const k of rev.visible) {
        const a = rev.allowed.get(k), l = rev.level.get(k) ?? 0;
        const up = (a === 'both' || a === 'up') && within(l, v.depthUp);
        const down = (a === 'both' || a === 'down') && within(l, v.depthDown);
        open[k] = up && down ? 'both' : up ? 'up' : down ? 'down' : 'none';
    }
    commit((x) => { x.view.arrange = 'grow'; x.view.open = { ...(x.view.open ?? {}), ...open }; });
}

/** Full: one side's call depth; `all` keeps every level the data holds. */
function setDepth(side: 'up' | 'down', d: Depth | ((n: number) => number)) {
    why('setDepth', { side, depth: typeof d === 'function' ? 'step' : d });
    commit((x) => {
        const cur = side === 'up' ? x.view.depthUp : x.view.depthDown;
        const next = typeof d === 'function' ? Math.max(0, d(cur === 'all' ? levelOf(side) : cur)) : d;
        if (side === 'up') x.view.depthUp = next; else x.view.depthDown = next;
    });
}

function toolbar() {
    if (!doc || !style) return;
    pageContext();
    const v = doc.view;
    const mode = v.edges ?? style.edges.mode;
    const curve = v.curve ?? style.edges.curve;
    const rule = v.parentRule ?? style.grid.parentRule;
    const boxes = v.boxes ?? style.boxes.enabled;
    const removed = v.hidden.length + (v.cut?.length ?? 0) + v.collapsed.length;
    const isolated = removed > 0;
    const canIsolate = selCalls.size > 0 || selected.size > 0;

    // full: `all` `+` `−` callers  call depth  callees `−` `+` `all`
    const depthBtns = (side: 'up' | 'down'): Btn[] => {
        const d = side === 'up' ? v.depthUp : v.depthDown;
        const who = side === 'up' ? 'caller' : 'callee';
        const all: Btn = { label: 'all', title: `every ${who} level`, on: d === 'all', act: () => setDepth(side, 'all') };
        const plus: Btn = { label: '+', title: `one ${who} level more`, disabled: d === 'all', act: () => setDepth(side, (n) => n + 1) };
        const minus: Btn = { label: '−', title: `one ${who} level less`, disabled: d === 0, act: () => setDepth(side, (n) => n - 1) };
        const num: Btn = { label: d === 'all' ? `${levelOf(side)}` : `${d}`, title: `${who} levels shown`, text: true, act: () => {} };
        return side === 'up' ? [all, plus, minus, num] : [num, minus, plus, all];
    };
    const bar: Btn[] = [
        isolated
            ? { label: `Show all (${removed})`, title: 'show every hidden function, removed call and collapsed container (Esc)', on: true, act: () => runCmd('showAll') }
            : { label: 'Isolate', title: 'show only the selected calls or functions (Enter)', disabled: !canIsolate, act: () => runCmd('isolateSelection') },
        ...(v.arrange === 'grow' ? [] : [
            ...depthBtns('up'),
            { label: 'call depth', title: 'caller levels (left), callee levels (right)', text: true, act: () => {} },
            ...depthBtns('down'),
        ]),
        { label: 'fit', title: 'fit to window (0)', act: fit },
    ];
    const fl = folders();
    const sections: Section[] = [
        { caption: 'Call Expansion', radio: true, items: [
            { label: 'Individual On Graph: >>', title: '>> and └─>> open a side; an arrowhead closes the level it points into; Delete removes the selection; the function acted on stays in place on screen', on: v.arrange === 'grow',
                act: () => setArrange('grow') },
            { label: 'Global Toolbar: + - call depth - +', title: 'caller and callee levels from the toolbar; the same picture, no opening or closing of single functions', on: v.arrange !== 'grow',
                act: () => setArrange('auto') },
        ] },
        ...(v.arrange !== 'grow' ? [{ caption: 'Call depth by', radio: true, items: (['shortest', 'longest'] as const).map((r) => ({
            label: r === 'shortest' ? 'Shortest call path' : 'Longest call path',
            title: r === 'shortest' ? 'a function sits at the fewest calls from the seeds' : 'a function sits at the most calls from the seeds (loops not counted)',
            on: v.depthRule === r, act: () => commit((x) => { x.view.depthRule = r; }) })) } as Section] : []),
        { caption: 'Namespaces', items: [
            { label: 'Group namespaces', title: 'boxes per package and folder (b); right click a box or function to group or ungroup one', on: boxes,
                act: () => commit((x) => { x.view.boxes = !boxes; }) },
            { label: 'Tight groups', title: 'namespace frames hug their content: functions moved right or down pull the frame edges along', on: v.tight ?? style!.boxes.tight,
                act: () => commit((x) => { x.view.tight = !(v.tight ?? style!.boxes.tight); }) },
            ...(v.group.length || v.ungroup.length ? [{ label: `Reset grouping (${v.group.length + v.ungroup.length})`, title: 'drop per-box group and ungroup choices',
                act: () => commit((x) => { for (const c of [...x.view.group, ...x.view.ungroup]) dropMovesWithin(x, c); x.view.group = []; x.view.ungroup = []; }) }] : []),
        ] },
        { caption: 'Edges', radio: true, items: (['glyph', 'vector'] as const).map((m) => ({
            label: m === 'glyph' ? 'ASCII (UTF) Style' : 'D3 Vector Style', title: 'edge drawing (g)', on: mode === m, act: () => commit((x) => { x.view.edges = m; }),
        })) },
        ...(mode === 'vector' ? [{ caption: 'Curve', radio: true, items: (['orthogonal', 'rounded', 'sigmoid', 'spline'] as Curve[]).map((c) => ({
            label: c, title: 'curve style of vector edges', on: curve === c, act: () => commit((x) => { x.view.curve = c; }),
        })) } as Section] : []),
        { caption: 'Tree parent', radio: true, items: (['dfs', 'nearest', 'joint'] as const).map((m) => ({
            label: m === 'dfs' ? 'First caller found' : m === 'nearest' ? 'Nearest caller above' : 'Left merge incoming calls',
            title: m === 'joint' ? 'no caller privileged: a caller right above joins the elbow (├───┴─>), several callers join one collector (┌──┘ └─>)'
                : 'which caller a shared function hangs under', on: rule === m,
            act: () => commit((x) => { x.view.parentRule = m; }) })) },
        // the same entries, names and order as the canvas context menu (package.json, group 3_arrange)
        { caption: 'Arrange', items: [
            { label: 'Reset graph: seeds, depth, direction', title: v.arrange === 'grow'
                ? 'back to the seeds and their first layer: close every side, drop hidden and removed, collapsed, moves, locks, grouping'
                : 'back to the starting call depths: drop hidden, collapsed, moves, locks, grouping', act: () => runCmd('resetView') },
            { label: 'Reset Layout: moves, locks, order', title: 'drop every move, lock, sibling order and straightened call', act: () => runCmd('resetLayout') },
            { label: selected.size ? `Re-arrange selected (${selected.size})` : `Re-arrange (${Object.keys(v.offset).length})`,
                title: 'the selected functions back to their computed place (moves and locks dropped), or every unlocked move (a)',
                act: () => runCmd(selected.size ? 'rearrangeSelection' : 'rearrange') },
            { label: `Unlock all (${Object.keys(v.lock).length})`, title: 'unlock every locked function and box', act: () => runCmd('unlockAll') },
            { label: `Expand collapsed (${v.collapsed.length})`, title: 'expand every collapsed container', act: () => runCmd('expandAll') },
        ] },
        { caption: 'Folders', items: [
            { label: 'Include external code', title: 'installed packages, system headers, build output (gaffy.includeExternal, workspace settings); turning it on asks the language server again',
                on: settings.includeExternal, act: () => api.postMessage({ type: 'setting', key: 'includeExternal', value: !settings.includeExternal }) },
            { label: 'Include standard library', title: 'gaffy.includeStandardLibrary: with external code, also the builtins and standard library of each language (Python builtins, Rust std, C++ std, TypeScript lib); drawn without the language server',
                on: settings.includeStandardLibrary, act: () => api.postMessage({ type: 'setting', key: 'includeStandardLibrary', value: !settings.includeStandardLibrary }) },
            ...fl.map((f) => ({
            label: f.label, title: `${f.path}: ${f.excluded ? 'excluded, click to include' : 'included, click to exclude'}`, on: !f.excluded,
            act: () => commit((x) => {
                if (f.excluded) {
                    if (x.view.exclude.includes(f.path)) x.view.exclude = x.view.exclude.filter((p) => p !== f.path);
                    else x.view.include.push(f.path);
                } else {
                    x.view.include = x.view.include.filter((p) => p !== f.path);
                    x.view.exclude.push(f.path);
                }
            }) })),
        ] },
        // the first four as the canvas context menu (package.json, group 1_file)
        { caption: 'File', items: [
            ...(settings.saveViews ? [] : [{ label: 'Save (.gaffy)', title: 'save this graph (.gaffy/views/)', act: () => api.postMessage({ type: 'save' }) }]),
            { label: 'Autosave Graphs', title: 'gaffy.saveViews: new graphs are written to .gaffy/views/ and saved after every change; off: a new graph opens unsaved, Save (.gaffy) keeps it',
                on: settings.saveViews, act: () => api.postMessage({ type: 'setting', key: 'saveViews', value: !settings.saveViews }) },
            { label: 'Save as Text (.txt, .md)', title: '.gaffy/<symbol>_<commit>.md and .txt, then _2, _3 (x)', act: () => api.postMessage({ type: 'export' }) },
            { label: 'Refresh Language Server', title: v.arrange === 'grow'
                ? 'calls of the functions on screen from the language server; the others when a side opens onto them. Unanswered functions keep their calls (r)'
                : 'calls of the functions on screen from the language server, then the levels within the call depths. Unanswered functions keep their calls (r)',
            act: () => api.postMessage({ type: 'refresh' }) },
            { label: 'Edit style.json', title: '.gaffy/style.json', act: () => api.postMessage({ type: 'editStyle' }) },
            { label: 'Settings', title: 'VS Code Settings, filtered to gaffy', act: () => api.postMessage({ type: 'openSettings' }) },
        ] },
    ];

    const tb = select('#toolbar');
    tb.selectAll('*').remove();
    for (const b of bar) {
        if (b.text) { tb.append('span').attr('class', 'depth').attr('title', b.title).text(b.label); continue; }
        tb.append('button').attr('class', b.on ? 'on' : null).attr('title', b.title).property('disabled', !!b.disabled).text(b.label)
            .on('click', (ev: MouseEvent) => { ev.stopPropagation(); b.act(); });
    }
    const wrap = tb.append('span').attr('class', 'opts');
    wrap.append('button').attr('class', optsOpen ? 'on' : null).text('☰ Options ▾').attr('title', 'layout, namespaces, edges, tree parent, arrange, folders, file')
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
    if (settings.untitled) parts.push('unsaved view: right click > Save keeps it');
    if (doc.view.static) parts.push('static view: no language server');
    if (note) parts.push(note);
    if (busy) parts.push('building…');
    else if (doc.updated) parts.push(`built ${new Date(doc.updated).toLocaleString()}`);
    parts.push(doc.view.arrange === 'grow'
        ? '>> └─>> open · arrowhead: close its level · click a line: select · Delete remove · dblclick toggle · drag move · right-click menu'
        : 'full: call depth in the toolbar · click open · ctrl/shift+click select · Delete hide · drag move · right-click menu');
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
