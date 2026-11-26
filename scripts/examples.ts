// Writes docs/examples.md: small pictures of the drawing terms and rules, rendered by gaffy itself (buildScene,
// toText) from made-up graphs; each rule example draws the picture with the rule as set by default and with its
// switch off or another choice. Run by `npm run heuristics`.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toText } from '../src/core/grid';
import { RuleConfig } from '../src/core/rules';
import { buildScene } from '../src/core/scene';
import { deepMerge, DEFAULT_STYLE, glyphSet, Style } from '../src/core/style';
import { emptyDoc, ViewSpec } from '../src/core/viewdoc';
import { buildFixture, k } from '../test/fixtures';

const DOC = 'docs/examples.md';
const flat: Style = deepMerge(DEFAULT_STYLE, { boxes: { enabled: false } });
const boxed: Style = deepMerge(DEFAULT_STYLE, { boxes: { enabled: true, root: false } });

function draw(edges: [string, string][], view: Partial<ViewSpec>, style: Style, rules?: RuleConfig): string {
    const doc = emptyDoc('example', { direction: 'out', depthUp: 0, depthDown: 'all', arrange: 'auto', ...view, rules });
    doc.view.boxes = style.boxes.enabled;
    doc.graph = buildFixture(edges);
    doc.explored = Object.fromEntries(Object.keys(doc.graph.nodes).map((x) => [x, 'both' as const]));
    return toText(buildScene(doc, style).grid, glyphSet(style)).split('\n').map((l) => l.trimEnd()).join('\n');
}

interface Example { title: string; text: string; edges: [string, string][]; view: Partial<ViewSpec>; style: Style; pictures: [string, RuleConfig | undefined, Partial<ViewSpec>?][] }

const seed = (id: string) => ({ seeds: [k(id)] });
const EXAMPLES: Example[] = [
    { title: 'Branches on a stem', style: flat, view: seed('foo:shoo'),
        text: 'A function hangs under parent caller.',
        edges: [['foo:shoo', 'foo:magoo'], ['foo:shoo', 'foo:doo'], ['foo:magoo', 'foo:zoinks']], pictures: [['', undefined]] },
    { title: 'Trunk: calls merging into one function', style: flat, view: { ...seed('foo:shoo'), parentRule: 'dfs' },
        text: 'Calls into one function share trunk: Parent rule `dfs`: `doo()` hangs under `magoo()`; the call from `shoo()` joins the trunk.',
        edges: [['foo:shoo', 'foo:magoo'], ['foo:magoo', 'foo:doo'], ['foo:shoo', 'foo:doo']], pictures: [['', undefined]] },
    { title: 'Shared entry from the left (parent rule `joint`, default)', style: flat, view: seed('foo:shoo'),
        text: '',
        edges: [['foo:shoo', 'foo:magoo'], ['foo:shoo', 'foo:zoinks'], ['foo:zoinks', 'foo:doo'], ['foo:magoo', 'foo:doo']], pictures: [['joint', undefined], ['dfs', undefined, { parentRule: 'dfs' }]] },
    { title: 'Calls between groups: path search', style: boxed, view: seed('aloo.patata:shoo'),
        text: 'Branches and trunks stay inside one group. All others search cheapest route on the character grid (h29).',
        edges: [['aloo.patata:shoo', 'zoinks.jinkies:doo'], ['aloo.patata:shoo', 'aloo.patata:magoo'], ['aloo.patata:magoo', 'zoinks.jinkies:doo']], pictures: [['', undefined]] },
    { title: 'h13 Caller alignment', style: boxed, view: seed('aloo.patata:shoo'),
        text: '',
        edges: [['aloo.patata:shoo', 'aloo.patata:magoo'], ['aloo.patata:magoo', 'zoinks.jinkies:doo'], ['aloo.patata:shoo', 'zoinks.jinkies:scoobie']],
        pictures: [['on', undefined], ['off', { off: ['h13_caller_alignment'] }]] },
    { title: 'h17 Group column, h18 Group row', style: boxed, view: seed('aloo.patata:shoo'),
        text: '',
        edges: [['aloo.patata:shoo', 'zoinks.jinkies:doo'], ['zoinks.jinkies:doo', 'moo.goo:magoo']],
        pictures: [['on', undefined], ['off', { off: ['h17_item_column', 'h18_item_row'] }]] },
    { title: 'h41 Called group below its caller (one layer at a time)', style: boxed,
        view: { ...seed('aloo.patata:magoo'), arrange: 'grow', open: { [k('aloo.patata:magoo')]: 'both' } },
        text: '',
        edges: [['zoinks.jinkies:scoobie_doo', 'aloo.patata:magoo'], ['aloo.patata:magoo', 'aloo.patata:doo']],
        pictures: [['on', undefined], ['off', { off: ['h41_called_below'] }]] },
    { title: 'h41 with two callers in the caller group', style: boxed,
        view: { ...seed('aloo.patata:magoo'), arrange: 'grow', open: { [k('aloo.patata:magoo')]: 'up' } },
        text: 'Only last function of a group can drop its call through frame.',
        edges: [['zoinks.jinkies:scoobie_doo', 'aloo.patata:magoo'], ['zoinks.jinkies:jinkies', 'aloo.patata:magoo'], ['aloo.patata:magoo', 'aloo.patata:doo']],
        pictures: [['', undefined]] },
    { title: 'h25 Search order', style: boxed, view: seed('aloo.patata:shoo'),
        text: 'Call search order: `row`: top to bottom; `longest`: longest calls first.',
        edges: [['aloo.patata:magoo', 'zoinks.wibble:doo'], ['aloo.patata:doo_be', 'moo.goo:zoinks'], ['aloo.patata:doo_be', 'moo.goo:jinkies'], ['aloo.patata:shoo', 'aloo.patata:doo_be'], ['aloo.patata:shoo', 'aloo.patata:magoo']],
        pictures: [['row', undefined], ['longest', { alt: { h25_routing_order: 'longest' } }]] },
    { title: 'Markers', style: flat, view: { ...seed('foo:magoo'), arrange: 'grow', open: { [k('foo:magoo')]: 'down' } },
        text: '`>>` `└─>>` Folded calls/callers. Click to open.',
        edges: [['foo:shoo', 'foo:magoo'], ['foo:magoo', 'foo:doo'], ['foo:doo', 'foo:zoinks']], pictures: [['', undefined]] },
];

const out: string[] = ['# gaffy pictures of terms and rules', '',
    'Generated by `npm run heuristics` ([scripts/examples.ts](../scripts/examples.ts)) with gaffy\'s own layout and text export; names made up. Rules: [heuristics.md](heuristics.md).', ''];
for (const x of EXAMPLES) {
    out.push(`## ${x.title}`, '', x.text, '');
    for (const [label, rules, view] of x.pictures) {
        if (label) out.push(`${label}:`, '');
        out.push('```', draw(x.edges, { ...x.view, ...(view ?? {}) }, x.style, rules), '```', '');
    }
}
writeFileSync(resolve(process.cwd(), DOC), out.join('\n'));
console.log(`${DOC}: ${EXAMPLES.length} examples`);
