// WebGPU wall test — Phase 3 validation milestone.
//
// Renders one DOOM-3-style lit wall: a quad with diffuse texture + normal
// (bump) texture, lit by a point light using the Phong-style interaction
// shader from DrBeef/Doom3Quest (GLSL ES 3.0) ported by hand to WGSL.
//
// Kill criterion: if this renders correctly on iPhone Safari WebGPU, the
// full port is technically viable. If it can't, the WebGPU port concept
// dies and we don't waste 6 months.
//
// Builds via: ./build.sh wall (writes public/wasm-webgpu/wall.{js,wasm})

#include <emscripten.h>
#include <emscripten/html5.h>
#include <webgpu/webgpu.h>
#include <cstdio>
#include <cstring>
#include <cmath>

static WGPUInstance gInstance;
static WGPUAdapter  gAdapter;
static WGPUDevice   gDevice;
static WGPUQueue    gQueue;
static WGPUSurface  gSurface;
static WGPURenderPipeline gPipeline;
static WGPUTextureFormat  gSurfaceFormat;
static WGPUBindGroup gBindGroup;
static WGPUBuffer    gUniformBuffer;
static WGPUTexture   gDiffuseTex, gNormalTex;
static WGPUSampler   gSampler;

// WGSL shader. Vertex transforms a fullscreen-ish quad; fragment is a
// hand-port of Doom3Quest's interaction.fp (GLSL ES 3.0) — Phong with a
// single point light, diffuse * NdotL + specular * (NdotH)^N, plus
// normalmap perturbation. Same math the engine uses; we're just proving
// it compiles and runs.
static const char* kShader = R"(
struct Uniforms {
  view_proj: mat4x4f,
  light_dir_ws: vec3f,    // light position in world space (point light)
  _pad0: f32,
  view_dir_ws: vec3f,     // view direction in world space
  _pad1: f32,
  diffuse_color: vec3f,
  _pad2: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var s_material: sampler;
@group(0) @binding(2) var t_diffuse: texture_2d<f32>;
@group(0) @binding(3) var t_normal: texture_2d<f32>;

struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) world_pos: vec3f,
  @location(1) world_normal: vec3f,
  @location(2) world_tangent: vec3f,
  @location(3) world_bitangent: vec3f,
  @location(4) uv: vec2f,
};

// Quad in world space — pretend it's a wall in front of the camera.
// Positions: 6 verts, two triangles.
@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  let positions = array<vec3f, 6>(
    vec3f(-1.0, -1.0, 0.0),
    vec3f( 1.0, -1.0, 0.0),
    vec3f( 1.0,  1.0, 0.0),
    vec3f(-1.0, -1.0, 0.0),
    vec3f( 1.0,  1.0, 0.0),
    vec3f(-1.0,  1.0, 0.0)
  );
  let uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0)
  );
  var out: VSOut;
  let world_pos = positions[vid];
  out.clip_pos = u.view_proj * vec4f(world_pos, 1.0);
  out.world_pos = world_pos;
  out.world_normal = vec3f(0.0, 0.0, 1.0);   // wall faces +Z
  out.world_tangent = vec3f(1.0, 0.0, 0.0);
  out.world_bitangent = vec3f(0.0, 1.0, 0.0);
  out.uv = uvs[vid];
  return out;
}

// Fragment — Phong interaction. Mirrors Doom3Quest's interaction.fp.
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  // Normal map: rg gives tangent-space xy, z derived
  let nm_sample = textureSample(t_normal, s_material, in.uv);
  var tangent_n = vec3f(nm_sample.r * 2.0 - 1.0,
                        nm_sample.g * 2.0 - 1.0,
                        0.0);
  tangent_n.z = sqrt(max(0.0, 1.0 - dot(tangent_n.xy, tangent_n.xy)));
  // Transform tangent-space normal to world space via TBN
  let N = normalize(
    in.world_tangent   * tangent_n.x +
    in.world_bitangent * tangent_n.y +
    in.world_normal    * tangent_n.z
  );

  // Light vector + view vector + half vector (all world-space)
  let L = normalize(u.light_dir_ws - in.world_pos);
  let V = normalize(u.view_dir_ws);
  let H = normalize(L + V);

  let NdotL = clamp(dot(N, L), 0.0, 1.0);
  let NdotH = clamp(dot(N, H), 0.0, 1.0);

  // Diffuse * material color, modulated by NdotL
  let albedo = textureSample(t_diffuse, s_material, in.uv).rgb * u.diffuse_color;
  let diffuse = albedo * NdotL;

  // Phong specular (pow 16)
  let spec = pow(NdotH, 16.0) * vec3f(0.4, 0.4, 0.4);

  // Simple distance falloff
  let dist = length(u.light_dir_ws - in.world_pos);
  let falloff = 1.0 / (1.0 + 0.1 * dist + 0.01 * dist * dist);

  let color = (diffuse + spec) * falloff;
  return vec4f(color, 1.0);
}
)";

static const uint32_t kTexSize = 64;
// Procedural diffuse: brick-like pattern
static void make_diffuse_data(uint32_t* out) {
  for (uint32_t y = 0; y < kTexSize; ++y) {
    for (uint32_t x = 0; x < kTexSize; ++x) {
      uint32_t bx = (x + (y / 16 % 2 ? 16 : 0)) / 32;
      uint32_t by = y / 16;
      bool mortar = ((x + (by % 2 ? 16 : 0)) % 32 < 2) || (y % 16 < 2);
      uint8_t r, g, b;
      if (mortar) { r = 90; g = 88; b = 85; }
      else {
        uint8_t base = 140 + ((bx * 7 + by * 13) % 50);
        r = base; g = base * 0.6f; b = base * 0.45f;
      }
      out[y * kTexSize + x] = 0xff000000u | (b << 16) | (g << 8) | r;
    }
  }
}
// Procedural normal map: bump for brick edges
static void make_normal_data(uint32_t* out) {
  for (uint32_t y = 0; y < kTexSize; ++y) {
    for (uint32_t x = 0; x < kTexSize; ++x) {
      // bump rises near brick edges (mortar lines)
      float fx = ((x + (y / 16 % 2 ? 16 : 0)) % 32 - 16) / 16.0f;
      float fy = (y % 16 - 8) / 8.0f;
      uint8_t nx = (uint8_t)(127 + fx * 80);
      uint8_t ny = (uint8_t)(127 + fy * 80);
      uint8_t nz = (uint8_t)(255 - sqrtf(fx*fx + fy*fy) * 80);
      out[y * kTexSize + x] = 0xff000000u | (nz << 16) | (ny << 8) | nx;
    }
  }
}

static WGPUTexture make_texture(uint32_t* data) {
  WGPUTextureDescriptor td = {};
  td.size = { kTexSize, kTexSize, 1 };
  td.mipLevelCount = 1;
  td.sampleCount = 1;
  td.dimension = WGPUTextureDimension_2D;
  td.format = WGPUTextureFormat_RGBA8Unorm;
  td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
  WGPUTexture tex = wgpuDeviceCreateTexture(gDevice, &td);
  WGPUTexelCopyTextureInfo dst = {};
  dst.texture = tex;
  WGPUTexelCopyBufferLayout layout = {};
  layout.bytesPerRow = kTexSize * 4;
  layout.rowsPerImage = kTexSize;
  WGPUExtent3D extent = { kTexSize, kTexSize, 1 };
  wgpuQueueWriteTexture(gQueue, &dst, data, kTexSize * kTexSize * 4, &layout, &extent);
  return tex;
}

static int frame_count = 0;

static EM_BOOL frame_cb(double t_ms, void*) {
  // Slowly orbit the light around the wall so we can SEE the shading react
  float t = (float)(t_ms * 0.001);
  float lightX = cosf(t) * 1.2f;
  float lightY = sinf(t * 0.7f) * 0.8f;
  float lightZ = 1.8f;

  // Update uniforms
  struct {
    float view_proj[16];
    float light_x, light_y, light_z, _pad0;
    float view_x, view_y, view_z, _pad1;
    float diff_r, diff_g, diff_b, _pad2;
  } u = {};
  // Simple ortho-ish projection: wall fills the view
  float scale = 0.9f;
  u.view_proj[0]  = scale; u.view_proj[5]  = scale;
  u.view_proj[10] = 0.001f; u.view_proj[15] = 1.0f;
  u.light_x = lightX; u.light_y = lightY; u.light_z = lightZ;
  u.view_x = 0.0f; u.view_y = 0.0f; u.view_z = 1.0f;
  u.diff_r = 1.0f; u.diff_g = 1.0f; u.diff_b = 1.0f;
  wgpuQueueWriteBuffer(gQueue, gUniformBuffer, 0, &u, sizeof(u));

  WGPUSurfaceTexture surface_tex;
  wgpuSurfaceGetCurrentTexture(gSurface, &surface_tex);
  if (surface_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
      surface_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
    printf("[wall] surface status %u\n", (unsigned)surface_tex.status);
    return EM_TRUE;
  }
  WGPUTextureView view = wgpuTextureCreateView(surface_tex.texture, nullptr);

  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(gDevice, nullptr);
  WGPURenderPassColorAttachment ca = {};
  ca.view = view;
  ca.loadOp = WGPULoadOp_Clear;
  ca.storeOp = WGPUStoreOp_Store;
  ca.clearValue = { 0.05, 0.05, 0.07, 1.0 };
  ca.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
  WGPURenderPassDescriptor rpd = {};
  rpd.colorAttachmentCount = 1;
  rpd.colorAttachments = &ca;
  WGPURenderPassEncoder rp = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
  wgpuRenderPassEncoderSetPipeline(rp, gPipeline);
  wgpuRenderPassEncoderSetBindGroup(rp, 0, gBindGroup, 0, nullptr);
  wgpuRenderPassEncoderDraw(rp, 6, 1, 0, 0);
  wgpuRenderPassEncoderEnd(rp);
  wgpuRenderPassEncoderRelease(rp);

  WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, nullptr);
  wgpuCommandEncoderRelease(enc);
  wgpuQueueSubmit(gQueue, 1, &cb);
  wgpuCommandBufferRelease(cb);
  wgpuTextureViewRelease(view);
  wgpuTextureRelease(surface_tex.texture);

  if (++frame_count == 1 || frame_count % 60 == 0) {
    printf("[wall] frame %d (light xyz=%.2f,%.2f,%.2f)\n", frame_count, lightX, lightY, lightZ);
  }
  return EM_TRUE;
}

static void make_pipeline() {
  // Shader
  WGPUShaderSourceWGSL wgsl = {};
  wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
  wgsl.code = { kShader, WGPU_STRLEN };
  WGPUShaderModuleDescriptor smd = {};
  smd.nextInChain = &wgsl.chain;
  WGPUShaderModule mod = wgpuDeviceCreateShaderModule(gDevice, &smd);

  // Bind group layout
  WGPUBindGroupLayoutEntry bgle[4] = {};
  bgle[0].binding = 0;
  bgle[0].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
  bgle[0].buffer.type = WGPUBufferBindingType_Uniform;
  bgle[0].buffer.minBindingSize = sizeof(float) * (16 + 4 + 4 + 4);
  bgle[1].binding = 1;
  bgle[1].visibility = WGPUShaderStage_Fragment;
  bgle[1].sampler.type = WGPUSamplerBindingType_Filtering;
  bgle[2].binding = 2;
  bgle[2].visibility = WGPUShaderStage_Fragment;
  bgle[2].texture.sampleType = WGPUTextureSampleType_Float;
  bgle[2].texture.viewDimension = WGPUTextureViewDimension_2D;
  bgle[3].binding = 3;
  bgle[3].visibility = WGPUShaderStage_Fragment;
  bgle[3].texture.sampleType = WGPUTextureSampleType_Float;
  bgle[3].texture.viewDimension = WGPUTextureViewDimension_2D;
  WGPUBindGroupLayoutDescriptor bgld = {};
  bgld.entryCount = 4;
  bgld.entries = bgle;
  WGPUBindGroupLayout bgl = wgpuDeviceCreateBindGroupLayout(gDevice, &bgld);

  WGPUPipelineLayoutDescriptor pld = {};
  pld.bindGroupLayoutCount = 1;
  pld.bindGroupLayouts = &bgl;
  WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(gDevice, &pld);

  WGPUColorTargetState target = {};
  target.format = gSurfaceFormat;
  target.writeMask = WGPUColorWriteMask_All;
  WGPUBlendState blend = {};
  blend.color.srcFactor = WGPUBlendFactor_One; blend.color.dstFactor = WGPUBlendFactor_Zero;
  blend.alpha.srcFactor = WGPUBlendFactor_One; blend.alpha.dstFactor = WGPUBlendFactor_Zero;
  target.blend = &blend;

  WGPUFragmentState frag = {};
  frag.module = mod;
  frag.entryPoint = { "fs_main", WGPU_STRLEN };
  frag.targetCount = 1;
  frag.targets = &target;

  WGPURenderPipelineDescriptor pd = {};
  pd.label = { "wall", WGPU_STRLEN };
  pd.layout = pl;
  pd.vertex.module = mod;
  pd.vertex.entryPoint = { "vs_main", WGPU_STRLEN };
  pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
  pd.primitive.cullMode = WGPUCullMode_None;
  pd.multisample.count = 1;
  pd.multisample.mask = 0xFFFFFFFF;
  pd.fragment = &frag;
  gPipeline = wgpuDeviceCreateRenderPipeline(gDevice, &pd);

  // Resources
  WGPUBufferDescriptor ubd = {};
  ubd.size = sizeof(float) * (16 + 4 + 4 + 4);
  ubd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  gUniformBuffer = wgpuDeviceCreateBuffer(gDevice, &ubd);

  uint32_t* diffuse = new uint32_t[kTexSize * kTexSize];
  uint32_t* normal  = new uint32_t[kTexSize * kTexSize];
  make_diffuse_data(diffuse);
  make_normal_data(normal);
  gDiffuseTex = make_texture(diffuse);
  gNormalTex  = make_texture(normal);
  delete[] diffuse; delete[] normal;

  WGPUSamplerDescriptor sd = {};
  sd.addressModeU = WGPUAddressMode_Repeat;
  sd.addressModeV = WGPUAddressMode_Repeat;
  sd.addressModeW = WGPUAddressMode_Repeat;
  sd.magFilter = WGPUFilterMode_Linear;
  sd.minFilter = WGPUFilterMode_Linear;
  sd.mipmapFilter = WGPUMipmapFilterMode_Linear;
  sd.maxAnisotropy = 1;
  gSampler = wgpuDeviceCreateSampler(gDevice, &sd);

  // Bind group
  WGPUBindGroupEntry bge[4] = {};
  bge[0].binding = 0;
  bge[0].buffer = gUniformBuffer;
  bge[0].size = sizeof(float) * (16 + 4 + 4 + 4);
  bge[1].binding = 1;
  bge[1].sampler = gSampler;
  bge[2].binding = 2;
  bge[2].textureView = wgpuTextureCreateView(gDiffuseTex, nullptr);
  bge[3].binding = 3;
  bge[3].textureView = wgpuTextureCreateView(gNormalTex, nullptr);
  WGPUBindGroupDescriptor bgd = {};
  bgd.layout = bgl;
  bgd.entryCount = 4;
  bgd.entries = bge;
  gBindGroup = wgpuDeviceCreateBindGroup(gDevice, &bgd);

  wgpuShaderModuleRelease(mod);
}

static void configure_surface() {
  WGPUSurfaceCapabilities caps = {};
  wgpuSurfaceGetCapabilities(gSurface, gAdapter, &caps);
  gSurfaceFormat = caps.formats[0];
  printf("[wall] surface format: %u\n", (unsigned)gSurfaceFormat);
  WGPUSurfaceConfiguration cfg = {};
  cfg.device = gDevice;
  cfg.format = gSurfaceFormat;
  cfg.usage = WGPUTextureUsage_RenderAttachment;
  cfg.alphaMode = WGPUCompositeAlphaMode_Auto;
  cfg.width = 600;
  cfg.height = 600;
  cfg.presentMode = WGPUPresentMode_Fifo;
  wgpuSurfaceConfigure(gSurface, &cfg);
  wgpuSurfaceCapabilitiesFreeMembers(caps);
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView msg, void*, void*) {
  if (status != WGPURequestDeviceStatus_Success) {
    printf("[wall] device fail: %.*s\n", (int)msg.length, msg.data);
    return;
  }
  gDevice = device;
  gQueue = wgpuDeviceGetQueue(gDevice);
  printf("[wall] device ready\n");

  WGPUEmscriptenSurfaceSourceCanvasHTMLSelector cs = {};
  cs.chain.sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector;
  cs.selector = { "#gameCanvas", WGPU_STRLEN };
  WGPUSurfaceDescriptor sd = {};
  sd.nextInChain = &cs.chain;
  gSurface = wgpuInstanceCreateSurface(gInstance, &sd);
  printf("[wall] surface created\n");

  configure_surface();
  make_pipeline();
  emscripten_request_animation_frame_loop(frame_cb, nullptr);
  printf("[wall] frame loop running\n");
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView msg, void*, void*) {
  if (status != WGPURequestAdapterStatus_Success) {
    printf("[wall] adapter fail: %.*s\n", (int)msg.length, msg.data);
    return;
  }
  gAdapter = adapter;
  printf("[wall] adapter ready\n");
  WGPUDeviceDescriptor dd = {};
  WGPURequestDeviceCallbackInfo ci = {};
  ci.mode = WGPUCallbackMode_AllowSpontaneous;
  ci.callback = on_device;
  wgpuAdapterRequestDevice(gAdapter, &dd, ci);
}

int main() {
  printf("[wall] start\n");
  WGPUInstanceDescriptor id = {};
  gInstance = wgpuCreateInstance(&id);
  if (!gInstance) { printf("[wall] no instance\n"); return 1; }
  WGPURequestAdapterOptions opts = {};
  WGPURequestAdapterCallbackInfo ci = {};
  ci.mode = WGPUCallbackMode_AllowSpontaneous;
  ci.callback = on_adapter;
  wgpuInstanceRequestAdapter(gInstance, &opts, ci);
  emscripten_exit_with_live_runtime();
  return 0;
}
