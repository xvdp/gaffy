// npm run metrics -- <view.gaffy> ['<rules JSON>' …]: edge metrics of a view per rule configuration (view `rules`
// format: {"off": [...], "alt": {...}, "params": {...}}), first the view's own: picture size, crossing cells, bends,
// routed cells, unrouted calls, total route cost (grid.ts gridCost), mean buildScene time over 5 builds after one.
import { readFileSync } from 'node:fs';
import { gridCost } from '../src/core/grid';
import { parseRules } from '../src/core/rules';
import { buildScene } from '../src/core/scene';
import { DEFAULT_STYLE, E, N, S, W } from '../src/core/style';
import { parseDoc } from '../src/core/viewdoc';

const [file, ...configs] = process.argv.slice(2);
if (!file) { console.log("usage: npm run metrics -- <view.gaffy> ['{\"alt\":{\"h25_routing_order\":\"row\"}}' …]"); process.exit(1); }
const doc = parseDoc(readFileSync(file, 'utf8'), 'view');
const outside = { external: doc.view.external ?? false, standard: doc.view.stdlib ?? false };
for (const c of ['', ...configs]) {
    const d = structuredClone(doc);
    if (c) d.view.rules = parseRules(JSON.parse(c)) ?? {};
    let sc = buildScene(d, DEFAULT_STYLE, [], outside);
    const t = performance.now();
    for (let i = 0; i < 5; i++) sc = buildScene(d, DEFAULT_STYLE, [], outside);
    const ms = (performance.now() - t) / 5;
    const g = sc.grid;
    let cross = 0;
    for (const [, nets] of g.cells) {
        if (nets.size < 2) continue;
        let v = false, h = false, o = false;
        for (const m of nets.values()) { if (m === (N | S)) v = true; else if (m === (E | W)) h = true; else o = true; }
        if (v && h && !o) cross++;
    }
    let bends = 0, cells = 0;
    for (const p of g.paths) { bends += Math.max(0, p.pts.length - 2); cells += p.cells.length; }
    console.log(`${(c || 'view rules').padEnd(60)} size ${g.width}×${g.height} · crossing cells ${cross} · bends ${bends} · cells ${cells} · unrouted ${g.unrouted} · cost ${gridCost(g).toFixed(0)} · ${ms.toFixed(1)} ms`);
}
