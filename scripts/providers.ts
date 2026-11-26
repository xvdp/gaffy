// npm run providers -- [folder]: language providers outside VS Code. Languages with files under the folder (default:
// the current one), the VS Code extension each needs for document symbols and call hierarchy (PROVIDERS,
// src/core/langs.ts), and whether it is installed: `code --list-extensions --show-versions`, else the extension
// folder (`$VSCODE_EXTENSIONS`, else ~/.vscode/extensions). Live state (active, answering): gaffy: List Language
// Providers inside VS Code.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { langOf, PROVIDERS } from '../src/core/langs';

const root = resolve(process.argv[2] ?? '.');
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'site-packages', 'target', '_deps', '__pycache__', 'dist', 'build']);
const BUILT_IN = new Set(['vscode.typescript-language-features']);

/** Installed extension ids (lower case) → version, and where the list came from. */
function installed(): { ids: Map<string, string>; from: string } {
    const ids = new Map<string, string>();
    try {
        const out = execFileSync('code', ['--list-extensions', '--show-versions'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const l of out.split('\n')) { const [id, v] = l.trim().split('@'); if (id) ids.set(id.toLowerCase(), v ?? ''); }
        if (ids.size) return { ids, from: 'code --list-extensions' };
    } catch { /* no `code` on the path, or refused */ }
    const dir = process.env.VSCODE_EXTENSIONS ?? join(homedir(), '.vscode', 'extensions');
    const manifest = join(dir, 'extensions.json');
    if (existsSync(manifest)) {
        try {
            for (const e of JSON.parse(readFileSync(manifest, 'utf8')) as { identifier?: { id?: string }; version?: string }[]) {
                if (e.identifier?.id) ids.set(e.identifier.id.toLowerCase(), e.version ?? '');
            }
            return { ids, from: manifest };
        } catch { /* fall through to the folder names */ }
    }
    if (existsSync(dir)) {
        for (const n of readdirSync(dir)) { const m = /^(.+?)-(\d[\w.+-]*)$/.exec(n); if (m) ids.set(m[1].toLowerCase(), m[2]); }
    }
    return { ids, from: dir };
}

/** File count per language under `root`, at most 200 000 entries visited. */
function languages(): Map<string, number> {
    const count = new Map<string, number>();
    const stack = [root];
    let seen = 0;
    while (stack.length && seen < 200_000) {
        const d = stack.pop()!;
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            seen++;
            if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(join(d, e.name)); continue; }
            const l = langOf(e.name);
            count.set(l, (count.get(l) ?? 0) + 1);
        }
    }
    return count;
}

const { ids, from } = installed();
const files = languages();
console.log(`folder: ${root}\nextensions: ${ids.size} listed by ${from}\n`);
console.log('| Language | Files | Extension | Status |');
console.log('|---|---|---|---|');
const missing: string[] = [];
for (const p of PROVIDERS) {
    const n = p.langs.reduce((a, l) => a + (files.get(l) ?? 0), 0);
    if (!n) continue;
    const have = p.any.find((id) => ids.has(id.toLowerCase()) || BUILT_IN.has(id));
    const status = have ? (BUILT_IN.has(have) ? 'built in' : `installed ${ids.get(have.toLowerCase())}`) : p.optional ? `missing (optional: ${p.optional})` : 'missing';
    if (!have && !p.optional) missing.push(p.install);
    console.log(`| ${p.label} | ${n} | ${have ?? p.install} | ${status} |`);
}
if (missing.length) console.log(`\ninstall:\n${missing.map((m) => `  code --install-extension ${m}`).join('\n')}`);
