/**
 * Node label text. One string per vertex; its length sets the grid width of the label.
 *
 * definition:          `<module>.<qual>()`, e.g. `foo.scoobie.do()`
 * module-level code:   `<module>.<module>`
 * collapsed container: `[<container label>] (<members>)`
 * Modules inside namespace boxes show relative names, e.g. functions `foo.magoo()` and `foo.scoobie.do()` 
 * show up as magoo() and scoobie.do() when in namespace box `foo`.
 */
import { relativeName } from './boxes';
import { GNode, isContainer, visible } from './model';

export interface LabelOptions {
    strip: string[];
    parens: boolean;
}

export function stripModule(module: string, strip: readonly string[]): string {
    for (const p of strip) if (p && module.startsWith(p) && module.length > p.length) return module.slice(p.length);
    return module;
}

export function containerLabel(n: GNode, strip: readonly string[], ns = ''): string {
    const full = n.kind === 'class' ? `${n.module}.${n.qual}` : n.module || n.name;
    return ns ? relativeName(full, ns) || n.name : stripModule(full, strip);
}

export function nodeLabel(n: GNode, opts: LabelOptions, ns = '', members = 0, collapsed = false): string {
    return visible(rawLabel(n, opts, ns, members, collapsed));
}

function rawLabel(n: GNode, opts: LabelOptions, ns: string, members: number, collapsed: boolean): string {
    if (collapsed) return `[${containerLabel(n, opts.strip, ns)}] (${members})`;
    if (isContainer(n) && n.kind !== 'class') return containerLabel(n, opts.strip, ns);
    const call = opts.parens && n.qual !== '<module>' ? '()' : '';
    const module = ns ? relativeName(n.module, ns) : stripModule(n.module, opts.strip);
    if (!n.qual) return module;
    return module ? `${module}.${n.qual}${call}` : `${n.qual}${call}`;
}
