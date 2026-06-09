/*
================================================================================

RenderBackend_WebGPU.cpp — Skeleton WebGPU backend (Phase 4 stub).

STATUS
------
SKELETON ONLY. Every operation is stubbed to fail-loud (assert or print).
The structure is in place; the implementations get filled in across the
phases listed in WEBGPU_PORT_PLAN.md.

The stub deliberately fails (instead of silently no-op) so that any GL
call site that hasn't been migrated yet causes an immediate visible
failure during the cutover — rather than a hard-to-diagnose missing-
work bug downstream.

DEPENDENCIES
------------
emdawnwebgpu (via Emscripten --use-port=emdawnwebgpu). Same Dawn snapshot
already used by webgpu-test/wall.cpp. The WGPUInstance / WGPUDevice
lifecycle is managed here (created during Init, destroyed on Shutdown).

================================================================================
*/

#include "RenderBackend.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <webgpu/webgpu.h>
#else
// On non-Emscripten builds (desktop dev / unit tests), this backend is a
// pure no-op so the engine compiles. WebGPU is browser-only for our target.
#endif

#include <cassert>
#include <cstdio>
#include <cstring>

#define WGPU_NOT_YET(name) do { \
    static bool warned = false; \
    if (!warned) { fprintf(stderr, "[WebGPU stub] %s not implemented\n", name); warned = true; } \
    assert(!"WebGPU backend not implemented for " name); \
} while (0)

class idRenderBackend_WebGPU : public idRenderBackend {
public:
    idRenderBackend_WebGPU() = default;
    ~idRenderBackend_WebGPU() override = default;

    idGpuBackendKind GetKind() const override { return idGpuBackendKind::WebGPU; }

    bool Init(void* /*nativeWindow*/, int /*w*/, int /*h*/) override {
#ifdef __EMSCRIPTEN__
        // Phase 4: just create the WGPUInstance + WGPUAdapter + WGPUDevice
        // and stash them. Surface creation follows in Phase 4b once we
        // actually own the canvas (currently still owned by SDL3 + GL4ES
        // during the cutover period).
        WGPUInstanceDescriptor id = {};
        instance = wgpuCreateInstance(&id);
        if (!instance) { fprintf(stderr, "[WebGPU] no instance\n"); return false; }
        // Adapter + Device request are async — initial impl uses
        // emscripten_main_loop callbacks to chain them. Code lives in a
        // future patch since the engine currently blocks on its own main.
        fprintf(stderr, "[WebGPU] Init: instance created (adapter/device async TBD)\n");
        return true;
#else
        return false;
#endif
    }

    void Shutdown() override {
#ifdef __EMSCRIPTEN__
        if (device)   { wgpuDeviceRelease(device);   device = nullptr; }
        if (adapter)  { wgpuAdapterRelease(adapter); adapter = nullptr; }
        if (instance) { wgpuInstanceRelease(instance); instance = nullptr; }
#endif
    }

    void Resize(int /*w*/, int /*h*/) override { WGPU_NOT_YET("Resize"); }

    void BeginFrame() override                            { WGPU_NOT_YET("BeginFrame"); }
    void EndFrame() override                              { WGPU_NOT_YET("EndFrame"); }
    void BeginRenderPass(const idGpuRenderPassDesc&) override { WGPU_NOT_YET("BeginRenderPass"); }
    void EndRenderPass() override                         { WGPU_NOT_YET("EndRenderPass"); }

    idGpuPipeline CreatePipeline(const idGpuPipelineDesc&) override { WGPU_NOT_YET("CreatePipeline"); return {}; }
    void DestroyPipeline(idGpuPipeline) override          { WGPU_NOT_YET("DestroyPipeline"); }
    void BindPipeline(idGpuPipeline) override             { WGPU_NOT_YET("BindPipeline"); }

    idGpuBuffer CreateBuffer(size_t, uint32_t, const char*) override { WGPU_NOT_YET("CreateBuffer"); return {}; }
    void UpdateBuffer(idGpuBuffer, size_t, size_t, const void*) override { WGPU_NOT_YET("UpdateBuffer"); }
    void DestroyBuffer(idGpuBuffer) override              { WGPU_NOT_YET("DestroyBuffer"); }
    void BindVertexBuffer(uint32_t, idGpuBuffer, size_t) override { WGPU_NOT_YET("BindVertexBuffer"); }
    void BindIndexBuffer(idGpuBuffer, size_t, bool) override { WGPU_NOT_YET("BindIndexBuffer"); }

    idGpuTexture CreateTexture(int, int, int, idGpuTextureFormat, uint32_t, const char*) override { WGPU_NOT_YET("CreateTexture"); return {}; }
    void UploadTexture(idGpuTexture, int, int, int, int, int, const void*, size_t) override { WGPU_NOT_YET("UploadTexture"); }
    void DestroyTexture(idGpuTexture) override            { WGPU_NOT_YET("DestroyTexture"); }

    idGpuSampler CreateSampler(bool, bool, bool, bool, bool) override { WGPU_NOT_YET("CreateSampler"); return {}; }
    void DestroySampler(idGpuSampler) override            { WGPU_NOT_YET("DestroySampler"); }

    idGpuBindGroup CreateBindGroup(idGpuPipeline, const idGpuTexture*, int, const idGpuSampler*, int, const idGpuBuffer*, int) override { WGPU_NOT_YET("CreateBindGroup"); return {}; }
    void DestroyBindGroup(idGpuBindGroup) override        { WGPU_NOT_YET("DestroyBindGroup"); }
    void BindBindGroup(uint32_t, idGpuBindGroup) override { WGPU_NOT_YET("BindBindGroup"); }

    void Draw(uint32_t, uint32_t, uint32_t, uint32_t) override { WGPU_NOT_YET("Draw"); }
    void DrawIndexed(uint32_t, uint32_t, uint32_t, int32_t, uint32_t) override { WGPU_NOT_YET("DrawIndexed"); }

    void SetViewport(int, int, int, int, float, float) override { WGPU_NOT_YET("SetViewport"); }
    void SetScissor(int, int, int, int) override          { WGPU_NOT_YET("SetScissor"); }
    void SetStencilReference(uint32_t) override           { WGPU_NOT_YET("SetStencilReference"); }

    const char* GetDeviceName() const override { return "WebGPU (stub)"; }

private:
#ifdef __EMSCRIPTEN__
    WGPUInstance instance = nullptr;
    WGPUAdapter  adapter  = nullptr;
    WGPUDevice   device   = nullptr;
    WGPUQueue    queue    = nullptr;
    WGPUSurface  surface  = nullptr;
#endif
};

// Factory glue. The full factory lives in RenderBackend_factory.cpp; this
// stub is exposed so the linker doesn't have to know which backend is
// being built.
idRenderBackend* CreateRenderBackend_WebGPU() {
    return new idRenderBackend_WebGPU();
}
