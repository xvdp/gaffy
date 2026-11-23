// Bundles: extension host (Node, CJS, `vscode` external), webview (browser, IIFE).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, minify: !watch, logLevel: 'info' };

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
