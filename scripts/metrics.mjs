// npm run metrics -- <view.gaffy> [rules JSON …]: bundles and runs scripts/metrics.ts (edge metrics per rule configuration)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('dist', { recursive: true });
await esbuild.build({ entryPoints: ['scripts/metrics.ts'], outfile: 'dist/metrics.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'warning' });
try {
    execFileSync(process.execPath, ['dist/metrics.cjs', ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (e) { process.exit(e.status ?? 1); }
