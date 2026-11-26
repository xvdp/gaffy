/** @xvdp
 * Rule links of the layout debugging panel (webview dbgpanel.ts): a rule's explanation (docs/heuristics.md) or one
 * of its code sites (core/rules.lines.ts), opened from the gaffy sources when they are at hand, else on GitHub.
 * Sources at hand: the extension running from its folder (Extension Development Host), or a workspace folder (or its
 * `gaffy/` subfolder) holding `src/core/rules.ts` and a package.json named gaffy. GitHub: package.json `repository`
 * at the commit the extension was built from (`__GAFFY_COMMIT__`, esbuild define), else `main`.
 * `docs/**` stays out of the package (.vscodeignore).
 */
import * as vscode from 'vscode';
import { RULE } from '../core/rules';
import { RULE_LINES } from '../core/rules.lines';

declare const __GAFFY_COMMIT__: string;
const COMMIT = typeof __GAFFY_COMMIT__ === 'string' && /^[0-9a-f]{7,40}$/.test(__GAFFY_COMMIT__) ? __GAFFY_COMMIT__ : 'main';

/** Folder of the gaffy sources: the running extension's, else a workspace folder holding them; undefined: none. */
async function sourcesOf(ctx: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
    const holds = async (u: vscode.Uri) => {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(u, 'src', 'core', 'rules.ts'));
            const pkg = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(u, 'package.json'))));
            return pkg?.name === 'gaffy';
        } catch { return false; }
    };
    if (ctx.extensionMode !== vscode.ExtensionMode.Production && await holds(ctx.extensionUri)) return ctx.extensionUri;
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        for (const u of [f.uri, vscode.Uri.joinPath(f.uri, 'gaffy')]) if (await holds(u)) return u;
    }
    return undefined;
}

/** Opens rule `id`'s explanation (`site` 'doc') or its code site number `site`; ids and sites from the registry only. */
export async function openRuleSite(ctx: vscode.ExtensionContext, id: unknown, site: unknown): Promise<void> {
    if (typeof id !== 'string' || !RULE.has(id)) return;
    const sites = RULE_LINES[id] ?? [];
    const at: [string, number] | undefined = site === 'doc' ? ['docs/heuristics.md', 0] : Number.isInteger(site) ? sites[site as number] : undefined;
    if (!at) return;
    const root = await sourcesOf(ctx);
    if (root) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ...at[0].split('/')));
        const line = site === 'doc' ? Math.max(0, doc.getText().split('\n').findIndex((l) => l === `### ${id}`)) : at[1] - 1;
        const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(pos, pos) });
        return;
    }
    const repo = String(ctx.extension.packageJSON?.repository?.url ?? ctx.extension.packageJSON?.repository ?? 'https://github.com/xvdp/gaffy')
        .replace(/^git\+/, '').replace(/\.git$/, '');
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) return;
    const url = site === 'doc' ? `${repo}/blob/${COMMIT}/docs/heuristics.md#${id}` : `${repo}/blob/${COMMIT}/${at[0]}#L${at[1]}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
}
