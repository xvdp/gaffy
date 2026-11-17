/**
 * Node label text. One string per vertex; its length sets the grid width of the label.
 *
 * full:     `<module>.<qual>()`, e.g. `render.harmonics.projector()`
 * relative: common dotted prefix with the tree parent's module removed, keeping the last module
 *           component, e.g. parent `render.harmonics` → `.harmonics.projector()` (giddy experiment 2)
 * collapsed container: `[<container label>] (<members>)`
 */
import { GNode, isContainer } from './model';
import type { LabelMode } from './viewdoc';

export interface LabelOptions {
  mode: LabelMode;
  strip: string[];
  parens: boolean;
}

export function stripModule(module: string, strip: readonly string[]): string {
  for (const p of strip) if (p && module.startsWith(p) && module.length > p.length) return module.slice(p.length);
  return module;
}

export function containerLabel(n: GNode, strip: readonly string[]): string {
  if (n.kind === 'class') return `${stripModule(n.module, strip)}.${n.qual}`;
  return stripModule(n.module, strip) || n.name;
}

const split = (m: string) => m.split(/[./]/).filter(Boolean);

export function nodeLabel(n: GNode, opts: LabelOptions, parent?: GNode, members = 0, collapsed = false): string {
  if (collapsed || isContainer(n) && n.kind !== 'class') {
    return collapsed ? `[${containerLabel(n, opts.strip)}] (${members})` : containerLabel(n, opts.strip);
  }
  const call = opts.parens && n.qual !== '<module>' ? '()' : '';
  const qual = n.qual;
  let module = stripModule(n.module, opts.strip);
  if (opts.mode === 'relative' && parent && !isContainer(parent)) {
    const a = split(stripModule(parent.module, opts.strip));
    const b = split(module);
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    if (k > 0) module = '.' + b.slice(Math.min(k, b.length - 1)).join('.');
  }
  return qual ? `${module}.${qual}${call}` : module;
}
