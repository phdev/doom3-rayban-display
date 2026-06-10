// haze.wgsl — heat-haze / screen-distortion new-stage echo (iter 16).
//
// Replicates glprogs/heatHaze.vfp, heatHazeWithMask.vfp and
// heatHazeWithMaskAndVertex.vfp (the variant mars_city1's materials use).
// The ARB program samples _currentRender (a copy of the framebuffer taken
// just before post-process surfaces draw) at screen coordinates deflected
// by a scrolled normal map:
//
//   deflection = min(proj_m00 / max(clipW, 1), 0.02) * magnitude   (per vertex)
//   offset.xy  = (normal*2-1).xy * maskTerm.xy * deflection.xy     (per fragment)
//   color      = currentRender[saturate(screenUV + offset)]
//
// Differences from the ARB text, on purpose:
//  - The normal map reads X from RGB, not alpha: the engine CPU image cache
//    feeding WebGPU holds PRE-rxgb-swap standard RGB normals (the DXT5-NM
//    alpha swizzle happens at GL upload, which we bypass).
//  - screenUV comes from @builtin(position)/canvasSize (already perspective-
//    divided), replacing fragment.position * env[1]; env[0]'s NPOT adjust is
//    1.0 here (the copy target matches the canvas exactly).
//  - proj_m00/max(w,1) assumes a symmetric frustum (proj[2][0]==0), true for
//    all DOOM 3 player views; haze inside subviews is dropped at capture.
//
// Bindings: uniform(128B) + sampler + _currentRender copy + normal + mask.

struct HazeUniforms {
    mvp: mat4x4<f32>,
    scroll: vec4<f32>,       // vertexParm 0 (evaluated at capture)
    magnitude: vec4<f32>,    // vertexParm 1 (evaluated at capture)
    // params: x = projectionMatrix[0] (m00), y = hasMask (0/1),
    //         z = canvas width px, w = canvas height px
    params: vec4<f32>,
    // params2: x = modulate mask by vertex color (0/1); yzw unused
    params2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: HazeUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texRender: texture_2d<f32>;
@group(0) @binding(3) var texNormal: texture_2d<f32>;
@group(0) @binding(4) var texMask: texture_2d<f32>;

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
    @location(0) uv_mask: vec2<f32>,      // unscrolled (mask lookup)
    @location(1) uv_normal: vec2<f32>,    // scrolled (normal lookup)
    @location(2) deflect: vec2<f32>,      // projection-scaled magnitude
    @location(3) vertex_color: vec4<f32>,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    // GL clip-z [-w,w] -> WebGPU [0,w]
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);
    out.uv_mask = in.texcoord;
    out.uv_normal = in.texcoord + u.scroll.xy;
    // heatHaze.vfp: scale magnitude by projected size of one world unit,
    // clamped so deformation doesn't go wild near the view plane.
    let d = min(u.params.x / max(cp.w, 1.0), 0.02);
    out.deflect = vec2<f32>(d * u.magnitude.x, d * u.magnitude.y);
    out.vertex_color = in.color;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    // Sample everything before the discard (keeps control flow uniform for
    // the derivative-based samples).
    let maskTex = textureSample(texMask, samp, in.uv_mask);
    let nrm = textureSample(texNormal, samp, in.uv_normal);

    let hasMask = u.params.y > 0.5;
    let vc = select(vec4<f32>(1.0), in.vertex_color, u.params2.x > 0.5);
    // heatHazeWithMask: mask.xy = mask.xy [* vertexColor.xy] - 0.01; KIL on <0
    var m = vec2<f32>(1.0, 1.0);
    if (hasMask) {
        m = maskTex.xy * vc.xy - vec2<f32>(0.01, 0.01);
    }

    var n = nrm.xyz * 2.0 - 1.0;           // RGB normal (pre-rxgb cache)
    let offset = n.xy * m * in.deflect;

    var suv = in.clip_pos.xy / vec2<f32>(u.params.z, u.params.w);
    // half-texel inset: the shared sampler is REPEAT (the normal map
    // scrolls), so keep filter taps off the copy's wrap-around border
    let inset = vec2<f32>(0.5, 0.5) / vec2<f32>(u.params.z, u.params.w);
    suv = clamp(suv + offset, inset, vec2<f32>(1.0, 1.0) - inset);
    let scene = textureSampleLevel(texRender, samp, suv, 0.0);

    if (hasMask && (m.x < 0.0 || m.y < 0.0)) {
        discard;
    }
    return vec4<f32>(scene.rgb, 1.0);
}
