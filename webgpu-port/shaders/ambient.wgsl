// ambient.wgsl — unlit material pass.
//
// Source: blend of RBDOOM-3-BFG ambientLighting_IBL approach + the
// engine's RB_STD_DrawShaderPasses inner loop semantics. The "ambient
// pass" in DOOM 3 renders any material stages that aren't part of a
// light interaction — emissive geometry, transparency, GUI surfaces,
// fog, etc.
//
// This is the simplest "draw material stage" shader: sample a diffuse
// texture (optionally modulated by vertex color) and output. The
// engine's per-stage state (blend mode, alpha test) is set on the
// pipeline state object, not in the shader.
//
// Bindings:
//   @group(0) @binding(0) uniforms
//   @group(0) @binding(1) sampler
//   @group(0) @binding(2) diffuse texture
//
// Differs from texture.wgsl: ambient supports a texgen matrix (for
// scrolling/animating UVs) and an alpha-test threshold.

struct Uniforms {
    mvp:           mat4x4<f32>,
    color_mod:     vec4<f32>,   // material colorMod (rgba)
    texgen_s:      vec4<f32>,   // ST texgen plane (xyzw → S coordinate)
    texgen_t:      vec4<f32>,
    alpha_test:    vec4<f32>,   // .x = threshold; 0 means no alpha test
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

    // texgen — supports identity (uv = in.texcoord) when texgen_s = (1,0,0,0)
    // texgen_t = (0,1,0,0), or arbitrary plane projection for scrolling.
    let pos4 = vec4<f32>(in.position, 1.0);
    let texgen_identity = abs(u.texgen_s.x - 1.0) + abs(u.texgen_s.y)
                           + abs(u.texgen_t.x) + abs(u.texgen_t.y - 1.0);
    if (texgen_identity < 0.001) {
        out.uv = in.texcoord;
    } else {
        out.uv = vec2<f32>(dot(pos4, u.texgen_s), dot(pos4, u.texgen_t));
    }
    out.vertex_color = in.color;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let sample = textureSample(tex, samp, in.uv);
    let result = sample * u.color_mod * in.vertex_color;
    // Alpha test (DOOM 3 uses alpha test for foliage / fence textures /
    // gun viewmodel transparency)
    if (u.alpha_test.x > 0.0 && result.a < u.alpha_test.x) {
        discard;
    }
    return result;
}
