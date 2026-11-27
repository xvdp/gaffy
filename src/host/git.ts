/** @xvdp
 * Short commit hash of a folder's repository (`git rev-parse --short HEAD`); web base, commit and root for export
 * links (`gitWeb`). Trusted workspaces only.
 */
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { webBase } from '../core/weblinks';

export function gitShort(cwd: string): Promise<string | undefined> {
    // a trusted window can hold folders outside its workspace folders (an active editor's file)
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) return Promise.resolve(undefined);
    return new Promise((res) => execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 3000 },
        (err, out) => res(err ? undefined : out.trim() || undefined)));
}

const git = (cwd: string, args: string[]): Promise<string | undefined> => new Promise((res) =>
    execFile('git', args, { cwd, timeout: 3000 }, (err, out) => res(err ? undefined : out.trim() || undefined)));

/** https base of the `origin` remote, full HEAD commit and repository root (POSIX path); undefined without them. */
export async function gitWeb(cwd: string): Promise<{ base: string; commit: string; root: string } | undefined> {
    if (!vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))) return undefined;
    const [remote, commit, root] = await Promise.all([git(cwd, ['remote', 'get-url', 'origin']), git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['rev-parse', '--show-toplevel'])]);
    const base = remote && webBase(remote);
    if (!base || !commit || !/^[0-9a-f]{7,64}$/.test(commit) || !root) return undefined;
    return { base, commit, root: vscode.Uri.file(root).path };
}
