// shadow.wgsl — stencil shadow volume vertex shader, WGSL port of
// glprogs/shadow.vp (VPROG_STENCIL_SHADOW).
//
// Shadow volume vertices are vec4s: w=1 verts are the near cap (on the
// occluder surface); w=0 verts are projected to infinity away from the
// light. The vertex program computes, for w=0 verts,
//   position' = (vertex.xyz - localLightOrigin.xyz, 0)
// and relies on the engine's infinite-far-plane projection matrix to
// rasterize the at-infinity geometry. u.mvp here is the engine's full
// projection*modelView baked at capture, so the same math holds.
//
// No fragment stage — the pipeline writes stencil only.

struct Uniforms {
    mvp:          mat4x4<f32>,
    light_origin: vec4<f32>,   // model-space light position (.w = 0)
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSIn {
    @location(0) position: vec4<f32>,
};

struct VSOut {
    @builtin(position) clip_pos: vec4<f32>,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    // w==1 → near cap vertex used as-is; w==0 → direction-to-infinity.
    let projected = vec4<f32>(in.position.xyz - u.light_origin.xyz, 0.0);
    let pos = select(projected, in.position, in.position.w > 0.5);
    let cp = u.mvp * pos;
    // GL [-w, w] → WebGPU [0, w] clip-z remap, matching every other pipeline.
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    return out;
}

// Empty fragment stage: the stencil pipelines render inside the per-light
// pass which has a color attachment, so the pipeline must declare a
// compatible color target (writeMask = none) even though nothing is written.
@fragment
fn fs_main() {
}

// Iter 38 debug (r_wgpuSingleLight 994): volumes drawn as visible color so
// geometry/matrix problems separate from stencil-mechanics problems.
@fragment
fn fs_debug() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 1.0, 1.0);
}
