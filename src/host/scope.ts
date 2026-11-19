/**
 * URI schemes gaffy reads: `file`, and the schemes of the workspace folders (a remote or virtual
 * workspace). VS Code loads the document of a URI through the file-system provider registered for its
 * scheme, which any extension may register. A location of another scheme in a language server's answer
 * or in a cache file is dropped where it arrives, so a URI from outside data reaches no provider and
 * opens no document beyond these.
 */
import * as vscode from 'vscode';

export function readable(u: vscode.Uri): boolean {
  return u.scheme === 'file' || (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === u.scheme);
}
