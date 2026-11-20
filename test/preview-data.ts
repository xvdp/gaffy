// Fixture view documents for the browser preview harness (scripts/preview.mjs).
import { readFileSync } from 'node:fs';
import { DEFAULT_STYLE } from '../src/core/style';
import { serializeDoc } from '../src/core/viewdoc';
import { fixtureDoc, k, KAZOO, MOO, STAR } from './fixtures';

const moo = fixtureDoc(MOO, { seeds: [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')], direction: 'in' });
moo.name = 'moo';
const star = fixtureDoc(STAR, {
    seeds: [k('foo.wobble:jiggly_boogaloos'), k('scripts/moo_trucks:moonwalk')],
    collapsed: ['py:moomoo/boogaloos.py'],
});
star.name = 'star';

const kazoo = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out' });
kazoo.name = 'kazoo';
kazoo.explored = { [k('kazoo.moomoo.boogaloos:scoobie')]: 'out', [k('kazoo.moomoo.boogaloos:scoobie_do')]: 'out' };

const grow = fixtureDoc(KAZOO, { seeds: [k('kazoo.moomoo.boogaloos:scoobie')], direction: 'out', arrange: 'grow', open: {} });
grow.name = 'grow';

// two seeds: a function and one of its upstream callers' callers, upstream view
const two = fixtureDoc(KAZOO, { seeds: [k('kazoo.noodles.jumbles:to_wacky'), k('kazoo.moomoo.boogaloos:_cheese_puffs')], direction: 'in', arrange: 'grow', open: {} });
two.name = 'two';

process.stdout.write(JSON.stringify({
    // GAFFY_PREVIEW_FILE: a .gaffy view file, as doc=file
    docs: { moo: serializeDoc(moo), star: serializeDoc(star), kazoo: serializeDoc(kazoo), grow: serializeDoc(grow), two: serializeDoc(two),
        ...(process.env.GAFFY_PREVIEW_FILE ? { file: readFileSync(process.env.GAFFY_PREVIEW_FILE, 'utf8') } : {}) }, style: DEFAULT_STYLE,
}));
