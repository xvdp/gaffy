/**
 * Fixture graphs from giddy/example/main_0218_0217_gutai-src-gutai_pyMOD.md, inverted-trees section.
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

const H = 'render.harmonics';
export const EXP4: [string, string][] = [
  ['scripts/mote_paths:traverse', 'scripts/mote_paths:speckle'],
  ['scripts/mote_paths:traverse', 'scripts/mote_paths:stack'],
  ['scripts/mote_paths:traverse', 'scripts/mote_paths:texel'],
  ['scripts/mote_paths:traverse', 'scripts/mote_paths:plenoptic'],
  ['scripts/mote_paths:traverse', 'scripts/mote_paths:streamed'],
  ['scripts/mote_paths:traverse', 'scripts/mote_paths:layers'],
  ['scripts/mote_paths:speckle', 'analysis.speckle:treatments'],
  ['scripts/mote_paths:stack', 'gett.render:render_fitted'],
  ['scripts/mote_paths:texel', 'gett.convert:Converter.texel'],
  ['gett.convert:Converter.texel', 'gett.site_harmonics:harmonics'],
  ['gett.site_harmonics:harmonics', 'fit.surfel:linear_harmonics'],
  ['scripts/mote_paths:plenoptic', 'gett.convert:Converter.plenoptic'],
  ['gett.convert:Converter.plenoptic', 'gett.surfel_fit:plenoptic_moteset'],
  ['gett.surfel_fit:plenoptic_moteset', 'fit.surfel:linear_harmonics'],
  ['fit.surfel:linear_harmonics', `${H}:sh_eval`],
  ['scripts/mote_paths:streamed', `${H}:project_streamed`],
  [`${H}:project_streamed`, `${H}:projector`],
  [`${H}:projector`, `${H}:_projector_solve`],
  [`${H}:_projector_solve`, `${H}:sh_eval`],
  [`${H}:sh_eval`, `${H}:sh_eval_torch_compiled`],
  [`${H}:sh_eval_torch_compiled`, `${H}:_compiled`],
  [`${H}:_compiled`, 'gett.render:Pass.compile'],
  ['gett.render:Pass.compile', 'render.mi_render:compile_aovs'],
  ['render.mi_render:compile_aovs', 'render.mi_scene:load'],
  ['analysis.speckle:treatments', 'render.mi_scene:load'],
  ['gett.render:render_fitted', 'render.mi_scene:load'],
  ['scripts/mote_paths:layers', 'render.mi_scene:load'],
  ['render.mi_scene:load', 'render.mi_sensor:register_plugins'],
  ['render.mi_sensor:register_plugins', 'render.mi_emitters:register_twosided_area'],
  ['render.mi_sensor:register_plugins', 'render.mi_emitters:register_sphere_spot'],
];

/** rrequest.md example (*). */
export const STAR: [string, string][] = [
  ['fit.surfel:linear_harmonics', `${H}:sh_eval`],
  ['scripts/mote_paths:streamed', `${H}:project_streamed`],
  [`${H}:project_streamed`, `${H}:projector`],
  [`${H}:projector`, `${H}:_projector_solve`],
  [`${H}:_projector_solve`, `${H}:sh_eval`],
  [`${H}:sh_eval`, `${H}:sh_eval_torch_compiled`],
  [`${H}:sh_eval_torch_compiled`, `${H}:_compiled`],
  [`${H}:_compiled`, 'gett.render:Pass.compile'],
];

export function fixtureDoc(edges: [string, string][], view: Partial<ViewSpec> = {}): ViewDoc {
  const doc = emptyDoc('fixture', view);
  doc.graph = buildFixture(edges);
  return doc;
}
