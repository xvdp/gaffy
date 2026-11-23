/** @xvdp
* Security tooling: rejects arbitrary URI schemes; blocks URIs from outside data reaching external providers.
**/
import * as vscode from 'vscode';

export function readable(u: vscode.Uri): boolean {
    return u.scheme === 'file' || (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === u.scheme);
}
