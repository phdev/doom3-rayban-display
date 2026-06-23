// R-MBLUR: camera motion blur via DEPTH RECONSTRUCTION (fullscreen post-pass,
// after tonemap / before GUI). Reconstruct each pixel's world position from the
// depth buffer + the inverse current view-projection, reproject it through the
// PREVIOUS frame's view-projection, and blur the composited scene copy along the
// resulting screen-space velocity. Deterministic (cur/prev VP are fixed per
// frame) -> __d3WgpuDet-safe, like the R0 tonemap pass. Camera-only (no per-object
// velocity buffer): the mobile-friendly variant.
//
// Conventions (the convention pitfalls the review flagged):
//  - depth is the WebGPU depth buffer value [0,1]; the port's vertex shaders store
//    z' = (glClipZ + w)/2, so GL NDC z = 2*d - 1.
//  - framebuffer uv is y-down; GL NDC is y-up -> ndc.y = 1 - 2*uv.y.
//  - invCurVP / prevVP are the GL-convention (column-major) view-projections.
//  - textureSampleLevel (not textureSample) so sampling is legal under the
//    conditional early-outs (no implicit-derivative uniform-control-flow rule).

struct MB {
  invCurVP    : mat4x4<f32>,
  prevVP      : mat4x4<f32>,
  screenSize  : vec2<f32>,
  scale       : f32,
  maxOffsetPx : f32,
  samples     : f32,
  zeroVel     : f32,
  selfTest    : f32,   // P4 operator gate: reconstruct velocity for (testUv,testDepth) -> output it
  testDepth   : f32,
  testUv      : vec2<f32>,
  minDepth    : f32,   // view-weapon exclusion: skip blur where depth < minDepth (0 = off)
  pad         : f32,
};
@group(0) @binding(0) var<uniform> u : MB;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var sceneSamp : sampler;
@group(0) @binding(3) var depthTex : texture_depth_2d;

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fc : vec4<f32>) -> @location(0) vec4<f32> {
  // P4 operator self-test: reconstruct the screen velocity for a synthetic
  // (testUv, testDepth) from the UB matrices and output it ENCODED in [0,1]
  // (R = vx, G = vy, ±128 px range). The CPU compares against a forward-projection
  // ground truth -> proves the unproject/reproject + clip-z/Y-flip conventions.
  // P4 identity self-test (selfTest==3): blur a KNOWN sceneTex using a CONTROLLED
  // depth (testDepth) — independent of the live depth buffer. zeroVel/scale=0 must
  // return the scene EXACTLY (identity); otherwise the blur must CHANGE the image
  // (the mutation arm) -> proves the disable path is a true no-op, not vacuous.
  if (u.selfTest > 2.5) {
    let uvI = fc.xy / u.screenSize;
    let sceneI = textureSampleLevel(sceneTex, sceneSamp, uvI, 0.0);
    if (u.zeroVel > 0.5 || u.scale < 0.01) { return sceneI; }
    let ndcI = vec3<f32>(uvI.x * 2.0 - 1.0, 1.0 - uvI.y * 2.0, 2.0 * u.testDepth - 1.0);
    let wHI = u.invCurVP * vec4<f32>(ndcI, 1.0);
    let worldI = wHI.xyz / wHI.w;
    let pHI = u.prevVP * vec4<f32>(worldI, 1.0);
    let pUvI = vec2<f32>(pHI.x / pHI.w * 0.5 + 0.5, 0.5 - pHI.y / pHI.w * 0.5);
    let velUvI = (uvI - pUvI) * u.scale;
    let cntI = max(2, i32(u.samples));
    var accI = vec4<f32>(0.0);
    for (var i = 0; i < cntI; i = i + 1) {
      let t = (f32(i) / (f32(cntI) - 1.0)) - 0.5;
      accI = accI + textureSampleLevel(sceneTex, sceneSamp, uvI + velUvI * t, 0.0);
    }
    return accI / f32(cntI);
  }
  if (u.selfTest > 0.5) {
    let uvT = u.testUv;
    let ndcT = vec3<f32>(uvT.x * 2.0 - 1.0, 1.0 - uvT.y * 2.0, 2.0 * u.testDepth - 1.0);
    let wHt = u.invCurVP * vec4<f32>(ndcT, 1.0);
    let worldT = wHt.xyz / wHt.w;
    let pHt = u.prevVP * vec4<f32>(worldT, 1.0);
    let pUvT = vec2<f32>(pHt.x / pHt.w * 0.5 + 0.5, 0.5 - pHt.y / pHt.w * 0.5);
    let velT = (uvT - pUvT) * u.screenSize;
    return vec4<f32>(velT.x * (1.0 / 256.0) + 0.5, velT.y * (1.0 / 256.0) + 0.5, 0.0, 1.0);
  }
  let uv = fc.xy / u.screenSize;                                  // [0,1], framebuffer (y-down)
  let scene = textureSampleLevel(sceneTex, sceneSamp, uv, 0.0);
  if (u.zeroVel > 0.5 || u.scale < 0.01) { return scene; }         // disabled / mutation -> identity
  let d = textureLoad(depthTex, vec2<i32>(fc.xy), 0);              // [0,1] WebGPU depth
  if (d >= 0.9999) { return scene; }                               // skybox / far plane -> no blur
  if (d < u.minDepth) { return scene; }                            // view-weapon: compressed near slice -> no smear
  let ndc = vec3<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 2.0 * d - 1.0);  // GL NDC
  let wH = u.invCurVP * vec4<f32>(ndc, 1.0);
  if (abs(wH.w) < 1e-6) { return scene; }
  let world = wH.xyz / wH.w;
  let pH = u.prevVP * vec4<f32>(world, 1.0);
  if (pH.w <= 1e-4) { return scene; }                              // behind the previous camera
  let pNdc = pH.xy / pH.w;                                          // GL NDC, y-up
  let pUv = vec2<f32>(pNdc.x * 0.5 + 0.5, 0.5 - pNdc.y * 0.5);      // -> framebuffer uv (y-down)
  var velPx = (uv - pUv) * u.screenSize;                           // pixels, current - previous
  if (!(dot(velPx, velPx) >= 0.0)) { return scene; }               // NaN guard (false for NaN)
  let len = length(velPx);
  if (len > u.maxOffsetPx) { velPx = velPx * (u.maxOffsetPx / len); }
  velPx = velPx * u.scale;
  if (length(velPx) < 0.5) { return scene; }                       // sub-pixel -> no blur
  let velUv = velPx / u.screenSize;
  let cnt = max(2, i32(u.samples));
  let fcnt = f32(cnt);
  var acc = vec4<f32>(0.0);
  for (var i = 0; i < cnt; i = i + 1) {
    let t = (f32(i) / (fcnt - 1.0)) - 0.5;                         // -0.5 .. 0.5, centered
    acc = acc + textureSampleLevel(sceneTex, sceneSamp, uv + velUv * t, 0.0);
  }
  return acc / fcnt;
}
