// depth.wgsl — z-fill / depth-only pass.
//
// Source: RBDOOM-3-BFG neo/shaders/builtin/depth.{vs,ps}.hlsl
// Used for: depth prepass, shadow generation, anything that just needs
// the depth value written without color output.
//
// Bindings:
//   @group(0) @binding(0) uniforms (just MVP)
//   No textures or samplers needed.
//
// Vertex format: idDrawVert (60 bytes), but only position is read.

struct Uniforms {
    mvp: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

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
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    // GL [-w, w] → WebGPU [0, w] clip-z remap. MUST match interaction.wgsl
    // exactly — the depth pre-pass and the lit pass need bit-identical
    // positions or the LessEqual test rejects lit fragments.
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    return out;
}

@fragment
fn fs_main(_in: VSOut) {
    // Empty fragment — depth-only. The render pipeline must have NO
    // color target (idGpuPipelineDesc.hasColorTarget = false) and a
    // depth attachment with depthWriteEnabled = true.
}
