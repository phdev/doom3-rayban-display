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
// Bindings (split into two groups so per-record uniforms and per-material
// texture sets can be cached and rebound independently — group(0) is one
// fixed bind group per record slot, group(1) is cached per unique
// 5-texture tuple):
//   @group(0) @binding(0)  uniforms (Uniforms struct below)
//   @group(1) @binding(0)  s_material   sampler
//   @group(1) @binding(1)  s_lighting   sampler
//   @group(1) @binding(2)  t_normal       Texture2D  (tangent-space RGB)
//   @group(1) @binding(3)  t_specular     Texture2D
//   @group(1) @binding(4)  t_diffuse      Texture2D
//   @group(1) @binding(5)  t_lightFalloff Texture2D
//   @group(1) @binding(6)  t_lightProj    Texture2D
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
    // Iter 8a fidelity params:
    //   params.x = isAmbient (1 = ambient light: N·L term forced to 1, no spec)
    //   params.y = vertex color modulate (SVC: 0 ignore, 1 modulate, -1 inverse)
    //   params.z = vertex color add      (1 for ignore/inverse, 0 for modulate)
    //   params.w = r_brightness
    //   params2.x = 1 / r_gamma
    params:               vec4<f32>,
    params2:              vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var s_material: sampler;
@group(1) @binding(1) var s_lighting: sampler;
@group(1) @binding(2) var t_normal: texture_2d<f32>;
@group(1) @binding(3) var t_specular: texture_2d<f32>;
@group(1) @binding(4) var t_diffuse: texture_2d<f32>;
@group(1) @binding(5) var t_lightFalloff: texture_2d<f32>;
@group(1) @binding(6) var t_lightProj: texture_2d<f32>;

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

    // Normal map: standard tangent-space RGB encoding (XYZ in RGB). The
    // engine's CPU image cache captures normal maps BEFORE the rxgb
    // red↔alpha swap in GenerateImage, so RGB is the right decode here
    // (NOT DXT5-NM alpha/green). Normalize to absorb 8-bit quantization.
    let nm = textureSample(t_normal, s_material, in.tex_bump);
    let N = normalize(nm.rgb * 2.0 - vec3<f32>(1.0, 1.0, 1.0));

    // Ambient lights have no meaningful direction: the engine renders them
    // with a flat "ambient normal map" so the N·L term is ~constant. Force
    // the diffuse term to 1 and kill specular for them.
    let is_ambient = u.params.x > 0.5;
    var NdotL = clamp(dot(N, L), 0.0, 1.0);
    var NdotH = clamp(dot(N, H), 0.0, 1.0);
    if (is_ambient) {
        NdotL = 1.0;
        NdotH = 0.0;
    }

    // Light projection cookie (perspective-corrected projection)
    let proj_uv = in.light_proj_uvw.xy / max(in.light_proj_uvw.z, 0.001);
    let light_proj_color = textureSample(t_lightProj, s_lighting, proj_uv).rgb;
    // Falloff ramp: vanilla interaction.vfp does `MUL light, light, falloff`
    // with the full RGBA sample — the ramp lives in RGB (TGA / makeintensity
    // images replicate intensity across channels). Sampling .a here was a
    // GL4ES-on-WebKit artifact, not the engine convention.
    let light_falloff = textureSample(t_lightFalloff, s_lighting,
                                       vec2<f32>(in.light_falloff_u, 0.5)).rgb;

    // Material lookups
    let diffuse = textureSample(t_diffuse, s_material, in.tex_diffuse).rgb
                  * u.diffuse_color.rgb;
    let spec = textureSample(t_specular, s_material, in.tex_specular).rgb
               * u.specular_color.rgb;

    // Phong specular approximating the engine's specular lookup table;
    // vanilla also doubles the specular map (ADD R2, R2, R2).
    let specFalloff = pow(NdotH, 12.0);

    var color = (diffuse + specFalloff * spec * 2.0)
                * NdotL
                * light_proj_color
                * light_falloff;

    // Vertex color, engine-style: vc' = vc * modulate + add. SVC_IGNORE is
    // (0, 1) → multiply by 1; SVC_MODULATE (1, 0); SVC_INVERSE (-1, 1).
    let vc = in.vertex_color.rgb * u.params.y + vec3<f32>(u.params.z);
    color = color * vc;

    // Gamma/brightness term matching dhewm3's r_gammaInShader injection.
    color = pow(max(color * u.params.w, vec3<f32>(0.0)), vec3<f32>(u.params2.x));

    return vec4<f32>(color, 1.0);
}
