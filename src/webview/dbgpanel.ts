/** @xvdp
 * Layout debugging panel (gaffy.debugLayout), docked under the graph, three tabs:
 * - Rules: every rule of rules.ts by stage: switch, alternative, parameters (the view's value, else the default),
 *   links to its explanation (docs/heuristics.md) and its code lines (rules.lines.ts); changes go to the view's
 *   `rules`, saved with the graph, one undo step each.
 * - Actions: running log, one entry per change of the picture: cause (event, target, interpreter), each moved box
 *   and function with old and new cell [row, column], the decisions of rules that placed it, with code links; the
 *   functions that moved with their box are counted under it.
 * - Calls: one row per drawn call (grid.ts `RouteRecord`): how its line is drawn (branch, trunk, path search), search
 *   order and pass, arrival side and reason, cost parts, crossings paid and received (by which calls), search-again
 *   round; a click selects the call.
 * Links post `openRule` (rule id, site index or `doc`); the host opens the local clone or GitHub (host/sources.ts).
 */
import { select, Selection } from 'd3-selection';
import { Decision } from '../core/explain';
import { RouteRecord } from '../core/grid';
import { NodeKey } from '../core/model';
import { RULES, RuleConfig, RuleSpec, STAGES } from '../core/rules';
import { RULE_LINES } from '../core/rules.lines';
import { Scene } from '../core/scene';
import { Style } from '../core/style';
import { ViewDoc } from '../core/viewdoc';

export interface DebugHost {
    doc(): ViewDoc | undefined;
    style(): Style | undefined;
    scene(): Scene | undefined;
    decisions(): Decision[];
    boxChain(unit: string): string[];
    /** Commits a change of the view's rules (one undo step). */
    setRules(mut: (r: RuleConfig) => void, why: string): void;
    post(msg: Record<string, unknown>): void;
    selectCall(from: NodeKey, to: NodeKey): void;
}

/** Old and new cell [row, column] of a label (vertex key) or frame (box unit); null: absent. */
export type Move = [string, [number, number] | null, [number, number] | null];
export interface Cause { event?: string; target?: string; fn?: string }
interface Action { seq: number; cause: Cause; moved: Move[]; decisions: Decision[] }

type Div = Selection<HTMLDivElement, unknown, HTMLElement, unknown>;
const short = (k: string) => k.slice(k.indexOf('#') + 1).replace(/^box:dir:|^box:/, '');
const cell = (c: [number, number] | null) => (c ? `(${c[0]}, ${c[1]})` : '-');

export class DebugPanel {
    open = false;
    tab: 'rules' | 'actions' | 'calls' = 'actions';
    crossedOnly = true;
    private actions: Action[] = [];
    private scroll: Partial<Record<DebugPanel['tab'], number>> = {};
    private shown: DebugPanel['tab'] = 'actions';
    private seq = 0;

    constructor(private readonly host: DebugHost) {}

    toggle(tab?: DebugPanel['tab']): void {
        if (tab && (!this.open || this.tab !== tab)) { this.open = true; this.tab = tab; } else this.open = !this.open;
        this.render();
    }

    /** Records one change of the picture: its cause, the moved labels and frames, the current decisions. */
    record(cause: Cause, moved: Move[]): void {
        if (!moved.length && !cause.event) return;
        this.actions.push({ seq: ++this.seq, cause, moved, decisions: this.host.decisions() });
        if (this.actions.length > 200) this.actions.shift();
        if (this.open && this.tab === 'actions') this.render();
    }

    render(): void {
        let el = select<HTMLDivElement, unknown>('#dbg');
        if (el.empty()) el = select('body').append<HTMLDivElement>('div').attr('id', 'dbg');
        el.classed('on', this.open);
        select('body').classed('dbg-open', this.open);
        // the body list keeps its scroll position per tab across redraws (a rule change redraws it)
        const body0 = el.select<HTMLDivElement>('.dbgbody').node();
        if (body0) this.scroll[this.shown] = body0.scrollTop;
        el.selectAll('*').remove();
        if (!this.open) return;
        this.shown = this.tab;
        const head = el.append('div').attr('class', 'dbghead');
        for (const [t, label] of [['rules', 'Rules'], ['actions', 'Actions'], ['calls', 'Calls']] as const) {
            head.append('button').attr('class', this.tab === t ? 'on' : null).text(label).on('click', () => { this.tab = t; this.render(); });
        }
        head.append('span').attr('class', 'grow');
        head.append('a').text('heuristics.md').attr('title', 'every rule explained').on('click', () => this.host.post({ type: 'openRule', id: RULES[0].id, site: 'doc' }));
        head.append('button').text('×').attr('title', 'close').on('click', () => this.toggle());
        const body = el.append<HTMLDivElement>('div').attr('class', 'dbgbody');
        if (this.tab === 'rules') this.rules(body);
        else if (this.tab === 'actions') this.log(body);
        else this.calls(body);
        body.node()!.scrollTop = this.scroll[this.tab] ?? 0;
    }

    /** Link to a rule's explanation or code site. */
    private link(parent: Div | Selection<HTMLSpanElement, unknown, HTMLElement, unknown>, id: string, site: number | 'doc', text?: string): void {
        const s = RULE_LINES[id]?.[site === 'doc' ? 0 : site];
        if (site !== 'doc' && !s) return;
        parent.append('a').attr('class', 'code').text(text ?? (site === 'doc' ? id.slice(0, 3) : `${s![0].split('/').pop()}:${s![1]}`))
            .attr('title', site === 'doc' ? `docs/heuristics.md#${id}` : `${s![0]}:${s![1]}`)
            .on('click', (ev: MouseEvent) => { ev.stopPropagation(); this.host.post({ type: 'openRule', id, site }); });
    }

    // ---- rules ----------------------------------------------------------------------------------------
    private rules(body: Div): void {
        const doc = this.host.doc(), style = this.host.style();
        if (!doc || !style) return;
        const mine = doc.view.rules ?? {};
        const offNow = new Set<string>(mine.off ?? []);
        body.append('div').attr('class', 'dbgnote').text('Switches, alternatives and parameters of this view (saved with it; one undo step each); ↺ returns a parameter to its default. Ids link to the explanation, file:line to the code.');
        for (const stage of STAGES) {
            body.append('div').attr('class', 'dbgstage').text(stage);
            for (const r of RULES.filter((x) => x.stage === stage)) this.rule(body, r, offNow, mine);
        }
    }

    private rule(body: Div, r: RuleSpec, offNow: Set<string>, mine: RuleConfig): void {
        const row = body.append('div').attr('class', 'dbgrule').attr('title', r.text);
        if (r.without) {
            row.append('input').attr('type', 'checkbox').property('checked', !offNow.has(r.id)).attr('title', `off: ${r.without}`)
                .on('change', () => this.host.setRules((c) => {
                    const off = new Set(c.off ?? []);
                    if (off.has(r.id)) off.delete(r.id); else off.add(r.id);
                    c.off = [...off];
                }, `rule ${r.id} ${offNow.has(r.id) ? 'on' : 'off'}`));
        } else row.append('span').attr('class', 'nobox');
        this.link(row, r.id, 'doc', r.id);
        row.append('span').attr('class', 'title').text(` ${r.title}`);
        (RULE_LINES[r.id] ?? []).forEach((_, i) => this.link(row, r.id, i));
        if (r.control) row.append('span').attr('class', 'dbgnote').text(` · ${r.control}`);
        if (r.alternatives) {
            const cur = mine.alt?.[r.id] ?? r.alternatives.default;
            const sel = row.append('select').on('change', (ev: Event) => {
                const v = (ev.target as HTMLSelectElement).value;
                this.host.setRules((c) => { c.alt = { ...(c.alt ?? {}), [r.id]: v }; }, `rule ${r.id} ${v}`);
            });
            for (const [k, v] of Object.entries(r.alternatives.choices)) sel.append('option').attr('value', k).attr('title', v).property('selected', k === cur).text(k);
        }
        for (const [n, p] of Object.entries(r.params ?? {})) {
            const key = `${r.id}.${n}`;
            const own = mine.params?.[key];
            const v = own ?? p.value;
            const span = row.append('span').attr('class', `param${own !== undefined ? ' own' : ''}`)
                .attr('title', `${p.doc}; range [${p.min}, ${p.max}], default ${p.value}${own !== undefined ? '; set in this view' : ''}`);
            span.append('span').text(` ${n} `);
            span.append('input').attr('type', 'number').attr('min', p.min).attr('max', p.max).attr('step', p.max - p.min <= 2 ? 0.05 : 1).property('value', v)
                .on('change', (ev: Event) => {
                    const x = Number((ev.target as HTMLInputElement).value);
                    if (!Number.isFinite(x)) return;
                    this.host.setRules((c) => { c.params = { ...(c.params ?? {}), [key]: Math.min(p.max, Math.max(p.min, x)) }; }, `${key} = ${x}`);
                });
            if (own !== undefined) {
                span.append('a').attr('class', 'reset').text('↺').attr('title', 'drop this view\'s value')
                    .on('click', () => this.host.setRules((c) => { const q = { ...(c.params ?? {}) }; delete q[key]; c.params = q; }, `${key} reset`));
            }
        }
    }

    // ---- actions ----------------------------------------------------------------------------------------
    private log(body: Div): void {
        const bar = body.append('div').attr('class', 'dbgnote');
        bar.append('span').text(`${this.actions.length} changes, newest first; cells as (row, column). `);
        bar.append('a').text('clear').on('click', () => { this.actions = []; this.render(); });
        for (const a of [...this.actions].reverse()) this.action(body, a);
    }

    private action(body: Div, a: Action): void {
        const sc = this.host.scene();
        const e = body.append('div').attr('class', 'dbgact');
        e.append('div').attr('class', 'dbgcause').text(`#${a.seq} ${a.cause.event ?? 'change'}${a.cause.target ? ` ${short(a.cause.target)}` : ''}${a.cause.fn ? ` · ${a.cause.fn}` : ''} · ${a.moved.length} moved`);
        const delta = (m: Move) => (m[1] && m[2] ? [m[2][0] - m[1][0], m[2][1] - m[1][1]] : undefined);
        const frames = new Map(a.moved.filter((m) => m[0].startsWith('box:')).map((m) => [m[0], delta(m)]));
        // functions moving with their innermost moved box by the same delta: counted under the box
        const carried = new Map<string, number>();
        const own: Move[] = [];
        for (const m of a.moved) {
            if (m[0].startsWith('box:')) { own.push(m); continue; }
            const d = delta(m);
            const box = d && this.host.boxChain(m[0]).map((b) => `box:${b}`).find((b) => frames.has(b));
            const bd = box ? frames.get(box) : undefined;
            if (box && bd && d && bd[0] === d[0] && bd[1] === d[1]) carried.set(box, (carried.get(box) ?? 0) + 1);
            else own.push(m);
        }
        for (const m of own.slice(0, 60)) {
            const unit = m[0];
            const name = unit.startsWith('box:') ? `group ${short(unit)}` : `${sc?.graph.nodes[unit]?.name ?? short(unit)}()`;
            const line = e.append('div').attr('class', 'dbgmove');
            line.append('span').text(`${name} ${cell(m[1])} → ${cell(m[2])}${carried.get(unit) ? ` · ${carried.get(unit)} functions with it` : ''}`);
            const chain = unit.startsWith('box:') ? [] : this.host.boxChain(unit).slice(0, 1);
            const ds = a.decisions.filter((d) => d.unit === unit || d.unit === `collapsed:${unit}` || chain.some((b) => d.unit === `block:${b}` && /h1[35]_/.test(d.rule)));
            for (const d of ds) {
                const dl = line.append('div').attr('class', `dbgdec${d.flag ? ' flag' : ''}`);
                this.link(dl, d.rule, 'doc', d.rule.slice(0, 3));
                dl.append('span').text(` ${d.text}${d.flag ? ` · flag: ${d.flag}` : ''} `);
                this.link(dl, d.rule, 0);
            }
        }
        if (own.length > 60) e.append('div').attr('class', 'dbgnote').text(`${own.length - 60} more`);
    }

    // ---- edges ------------------------------------------------------------------------------------------
    private calls(body: Div): void {
        const sc = this.host.scene();
        if (!sc) return;
        const g = sc.grid;
        const rs = [...g.routes].sort((a, b) => (a.order ?? -1) - (b.order ?? -1));
        const bar = body.append('div').attr('class', 'dbgnote');
        const crossed = rs.filter((r) => r.received || r.paid);
        bar.append('span').text(`${rs.length} calls: ${rs.filter((r) => r.kind === 'routed').length} by path search, ${rs.filter((r) => r.kind === 'elbow').length} branches, ${rs.filter((r) => r.kind === 'lane').length} on trunks, ${g.unrouted} dashed; ${crossed.length} with crossings; search-again rounds kept ${g.reroutes}. `);
        bar.append('label').call((l) => {
            l.append('input').attr('type', 'checkbox').property('checked', this.crossedOnly).on('change', () => { this.crossedOnly = !this.crossedOnly; this.render(); });
            l.append('span').text(' crossed only');
        });
        bar.append('span').text(' · rules: ');
        for (const id of ['h25_routing_order', 'h26_arrival_side', 'h29_route_cost', 'h39_reroute', 'h40_lookahead']) { this.link(bar, id, 'doc', id.slice(0, 3)); bar.append('span').text(' '); }
        const name = (k: NodeKey) => sc.graph.nodes[k]?.name ?? short(k);
        for (const r of (this.crossedOnly ? crossed : rs)) this.edge(body, r, name);
    }

    private edge(body: Div, r: RouteRecord, name: (k: NodeKey) => string): void {
        const row = body.append('div').attr('class', 'dbgedge').on('click', () => this.host.selectCall(r.from, r.to));
        const what = r.kind === 'routed' ? `search #${r.order}, ${r.pass ? 'relaxed pass' : 'strict pass'}` : r.kind === 'elbow' ? 'branch' : r.kind === 'lane' ? 'trunk' : 'dashed, no path';
        row.append('span').attr('class', 'title').text(`${name(r.from)}() → ${name(r.to)}()`);
        row.append('span').text(` · ${what}${r.round ? ` · searched again in round ${r.round}` : ''}`);
        if (r.kind === 'routed') {
            row.append('span').text(` · ${r.arrival} · cost ${r.cost!.toFixed(1)}: ${r.steps} steps, ${r.bends} bends, ${r.paid} crossings paid, ${r.borders} borders${r.relaxed ? `, ${r.relaxed.toFixed(0)} relaxed` : ''}`);
        } else if (r.kind === 'fallback') row.append('span').text(` · ${r.arrival ?? ''}`);
        if (r.received) {
            const by = new Map<string, number>();
            for (const b of r.by) by.set(b, (by.get(b) ?? 0) + 1);
            row.append('span').attr('class', 'flag').text(` · crossed ${r.received}× later by ${[...by].map(([b, n]) => `${name(b.slice(0, b.indexOf('\u0000')))} → ${name(b.slice(b.indexOf('\u0000') + 1))}${n > 1 ? ` (${n}×, braid)` : ''}`).join(', ')}`);
        }
    }
}
