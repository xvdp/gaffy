import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { EXTERNAL, externalPath, langOf, segments } from '../src/core/langs';
import { isStandard } from '../src/core/viewdoc';
import { callSites, functionAt, mask, outline, qualOf } from '../src/core/textcalls';

describe('symbol names → qualified segments', () => {
    it.each([
        ['helper', ['helper']],
        ['run(self, x)', ['run']],
        ['impl Foo', ['Foo']],
        ['impl<T> Foo<T>', ['Foo']],
        ['impl fmt::Display for Foo', ['Foo[Display]']],
        ['impl<T: Clone> std::fmt::Debug for crate::geo::Foo<T>', ['Foo[Debug]']],
        ['(*Server).Start', ['Server', 'Start']],
        ['(Point).String', ['Point', 'String']],
        ['items.forEach() callback', ['items·forEach·callback']],
        ['map() callback', ['map·callback']],
        ['ns::Foo::bar', ['ns', 'Foo', 'bar']],
        ['Foo<T>::bar(int)', ['Foo', 'bar']],
        ['Foo::operator()', ['Foo', 'operator()']],
        ['operator==', ['operator==']],
        ['~Foo', ['~Foo']],
    ])('%s', (name, want) => expect(segments(name)).toEqual(want));
});

describe('languages and external paths', () => {
    it('maps extensions', () => {
        expect(['a.py', 'a.tsx', 'a.rs', 'a.hpp', 'a.cu', 'a.frag', 'a.hlsli', 'a.slang', 'a.wgsl'].map(langOf))
            .toEqual(['py', 'ts', 'rs', 'cpp', 'cuda', 'glsl', 'hlsl', 'slang', 'wgsl']);
    });
    it('marks packages, build output and system headers external', () => {
        for (const p of ['/w/node_modules/x/a.js', '/w/.venv/lib/a.py', '/w/target/debug/build/x.rs', '/w/build/_deps/fmt/a.h', '/usr/include/stdio.h'])
            expect(EXTERNAL.test(p), p).toBe(true);
        for (const p of ['/w/src/target.rs', '/w/src/main.rs', '/w/lib/a.cpp', '/w/src/pkg.js', '/w/pkg/sub/x.ts', '/w/src/pkg/index.ts']) expect(EXTERNAL.test(p), p).toBe(false);
        // wasm-pack output: the glue between a caller and the Rust function
        for (const p of ['/w/rust/moose-core/pkg/moose_core.js', '/w/rust/moose-core/pkg/moose_core_bg.js']) expect(EXTERNAL.test(p), p).toBe(true);
    });
});

const SLANG = `interface IShape { float area(); }
struct Circle : IShape {
    float r;
    float area() { return 3.14 * sq(r); }   // sq(not this)
}
float sq(float v) { return v * v; }
namespace lighting {
    float lambert(float3 n, float3 l) { return max(dot(n, l), 0.0) * sq(1.0); }
}
#define TWICE(x) (2 * (x))
float shade(Circle c, float3 n) {
    if (n.x > 0) { return lighting::lambert(n, float3(0, 1, 0)) * c.area(); }
    return "sq(" == "" ? 0 : pick<float>(1.0);
}
[shader("fragment")]
float4 fragMain(float3 n : NORMAL) : SV_Target {
    Circle c; c.r = 2.0;
    return float4(shade(c, n));
}
fn wmain(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> { return helper(p); }
`;

describe('files outside the workspace', () => {
    it.each([
        ['/home/u/.venv/lib/python3.12/site-packages/torch/functional.py', 'site-packages/torch/functional.py', 'torch.functional'],
        ['/home/u/.venv/lib/python3.12/site-packages/torch/__init__.py', 'site-packages/torch/__init__.py', 'torch'],
        ['/usr/lib/python3/dist-packages/numpy/core/fromnumeric.py', 'dist-packages/numpy/core/fromnumeric.py', 'numpy.core.fromnumeric'],
        ['/home/u/.vscode/extensions/ms-python.vscode-pylance-2026.1.1/dist/typeshed-fallback/stdlib/builtins.pyi', 'stdlib/builtins.pyi', 'builtins'],
        ['/home/u/.vscode/extensions/ms-python.vscode-pylance-2026.1.1/dist/typeshed-fallback/stubs/requests/requests/api.pyi', 'requests/requests/api.pyi', 'requests.api'],
        ['/usr/lib/python3.12/json/__init__.py', 'python3.12/json/__init__.py', 'json'],
        ['/home/u/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/alloc/src/vec/mod.rs', 'library/alloc/src/vec/mod.rs', undefined],
        ['/home/u/.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.200/src/de/mod.rs', 'serde-1.0.200/src/de/mod.rs', undefined],
        ['/usr/share/code/resources/app/extensions/node_modules/typescript/lib/lib.es5.d.ts', 'node_modules/typescript/lib/lib.es5.d.ts', undefined],
        ['/usr/include/c++/13/bits/stl_vector.h', 'include/c++/13/bits/stl_vector.h', undefined],
        ['/opt/tools/gen/foo.py', 'opt/tools/gen/foo.py', undefined],
    ])('%s → %s', (abs, rel, module) => {
        const p = externalPath(abs);
        expect([p.rel, p.module]).toEqual([rel, module]);
        expect(posix.join(p.root, p.rel)).toBe(abs);
        // the folder chain of `rel` ends: dirname reaches '.', never the fixed point '/'
        let d = posix.dirname(p.rel), n = 0;
        while (d !== '.' && n < 64) { d = posix.dirname(d); n++; }
        expect(d).toBe('.');
    });
});

describe('standard library paths', () => {
    it.each([
        ['/home/u/.vscode/extensions/ms-python.vscode-pylance-2026.4.1/dist/typeshed-fallback/stdlib/builtins.pyi', true],
        ['/usr/lib/python3.12/json/__init__.py', true],
        ['/home/u/.venv/lib/python3.12/site-packages/torch/functional.py', false],
        ['/home/u/.vscode/extensions/ms-python.vscode-pylance-2026.4.1/dist/typeshed-fallback/stubs/requests/requests/api.pyi', false],
        ['/home/u/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/alloc/src/vec/mod.rs', true],
        ['/home/u/.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.200/src/de/mod.rs', false],
        ['/usr/share/code/resources/app/extensions/node_modules/typescript/lib/lib.es5.d.ts', true],
        ['/home/u/proj/node_modules/three/src/core/Object3D.d.ts', false],
        ['/usr/include/c++/13/bits/stl_vector.h', true],
        ['/usr/include/opencv4/opencv2/core.hpp', false],
    ])('%s → %s', (abs, std) => expect(isStandard(externalPath(abs).rel)).toBe(std));
});

describe('text calls (shader languages)', () => {
    const syms = outline(SLANG);
    const flat = (ss: typeof syms, up = ''): string[] => ss.flatMap((s) => [`${up}${s.name}:${s.kind}`, ...flat(s.children, `${up}${s.name}.`)]);

    it('masks comments, strings and preprocessor lines, keeping offsets', () => {
        const m = mask(SLANG);
        expect(m.length).toBe(SLANG.length);
        expect(m).not.toMatch(/sq\(not this\)|TWICE|"sq\("/);
    });

    it('outlines containers and functions', () => {
        expect(flat(syms)).toEqual(['IShape:container', 'Circle:container', 'Circle.area:function', 'sq:function', 'lighting:container',
            'lighting.lambert:function', 'shade:function', 'fragMain:function', 'wmain:function']);
    });

    it('finds call sites inside a function body, without keywords, comments or strings', () => {
        const shade = syms.find((s) => s.name === 'shade')!;
        expect(callSites(SLANG, shade.body, shade.end).map((c) => c.name)).toEqual(['lambert', 'float3', 'area', 'pick']);
        const area = syms.find((s) => s.name === 'Circle')!.children[0];
        expect(callSites(SLANG, area.body, area.end).map((c) => c.name)).toEqual(['sq']);
    });

    it('maps an offset to its function and qualified name', () => {
        const at = SLANG.indexOf('max(dot');
        const f = functionAt(syms, at)!;
        expect(f.name).toBe('lambert');
        expect(qualOf(syms, f.nameAt)).toEqual(['lighting', 'lambert']);
    });
});

describe('hostile input', () => {
    it('a long header without declarations stays fast (bounded regex work)', () => {
        const junk = 'x'.repeat(50) + 'a('.repeat(40000) + ' -> ' + 'b'.repeat(40000) + ' {';
        const t0 = performance.now();
        outline(junk);
        callSites(junk, 0, junk.length);
        expect(performance.now() - t0).toBeLessThan(2000);
    });
});
