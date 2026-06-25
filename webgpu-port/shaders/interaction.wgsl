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
    //   params2.y = BFG specular (0 = classic LUT ramp, 1 = pow(N·H,10))
    //   params2.z = zeroClamp projection (1 = cookie is TR_CLAMP_TO_ZERO:
    //               zero light outside the projection's [0,1] uv box —
    //               WebGPU has no border-clamp sampler, and without this
    //               the cookie's edge texels smear across the whole light
    //               volume; see the enpro warm-wash bug)
    params:               vec4<f32>,
    params2:              vec4<f32>,
    // R-IBL (Full PBR look, P0): image-based-lighting params, isPBR-scoped.
    //   ibl.x = enable (1 = this record is isPBR AND r_ibl is on; legacy = 0)
    //   ibl.y = diffuse-irradiance scale (r_iblDiffuseScale, default LOW so a PBR
    //           surface integrates with the near-black world, not a lit decal)
    //   ibl.z = specular-reflection scale (r_iblSpecScale)
    //   ibl.w = max mip count (roughness -> prefiltered-radiance LOD)
    //   ibl2.x = self-test/live mutation flag (r_iblMutate; 1 = corrupt the IBL
    //            term so the operator self-test goes RED — falsifiability hook)
    ibl:                  vec4<f32>,
    ibl2:                 vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var s_material: sampler;
@group(1) @binding(1) var s_lighting: sampler;
@group(1) @binding(2) var t_normal: texture_2d<f32>;
@group(1) @binding(3) var t_specular: texture_2d<f32>;
@group(1) @binding(4) var t_diffuse: texture_2d<f32>;
@group(1) @binding(5) var t_lightFalloff: texture_2d<f32>;
@group(1) @binding(6) var t_lightProj: texture_2d<f32>;
@group(1) @binding(7) var t_specLUT: texture_2d<f32>;

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
    // R-IBL P0: model-space TBN basis + view vector, so the fragment shader can
    // rotate the tangent-space normal map into the probe's space (model space ==
    // world space for static world geometry; the world-accurate transform for
    // moving entities is the P5 join). Only read inside the isPBR IBL branch.
    @location(8)  m_tangent:   vec3<f32>,
    @location(9)  m_bitangent: vec3<f32>,
    @location(10) m_normal:    vec3<f32>,
    @location(11) view_model:  vec3<f32>,
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

    // R-IBL P0: pass the model-space TBN basis + the model-space view vector.
    // (u.view_origin_tangent.xyz is the view origin in MODEL space — it's
    // transformed to tangent space above; here we keep the model-space vector.)
    out.m_tangent   = in.tangent;
    out.m_bitangent = in.bitangent;
    out.m_normal    = in.normal;
    out.view_model  = u.view_origin_tangent.xyz - in.position;
    return out;
}

// R-PBR P0: metallic-roughness GGX/Cook-Torrance direct BRDF (Karis UE4 mobile).
// ORM convention (content-forge §7 contract): albedo = base color, roughness/metallic
// from the ORM pack (G/B), ao from R; F0 = mix(0.04, albedo, metallic). Returns the
// BRDF (diffuse + spec); the caller applies N·L and the light radiance — same outer
// structure as the legacy path, so it slots in where (diffuse + specFalloff*spec*2) was.
// This SAME function is exercised by the fs_pbr_selftest operator gate (no divergence).
const PBR_PI: f32 = 3.14159265;
fn pbr_direct(N: vec3<f32>, L: vec3<f32>, V: vec3<f32>, albedo: vec3<f32>,
              roughness: f32, metallic: f32, ao: f32) -> vec3<f32> {
    let H = normalize(L + V);
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let VdotH = max(dot(V, H), 0.0);
    let a  = max(roughness * roughness, 0.001);
    let a2 = a * a;
    let dterm = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
    let D = a2 / max(PBR_PI * dterm * dterm, 1e-7);                  // Trowbridge-Reitz GGX
    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;            // Smith k (direct lighting)
    let gL = NdotL / (NdotL * (1.0 - k) + k);
    let gV = NdotV / (NdotV * (1.0 - k) + k);
    let G = gL * gV;                                                 // Smith Schlick-GGX
    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    let F = F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - VdotH, 5.0);     // Schlick Fresnel
    let spec = (D * G) * F / max(4.0 * NdotL * NdotV, 1e-4);        // Cook-Torrance
    let kd = (vec3<f32>(1.0) - F) * (1.0 - metallic);
    let diffuse = kd * albedo;                                       // Lambert (un-pi-normalized, engine scale)
    return diffuse * ao + spec;
}

// ============================ R-IBL (Full PBR look) ============================
// Image-based lighting: cosine-convolved diffuse-irradiance ambient + Karis
// split-sum specular reflections, evaluated INSIDE fs_main's PBR branch and summed
// into the float color register BEFORE the gamma/clamp store (no separate 8-bit
// pass — direct + IBL share one clamp point). isPBR-scoped, so the legacy near-black
// DOOM 3 world is byte-identical (ibl.x is 0 for legacy records by construction).
//
// SOLO PROBE: the irradiance/radiance below are SYNTHETIC + procedural (directionally
// varying so the N-space / reflection mutations are non-vacuous). This proves the IBL
// MATH on Dawn with no content cubes. The real per-area cube probes (sampled by N/R)
// are the P5 content-forge join; ibl_ambient() is format-agnostic — swap synth_* for a
// textureSampleLevel(cube,...) and the math is unchanged.

// Hemispherical-gradient irradiance: warm sky (+Z, intentionally >1 in B to exercise
// the float accumulation) fading to a dim ground (-Z). Directional by construction.
fn synth_irradiance(N: vec3<f32>) -> vec3<f32> {
    let t = clamp(N.z * 0.5 + 0.5, 0.0, 1.0);
    let sky    = vec3<f32>(0.55, 0.70, 1.05);
    let ground = vec3<f32>(0.12, 0.10, 0.09);
    return mix(ground, sky, t);
}
// Single-lobe radiance: a bright directional lobe + dim fill; mip (roughness) widens
// and dims the lobe (prefilter stand-in). Reflection-direction dependent by construction.
fn synth_radiance(R: vec3<f32>, mip: f32) -> vec3<f32> {
    let lobe  = normalize(vec3<f32>(0.30, 0.40, 0.85));
    let sharp = max(64.0 / (mip + 1.0), 1.0);
    let hi    = pow(max(dot(normalize(R), lobe), 0.0), sharp);
    let fill  = vec3<f32>(0.10, 0.12, 0.16);
    return fill + vec3<f32>(1.40, 1.25, 0.95) * hi;
}
// Karis 2013 mobile analytic env-BRDF (no LUT): returns (scale, bias) applied to F0.
fn env_brdf_approx(roughness: f32, NoV: f32) -> vec2<f32> {
    let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4<f32>( 1.0,  0.0425,  1.04, -0.04);
    let r  = roughness * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
    return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}
// Combined diffuse + specular IBL ambient (float, pre-clamp). irr/pref come from the
// probe (synthetic now; cube at P5). dScale/sScale are the per-record intensity knobs.
fn ibl_ambient(N: vec3<f32>, V: vec3<f32>, R: vec3<f32>, albedo: vec3<f32>,
               roughness: f32, metallic: f32, ao: f32,
               irr: vec3<f32>, pref: vec3<f32>, dScale: f32, sScale: f32) -> vec3<f32> {
    let NoV = max(dot(N, V), 1e-4);
    let F0  = mix(vec3<f32>(0.04), albedo, metallic);
    // roughness-aware Fresnel (Lagarde) so rough dielectrics don't over-reflect at grazing
    let F_rough = F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(1.0 - NoV, 5.0);
    let kd = (vec3<f32>(1.0) - F_rough) * (1.0 - metallic);
    let diffuseIBL = irr * albedo * ao * kd * dScale;
    let sb = env_brdf_approx(roughness, NoV);
    var horizon = clamp(1.0 + dot(R, N), 0.0, 1.0);   // suppress below-surface leak
    horizon = horizon * horizon;
    let specIBL = pref * (F0 * sb.x + sb.y) * ao * horizon * sScale;
    return diffuseIBL + specIBL;
}

// R-PBR P0 operator gate: a fullscreen self-test that drives the REAL pbr_direct with
// two known configs (left half = dielectric/diffuse-dominant; right half = metal/spec)
// packed in the uniforms, so a CPU reference can byte-compare. vs_fs_main = the same
// bufferless fullscreen triangle the bloom/tonemap passes use.
@vertex
fn vs_fs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    return vec4<f32>(p[vi], 0.0, 1.0);
}
@fragment
fn fs_pbr_selftest(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
    // Config A (left): N/rough = light_origin_tangent, L/metal = view_origin_tangent,
    //   V/ao = diffuse_color, albedo = specular_color.xyz.
    // Config B (right): N/rough = light_proj_s, L/metal = light_proj_t,
    //   V/ao = light_proj_q, albedo = light_falloff_s.xyz.
    var N: vec3<f32>; var L: vec3<f32>; var V: vec3<f32>; var albedo: vec3<f32>;
    var rough: f32; var metal: f32; var ao: f32;
    if (fc.x < 128.0) {
        N = u.light_origin_tangent.xyz; rough = u.light_origin_tangent.w;
        L = u.view_origin_tangent.xyz;  metal = u.view_origin_tangent.w;
        V = u.diffuse_color.xyz;        ao = u.diffuse_color.w;
        albedo = u.specular_color.xyz;
    } else {
        N = u.light_proj_s.xyz; rough = u.light_proj_s.w;
        L = u.light_proj_t.xyz; metal = u.light_proj_t.w;
        V = u.light_proj_q.xyz; ao = u.light_proj_q.w;
        albedo = u.light_falloff_s.xyz;
    }
    let brdf = pbr_direct(normalize(N), normalize(L), normalize(V), albedo, rough, metal, ao);
    return vec4<f32>(brdf, 1.0);
}

// R-IBL operator gate: drives the REAL ibl_ambient + synth probe with two known configs
// (left = dielectric, right = metal) packed in the uniforms, so a CPU mirror byte-compares.
// Config A (fc.x<128): N/rough=light_origin_tangent, V/metal=view_origin_tangent, albedo/ao=diffuse_color.
// Config B: N/rough=light_proj_s, V/metal=light_proj_t, albedo/ao=light_proj_q. ibl.{y,z,w}=dScale,sScale,maxMip.
@fragment
fn fs_ibl_selftest(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
    var N: vec3<f32>; var V: vec3<f32>; var albedo: vec3<f32>;
    var rough: f32; var metal: f32; var ao: f32;
    if (fc.x < 128.0) {
        N = u.light_origin_tangent.xyz; rough = u.light_origin_tangent.w;
        V = u.view_origin_tangent.xyz;  metal = u.view_origin_tangent.w;
        albedo = u.diffuse_color.xyz;   ao = u.diffuse_color.w;
    } else {
        N = u.light_proj_s.xyz; rough = u.light_proj_s.w;
        V = u.light_proj_t.xyz; metal = u.light_proj_t.w;
        albedo = u.light_proj_q.xyz; ao = u.light_proj_q.w;
    }
    let Nn = normalize(N);
    let Vn = normalize(V);
    let R  = reflect(-Vn, Nn);
    let maxMip = max(u.ibl.w, 1.0);
    let irr  = synth_irradiance(Nn);
    let pref = synth_radiance(R, rough * (maxMip - 1.0));
    var term = ibl_ambient(Nn, Vn, R, albedo, rough, metal, ao, irr, pref, u.ibl.y, u.ibl.z);
    if (u.ibl2.x > 0.5) { term = term * 0.5; }   // falsifiability mutation (CPU mirror stays correct -> RED)
    return vec4<f32>(term, 1.0);
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

    // Light projection cookie (perspective-corrected projection).
    //
    // Iter 71 (enpro orange-panel fix): light_proj_uvw and light_falloff_u are
    // INTERPOLATED attributes. On WebKit, geometry that crosses the near plane
    // / has projective w~0 interpolates these differently than Dawn and they
    // can blow up to inf/NaN — the documented iter 47b near-plane pathology
    // (the same WebKit-only-orange-warm-wash class). The original mask used
    // step() and sampled the cookie at the RAW proj_uv; both are unsafe:
    //   * step()/min/max/clamp PASS NaN THROUGH on Apple GPUs, so a NaN proj_uv
    //     can flip the in-frustum mask to 1 and un-mask the cookie — and the
    //     cookie carries the LIGHT COLOR (the orange squarelight1 lights), which
    //     is exactly the bright-orange-where-it-should-be-black symptom;
    //   * an inf/NaN uv can sample the bright cookie interior.
    // Fix, per the iter 47b law (clamp AND NaN-guard anything derived from an
    // interpolated attribute; comparisons are FALSE for NaN and select() does
    // not pass NaN, unlike step/min/max):
    //   1. build the in-frustum mask from ordered comparisons + select(), so a
    //      non-finite fragment is masked OFF;
    //   2. feed the sampler a finite, [0,1]-clamped uv.
    // For all FINITE inputs this is byte-identical to the old step() mask
    // (Dawn/GL never produce the NaN), so it cannot regress those backends.
    // params2.w = 1 (debug A/B) restores the raw step()+unclamped path.
    let pz = in.light_proj_uvw.z;
    let proj_uv = in.light_proj_uvw.xy / max(pz, 0.001);
    let fix_on = u.params2.w < 0.5;
    let proj_finite = proj_uv.x == proj_uv.x && proj_uv.y == proj_uv.y; // false for NaN
    let in_frustum = proj_finite && pz >= 0.0001
                  && proj_uv.x >= 0.0 && proj_uv.x <= 1.0
                  && proj_uv.y >= 0.0 && proj_uv.y <= 1.0;
    let zc_in_fixed = select(0.0, 1.0, in_frustum);
    let zc_in_raw   = step(0.0, proj_uv.x) * step(proj_uv.x, 1.0)
                    * step(0.0, proj_uv.y) * step(proj_uv.y, 1.0)
                    * step(0.0001, pz);
    let zc_in = select(zc_in_raw, zc_in_fixed, fix_on);
    // Finite, clamped uv when the fix is on (2.0 on NaN -> sampler clamps to the
    // dark cookie edge, and zc_in has already masked it off anyway).
    let puv_fixed = select(vec2<f32>(2.0, 2.0),
                           clamp(proj_uv, vec2<f32>(0.0), vec2<f32>(1.0)), proj_finite);
    let puv = select(proj_uv, puv_fixed, fix_on);
    var light_proj_color = textureSample(t_lightProj, s_lighting, puv).rgb;
    // zeroClamp emulation (params2.z): vanilla GL gives these cookies a black
    // border + border-clamp sampler, so the light is ZERO outside its frustum
    // (and behind the light, w<=0). Mask explicitly.
    light_proj_color = light_proj_color * mix(1.0, zc_in, u.params2.z);

    // Axial falloff ramp: vanilla interaction.vfp does `MUL light, light,
    // falloff` with the full RGBA sample — the ramp lives in RGB (TGA /
    // makeintensity images replicate intensity across channels). Sampling .a
    // here was a GL4ES-on-WebKit artifact, not the engine convention.
    //
    // Same iter 71 guard: a panel straddling the light box has falloff_u
    // outside [0,1] on its outside vertices; clamping the COORDINATE reads the
    // DARK falloff edge (bounds the light axially), and a NaN-safe select reads
    // the dark edge rather than the bright center for a non-finite falloff_u.
    // No-op where the sampler already clamps a finite coord (Dawn/GL).
    let fo_finite = in.light_falloff_u == in.light_falloff_u;
    let fo_clamped = select(2.0, clamp(in.light_falloff_u, 0.0, 1.0), fo_finite);
    let fo_u = select(in.light_falloff_u, fo_clamped, fix_on);
    let light_falloff = textureSample(t_lightFalloff, s_lighting,
                                       vec2<f32>(fo_u, 0.5)).rgb;

    // Material lookups
    let diffuse = textureSample(t_diffuse, s_material, in.tex_diffuse).rgb
                  * u.diffuse_color.rgb;
    let tspec = textureSample(t_specular, s_material, in.tex_specular).rgb;

    // R-PBR P0: per-record isPBR flag in the (otherwise unused) specular_color.w
    // (§7 contract). When set, t_specular is the LINEAR ORM pack (R=AO,G=rough,B=metal)
    // and the BRDF term is GGX; otherwise the legacy Blinn-Phong path runs VERBATIM
    // (the OFF-identity guarantee — legacy materials are byte-identical, .w defaults 0).
    // specular_color.w is a per-record uniform -> uniform control flow -> the branch +
    // the textureSample inside the else are legal.
    var brdfTerm: vec3<f32>;
    var iblTerm = vec3<f32>(0.0);
    if (u.specular_color.w > 0.5) {
        // ORM from the LINEAR specular map (R=AO,G=rough,B=metal); OR, for the
        // r_pbrTest synthetic material (w==2), constant rough/metal/ao packed in
        // specular_color.xyz so PBR is visibly demonstrable before content's ORM lands.
        var rough = tspec.g; var metal = tspec.b; var aov = tspec.r;
        if (u.specular_color.w > 1.5) {
            rough = u.specular_color.x; metal = u.specular_color.y; aov = u.specular_color.z;
        }
        brdfTerm = pbr_direct(N, L, V, diffuse, rough, metal, aov);
        // R-IBL (isPBR-only): rotate the tangent-space normal map into the probe's
        // (model) space via the model-space TBN, derive the model-space view +
        // reflection vectors, sample the (synthetic) probe, accumulate ambient.
        if (u.ibl.x > 0.5) {
            let TBNm = mat3x3<f32>(normalize(in.m_tangent),
                                   normalize(in.m_bitangent),
                                   normalize(in.m_normal));
            let N_ibl = normalize(TBNm * N);
            let V_ibl = normalize(in.view_model);
            let R_ibl = reflect(-V_ibl, N_ibl);
            let maxMip = max(u.ibl.w, 1.0);
            let irr  = synth_irradiance(N_ibl);
            let pref = synth_radiance(R_ibl, rough * (maxMip - 1.0));
            iblTerm = ibl_ambient(N_ibl, V_ibl, R_ibl, diffuse, rough, metal, aov,
                                  irr, pref, u.ibl.y, u.ibl.z);
            if (u.ibl2.x > 0.5) { iblTerm = iblTerm * 0.5; }   // falsifiability mutation
        }
    } else {
        let spec = tspec * u.specular_color.rgb;
        // Specular falloff, two modes (iter 29):
        //  - classic (params2.y = 0): dependent read of the engine's baked
        //    specular table — zero below N·H 0.75, then (4(x-0.75))².
        //  - BFG (params2.y = 1): analytic pow(N·H, 10).
        // Vanilla also doubles the specular map (ADD R2, R2, R2) — both modes.
        let specLUT = textureSample(t_specLUT, s_lighting, vec2<f32>(NdotH, 0.5)).r;
        let specBFG = pow(NdotH, 10.0);
        let specFalloff = mix(specLUT, specBFG, u.params2.y);
        brdfTerm = diffuse + specFalloff * spec * 2.0;
    }

    var color = brdfTerm
                * NdotL
                * light_proj_color
                * light_falloff;
    // R-IBL: ambient irradiance + specular reflection, added in float registers
    // BEFORE the gamma/clamp store so direct + IBL share one 8-bit clamp point
    // (no inter-pass re-quantize). Zero for legacy (ibl.x==0) -> OFF-identity.
    color = color + iblTerm;

    // Vertex color, engine-style: vc' = vc * modulate + add. SVC_IGNORE is
    // (0, 1) → multiply by 1; SVC_MODULATE (1, 0); SVC_INVERSE (-1, 1).
    let vc = in.vertex_color.rgb * u.params.y + vec3<f32>(u.params.z);
    color = color * vc;

    // Gamma/brightness term matching dhewm3's r_gammaInShader injection.
    color = pow(max(color * u.params.w, vec3<f32>(0.0)), vec3<f32>(u.params2.x));

    return vec4<f32>(color, 1.0);
}
