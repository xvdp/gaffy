import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { traceRecord, viewDiff } from '../src/host/tracerec';
import { fixtureDoc, k, MOO } from './fixtures';

describe('view trace', () => {
    const before = fixtureDoc(MOO, { seeds: [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')], direction: 'in' });
    const after = structuredClone(before);
    after.view.offset = { 'box:dir:moomoo': [0, 12] };
    after.view.hidden = [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')];
    after.view.arrange = 'grow';

    it('fields: objects per key, arrays as added and removed, values as pairs', () => {
        expect(viewDiff(before.view as never, after.view as never)).toEqual({
            offset: { 'box:dir:moomoo': [null, [0, 12]] },
            hidden: { added: [k('moomoo.yo_blinkers:flibbity_jibbity_jabby')], removed: [] },
            arrange: ['auto', 'grow'],
        });
    });

    it('tools/gaffy-trace.mjs lists cause, changed fields and moves beyond the shared shift', () => {
        const moved: [string, [number, number], [number, number]][] = [
            ['py:moomoo/goo.py#magoo', [3, 4], [5, 4]], ['py:moomoo/goo.py#shoo', [6, 4], [8, 4]], ['py:moomoo/goo.py#foo', [7, 9], [9, 9]],
            ['box:dir:moomoo', [2, 1], [34, 1]],
        ];
        const rec = traceRecord(before, after, { event: 'mousedown', target: 'box:dir:moomoo', cell: [2, 1], fn: 'dragUnit', args: { drag: [0, 12] } }, moved, 'v', 1, new Date(0));
        const dir = mkdtempSync(join(tmpdir(), 'gaffy-trace-'));
        writeFileSync(join(dir, 'v.jsonl'), JSON.stringify(rec) + '\n');
        const out = execFileSync(process.execPath, [join(__dirname, '..', 'tools', 'gaffy-trace.mjs'), join(dir, 'v.jsonl')]).toString();
        expect(out).toContain('#1  00:00:00.000  mousedown on [moomoo] at row 2 col 1  →  dragUnit (drag [0,12])');
        expect(out).toContain('offset[[moomoo]]: – → [0,12]');
        expect(out).toContain('hidden: + yo_blinkers.flibbity_jibbity_jabby()');
        expect(out).toContain('arrange: auto → grow');
        expect(out).toContain('picture: 3 labels shifted +2 rows +0 cols together');
        expect(out).toContain('moved [moomoo]: row 2 col 1 → row 34 col 1 (+30 rows +0 cols beyond the shift)');
    });
});
