/**
* Security tooling: prevent abitrary scheme URIs. Block URIs from outside data reaching external providers.
**/
import * as vscode from 'vscode';

export function readable(u: vscode.Uri): boolean {
    return u.scheme === 'file' || (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === u.scheme);
}
