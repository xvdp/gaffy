import { describe, expect, it } from 'vitest';
import { callSites } from '../src/core/textcalls';
import { extModules, jsCallSites, jsImports, matchBindings, matchWasm, pyCallSites, pyImports, resolveDotted, scanNative, scanWasm, slangCalls, slangLoads } from '../src/core/bindings';

const PYBIND = `#include <pybind11/pybind11.h>
namespace py = pybind11;
int add(int a, int b);                 // m.def("not", &this) in a comment
namespace geo { float area(float r); }
struct Mesh { void build(); static Mesh load(const char* p); };
PYBIND11_MODULE(fastgeo, m) {
    m.doc() = "fast geometry";
    m.def("add", &add, "adds");
    m.def("area", py::overload_cast<float>(&geo::area));
    m.def("lam", [](int x) { return x; });
    auto io = m.def_submodule("io");
    io.def("load", &Mesh::load);
    py::class_<Mesh>(m, "Mesh")
        .def(py::init<>())
        .def("build", &Mesh::build)
        .def_static("load", &Mesh::load);
}
`;

const NANOBIND = `NB_MODULE(nbmod, m) {
    auto c = nb::class_<Cam>(m, "Camera");
    c.def("ray", &Cam::ray);
    m.def("render", &render_frame);
}`;

const TORCH = `TORCH_LIBRARY(myops, m) {
  m.def("fused(Tensor x) -> Tensor");
}
TORCH_LIBRARY_IMPL(myops, CUDA, m) {
  m.impl("fused", &fused_cuda);
}
PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
  m.def("forward", &lltm_forward, "LLTM forward (CUDA)");
}
__global__ void k_fwd(float* y) {}
torch::Tensor lltm_forward(torch::Tensor x) { k_fwd<<<grid, block, 0, stream>>>(x.data_ptr<float>()); return x; }
`;

describe('native bindings', () => {
    it('pybind11: functions, overloads, submodules, classes; lambdas and constructors skipped', () => {
        const b = scanNative(PYBIND).map((x) => `${x.module}:${x.py.join('.')}→${x.target}`);
        expect(b).toEqual(['fastgeo:add→add', 'fastgeo:area→geo::area', 'fastgeo.io:load→Mesh::load',
            'fastgeo:Mesh.build→Mesh::build', 'fastgeo:Mesh.load→Mesh::load']);
        const add = scanNative(PYBIND)[0];
        expect(PYBIND.slice(add.targetAt, add.targetAt + 3)).toBe('add');
    });
    it('nanobind: class through a variable', () => {
        expect(scanNative(NANOBIND).map((x) => `${x.via}:${x.module}:${x.py.join('.')}→${x.target}`))
            .toEqual(['nanobind:nbmod:Camera.ray→Cam::ray', 'nanobind:nbmod:render→render_frame']);
    });
    it('torch: operator implementations and an extension module named by the build', () => {
        expect(scanNative(TORCH).map((x) => `${x.via}:${x.module}:${x.py.join('.')}→${x.target}`))
            .toEqual(['torch:torch.ops.myops:fused→fused_cuda', 'pybind11:TORCH_EXTENSION_NAME:forward→lltm_forward']);
    });
    it('CUDA kernel launches are call sites', () => {
        const at = TORCH.indexOf('{ k_fwd');
        expect(callSites(TORCH, at, TORCH.length).map((c) => c.name)).toContain('k_fwd');
    });
});

const PY = `import fastgeo as fg
from fastgeo import add as plus
from fastgeo.io import load
import torch, slangpy as spy
from torch.utils.cpp_extension import load as build
lltm = build(name="lltm_cuda", sources=["lltm.cpp", "lltm_kernel.cu"], verbose=True)

class R:
    def __init__(self, device):
        self.kern = spy.Module.load_from_file(device, "shaders/shade.slang")
    def run(self, x):
        fg.area(2.0)            # fg.fake( in a comment
        plus(1, 2)
        load("m.obj")
        fg.Mesh.load("p")
        torch.ops.myops.fused(x)
        lltm.forward(x)
        return self.kern.shade(x, "s(")
`;

describe('Python side', () => {
    const imports = pyImports(PY);
    it('imports resolve local names', () => {
        expect(resolveDotted('fg.area', imports)).toEqual(['fastgeo', 'area']);
        expect(resolveDotted('plus', imports)).toEqual(['fastgeo', 'add']);
        expect(resolveDotted('load', imports)).toEqual(['fastgeo', 'io', 'load']);
    });
    it('call sites skip comments and strings', () => {
        const run = PY.indexOf('def run');
        expect(pyCallSites(PY, run).map((c) => c.dotted)).toEqual(['fg.area', 'plus', 'load', 'fg.Mesh.load', 'torch.ops.myops.fused', 'lltm.forward', 'self.kern.shade']);
    });
    it('calls match bindings through imports, torch.ops, extension modules', () => {
        const bindings = [...scanNative(PYBIND), ...scanNative(TORCH)];
        const ext = extModules(PY);
        expect(ext).toEqual([{ name: 'lltm_cuda', sources: ['lltm.cpp', 'lltm_kernel.cu'], local: 'lltm' }]);
        // the extension's module name stands for TORCH_EXTENSION_NAME of its sources
        const moduleOf = (b: { module: string }) => (b.module === 'TORCH_EXTENSION_NAME' ? 'lltm_cuda' : b.module);
        const hit = (d: string) => matchBindings(resolveDotted(d, new Map([...imports, ['lltm', 'lltm_cuda']])), bindings, moduleOf).map((b) => b.target);
        expect(hit('fg.area')).toEqual(['geo::area']);
        expect(hit('plus')).toEqual(['add']);
        expect(hit('load')).toEqual(['Mesh::load']);
        expect(hit('fg.Mesh.load')).toEqual(['Mesh::load']);
        expect(hit('torch.ops.myops.fused')).toEqual(['fused_cuda']);
        expect(hit('lltm.forward')).toEqual(['lltm_forward']);
        expect(hit('fg.nothing')).toEqual([]);
    });
    it('slang modules loaded by slangpy and slangtorch', () => {
        expect(slangLoads(PY)).toEqual([{ target: 'self.kern', file: 'shaders/shade.slang', via: 'slangpy' }]);
        expect(slangLoads('m = slangtorch.loadModule("square.slang")\nk = device.load_module("blur")')).toEqual([
            { target: 'm', file: 'square.slang', via: 'slangtorch' }, { target: 'k', file: 'blur.slang', via: 'slangpy' }]);
    });
});

describe('slang kernels chosen by name (slangpy, as in sdfx/points_as_tori/knn_slang.py)', () => {
    const PY2 = `import slangpy as spy
_DEVICES = {}
def get_device(dev):
    device_type = getattr(spy.DeviceType, 'cuda')
    module = spy.Module.load_from_file(device, 'knn.slang')
    _DEVICES[dev] = (device, module)
    return device, module

class SlangKNN:
    VARIANTS = {'heap': 'knn', 'scan': 'knn_scan'}
    def __init__(self, points):
        self.device, self.module = get_device(points.device)
    def _kernel(self, k):
        name = 'knn_f64' if k else self.VARIANTS['heap']
        return getattr(self.module, name).constants({})
    def direct(self, q):
        return self.module.knn_scan(q)
`;
    const names = new Set(['knn', 'knn_scan', 'knn_f64', 'knnHeap']);
    const holders = new Set(slangLoads(PY2).map((l) => l.target.split('.').pop()!));
    const fn = (n: string) => { const a = PY2.indexOf(`def ${n}`); const b = PY2.indexOf('\n    def ', a + 1); return [a, b < 0 ? PY2.length : b] as const; };
    it('getattr on the module holder reaches every kernel the file names; other getattr calls do not', () => {
        expect(holders).toEqual(new Set(['module']));
        expect(slangCalls(PY2, ...fn('_kernel'), names, holders).map((c) => `${c.name}:${c.dynamic}`).sort()).toEqual(['knn:true', 'knn_f64:true', 'knn_scan:true']);
        expect(slangCalls(PY2, ...fn('get_device'), names, holders)).toEqual([]);
        expect(slangCalls(PY2, ...fn('direct'), names, holders).map((c) => `${c.name}:${c.dynamic}`)).toEqual(['knn_scan:false']);
    });
});

describe('wasm-bindgen: Rust exports, JavaScript and TypeScript calls', () => {
    const RS = `//! exports
use wasm_bindgen::prelude::*;
/// not #[wasm_bindgen] pub fn hidden() in a comment
#[wasm_bindgen]
pub fn install() {}

#[wasm_bindgen(js_name = mergeMoose)]
#[must_use]
pub fn merge_field_moose(mu: &[f32]) -> Result<Merged, JsError> { inner(mu) }

#[wasm_bindgen]
#[derive(Debug, Default)]
pub struct Merged { inner: Vec<f32> }

#[wasm_bindgen]
impl Merged {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Merged { Merged::default() }
    #[wasm_bindgen(getter)]
    pub fn mu(&self) -> Vec<f32> { self.inner.clone() }
    pub fn scale(&mut self, s: f32) {}
    pub fn identity() -> Merged { Merged::default() }
    fn private_helper(&self) {}
}
fn inner(mu: &[f32]) -> Result<Merged, JsError> { Ok(Merged::default()) }
`;
    const TS = `import init, { install, mergeMoose as merge, Merged } from '../rust/moose-core/pkg/moose_core.js';
import * as core from 'moose-core';
import type { Other } from 'moose-core';
export async function boot(xs: Float32Array) {
  await init();
  install();               // install( in a comment
  const m = merge(xs);
  const n = new Merged();
  const i = Merged.identity();
  m.scale(2);
  core.install();
  const lazy = await import('../rust/moose-core/pkg');
  return "install(" + n;
}
function install2() {}
`;
    const exports = scanWasm(RS);
    it('exports: functions, constructor, statics, methods; getters and private functions out', () => {
        expect(exports.map((e) => `${e.kind}:${e.cls ? e.cls + '.' : ''}${e.js}=${e.rust}`)).toEqual([
            'function:install=install', 'function:mergeMoose=merge_field_moose', 'constructor:Merged.new=new', 'method:Merged.scale=scale', 'static:Merged.identity=identity']);
        expect(RS.slice(exports[1].at, exports[1].at + 17)).toBe('merge_field_moose');
    });
    it('imports and calls resolve to exports', () => {
        const imports = jsImports(TS);
        expect(imports.map((i) => `${i.local}=${i.name}`)).toEqual(['init=default', 'install=install', 'merge=mergeMoose', 'Merged=Merged', 'core=*', 'lazy=*']);
        const calls = jsCallSites(TS);
        expect(calls.map((c) => `${c.ctor ? 'new ' : ''}${c.dotted}`)).toEqual(['init', 'install', 'merge', 'new Merged', 'Merged.identity', 'm.scale', 'core.install']);
        const hit = (d: string, ctor = false) => matchWasm({ dotted: d, ctor }, imports, exports).map((e) => e.rust);
        expect(hit('install')).toEqual(['install']);
        expect(hit('merge')).toEqual(['merge_field_moose']);
        expect(hit('Merged', true)).toEqual(['new']);
        expect(hit('Merged.identity')).toEqual(['identity']);
        expect(hit('core.install')).toEqual(['install']);
        expect(hit('init')).toEqual([]);                     // the default export loads the module
        expect(hit('m.scale')).toEqual([]);                  // an instance: its type is unknown in the text
    });
});
