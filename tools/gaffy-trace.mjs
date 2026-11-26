#!/usr/bin/env node
// Prints a gaffy view trace (.baggy/gaffy/trace/<view>.jsonl, setting gaffy.trace) as a numbered list: event, target,
// grid cell, acting functions, changed view fields, grid moves. Standalone, outside the extension: Node 18+, no deps.
//
//   node tools/gaffy-trace.mjs <trace.jsonl> [--last N] [--from SEQ] [--all-moves] [--json]
//
// Moves: the shift most labels share (pan, or growth above them) prints once; other moved labels and boxes list
// their move beyond it, largest first (10, or all with --all-moves).
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!file) {
    console.error('usage: node tools/gaffy-trace.mjs <trace.jsonl> [--last N] [--from SEQ] [--all-moves] [--json]');
    process.exit(2);
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : undefined; };
const last = opt('--last'), from = opt('--from'), allMoves = args.includes('--all-moves'), json = args.includes('--json');

let recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { return { seq: `line ${i + 1}`, cause: { event: 'unreadable line' }, changed: {} }; }
});
if (from !== undefined) recs = recs.filter((r) => typeof r.seq !== 'number' || r.seq >= from);
if (last !== undefined) recs = recs.slice(-last);

// trace text holds language-server names and paths: control (terminal escape), zero-width and bidirectional
// characters print as \u{...}, as in gaffy (model.ts `visible`)
const SHOWN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
const safe = (s) => String(s).replace(SHOWN, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
const print = (s) => console.log(safe(s));

/** `py:pkg/mod.py#Cls.fn` => `mod.Cls.fn()`; `box:dir:a/b` => `[a/b]`; `collapsed:<key>` => `<key> (collapsed)`. */
function short(key) {
    if (typeof key !== 'string') return String(key);
    if (key.startsWith('collapsed:')) return `${short(key.slice(10))} (collapsed)`;
    if (key.startsWith('box:')) return `[${short(key.slice(4)).replace(/\(\)$/, '')}]`;
    if (key.includes(' → ')) return key.split(' → ').map(short).join(' → ');
    const m = /^[a-z]+:(.*?)(?:#(.*))?$/.exec(key);
    if (!m) return key;
    const file = m[1].split('/').pop().replace(/\.[^.]+$/, '');
    return m[2] ? `${file}.${m[2]}()` : m[1];
}
const cell = (c) => (c ? `row ${c[0]} col ${c[1]}` : '');
const val = (v) => (v === null || v === undefined ? '–' : typeof v === 'string' ? short(v) : JSON.stringify(v));
const time = (t) => (t ? t.slice(11, 23) : '');

function cause(c = {}) {
    const ev = c.event ?? '?';
    const on = c.target ? ` on ${short(c.target)}` : '';
    const at = c.cell ? ` at ${cell(c.cell)}` : '';
    const fn = c.fn ? `  →  ${c.fn}` : '';
    const a = c.args && Object.keys(c.args).length
        ? ` (${Object.entries(c.args).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${typeof v === 'string' ? short(v) : JSON.stringify(Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? short(x) : x)) : v)}`).join(', ')})`
        : '';
    return `${ev}${on}${at}${fn}${a}`;
}

function changed(ch = {}) {
    const out = [];
    for (const [f, d] of Object.entries(ch)) {
        if (Array.isArray(d)) out.push(`${f}: ${val(d[0])} → ${val(d[1])}`);
        else if (d && ('added' in d || 'removed' in d)) {
            const parts = [];
            if (d.added?.length) parts.push(`+ ${d.added.map(val).join(', ')}`);
            if (d.removed?.length) parts.push(`− ${d.removed.map(val).join(', ')}`);
            out.push(`${f}: ${parts.join('; ')}`);
        } else if (d && typeof d === 'object') {
            for (const [k, [a, b]] of Object.entries(d)) out.push(`${f}[${short(k)}]: ${val(a)} → ${val(b)}`);
        }
    }
    return out;
}

function moves(moved = []) {
    const both = moved.filter(([, a, b]) => a && b);
    const out = [];
    const appeared = moved.filter(([, a, b]) => !a && b).length, left = moved.filter(([, a, b]) => a && !b).length;
    if (!both.length) {
        if (appeared || left) out.push(`grid: ${appeared} appeared, ${left} left`);
        return out;
    }
    // shift shared by most moved labels; may be (0, 0): labels that kept their cell are absent from `moved`
    const tally = new Map();
    for (const [, a, b] of both) { const k = `${b[0] - a[0]},${b[1] - a[1]}`; tally.set(k, (tally.get(k) ?? 0) + 1); }
    const [common, n] = [...tally].sort((x, y) => y[1] - x[1])[0];
    const [sr, sc] = common.split(',').map(Number);
    const shared = n >= Math.max(3, both.length / 2);
    if (shared && (sr || sc)) out.push(`picture: ${n} labels shifted ${sr >= 0 ? '+' : ''}${sr} rows ${sc >= 0 ? '+' : ''}${sc} cols together`);
    const [br, bc] = shared ? [sr, sc] : [0, 0];
    const own = both.map(([k, a, b]) => ({ k, a, b, dr: b[0] - a[0] - br, dc: b[1] - a[1] - bc }))
        .filter((m) => m.dr || m.dc).sort((x, y) => Math.abs(y.dr) + Math.abs(y.dc) - Math.abs(x.dr) - Math.abs(x.dc));
    for (const m of allMoves ? own : own.slice(0, 10)) {
        out.push(`moved ${short(m.k)}: ${cell(m.a)} → ${cell(m.b)} (${m.dr >= 0 ? '+' : ''}${m.dr} rows ${m.dc >= 0 ? '+' : ''}${m.dc} cols${shared && (br || bc) ? ' beyond the shift' : ''})`);
    }
    if (!allMoves && own.length > 10) out.push(`... ${own.length - 10} more moved (--all-moves)`);
    if (appeared || left) out.push(`grid: ${appeared} appeared, ${left} left`);
    return out;
}

// --json: JSON.stringify escapes only U+0000–U+001F; C1 and bidirectional controls → \uXXXX (valid JSON)
if (json) { for (const r of recs) console.log(JSON.stringify(r).replace(SHOWN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)); process.exit(0); }
for (const r of recs) {
    print(`#${r.seq}  ${time(r.t)}  ${cause(r.cause)}`);
    for (const l of changed(r.changed)) print(`    ${l}`);
    if (r.graph) print(`    data: functions +${r.graph.nodes[0]} −${r.graph.nodes[1]}, calls +${r.graph.edges[0]} −${r.graph.edges[1]}`);
    for (const l of moves(r.moved)) print(`    ${l}`);
}
