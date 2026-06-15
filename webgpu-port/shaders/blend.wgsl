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
    // Iter 71 (sibling of the interaction.wgsl orange-panel fix): uvq and sF
    // are interpolated attributes carrying this blend light's projective cookie
    // and axial falloff coords. On WebKit, near-plane / projective-w~0 geometry
    // can interpolate them to inf/NaN (the documented iter 47b pathology), and
    // an unclamped/NaN coord on the shared ClampToEdge+LOD-0 light sampler
    // reads the BRIGHT cookie/falloff interior instead of the dark bounded edge
    // — the same WebKit-only light bleed. Clamp both coords to [0,1] with a
    // NaN-safe select (clamp() alone passes NaN through). This is byte-identical
    // to ClampToEdge for every FINITE coord, so it cannot change Dawn/GL output;
    // it only bounds the degenerate non-finite WebKit fragments.
    let uv_raw = in.uvq.xy / max(in.uvq.z, 0.001);
    let uv_finite = uv_raw.x == uv_raw.x && uv_raw.y == uv_raw.y; // false for NaN
    let uv = select(vec2<f32>(2.0, 2.0),
                    clamp(uv_raw, vec2<f32>(0.0), vec2<f32>(1.0)), uv_finite);
    let sf_finite = in.sF == in.sF;
    let sf = select(2.0, clamp(in.sF, 0.0, 1.0), sf_finite);
    let c0 = textureSample(t_proj, samp, uv);
    let c1 = textureSample(t_falloff, samp, vec2<f32>(sf, 0.5));
    return c0 * c1 * u.color;
}
