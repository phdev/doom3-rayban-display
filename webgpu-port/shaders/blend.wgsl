// blend.wgsl — DOOM 3 blend light pass (RB_BlendLight / RB_T_BlendLight).
//
// Blend lights tint/filter whatever is already in the framebuffer instead
// of interacting with surface materials: projected cookie (projective
// S/T/Q texgens) x falloff ramp x stage color. The blend factor variant
// (filter = DstColor/Zero, additive = One/One) is chosen per record.

struct Uniforms {
    mvp:       mat4x4<f32>,
    color:     vec4<f32>,
    proj_s:    vec4<f32>,
    proj_t:    vec4<f32>,
    proj_q:    vec4<f32>,
    falloff_s: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var t_proj: texture_2d<f32>;
@group(0) @binding(3) var t_falloff: texture_2d<f32>;

struct VSIn {
    @location(0) position:  vec3<f32>,
    @location(1) texcoord:  vec2<f32>,
    @location(2) normal:    vec3<f32>,
    @location(3) tangent:   vec3<f32>,
    @location(4) bitangent: vec3<f32>,
    @location(5) color:     vec4<f32>,
};

struct VSOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) uvq: vec3<f32>,
    @location(1) sF:  f32,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    let pos4 = vec4<f32>(in.position, 1.0);
    out.uvq = vec3<f32>(dot(pos4, u.proj_s), dot(pos4, u.proj_t), dot(pos4, u.proj_q));
    out.sF  = dot(pos4, u.falloff_s);
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let uv = in.uvq.xy / max(in.uvq.z, 0.001);
    let c0 = textureSample(t_proj, samp, uv);
    let c1 = textureSample(t_falloff, samp, vec2<f32>(in.sF, 0.5));
    return c0 * c1 * u.color;
}
