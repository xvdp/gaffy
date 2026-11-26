/** @xvdp
 * `gaffy.autoSave`, the single save setting: a new view written to `.baggy/gaffy/` at once, every view saved after
 * each change. Read with the view's folder as scope (VS Code precedence: folder, workspace, user, default); written
 * where it takes effect: the folder's settings when they hold a value, else the workspace's, else the user's.
 */
import * as vscode from 'vscode';

/** Effective `gaffy.autoSave` for `folder` (a view's workspace folder), else for the workspace. */
export function autoSaveOf(folder?: vscode.Uri): boolean {
    return vscode.workspace.getConfiguration('gaffy', folder).get<boolean>('autoSave') ?? false;
}

/** Writes `gaffy.autoSave` at the most specific scope holding it, at least the workspace (user without one). */
export async function setAutoSave(value: boolean, folder?: vscode.Uri): Promise<void> {
    const c = vscode.workspace.getConfiguration('gaffy', folder);
    const at = c.inspect<boolean>('autoSave');
    const target = folder && at?.workspaceFolderValue !== undefined && vscode.workspace.workspaceFile
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await c.update('autoSave', value, target);
}
