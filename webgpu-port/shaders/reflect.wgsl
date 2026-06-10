// reflect.wgsl — TG_REFLECT_CUBE environment mapping.
//
// GL used fixed-function GL_REFLECTION_MAP (eye-space reflection of the
// per-vertex normal) with the texture matrix set to the transposed view
// rotation, rotating the eye-space reflection into world axes for the cube
// lookup. Same math here, per fragment.

struct Uniforms {
    mvp:        mat4x4<f32>,
    model_view: mat4x4<f32>,   // model -> eye
    inv_view0:  vec4<f32>,     // rows of transpose(view rotation)
    inv_view1:  vec4<f32>,
    inv_view2:  vec4<f32>,
    tint:       vec4<f32>,
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
};

struct VSOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) n_eye: vec3<f32>,
    @location(1) p_eye: vec3<f32>,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    out.n_eye = (u.model_view * vec4<f32>(in.normal, 0.0)).xyz;
    out.p_eye = (u.model_view * vec4<f32>(in.position, 1.0)).xyz;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let n = normalize(in.n_eye);
    let v = normalize(in.p_eye);
    let r = reflect(v, n);
    let dir = vec3<f32>(dot(u.inv_view0.xyz, r),
                        dot(u.inv_view1.xyz, r),
                        dot(u.inv_view2.xyz, r));
    return textureSample(tcube, samp, dir) * u.tint;
}
