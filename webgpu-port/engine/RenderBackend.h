/*
================================================================================

RenderBackend.h — Abstraction layer for dhewm3's GPU work.

PURPOSE
-------
Decouple the engine's renderer (~17 files, 809 GL call sites, 94 unique GL
functions) from any one graphics API so we can run on EITHER the existing
GL4ES→WebGL path OR a new WebGPU path (and theoretically others later).

This is the foundational Phase 4 deliverable. The interface here is the
contract that both RenderBackend_GL.cpp (wraps existing qgl* calls) and
RenderBackend_WebGPU.cpp (new, using emdawnwebgpu) must implement.

DESIGN PHILOSOPHY
-----------------
NOT a 1:1 wrapper around 94 GL functions. That would inherit GL's
implicit-state-machine nature and produce slow, unverifiable WebGPU code
(the same problem D3Wasm hit with Regal in 2018). Instead:

  Higher-level operations modeled on what DOOM 3 ACTUALLY does:
    - Resource lifecycle (buffers, textures, programs)
    - Encoded render passes (clear → draws → end)
    - Pipeline state objects (bundles of state vs. per-call setters)
    - Material/light interaction draws (the engine's primary "verb")

That maps cleanly onto WebGPU's design and can also be implemented by the
GL backend by translating to immediate-mode calls under the hood.

CALL-SITE MIGRATION STRATEGY
----------------------------
Phase 4a: introduce RenderBackend.h, wrap the existing GL backend behind
          it. Call sites still use qgl* directly. Zero behavior change.
Phase 4b: migrate tr_backend.cpp's frame loop to RenderBackend ops.
Phase 4c: migrate draw_common.cpp (the lit-interaction pass) to
          RenderBackend ops.
Phase 4d: migrate Image_load.cpp's texture upload to RenderBackend ops.
Phase 4e: migrate VertexCache.cpp / draw_arb2.cpp.
Phase 5: enable the WebGPU backend; cut over one shader/material at a
         time. Both backends coexist via runtime cvar.

================================================================================
*/

#pragma once

#include <cstddef>
#include <cstdint>

// ─── Opaque handles ─────────────────────────────────────────────────────────
// Backend resource IDs. Tagged via type-aliased uint64_t so a GL handle and
// a WebGPU handle can't be accidentally mixed across backends.

struct idGpuBuffer    { uint64_t id; };
struct idGpuTexture   { uint64_t id; };
struct idGpuSampler   { uint64_t id; };
struct idGpuPipeline  { uint64_t id; };
struct idGpuBindGroup { uint64_t id; };

// ─── Enums ──────────────────────────────────────────────────────────────────

enum class idGpuBackendKind : int {
    GL,        // current behavior, qgl* + GL4ES → WebGL2
    WebGPU,    // new, emdawnwebgpu → Metal/Vulkan/D3D12
};

enum class idGpuTextureFormat : int {
    Invalid = 0,
    R8,
    RG8,
    RGBA8,
    RGBA8Srgb,
    RGB10A2,
    R11G11B10F,
    R16F,
    RGBA16F,
    R32F,
    Depth16,
    Depth24,
    Depth24Stencil8,
    Depth32F,
    // Compressed (chosen at upload time based on extension support):
    BC1,    // S3TC DXT1
    BC3,    // S3TC DXT5
    BC7,    // BPTC
    ASTC4x4,
};

enum class idGpuBufferUsage : uint32_t {
    Vertex   = 1 << 0,
    Index    = 1 << 1,
    Uniform  = 1 << 2,
    Storage  = 1 << 3,
    CopySrc  = 1 << 4,
    CopyDst  = 1 << 5,
    MapWrite = 1 << 6,
    MapRead  = 1 << 7,
};

enum class idGpuTextureUsage : uint32_t {
    Sampled       = 1 << 0,
    Storage       = 1 << 1,
    RenderTarget  = 1 << 2,
    CopySrc       = 1 << 3,
    CopyDst       = 1 << 4,
};

enum class idGpuCullMode : int { None, Front, Back };
enum class idGpuFrontFace : int { CW, CCW };
enum class idGpuCompare : int { Never, Less, Equal, LessEqual, Greater, NotEqual, GreaterEqual, Always };
enum class idGpuBlendFactor : int { Zero, One, SrcColor, OneMinusSrcColor, DstColor, OneMinusDstColor, SrcAlpha, OneMinusSrcAlpha, DstAlpha, OneMinusDstAlpha };
enum class idGpuBlendOp : int { Add, Subtract, ReverseSubtract, Min, Max };
enum class idGpuStencilOp : int { Keep, Zero, Replace, IncrementClamp, DecrementClamp, Invert, IncrementWrap, DecrementWrap };
enum class idGpuLoadOp : int { Load, Clear, DontCare };
enum class idGpuStoreOp : int { Store, DontCare };

// ─── Descriptor structs ─────────────────────────────────────────────────────

struct idGpuColorTargetState {
    idGpuTextureFormat format;
    bool               blendEnabled;
    idGpuBlendFactor   srcColor, dstColor;
    idGpuBlendOp       colorOp;
    idGpuBlendFactor   srcAlpha, dstAlpha;
    idGpuBlendOp       alphaOp;
    uint8_t            writeMask;  // bits 0..3 = R,G,B,A
};

struct idGpuDepthStencilState {
    idGpuTextureFormat format;
    bool               depthWriteEnabled;
    idGpuCompare       depthCompare;
    bool               stencilEnabled;
    // Front face
    idGpuCompare       stencilFrontCompare;
    idGpuStencilOp     stencilFrontFail, stencilFrontDepthFail, stencilFrontPass;
    // Back face
    idGpuCompare       stencilBackCompare;
    idGpuStencilOp     stencilBackFail, stencilBackDepthFail, stencilBackPass;
    uint8_t            stencilReadMask, stencilWriteMask;
};

struct idGpuPipelineDesc {
    const char*               name;          // debug label
    const char*               wgsl;          // WGSL source (WebGPU backend); for GL, this is the ARB program or compiled GLSL
    const char*               vsEntryPoint;  // "vs_main"
    const char*               fsEntryPoint;  // "fs_main"
    // Vertex attribute layout — DOOM 3's draw verts have fixed layout
    // (position + normal + tangent + bitangent + texcoord + color),
    // so the descriptor can be largely templated. Initial impl assumes
    // the standard idDrawVert layout.

    idGpuCullMode             cull;
    idGpuFrontFace            frontFace;

    bool                      hasColorTarget;
    idGpuColorTargetState     color;
    bool                      hasDepthStencil;
    idGpuDepthStencilState    depthStencil;

    // Bind group layout — slots dhewm3 uses:
    //   0: per-frame uniforms (view/proj matrices, time)
    //   1: per-light uniforms (light origin/color/falloff)
    //   2: per-material uniforms (diffuse/spec color, scroll)
    //   3..6: material textures (normal, specular, diffuse, glow)
    //   7: light projection cookie
    //   8: light falloff
    //   9: normalization cubemap
    // The descriptor includes the WGSL bind group layout that matches.
};

struct idGpuRenderPassDesc {
    const char*       name;  // debug label
    idGpuTexture      colorAttachment;
    idGpuLoadOp       colorLoad;
    idGpuStoreOp      colorStore;
    float             clearR, clearG, clearB, clearA;

    bool              hasDepth;
    idGpuTexture      depthAttachment;
    idGpuLoadOp       depthLoad, stencilLoad;
    idGpuStoreOp      depthStore, stencilStore;
    float             clearDepth;
    uint32_t          clearStencil;
};

// ─── The backend interface ──────────────────────────────────────────────────

class idRenderBackend {
public:
    virtual ~idRenderBackend() = default;
    virtual idGpuBackendKind GetKind() const = 0;

    // Lifecycle
    virtual bool   Init(void* nativeWindow, int width, int height) = 0;
    virtual void   Shutdown() = 0;
    virtual void   Resize(int width, int height) = 0;

    // Frame
    virtual void   BeginFrame() = 0;
    virtual void   EndFrame() = 0;

    // Render pass
    virtual void   BeginRenderPass(const idGpuRenderPassDesc& desc) = 0;
    virtual void   EndRenderPass() = 0;

    // Pipeline state
    virtual idGpuPipeline  CreatePipeline(const idGpuPipelineDesc& desc) = 0;
    virtual void           DestroyPipeline(idGpuPipeline pipeline) = 0;
    virtual void           BindPipeline(idGpuPipeline pipeline) = 0;

    // Buffers
    virtual idGpuBuffer    CreateBuffer(size_t bytes, uint32_t usage, const char* label) = 0;
    virtual void           UpdateBuffer(idGpuBuffer buf, size_t offset, size_t bytes, const void* data) = 0;
    virtual void           DestroyBuffer(idGpuBuffer buf) = 0;
    virtual void           BindVertexBuffer(uint32_t slot, idGpuBuffer buf, size_t offset) = 0;
    virtual void           BindIndexBuffer(idGpuBuffer buf, size_t offset, bool isUint32) = 0;

    // Textures
    virtual idGpuTexture   CreateTexture(int width, int height, int mipCount,
                                          idGpuTextureFormat format, uint32_t usage,
                                          const char* label) = 0;
    virtual void           UploadTexture(idGpuTexture tex, int mip, int x, int y,
                                          int width, int height, const void* pixels,
                                          size_t bytesPerRow) = 0;
    virtual void           DestroyTexture(idGpuTexture tex) = 0;

    // Samplers
    virtual idGpuSampler   CreateSampler(bool linearMin, bool linearMag, bool linearMip,
                                          bool repeatU, bool repeatV) = 0;
    virtual void           DestroySampler(idGpuSampler sampler) = 0;

    // Bind groups (WebGPU-native; the GL backend simulates them via
    // batched glBindTexture / glActiveTexture / glUniform4fv).
    virtual idGpuBindGroup CreateBindGroup(idGpuPipeline pipeline,
                                            const idGpuTexture* textures, int textureCount,
                                            const idGpuSampler* samplers, int samplerCount,
                                            const idGpuBuffer* uniforms, int uniformCount) = 0;
    virtual void           DestroyBindGroup(idGpuBindGroup bg) = 0;
    virtual void           BindBindGroup(uint32_t slot, idGpuBindGroup bg) = 0;

    // Draw
    virtual void           Draw(uint32_t vertexCount, uint32_t instanceCount,
                                 uint32_t firstVertex, uint32_t firstInstance) = 0;
    virtual void           DrawIndexed(uint32_t indexCount, uint32_t instanceCount,
                                        uint32_t firstIndex, int32_t baseVertex,
                                        uint32_t firstInstance) = 0;

    // Dynamic state (kept fluid because the engine sets it per-draw a lot)
    virtual void           SetViewport(int x, int y, int width, int height,
                                        float minDepth, float maxDepth) = 0;
    virtual void           SetScissor(int x, int y, int width, int height) = 0;
    virtual void           SetStencilReference(uint32_t ref) = 0;

    // Debug / introspection
    virtual const char*    GetDeviceName() const = 0;
};

// ─── Factory ────────────────────────────────────────────────────────────────

idRenderBackend* CreateRenderBackend(idGpuBackendKind kind);

// Globally-accessible current backend (initialized in RenderSystem_init.cpp).
// Selected via cvar `r_backend` (values: "gl" | "webgpu").
extern idRenderBackend* renderBackend;
