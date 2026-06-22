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

// R0 — HDR filmic tonemap (RBDOOM-3-BFG-class), the principled replacement
// for the per-fragment gamma "lift" the iter-29 BFG-look research found was the
// wash ("the BFG look needs deep blacks, not more lift"). A single fullscreen
// grade of the already-composited 8-bit frame (LDR-on-LDR, exactly like the
// bloom/shadow-darken passes above), bound through the SAME bloomBGL.
//
// params.x = exposure (linear pre-scale), params.z = dither enable (1=on).
// The pipeline blend is REPLACE (non-additive, like fs_bright) — it overwrites
// the canvas with the graded result.
//
// DETERMINISM: the curve is a pure function of the sampled bytes + constant
// uniforms; the dither is a pure function of @builtin(position). No time, no
// frame counter, no RNG, no cross-frame feedback — so the two encodeRecordsPass
// runs of the __d3WgpuDet self-test are byte-identical (like fs_darken, which
// CLAUDE.md confirms "runs in det rounds too" and stays IDENTICAL).

// Narkowicz ACES filmic fit — self-normalizing (no separate white-point scale).
// Crushes the toe (deep blacks) and rolls off the shoulder (no blown highlights).
fn aces_narkowicz(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

// 8x8 ordered (Bayer-class) threshold in [0,1), keyed by integer pixel position
// — STATIC (no frame term), so it stays det-IDENTICAL. NOT RBDOOM's temporal
// golden-ratio dither (that is frame-dependent and would break the self-test).
fn ordered8(p: vec2<u32>) -> f32 {
    let x = p.x & 7u; let y = p.y & 7u;
    var v = 0u;                                  // interleave the low 3 bits of x,y
    v = (v << 1u) | ((y >> 2u) & 1u); v = (v << 1u) | ((x >> 2u) & 1u);
    v = (v << 1u) | ((y >> 1u) & 1u); v = (v << 1u) | ((x >> 1u) & 1u);
    v = (v << 1u) | ((y      ) & 1u); v = (v << 1u) | ((x      ) & 1u);
    return f32(v) / 64.0;
}

@fragment
fn fs_tonemap(in: VSOut) -> @location(0) vec4<f32> {
    let src = textureSampleLevel(tex, samp, in.uv, 0.0).rgb;
    var c = aces_narkowicz(max(src, vec3<f32>(0.0)) * u.params.x);
    if (u.params.z > 0.5) {
        // break up 8-bit contour banding the deep-blacks curve exposes: a
        // ±0.5-LSB offset distributed across pixels (sub-quantum, deterministic).
        let off = (ordered8(vec2<u32>(u32(in.pos.x), u32(in.pos.y))) - 0.5) / 255.0;
        c = c + vec3<f32>(off);
    }
    return vec4<f32>(c, 1.0);
}
