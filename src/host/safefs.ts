/** @xvdp
 * Writes under `.gaffy/` (call cache, trace, exports, new views, style.json) must not follow symbolic links. A
 * cloned repository can ship `.gaffy/cache/calls.json` or `.gaffy/trace/<view>.jsonl` as a link to a file outside
 * the workspace (a shell startup file); the next write would truncate it or append text to it. `noLinks(base, target)`
 * throws when `target` lies outside `base` or when a path segment below `base` that exists (a directory on the way,
 * the target itself) is a symbolic link; segments that do not exist yet are created by the caller as plain directories
 * and files. `base`, the workspace folder, may itself be a link. Checked with lstat for `file` URIs, with the
 * `SymbolicLink` bit of `workspace.fs.stat` otherwise. A link made between the check and the write (a local process
 * racing the editor) is not covered.
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
            return;   // not there yet: this segment and the ones below are created by the write
        }
        if (link) throw new Error(`${path.posix.relative(base.path, cur.path)} is a symbolic link; gaffy does not write through links`);
    }
}
