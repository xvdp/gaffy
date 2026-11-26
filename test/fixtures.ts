/**
 * Fixture graphs over made-up Python packages and scripts.
 * Definition ids `<module>:<qual>`; modules with `/` are scripts outside packages.
 */
import { GEdge, GNode, NodeKey, Subgraph } from '../src/core/model';
import { emptyDoc, ViewDoc, ViewSpec } from '../src/core/viewdoc';

export function buildFixture(edges: [string, string][]): Subgraph {
    const nodes: Record<NodeKey, GNode> = {};
    let line = 0;
    const fileKey = (module: string) => `py:${module.replace(/\./g, '/')}.py`;
    const ensureDir = (dir: string): NodeKey | null => {
        if (!dir) return null;
        const key = `dir:${dir}`;
        if (!nodes[key]) {
            const i = dir.lastIndexOf('/');
            nodes[key] = { key, kind: 'package', name: dir.slice(i + 1), qual: '', module: dir.replace(/\//g, '.'),
                parent: ensureDir(i < 0 ? '' : dir.slice(0, i)) };
        }
        return key;
    };
    const ensure = (id: string): NodeKey => {
        const [module, qual] = id.split(':');
        const fk = fileKey(module);
        const path = fk.slice(3);
        if (!nodes[fk]) {
            const dir = path.slice(0, path.lastIndexOf('/'));
            nodes[fk] = { key: fk, kind: 'module', name: module.split(/[./]/).pop()!, qual: '', module,
                parent: ensureDir(dir), path };
        }
        const parts = qual.split('.');
        let parent = fk;
        for (let i = 0; i < parts.length - 1; i++) {
            const ck = `${fk}#${parts.slice(0, i + 1).join('.')}`;
            if (!nodes[ck]) nodes[ck] = { key: ck, kind: 'class', name: parts[i], qual: parts.slice(0, i + 1).join('.'),
                module, parent, path, line: line++ };
            parent = ck;
        }
        const key = `${fk}#${qual}`;
        if (!nodes[key]) nodes[key] = { key, kind: parts.length > 1 ? 'method' : 'function', name: parts[parts.length - 1],
            qual, module, parent, path, line: line++, hash: 'h0' };
        return key;
    };
    const out: GEdge[] = edges.map(([a, b], i) => ({ from: ensure(a), to: ensure(b), line: i }));
    return { nodes, edges: out };
}

export const k = (id: string) => {
    const [module, qual] = id.split(':');
    return `py:${module.replace(/\./g, '/')}.py#${qual}`;
};

const H = 'moomoo.boogaloos';
export const MOO: [string, string][] = [
    ['scripts/moo_trucks:wanderoo', 'scripts/moo_trucks:flubber'],
    ['scripts/moo_trucks:wanderoo', 'scripts/moo_trucks:hokey'],
    ['scripts/moo_trucks:wanderoo', 'scripts/moo_trucks:snoot'],
    ['scripts/moo_trucks:wanderoo', 'scripts/moo_trucks:doohickey'],
    ['scripts/moo_trucks:wanderoo', 'scripts/moo_trucks:moonwalk'],
    ['scripts/moo_trucks:wanderoo', 'scripts/moo_trucks:bonbon'],
    ['scripts/moo_trucks:flubber', 'aardvark.flubber:tomfoolery'],
    ['scripts/moo_trucks:hokey', 'goof.moomoo:moomoo_fluffy'],
    ['scripts/moo_trucks:snoot', 'goof.kerplop:Gizmotron.snoot'],
    ['goof.kerplop:Gizmotron.snoot', 'goof.shoo_boogaloos:boogaloos'],
    ['goof.shoo_boogaloos:boogaloos', 'foo.wobble:jiggly_boogaloos'],
    ['scripts/moo_trucks:doohickey', 'goof.kerplop:Gizmotron.doohickey'],
    ['goof.kerplop:Gizmotron.doohickey', 'goof.wobble_foo:doohickey_muppets'],
    ['goof.wobble_foo:doohickey_muppets', 'foo.wobble:jiggly_boogaloos'],
    ['foo.wobble:jiggly_boogaloos', `${H}:scoobie`],
    ['scripts/moo_trucks:moonwalk', `${H}:doodler_moonwalk`],
    [`${H}:doodler_moonwalk`, `${H}:flimflams`],
    [`${H}:flimflams`, `${H}:_jelly_doughnuts`],
    [`${H}:_jelly_doughnuts`, `${H}:scoobie`],
    [`${H}:scoobie`, `${H}:scoobie_zoinks_jinkies`],
    [`${H}:scoobie_zoinks_jinkies`, `${H}:_burritos`],
    [`${H}:_burritos`, 'goof.moomoo:Pogo.splotch'],
    ['goof.moomoo:Pogo.splotch', 'moomoo.yo_moomoo:splotch_zaps'],
    ['moomoo.yo_moomoo:splotch_zaps', 'moomoo.yo_nudge:shoo'],
    ['aardvark.flubber:tomfoolery', 'moomoo.yo_nudge:shoo'],
    ['goof.moomoo:moomoo_fluffy', 'moomoo.yo_nudge:shoo'],
    ['scripts/moo_trucks:bonbon', 'moomoo.yo_nudge:shoo'],
    ['moomoo.yo_nudge:shoo', 'moomoo.yo_wombat:wingding_widgets'],
    ['moomoo.yo_wombat:wingding_widgets', 'moomoo.yo_blinkers:flibbity_jibbity_jabby'],
    ['moomoo.yo_wombat:wingding_widgets', 'moomoo.yo_blinkers:flibbity_bibbidi_bob'],
];

/** ..rrequest.md addendum 1a: `kazoo.moomoo.boogaloos.scoobie` and its . */
const RH = 'kazoo.moomoo.boogaloos', IO = 'kazoo.noodles.jumbles', VA = 'kazoo.noodles.wibbles', DV = 'kazoo.noodles.doodle';
export const KAZOO: [string, string][] = [
    [`${RH}:scoobie`, `${RH}:hullabaloo_hoot`],
    [`${RH}:hullabaloo_hoot`, `${RH}:_fritter`],
    [`${RH}:scoobie`, `${RH}:_fritter`],
    [`${RH}:scoobie`, `${RH}:scoobie_zoinks_jinkies`],
    [`${RH}:scoobie_zoinks_jinkies`, `${RH}:_nacho_plate`],
    [`${RH}:scoobie_zoinks_jinkies`, `${RH}:_hotdog_bun`],
    [`${RH}:scoobie_zoinks_jinkies`, `${RH}:_burritos`],
    [`${RH}:scoobie`, `${RH}:_donut_holes`],
    [`${RH}:scoobie`, `${RH}:_cheese_puffs`],
    [`${RH}:_cheese_puffs`, `${RH}:_lasagna`],
    [`${RH}:_lasagna`, `${IO}:to_wacky`],
    [`${RH}:scoobie`, `${IO}:to_wacky`],
    [`${RH}:scoobie`, `${RH}:_pizza_roll`],
    [`${RH}:_pizza_roll`, `${IO}:whoozit`],
    [`${RH}:_pizza_roll`, `${RH}:scoobie_do`],
    [`${RH}:scoobie`, `${RH}:scoobie_do`],
    [`${RH}:scoobie_do`, `${VA}:mister_magoos`],
    [`${VA}:mister_magoos`, `${VA}:_hokey_pokeys`],
    [`${VA}:_hokey_pokeys`, `${DV}:_meep`],
    [`${VA}:_hokey_pokeys`, `${DV}:honk_honk`],
    [`${DV}:honk_honk`, `${DV}:_noot`],
    [`${VA}:mister_magoos`, `${VA}:bazooka`],
    [`${RH}:scoobie_do`, `${VA}:abba_dabba_doo`],
    [`${VA}:abba_dabba_doo`, `${VA}:_whatsits`],
    [`${VA}:_whatsits`, `${VA}:aloo_gobi`],
    [`${VA}:mister_magoos`, `${VA}:aloo_gobi`],
    [`${VA}:aloo_gobi`, `${VA}:_bean_stalk`],
    [`${VA}:abba_dabba_doo`, `${VA}:cuckoos`],
    [`${VA}:mister_magoos`, `${VA}:cuckoos`],
    [`${RH}:scoobie_do`, `${RH}:_gummy_bears`],
    [`${RH}:_pizza_roll`, `${RH}:_meatball`],
    [`${RH}:_cheese_puffs`, `${RH}:_meatball`],
    [`${RH}:scoobie`, `${IO}:to_magoo`],
    [`${RH}:_donut_holes`, `${IO}:to_magoo`],
    [`${IO}:to_magoo`, `${IO}:_doodle_of`],
    [`${IO}:to_magoo`, `${IO}:_on_doodle`],
    [`${IO}:to_magoo`, `${IO}:_shmoo`],
    [`${IO}:to_magoo`, `${IO}:to_magoo`],
];

/** rrequest.md example (*). */
export const STAR: [string, string][] = [
    ['foo.wobble:jiggly_boogaloos', `${H}:scoobie`],
    ['scripts/moo_trucks:moonwalk', `${H}:doodler_moonwalk`],
    [`${H}:doodler_moonwalk`, `${H}:flimflams`],
    [`${H}:flimflams`, `${H}:_jelly_doughnuts`],
    [`${H}:_jelly_doughnuts`, `${H}:scoobie`],
    [`${H}:scoobie`, `${H}:scoobie_zoinks_jinkies`],
    [`${H}:scoobie_zoinks_jinkies`, `${H}:_burritos`],
    [`${H}:_burritos`, 'goof.moomoo:Pogo.splotch'],
];

/** Fixture view; a full view shows every level of its direction unless the call depths are given. */
export function fixtureDoc(edges: [string, string][], view: Partial<ViewSpec> = {}): ViewDoc {
    const dir = view.direction ?? 'out';
    const doc = emptyDoc('fixture', { depthUp: dir !== 'out' ? 'all' : 0, depthDown: dir !== 'in' ? 'all' : 0, ...view });
    doc.graph = buildFixture(edges);
    doc.explored = Object.fromEntries(Object.keys(doc.graph.nodes).map((x) => [x, 'both' as const]));
    return doc;
}
