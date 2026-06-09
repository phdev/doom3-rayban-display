// Minimal WebGPU triangle. Proves the WASM + emdawnwebgpu stack works on
// the target browser (Mac Safari, iOS Safari, MobileSafari via D3Bridge).
//
// If this renders correctly on iPhone, the foundation is solid for porting
// dhewm3's renderer to WebGPU.

#include <emscripten.h>
#include <emscripten/html5.h>
#include <webgpu/webgpu.h>
#include <cstdio>
#include <cstdlib>

static WGPUInstance gInstance;
static WGPUAdapter  gAdapter;
static WGPUDevice   gDevice;
static WGPUQueue    gQueue;
static WGPUSurface  gSurface;
static WGPURenderPipeline gPipeline;
static WGPUTextureFormat  gSurfaceFormat;

// Triangle in NDC: red vert top, green left, blue right.
static const char* kShaderSrc = R"(
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var positions = array<vec2f, 3>(
    vec2f( 0.0,  0.75),
    vec2f(-0.75, -0.65),
    vec2f( 0.75, -0.65)
  );
  var colors = array<vec3f, 3>(
    vec3f(1.0, 0.2, 0.2),
    vec3f(0.2, 1.0, 0.2),
    vec3f(0.2, 0.2, 1.0)
  );
  var out: VSOut;
  out.pos = vec4f(positions[vid], 0.0, 1.0);
  out.color = colors[vid];
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
)";

static void make_pipeline() {
    WGPUShaderSourceWGSL wgsl = {};
    wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code = { kShaderSrc, WGPU_STRLEN };

    WGPUShaderModuleDescriptor smd = {};
    smd.nextInChain = &wgsl.chain;
    WGPUShaderModule mod = wgpuDeviceCreateShaderModule(gDevice, &smd);

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
    pd.label = { "triangle", WGPU_STRLEN };
    pd.vertex.module = mod;
    pd.vertex.entryPoint = { "vs_main", WGPU_STRLEN };
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.cullMode = WGPUCullMode_None;
    pd.multisample.count = 1;
    pd.multisample.mask  = 0xFFFFFFFF;
    pd.fragment = &frag;
    gPipeline = wgpuDeviceCreateRenderPipeline(gDevice, &pd);
    wgpuShaderModuleRelease(mod);
}

static int frame_count = 0;

static EM_BOOL frame_cb(double, void*) {
    WGPUSurfaceTexture surface_tex;
    wgpuSurfaceGetCurrentTexture(gSurface, &surface_tex);
    if (surface_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
        surface_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
        printf("[triangle] surface status %u\n", (unsigned)surface_tex.status);
        return EM_TRUE;
    }
    WGPUTextureView view = wgpuTextureCreateView(surface_tex.texture, nullptr);

    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(gDevice, nullptr);

    WGPURenderPassColorAttachment colorAttach = {};
    colorAttach.view = view;
    colorAttach.loadOp = WGPULoadOp_Clear;
    colorAttach.storeOp = WGPUStoreOp_Store;
    colorAttach.clearValue = { 0.05, 0.05, 0.07, 1.0 };
    colorAttach.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;

    WGPURenderPassDescriptor rpd = {};
    rpd.colorAttachmentCount = 1;
    rpd.colorAttachments = &colorAttach;

    WGPURenderPassEncoder rp = wgpuCommandEncoderBeginRenderPass(enc, &rpd);
    wgpuRenderPassEncoderSetPipeline(rp, gPipeline);
    wgpuRenderPassEncoderDraw(rp, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(rp);
    wgpuRenderPassEncoderRelease(rp);

    WGPUCommandBuffer cb = wgpuCommandEncoderFinish(enc, nullptr);
    wgpuCommandEncoderRelease(enc);
    wgpuQueueSubmit(gQueue, 1, &cb);
    wgpuCommandBufferRelease(cb);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(surface_tex.texture);

    if (++frame_count == 1 || frame_count % 60 == 0) {
        printf("[triangle] frame %d ok\n", frame_count);
    }
    return EM_TRUE;
}

static void configure_surface() {
    WGPUSurfaceCapabilities caps = {};
    wgpuSurfaceGetCapabilities(gSurface, gAdapter, &caps);
    gSurfaceFormat = caps.formats[0];
    printf("[triangle] surface preferred format: %u\n", (unsigned)gSurfaceFormat);

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
        printf("[triangle] device request failed: %.*s\n", (int)msg.length, msg.data);
        return;
    }
    gDevice = device;
    gQueue = wgpuDeviceGetQueue(gDevice);
    printf("[triangle] device acquired\n");

    // Surface from the canvas selector
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector canvasSrc = {};
    canvasSrc.chain.sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector;
    canvasSrc.selector = { "#gameCanvas", WGPU_STRLEN };
    WGPUSurfaceDescriptor sd = {};
    sd.nextInChain = &canvasSrc.chain;
    gSurface = wgpuInstanceCreateSurface(gInstance, &sd);
    if (!gSurface) { printf("[triangle] no surface\n"); return; }
    printf("[triangle] surface created\n");

    configure_surface();
    make_pipeline();
    emscripten_request_animation_frame_loop(frame_cb, nullptr);
    printf("[triangle] frame loop scheduled\n");
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView msg, void*, void*) {
    if (status != WGPURequestAdapterStatus_Success) {
        printf("[triangle] adapter request failed: %.*s\n", (int)msg.length, msg.data);
        return;
    }
    gAdapter = adapter;
    printf("[triangle] adapter acquired\n");

    WGPUDeviceDescriptor dd = {};
    WGPURequestDeviceCallbackInfo ci = {};
    ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_device;
    wgpuAdapterRequestDevice(gAdapter, &dd, ci);
}

int main() {
    printf("[triangle] start\n");
    WGPUInstanceDescriptor id = {};
    gInstance = wgpuCreateInstance(&id);
    if (!gInstance) { printf("[triangle] no instance\n"); return 1; }
    printf("[triangle] instance created\n");

    WGPURequestAdapterOptions opts = {};
    WGPURequestAdapterCallbackInfo ci = {};
    ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_adapter;
    wgpuInstanceRequestAdapter(gInstance, &opts, ci);

    emscripten_exit_with_live_runtime();
    return 0;
}
