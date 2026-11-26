/** @xvdp
 * Implicit calls: runtime calls without a call expression naming the callee, absent from language-server answers;
 * edges carry `implicit`.
 * - construction: Python `C(...)` => `C.__new__`, `C.__init__`; dataclass `__init__` => `__post_init__`;
 *   TypeScript/JavaScript `new C(...)` => `constructor`. `__init__`, `constructor`: class, else nearest defining base
 *   (go to definition on header names, depth ≤ 4, `object` skipped); `__new__`, `__post_init__`: class only.
 *   Incoming: the class calls its construction methods.
 * - instance call (Python): `obj(...)` => `type(obj).__call__`; torch `nn.Module` (no `__call__` below base `Module`)
 *   => `forward` via `Module.__call__`. Sites: body call sites the server left unanswered; `obj` type by type
 *   definition at the called name (`criterion` in `criterion(x)`, `net` in `self.net(x)`).
 * Out of scope (call trace, not call hierarchy): backprop, hooks, `with` blocks, iteration, operators, properties,
 * decorators.
 */
import * as vscode from 'vscode';
import { pyBases, pyCallSites } from '../core/bindings';
import { langOf } from '../core/langs';
import { GEdge, GNode, NodeKey } from '../core/model';
import type { LspProvider } from './lsp';
import { readable } from './scope';

type Sym = vscode.DocumentSymbol;
interface ClassAt { uri: vscode.Uri; cls: Sym }

const METHODS = new Set([vscode.SymbolKind.Method, vscode.SymbolKind.Function, vscode.SymbolKind.Constructor]);
const PY_CONSTRUCT = ['__new__', '__init__', '__post_init__'];
const PY_INHERITED = new Set(['__init__']);
const JS_CONSTRUCT = ['constructor'];
const BASE_DEPTH = 4;
const MAX_CLASSES = 64;   // classes one base-class walk visits at most
/** Call sites per function asked for their type; the rest is skipped. */
const MAX_SITES = 48;

export class Implicit {
    constructor(private readonly p: LspProvider) {}

    /** Innermost outline class containing `pos`. */
    private async classAt(uri: vscode.Uri, pos: vscode.Position): Promise<Sym | undefined> {
        let found: Sym | undefined;
        const walk = (ss: readonly Sym[]) => {
            for (const s of ss) {
                if (!s.range.contains(pos)) continue;
                if (s.kind === vscode.SymbolKind.Class) found = s;
                walk(s.children ?? []);
            }
        };
        walk(await this.p.symbolsOf(uri));
        return found;
    }

    /** Base classes of a Python class header `class C(A, m.B, metaclass=M):`, by go to definition. */
    private async bases(at: ClassAt): Promise<ClassAt[]> {
        if (langOf(at.uri.path) !== 'py') return [];
        const doc = await vscode.workspace.openTextDocument(at.uri);
        const from = doc.offsetAt(at.cls.selectionRange.end);
        const out: ClassAt[] = [];
        for (const b of pyBases(doc.getText().slice(from, from + 400))) {
            let defs: (vscode.Location | vscode.LocationLink)[] = [];
            try { defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', at.uri, doc.positionAt(from + b.at)) ?? []; } catch { /* none */ }
            for (const l of defs) {
                const u = 'targetUri' in l ? l.targetUri : l.uri;
                const pos = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange).start : l.range.start;
                if (!readable(u)) continue;
                const cls = await this.classAt(u, pos);
                if (cls) { out.push({ uri: u, cls }); break; }
            }
        }
        return out;
    }

    /** Method `name` of the class, else (`inherit`) of the nearest defining base; breadth first. */
    private async methodOf(start: ClassAt, name: string, inherit: boolean): Promise<{ uri: vscode.Uri; sym: Sym } | undefined> {
        let level = [start];
        const seen = new Set<string>();
        for (let depth = 0; depth <= BASE_DEPTH && level.length; depth++) {
            const next: ClassAt[] = [];
            for (const c of level) {
                const id = `${c.uri.toString()}#${c.cls.selectionRange.start.line}`;
                if (seen.has(id) || seen.size >= MAX_CLASSES) continue;
                seen.add(id);
                const m = (c.cls.children ?? []).find((s) => s.name === name && METHODS.has(s.kind));
                if (m) return { uri: c.uri, sym: m };
                if (inherit) next.push(...(await this.bases(c)));
            }
            if (!inherit) break;
            level = next;
        }
        return undefined;
    }

    /**
     * Whether a base (depth ≤ 4) is named `Module` (torch `nn.Module`). Each class once, ≤ MAX_CLASSES total:
     * repeated or self-listed bases (`class A(B, B, ...)`, workspace source) would multiply definition requests per level.
     */
    private async isModule(start: ClassAt): Promise<boolean> {
        let level = [start];
        const seen = new Set<string>();
        for (let depth = 0; depth <= BASE_DEPTH && level.length; depth++) {
            const next: ClassAt[] = [];
            for (const c of level) {
                const id = `${c.uri.toString()}#${c.cls.selectionRange.start.line}`;
                if (seen.has(id) || seen.size >= MAX_CLASSES) continue;
                seen.add(id);
                if (depth > 0 && c.cls.name === 'Module') return true;
                next.push(...(await this.bases(c)));
            }
            level = next;
        }
        return false;
    }

    /** Node key of an outline method; undefined when excluded or unresolved. */
    private async nodeOf(m: { uri: vscode.Uri; sym: Sym }, acc: Record<NodeKey, GNode>): Promise<NodeKey | undefined> {
        const it = (await this.p.prepare(m.uri, m.sym.selectionRange.start))[0];
        return it && this.p.describe(it, acc);
    }

    /** Implicit calls: class => construction methods; Python body => instance calls. */
    async outgoing(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>, answered: readonly vscode.Range[]): Promise<GEdge[]> {
        const lang = langOf(it.uri.path);
        if (it.kind === vscode.SymbolKind.Class) {
            const cls = await this.classAt(it.uri, it.selectionRange.start);
            if (!cls) return [];
            const names = lang === 'py' ? PY_CONSTRUCT : lang === 'ts' || lang === 'js' ? JS_CONSTRUCT : [];
            const edges: GEdge[] = [];
            for (const name of names) {
                const m = await this.methodOf({ uri: it.uri, cls }, name, PY_INHERITED.has(name) || name === 'constructor');
                const to = m && (await this.nodeOf(m, acc));
                if (to && to !== key) edges.push({ from: key, to, implicit: 'construction' });
            }
            return edges;
        }
        if (lang !== 'py' || !METHODS.has(it.kind)) return [];
        const doc = await vscode.workspace.openTextDocument(it.uri);
        const sites = pyCallSites(doc.getText(), doc.offsetAt(it.selectionRange.end), doc.offsetAt((await this.p.bodyOf(it)).end))
            .map((s) => ({ ...s, pos: doc.positionAt(s.at) }))
            .filter((s) => !answered.some((r) => r.contains(s.pos)));
        // one type request per called name; line from its first site
        const first = new Map<string, (typeof sites)[number]>();
        for (const s of sites) if (!first.has(s.dotted)) first.set(s.dotted, s);
        const edges: GEdge[] = [];
        for (const s of [...first.values()].slice(0, MAX_SITES)) {
            let types: (vscode.Location | vscode.LocationLink)[] = [];
            try { types = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeTypeDefinitionProvider', it.uri, s.pos) ?? []; } catch { continue; }
            for (const l of types) {
                const u = 'targetUri' in l ? l.targetUri : l.uri;
                const pos = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange).start : l.range.start;
                if (!readable(u)) continue;
                const cls = await this.classAt(u, pos);
                if (!cls || !cls.selectionRange.contains(pos)) continue;      // the type of a function, not of an instance
                const at = { uri: u, cls };
                const m = (await this.methodOf(at, '__call__', true)) ?? ((await this.isModule(at)) ? await this.methodOf(at, 'forward', true) : undefined);
                const to = m && (await this.nodeOf(m, acc));
                if (to && to !== key) edges.push({ from: key, to, line: s.pos.line, implicit: 'instance call' });
                break;
            }
        }
        return edges;
    }

    /** Implicit caller of a construction method: its class. */
    async incoming(key: NodeKey, it: vscode.CallHierarchyItem, acc: Record<NodeKey, GNode>): Promise<GEdge[]> {
        const lang = langOf(it.uri.path);
        const names = lang === 'py' ? PY_CONSTRUCT : lang === 'ts' || lang === 'js' ? JS_CONSTRUCT : [];
        const name = it.name.split('.').pop()!;
        if (!names.includes(name) || !METHODS.has(it.kind)) return [];
        const cls = await this.classAt(it.uri, it.selectionRange.start);
        if (!cls) return [];
        const c = (await this.p.prepare(it.uri, cls.selectionRange.start))[0];
        const from = c && (await this.p.describe(c, acc));
        return from && from !== key ? [{ from, to: key, implicit: 'construction' }] : [];
    }
}
