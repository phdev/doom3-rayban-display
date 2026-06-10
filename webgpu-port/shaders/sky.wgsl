// sky.wgsl — skybox / wobblesky cube stages.
//
// The engine computes per-vertex cube direction vectors on the CPU
// (R_SkyboxTexGen / R_WobbleskyTexGen — the wobble rotation is baked in),
// which the capture stashes; this shader just samples the cube map along
// the interpolated direction. Opaque, depth-tested like any pass stage.

struct Uniforms {
    mvp:   mat4x4<f32>,
    tint:  vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tcube: texture_cube<f32>;

struct VSIn {
    @location(0) position:  vec3<f32>,
    @location(1) texcoord:  vec2<f32>,
    @location(2) normal:    vec3<f32>,
    @location(3) tangent:   vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) color:     vec4<f32>,
    @location(6) cubedir:   vec3<f32>,   // second vertex stream
};

struct VSOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) dir: vec3<f32>,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    out.dir = in.cubedir;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(tcube, samp, normalize(in.dir)) * u.tint;
}
