// texture.wgsl — single-texture sample shader for GUI / HUD / 2D blit.
//
// Source: RBDOOM-3-BFG neo/shaders/builtin/texture.{vs,ps}.hlsl
// Used for: console, HUD elements, full-screen quads, menu rendering.
//
// Bindings:
//   @group(0) @binding(0)  uniforms (MVP + tint color)
//   @group(0) @binding(1)  sampler
//   @group(0) @binding(2)  diffuse texture
//
// Vertex format: idDrawVert; only position + texcoord + color used.

struct Uniforms {
    mvp: mat4x4<f32>,
    tint: vec4<f32>,
    // params.x/.y = vertex-color modulate/add (SVC_IGNORE=(0,1),
    // SVC_MODULATE=(1,0), SVC_INVERSE=(-1,1)); .zw unused.
    params: vec4<f32>,
    // 2x3 stage texture matrix (scroll/rotate/scale), engine reg layout:
    // u' = u*s.x + v*s.y + s.w ; v' = u*t.x + v*t.y + t.w
    texmat_s: vec4<f32>,
    texmat_t: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

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
    @location(0) uv: vec2<f32>,
    @location(1) vertex_color: vec4<f32>,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    // GL [-w, w] → WebGPU [0, w] clip-z remap. Identity MVP is unaffected.
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    out.uv = vec2<f32>(
        in.texcoord.x * u.texmat_s.x + in.texcoord.y * u.texmat_s.y + u.texmat_s.w,
        in.texcoord.x * u.texmat_t.x + in.texcoord.y * u.texmat_t.y + u.texmat_t.w);
    out.vertex_color = in.color;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let vc = in.vertex_color * u.params.x + vec4<f32>(u.params.y);
    var texColor = textureSample(tex, samp, in.uv);
    // iter 123: filter-blend scorch/wound decal cap (params.z, set only for
    // SS_DECAL filter records — textures/decals/hurt02 etc). These are mostly
    // near-white "multiply" textures (white == transparent) with a dark wound
    // body. Two failure modes turn them into opaque BLACK quads under WebGPU-
    // primary: (a) the ~0.92 white surround multiplies down to black when many
    // overlapping wound projections stack, and (b) when the material covers a
    // whole damaged model the dark wound body (~0.18) multiplies the surface to
    // ~black. Fix both: lift the near-white surround to pure 1.0 (truly
    // transparent, no compounding), then FLOOR the result so the multiply can
    // never drive the surface below ~0.4 (a wound darkens, but never to black).
    if (u.params.z > 0.5) {
        // Lift the near-white "transparent" surround to pure 1.0 (no multiply
        // compounding), then FLOOR the result high enough that the dark wound
        // body can only darken the surface to ~0.75 — a visible damage flash,
        // never a black-out. (0.4 was too dark on a dim display.)
        let mx = max(texColor.r, max(texColor.g, texColor.b));
        let lifted = mix(texColor.rgb, vec3<f32>(1.0), smoothstep(0.55, 0.9, mx));
        texColor = vec4<f32>(max(lifted, vec3<f32>(0.75)), texColor.a);
    }
    return texColor * u.tint * vc;
}
