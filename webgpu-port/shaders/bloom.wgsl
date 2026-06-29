// bloom.wgsl — WebGPU-native bloom post-process (iter 19).
//
// Vanilla dhewm3 has no bloom at all; this adds the RBDOOM-style glow the
// PC reference shots show (halos on emissives — alarm lights, fixtures,
// monitors). Three entry points share one module + bind group layout:
//   fs_bright    — threshold the scene copy into the quarter-res target
//   fs_blur      — 9-tap separable Gaussian (direction in u.dir)
//   fs_composite — additive blend of the blurred glow over the canvas
// All draws are bufferless fullscreen triangles (vertex_index trick).
//
// params: x = threshold, y = intensity, z = 1/texW, w = 1/texH
// dir:    blur direction in texels (1,0) or (0,1); zw unused

struct BloomUniforms {
    params: vec4<f32>,
    dir: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: BloomUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var out: VSOut;
    let x = f32(i32(vi & 1u) * 4 - 1);   // -1, 3, -1
    let y = f32(i32(vi >> 1u) * 4 - 1);  // -1, -1, 3
    out.pos = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>(x, -y) * 0.5 + vec2<f32>(0.5, 0.5);
    return out;
}

@fragment
fn fs_bright(in: VSOut) -> @location(0) vec4<f32> {
    let c = textureSampleLevel(tex, samp, in.uv, 0.0).rgb;
    let t = u.params.x;
    // soft knee: rescale what survives the threshold back to 0..1
    let b = max(c - vec3<f32>(t), vec3<f32>(0.0)) / max(1.0 - t, 0.001);
    return vec4<f32>(b, 1.0);
}

@fragment
fn fs_blur(in: VSOut) -> @location(0) vec4<f32> {
    let step = u.dir.xy * vec2<f32>(u.params.z, u.params.w);
    var c = textureSampleLevel(tex, samp, in.uv, 0.0).rgb * 0.227027;
    c += textureSampleLevel(tex, samp, in.uv + step * 1.0, 0.0).rgb * 0.1945946;
    c += textureSampleLevel(tex, samp, in.uv - step * 1.0, 0.0).rgb * 0.1945946;
    c += textureSampleLevel(tex, samp, in.uv + step * 2.0, 0.0).rgb * 0.1216216;
    c += textureSampleLevel(tex, samp, in.uv - step * 2.0, 0.0).rgb * 0.1216216;
    c += textureSampleLevel(tex, samp, in.uv + step * 3.0, 0.0).rgb * 0.054054;
    c += textureSampleLevel(tex, samp, in.uv - step * 3.0, 0.0).rgb * 0.054054;
    c += textureSampleLevel(tex, samp, in.uv + step * 4.0, 0.0).rgb * 0.016216;
    c += textureSampleLevel(tex, samp, in.uv - step * 4.0, 0.0).rgb * 0.016216;
    return vec4<f32>(c, 1.0);
}

@fragment
fn fs_composite(in: VSOut) -> @location(0) vec4<f32> {
    let b = textureSampleLevel(tex, samp, in.uv, 0.0).rgb;
    return vec4<f32>(b * u.params.y, 1.0);   // pipeline blend is additive
}

// Iter 23: Quest-style shadow darkening — a fullscreen multiply applied
// where the union of all shadow volumes marked the stencil (≠128).
// params.x = darken factor (0.6 = shadows at 60% brightness).
@fragment
fn fs_darken(in: VSOut) -> @location(0) vec4<f32> {
    let k = u.params.x;
    return vec4<f32>(k, k, k, 1.0);   // pipeline blend: dst * src
}

// --- consistency entry points (2026-06-29) --------------------------------------
// RenderBackend_WebGPU.cpp creates `tonemap`/`tracer` pipelines via
// makeBloom("fs_tonemap"/"fs_tracer", ...). These entry points had been dropped from
// this module while the C++ kept calling them, so both pipelines were INVALID; binding
// the tracer on weapon-fire produced an [Invalid CommandBuffer] → Queue.Submit failed →
// the rendered view FROZE (the rocket-launcher "freeze" bug). Provide valid entry points
// so the pipelines are valid. arco-doom uses neither effect, so these are inert:
//   fs_tracer  — transparent (additive One/One → adds nothing; no streak, no black).
//   fs_tonemap — identity passthrough (REPLACE One/Zero → scene unchanged).
// No helper functions referenced → the module compiles standalone. The render-track can
// replace these with the real graded R-TRACER / ACES tonemap implementations later.
@fragment
fn fs_tracer(in: VSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

@fragment
fn fs_tonemap(in: VSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(textureSampleLevel(tex, samp, in.uv, 0.0).rgb, 1.0);
}
