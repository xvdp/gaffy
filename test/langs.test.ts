import { describe, expect, it } from 'vitest';
import { EXTERNAL, langOf, segments } from '../src/core/langs';
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
    for (const p of ['/w/rust/mote-core/pkg/mote_core.js', '/w/rust/mote-core/pkg/mote_core_bg.js']) expect(EXTERNAL.test(p), p).toBe(true);
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
