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
    out.clip_pos = u.mvp * vec4<f32>(in.position, 1.0);
    out.uv = in.texcoord;
    out.vertex_color = in.color;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return textureSample(tex, samp, in.uv) * u.tint * in.vertex_color;
}
