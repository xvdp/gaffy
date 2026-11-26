// npm run explain -- <view.gaffy> [--unit <text>] [--flags] [--off <rule,…>] [--trace <view.jsonl>] [--style <style.json>]
// Placement decision log of a view (src/core/explain.ts), each decision with its rule's code line (scripts/rules.ts):
//   --unit   decisions of units whose key holds <text>
//   --flags  flagged decisions only (thresholds: explain.ts FLAGS)
//   --off    rules switched off (explain.ts SWITCHES): frames and functions that move against the full rule set
//   --trace  replay of a gaffy.trace file: the view before each recorded change, rebuilt from the saved view by
//            undoing the changes from the last one back; per change, its flags and the frames that jumped ≥ 12 rows
import { readFileSync } from 'node:fs';
import { Debug, Decision, decisionLine, SWITCHES } from '../src/core/explain';
import { buildScene, Scene } from '../src/core/scene';
import { boundedStyle, deepMerge, DEFAULT_STYLE, Style, userStyle } from '../src/core/style';
import { parseDoc, ViewDoc } from '../src/core/viewdoc';
import { locate } from './rules';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
if (!file) {
    console.log('usage: npm run explain -- <view.gaffy> [--unit <text>] [--flags] [--off <rule,…>] [--trace <view.jsonl>] [--style <style.json>]');
    console.log(`rules that switch off: ${Object.keys(SWITCHES).join(', ')}`);
    process.exit(1);
}
const style: Style = boundedStyle(deepMerge(DEFAULT_STYLE, userStyle(opt('--style') ? JSON.parse(readFileSync(opt('--style')!, 'utf8')) : {}).style));
const doc = parseDoc(readFileSync(file, 'utf8'), 'view');
const { ruleLine, fileOf } = locate(ROOT);
const where = (rule: string) => (ruleLine.has(rule) ? `${fileOf(rule)}:${ruleLine.get(rule)! + 1}` : undefined);

const run = (d: ViewDoc, off: ReadonlySet<string> = new Set()) => {
    const log: Decision[] = [];
    const debug: Debug = { rules: { off: [...off] }, log: (x) => log.push(x) };
    return { sc: buildScene(d, style, [], true, debug), log };
};

/** Drawn place of each frame and function, relative to the first seed on screen (the still point of a view). */
function places(sc: Scene): Map<string, [number, number]> {
    const seed = [...sc.seeds].find((k) => sc.placement.pos.has(k));
    const o = seed ? sc.placement.pos.get(seed)! : { col: 0, row: 0 };
    const out = new Map<string, [number, number]>();
    for (const f of sc.placement.frames) out.set(f.unit, [f.c0 - o.col, f.r0 - o.row]);
    for (const [k, p] of sc.placement.pos) if (!k.startsWith('⋯')) out.set(k, [p.col - o.col, p.row - o.row]);
    return out;
}
const moves = (a: Scene, b: Scene, min: number) => {
    const pa = places(a), pb = places(b);
    const out: string[] = [];
    for (const [k, p] of pa) {
        const q = pb.get(k);
        if (q && (Math.abs(q[1] - p[1]) >= min || (min <= 1 && q[0] !== p[0]))) out.push(`${k}: (${q[0] - p[0]}, ${q[1] - p[1]})`);
    }
    return out;
};

const unit = opt('--unit');
const offArg = opt('--off');
const tracePath = opt('--trace');

if (tracePath) {
    // ---- replay -----------------------------------------------------------------------------------------
    type Rec = { seq: number; view: string; cause?: { event?: string; fn?: string; target?: string }; changed?: Record<string, unknown>; graph?: unknown };
    const recs: Rec[] = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const undo = (v: Record<string, unknown>, changed: Record<string, unknown>) => {
        for (const [f, ch] of Object.entries(changed)) {
            if (Array.isArray(ch)) { if (ch[0] === null) delete v[f]; else v[f] = ch[0]; continue; }
            const c = ch as Record<string, unknown>;
            if (Array.isArray(c.added) && Array.isArray(c.removed) && Object.keys(c).length === 2) {
                const add = new Set((c.removed as unknown[]).map((x) => JSON.stringify(x)));
                const drop = new Set((c.added as unknown[]).map((x) => JSON.stringify(x)));
                v[f] = [...((v[f] as unknown[] | undefined) ?? []).filter((x) => !drop.has(JSON.stringify(x))), ...[...add].map((x) => JSON.parse(x))];
                continue;
            }
            const o = { ...((v[f] as Record<string, unknown> | undefined) ?? {}) };
            for (const [k, pair] of Object.entries(c)) { const b = (pair as unknown[])[0]; if (b === null) delete o[k]; else o[k] = b; }
            v[f] = o;
        }
    };
    // states[i]: the view before record i; states[n]: the saved view
    const states: ViewDoc[] = [doc];
    for (let i = recs.length - 1; i >= 0; i--) {
        const prev = structuredClone(states[0]);
        undo(prev.view as unknown as Record<string, unknown>, recs[i].changed ?? {});
        states.unshift(prev);
    }
    let last = run(states[0]).sc;
    console.log(`${recs.length} changes replayed on the saved graph (graph changes are not in a trace: data as saved)`);
    recs.forEach((r, i) => {
        const { sc, log } = run(states[i + 1]);
        const flags = log.filter((d) => d.flag);
        const jumps = moves(last, sc, 12);
        const what = `${r.cause?.event ?? '?'}${r.cause?.fn ? ` ${r.cause.fn}` : ''}${r.cause?.target ? ` ${r.cause.target}` : ''}`;
        console.log(`#${r.seq} ${what}: ${Object.keys(r.changed ?? {}).join(', ') || 'no view field'}${r.graph ? ' · graph changed' : ''}`);
        for (const j of jumps.slice(0, 12)) console.log(`    jump ${j}`);
        for (const d of flags) console.log(`    ⚑ ${decisionLine(d, where)}`);
        last = sc;
    });
} else if (offArg) {
    // ---- rule ablation ----------------------------------------------------------------------------------
    const off = new Set(offArg.split(',').map((x) => x.trim()).filter(Boolean));
    for (const r of off) if (!SWITCHES[r]) { console.log(`unknown rule ${r}; rules that switch off: ${Object.keys(SWITCHES).join(', ')}`); process.exit(1); }
    const full = run(doc).sc, cut = run(doc, off).sc;
    for (const r of off) console.log(`${r} off: ${SWITCHES[r]}`);
    const m = moves(full, cut, 1);
    console.log(`${m.length} frames and functions move (column, row), relative to the first seed:`);
    for (const x of m) console.log(`    ${x}`);
} else {
    // ---- decision log -----------------------------------------------------------------------------------
    const { log } = run(doc);
    const shown = log.filter((d) => (!unit || d.unit.includes(unit)) && (!args.includes('--flags') || d.flag));
    for (const d of shown) console.log(decisionLine(d, where));
    console.log(`${shown.length} of ${log.length} decisions; ${log.filter((d) => d.flag).length} flagged`);
}
