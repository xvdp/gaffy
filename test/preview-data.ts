// Fixture view documents for the browser preview harness (scripts/preview.mjs).
import { DEFAULT_STYLE } from '../src/core/style';
import { serializeDoc } from '../src/core/viewdoc';
import { EXP4, fixtureDoc, k, SH, STAR } from './fixtures';

const exp4 = fixtureDoc(EXP4, { seeds: [k('render.mi_emitters:register_twosided_area')], direction: 'in' });
exp4.name = 'exp4';
const star = fixtureDoc(STAR, {
  seeds: [k('fit.surfel:linear_harmonics'), k('scripts/mote_paths:streamed')],
  collapsed: ['py:render/harmonics.py'],
});
star.name = 'star';

const sh = fixtureDoc(SH, { seeds: [k('gutai.render.harmonics:sh_eval')], direction: 'out' });
sh.name = 'sh';

process.stdout.write(JSON.stringify({
  docs: { exp4: serializeDoc(exp4), star: serializeDoc(star), sh: serializeDoc(sh) }, style: DEFAULT_STYLE,
}));
