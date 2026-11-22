// npm run heuristics: bundles scripts/heuristics.ts with the core and runs it (writes .HEURISTICS.md, .heuristics.gaffy)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('dist', { recursive: true });
await esbuild.build({ entryPoints: ['scripts/heuristics.ts'], outfile: 'dist/heuristics.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'warning' });
process.stdout.write(execFileSync(process.execPath, ['dist/heuristics.cjs']).toString());
