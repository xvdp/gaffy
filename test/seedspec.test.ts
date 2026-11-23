import { describe, expect, it } from 'vitest';
import { seedSpec } from '../src/host/seedspec';

describe('seeds written by name', () => {
    it('path and qualified name, path and line, a key without its node record', () => {
        expect(seedSpec('src/pkg/mod.py#Scoobie.do')).toEqual({ path: 'src/pkg/mod.py', qual: 'Scoobie.do' });
        expect(seedSpec('src/pkg/mod.py:120')).toEqual({ path: 'src/pkg/mod.py', line: 120 });
        expect(seedSpec('py:src/pkg/mod.py#magoo')).toEqual({ path: 'src/pkg/mod.py', qual: 'magoo' });
        expect(seedSpec(' src/a.ts#aloo.patata ')).toEqual({ path: 'src/a.ts', qual: 'aloo.patata' });
    });
    it('anything else is no seed spec', () => {
        expect(seedSpec('src/pkg/mod.py')).toBeUndefined();
        expect(seedSpec('src/pkg/mod.py:0')).toBeUndefined();
        expect(seedSpec('#shoo')).toBeUndefined();
        expect(seedSpec('')).toBeUndefined();
    });
});
