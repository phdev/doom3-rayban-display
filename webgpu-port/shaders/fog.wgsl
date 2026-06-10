// fog.wgsl — DOOM 3 fog light pass (RB_FogPass / RB_T_BasicFog port).
//
// Two alpha-ramp textures modulate the fog color's alpha:
//   t_fog      sampled at (s0, 0.5)  — eye-space depth ramp
//   t_fogEnter sampled at (s1, t1)   — enter-plane fade correction
// where s0/t1 are object-plane texgens against per-record LOCAL planes and
// s1 is a per-view constant baked into its plane's .w. Blend is
// SrcAlpha / OneMinusSrcAlpha over the lit scene.

struct Uniforms {
    mvp:      mat4x4<f32>,
    color:    vec4<f32>,   // fog color (rgb; alpha unused — ramps drive it)
    plane_s0: vec4<f32>,   // local eye-depth plane (+0.5 baked)
    plane_t1: vec4<f32>,   // local enter fade plane (+FOG_ENTER baked)
    plane_s1: vec4<f32>,   // constant (0,0,0,FOG_ENTER + viewer term)
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var t_fog: texture_2d<f32>;
@group(0) @binding(3) var t_fogEnter: texture_2d<f32>;

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
    @location(0) s0: f32,
    @location(1) s1: f32,
    @location(2) t1: f32,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    let pos4 = vec4<f32>(in.position, 1.0);
    out.s0 = dot(pos4, u.plane_s0);
    out.s1 = dot(pos4, u.plane_s1);
    out.t1 = dot(pos4, u.plane_t1);
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let a0 = textureSample(t_fog,      samp, vec2<f32>(in.s0, 0.5)).a;
    let a1 = textureSample(t_fogEnter, samp, vec2<f32>(in.s1, in.t1)).a;
    return vec4<f32>(u.color.rgb, a0 * a1);
}
