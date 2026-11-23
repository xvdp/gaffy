// npm run heuristics: bundles and runs scripts/heuristics.ts, scripts/ordering.ts
// → docs/heuristics.md, docs/heuristics.gaffy, docs/ordering.md
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('dist', { recursive: true });
await esbuild.build({ entryPoints: ['scripts/heuristics.ts'], outfile: 'dist/heuristics.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'warning' });
process.stdout.write(execFileSync(process.execPath, ['dist/heuristics.cjs']).toString());
await esbuild.build({ entryPoints: ['scripts/ordering.ts'], outfile: 'dist/ordering.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'warning' });
process.stdout.write(execFileSync(process.execPath, ['dist/ordering.cjs']).toString());
