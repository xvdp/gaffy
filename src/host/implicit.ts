/**
 * Implicit calls: calls the language runtime makes where no call expression names the callee. They join
 * the language server's answers as edges with `implicit`; the language server answers neither kind.
 *
 * - construction: a class calls the methods its construction runs. Python `C(…)` runs `C.__new__` and
 *   `C.__init__`, a dataclass's generated `__init__` runs `__post_init__`; TypeScript and JavaScript
 *   `new C(…)` run `constructor`. `__init__` and `constructor` come from the class or, inherited, from the
 *   nearest base class that defines them (bases by go to definition on the names of the class header,
 *   depth ≤ 4, `object` skipped); `__new__` and `__post_init__` only from the class itself.
 *   Incoming: a construction method has its class as caller.
 * - instance call (Python): `obj(…)` runs `type(obj).__call__`. A torch `nn.Module` (no `__call__`
 *   definition up to a base class named `Module`) runs `forward` through `Module.__call__`. Sites: the call
 *   sites of the caller's body where the language server answered no call; the type of `obj` from type
 *   definition at the called name (`criterion` in `criterion(x)`, `net` in `self.net(x)`).
 *
 * Out of scope (a call trace, not a call hierarchy): which methods backprop, hooks, `with` blocks, iteration,
 * operators, properties and decorators run.
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
/** Call sites of one function asked for their type: the rest of a long function is not followed. */
const MAX_SITES = 48;

export class Implicit {
    constructor(private readonly p: LspProvider) {}

    /** Innermost class whose range holds `pos` in the file's outline. */
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

    /** Base classes named in a Python class header `class C(A, m.B, metaclass=M):`, by go to definition. */
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

    /** A method `name` of the class, or of its nearest base class defining it (`inherit`); breadth first. */
    private async methodOf(start: ClassAt, name: string, inherit: boolean): Promise<{ uri: vscode.Uri; sym: Sym } | undefined> {
        let level = [start];
        const seen = new Set<string>();
        for (let depth = 0; depth <= BASE_DEPTH && level.length; depth++) {
            const next: ClassAt[] = [];
            for (const c of level) {
                const id = `${c.uri.toString()}#${c.cls.selectionRange.start.line}`;
                if (seen.has(id)) continue;
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

    /** Whether a class or one of its bases (depth ≤ 4) is named `Module` (torch `nn.Module`). */
    private async isModule(start: ClassAt): Promise<boolean> {
        let level = [start];
        for (let depth = 0; depth <= BASE_DEPTH && level.length; depth++) {
            const next: ClassAt[] = [];
            for (const c of level) {
                if (depth > 0 && c.cls.name === 'Module') return true;
                next.push(...(await this.bases(c)));
            }
            level = next;
        }
        return false;
    }

    /** The node of a method found in an outline, or undefined (excluded, or no call hierarchy item). */
    private async nodeOf(m: { uri: vscode.Uri; sym: Sym }, acc: Record<NodeKey, GNode>): Promise<NodeKey | undefined> {
        const it = (await this.p.prepare(m.uri, m.sym.selectionRange.start))[0];
        return it && this.p.describe(it, acc);
    }

    /** Implicit calls from `it`: construction methods of a class; instance calls in a Python function's body. */
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
        // one type question per called name; its first site gives the line
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

    /** Implicit callers of `it`: its class, for a method that construction runs. */
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
