// Fixture view documents for the browser preview harness (scripts/preview.mjs).
import { DEFAULT_STYLE } from '../src/core/style';
import { serializeDoc } from '../src/core/viewdoc';
import { EXP4, fixtureDoc, k, STAR } from './fixtures';

const exp4 = fixtureDoc(EXP4, { seeds: [k('render.mi_emitters:register_twosided_area')], direction: 'in' });
exp4.name = 'exp4';
exp4.baseline = Object.fromEntries(Object.keys(exp4.graph.nodes).filter((x) => x.includes('#')).map((x) => [x, 'h0']));
exp4.graph.nodes[k('render.harmonics:sh_eval')].hash = 'h1';               // MOD
delete exp4.baseline[k('gett.surfel_fit:plenoptic_moteset')];               // ADD
const star = fixtureDoc(STAR, {
  seeds: [k('fit.surfel:linear_harmonics'), k('scripts/mote_paths:streamed')],
  collapsed: ['py:render/harmonics.py'],
});
star.name = 'star';

process.stdout.write(JSON.stringify({ docs: { exp4: serializeDoc(exp4), star: serializeDoc(star) }, style: DEFAULT_STYLE }));
