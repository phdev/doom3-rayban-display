// interaction.wgsl — DOOM 3 lit-pass shader, WGSL hand-port.
//
// Sources:
//   - RBDOOM-3-BFG: neo/shaders/builtin/lighting/interaction.{vs,ps}.hlsl
//     (the legacy non-PBR path; #if USE_PBR / KENNY_PBR branches stripped)
//   - DrBeef/Doom3Quest: renderer/glsl/interactionShaderFP.cpp (validated
//     against the wall.cpp Phase 3 render on iPhone)
//
// Vertex format: idDrawVert (60 bytes — defined in tr_local.h, matches the
// vertex layout RenderBackend_WebGPU::CreatePipeline assumes).
//
// Bindings (matches abstraction convention):
//   @group(0) @binding(0)  uniforms (Uniforms struct below)
//   @group(0) @binding(1)  s_material   sampler
//   @group(0) @binding(2)  s_lighting   sampler
//   @group(0) @binding(3)  t_normal       Texture2D  (bump map, DXT5-NM)
//   @group(0) @binding(4)  t_specular     Texture2D
//   @group(0) @binding(5)  t_diffuse      Texture2D
//   @group(0) @binding(6)  t_lightFalloff Texture2D
//   @group(0) @binding(7)  t_lightProj    Texture2D
//
// Crucially: NO cubemap. The cubemap detour in the original ARB program was
// for old fixed-function GPUs that lacked fast normalize(). We compute L
// directly from the per-vertex tangent-space light direction varying, which
// also sidesteps the Apple-Silicon cubemap gradient bug (SPIRV-Cross
// commit 7ef52b0) that's been documented as a likely contributor to the
// chunky-tile artifact on iOS Safari WebGL.

struct Uniforms {
    mvp:                  mat4x4<f32>,
    light_origin_tangent: vec4<f32>,   // tangent-space light pos (.xyz) + 1 (.w)
    view_origin_tangent:  vec4<f32>,
    diffuse_color:        vec4<f32>,   // material diffuseColor (Env_0)
    specular_color:       vec4<f32>,   // material specularColor (Env_1)
    light_proj_s:         vec4<f32>,   // light projection texgen S
    light_proj_t:         vec4<f32>,
    light_proj_q:         vec4<f32>,
    light_falloff_s:      vec4<f32>,   // light falloff texgen S
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var s_material: sampler;
@group(0) @binding(2) var s_lighting: sampler;
@group(0) @binding(3) var t_normal: texture_2d<f32>;
@group(0) @binding(4) var t_specular: texture_2d<f32>;
@group(0) @binding(5) var t_diffuse: texture_2d<f32>;
@group(0) @binding(6) var t_lightFalloff: texture_2d<f32>;
@group(0) @binding(7) var t_lightProj: texture_2d<f32>;

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
    @location(0) tex_bump:       vec2<f32>,
    @location(1) tex_diffuse:    vec2<f32>,
    @location(2) tex_specular:   vec2<f32>,
    @location(3) light_tangent:  vec3<f32>,
    @location(4) view_tangent:   vec3<f32>,
    @location(5) light_proj_uvw: vec3<f32>,   // projection cookie uv + perspective w
    @location(6) light_falloff_u: f32,
    @location(7) vertex_color:   vec4<f32>,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let cp = u.mvp * vec4<f32>(in.position, 1.0);
    // DOOM 3 (OpenGL) projection produces clip-z in [-w, w]. WebGPU clip-z is
    // [0, w]. Remap so anything with GL clip-z >= 0 ends up in WebGPU's
    // visible range. Without this, ~half the geometry gets near-plane-clipped
    // and the canvas is black.
    out.clip_pos = vec4<f32>(cp.x, cp.y, (cp.z + cp.w) * 0.5, cp.w);

    // Tangent-space TBN. The engine pre-computes tangent + bitangent per
    // vertex; we use them directly.
    let TBN = mat3x3<f32>(in.tangent, in.bitangent, in.normal);

    // Light + view direction in tangent space (multiply object→tangent).
    let light_obj = u.light_origin_tangent.xyz - in.position;
    let view_obj  = u.view_origin_tangent.xyz  - in.position;
    out.light_tangent = light_obj * TBN;
    out.view_tangent  = view_obj * TBN;

    // Texgen for light projection cookie + falloff
    let pos4 = vec4<f32>(in.position, 1.0);
    out.light_proj_uvw = vec3<f32>(
        dot(pos4, u.light_proj_s),
        dot(pos4, u.light_proj_t),
        dot(pos4, u.light_proj_q),
    );
    out.light_falloff_u = dot(pos4, u.light_falloff_s);

    out.tex_bump     = in.texcoord;
    out.tex_diffuse  = in.texcoord;
    out.tex_specular = in.texcoord;
    out.vertex_color = in.color;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    // Normalize L and H in tangent space
    let L = normalize(in.light_tangent);
    let V = normalize(in.view_tangent);
    let H = normalize(L + V);

    // Normal map: DXT5-NM has X in alpha, Y in green. Z derived.
    let nm = textureSample(t_normal, s_material, in.tex_bump);
    var N = vec3<f32>(nm.a, nm.g, 0.0) * 2.0 - vec3<f32>(1.0, 1.0, 0.0);
    N.z = sqrt(max(0.0, 1.0 - dot(N.xy, N.xy)));

    let NdotL = clamp(dot(N, L), 0.0, 1.0);
    let NdotH = clamp(dot(N, H), 0.0, 1.0);

    // Light projection cookie (perspective-corrected projection)
    let proj_uv = in.light_proj_uvw.xy / max(in.light_proj_uvw.z, 0.001);
    let light_proj_color = textureSample(t_lightProj, s_lighting, proj_uv).rgb;
    let light_falloff = textureSample(t_lightFalloff, s_lighting,
                                       vec2<f32>(in.light_falloff_u, 0.5)).a;

    // Material lookups
    let diffuse = textureSample(t_diffuse, s_material, in.tex_diffuse).rgb
                  * u.diffuse_color.rgb;
    let spec = textureSample(t_specular, s_material, in.tex_specular).rgb
               * u.specular_color.rgb;

    // Phong specular (pow 12 to match the engine's interaction.vfp default)
    let specFalloff = pow(NdotH, 12.0);

    let color = (diffuse + specFalloff * spec)
                * NdotL
                * light_proj_color
                * light_falloff;

    // NOTE: deliberately NOT multiplied by vertex_color. DOOM 3 interactions
    // default to SVC_IGNORE (color modulate=0, add=1 → vertex color unused),
    // and world geometry often carries black vertex colors — multiplying
    // would zero the whole lit pass. Proper modulate/add support comes with
    // real material capture.
    return vec4<f32>(color, 1.0);
}
