/** @xvdp
 * Short commit hash of a folder's repository (`git rev-parse --short HEAD`); trusted workspaces only.
 */
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

export function gitShort(cwd: string): Promise<string | undefined> {
    // a trusted window can hold folders outside its workspace folders (an active editor's file)
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) return Promise.resolve(undefined);
    return new Promise((res) => execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 3000 },
        (err, out) => res(err ? undefined : out.trim() || undefined)));
}
