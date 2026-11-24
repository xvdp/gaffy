/** @xvdp
 * Symbolic-link guard for writes under `.baggy/gaffy/` (call cache, trace, exports, views, style.json). Threat: a cloned
 * repository ships `.baggy/gaffy/cache/calls.json` or `.baggy/gaffy/trace/<view>.jsonl` as a link to a file outside the
 * workspace (a shell startup file); the next write truncates or appends to it. `noLinks(base, target)` throws when
 * `target` is outside `base` or an existing segment below `base` (directory, target) is a link; the caller creates
 * missing segments as plain directories and files. `base` (workspace folder) may be a link. Check: lstat (`file`
 * URIs), else the `SymbolicLink` bit of `workspace.fs.stat`. Not covered: a link created between check and write.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export async function noLinks(base: vscode.Uri, target: vscode.Uri): Promise<void> {
    const rel = path.posix.relative(base.path, target.path);
    if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel) || target.scheme !== base.scheme) {
        throw new Error(`${target.path} is outside ${base.path}`);
    }
    let cur = base;
    for (const seg of rel.split('/')) {
        cur = vscode.Uri.joinPath(cur, seg);
        let link: boolean;
        try {
            link = cur.scheme === 'file'
                ? (await fs.lstat(cur.fsPath)).isSymbolicLink()
                : ((await vscode.workspace.fs.stat(cur)).type & vscode.FileType.SymbolicLink) !== 0;
        } catch {
            return;   // absent: the write creates this segment and those below
        }
        if (link) throw new Error(`${path.posix.relative(base.path, cur.path)} is a symbolic link; gaffy does not write through links`);
    }
}
