// npm run explain -- <view.gaffy> [options]: bundles and runs scripts/explain.ts (placement decision log)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('dist', { recursive: true });
await esbuild.build({ entryPoints: ['scripts/explain.ts'], outfile: 'dist/explain.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'warning' });
try {
    execFileSync(process.execPath, ['dist/explain.cjs', ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (e) { process.exit(e.status ?? 1); }
