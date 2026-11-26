// Bundles: extension host (Node, CJS, `vscode` external), webview (browser, IIFE).
import * as esbuild from 'esbuild';

import { execFileSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
// commit of the build: GitHub links of the layout debugging panel (src/host/sources.ts); 'main' without git
let commit = 'main';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no git */ }
const common = { bundle: true, sourcemap: true, minify: !watch, logLevel: 'info', define: { __GAFFY_COMMIT__: JSON.stringify(commit) } };

const configs = [
    { ...common, entryPoints: ['src/host/extension.ts'], outfile: 'dist/extension.js',
        platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] },
    { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js',
        platform: 'browser', format: 'iife', target: 'es2022' },
];

if (watch) {
    for (const c of configs) (await esbuild.context(c)).watch();
} else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
}
