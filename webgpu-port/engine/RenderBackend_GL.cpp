/*
================================================================================

RenderBackend_GL.cpp — Backward-compat backend wrapping the existing GL path.

PURPOSE
-------
Initial implementation just calls the existing qgl* functions through the
abstraction interface. ZERO behavior change for the GL backend — it's a
pass-through wrapper. The point of this file is:

  1. Establishes the call boundary so future code can be written against
     RenderBackend.h without caring which backend is active.
  2. As call sites get migrated from qgl* → renderBackend->X(), they keep
     producing identical GL command streams.
  3. Eventually, after Phase 4-7 complete, this file gets deprecated and
     the GL path is removed (the WebGPU backend replaces it entirely).

DURING MIGRATION
----------------
- Call sites NOT yet migrated continue to use qgl* directly. No problem.
- Call sites that ARE migrated go through renderBackend->X(), which here
  just calls the same qgl* underneath. Output is bit-identical.
- The cvar `r_backend "gl"` (default during cutover) instantiates this.
- When WebGPU is ready: `r_backend "webgpu"` instantiates the other
  backend. Anything still using raw qgl* will silently bypass — that's
  why migration must complete before flipping the cvar default.

================================================================================
*/

#include "RenderBackend.h"

// NOTE: This file references the engine's qgl* loader and GL constants.
// During Phase 4, this is kept as a stub that builds standalone. The
// integration step (Phase 4b) lifts it into neo/renderer/ and uncomments
// the qgl* calls. Initial commit ships the structure only.

#include <cstdio>

class idRenderBackend_GL : public idRenderBackend {
public:
    idGpuBackendKind GetKind() const override { return idGpuBackendKind::GL; }

    bool Init(void*, int w, int h) override {
        fprintf(stderr, "[GL backend] Init %dx%d (pass-through wrapper)\n", w, h);
        // Engine's existing GL init runs unchanged. This wrapper appears
        // AFTER GLimp_Init has already set up the WebGL context.
        return true;
    }
    void Shutdown() override {}
    void Resize(int, int) override {}

    void BeginFrame() override {}
    void EndFrame() override {}

    void BeginRenderPass(const idGpuRenderPassDesc& desc) override {
        // GL impl: glBindFramebuffer + glClearColor + glClear if desc.colorLoad == Clear
        // ... wire up when migrating tr_backend.cpp
        (void)desc;
    }
    void EndRenderPass() override {}

    idGpuPipeline CreatePipeline(const idGpuPipelineDesc&) override { return {}; }
    void DestroyPipeline(idGpuPipeline) override {}
    void BindPipeline(idGpuPipeline) override {}

    idGpuBuffer CreateBuffer(size_t, uint32_t, const char*) override { return {}; }
    void UpdateBuffer(idGpuBuffer, size_t, size_t, const void*) override {}
    void DestroyBuffer(idGpuBuffer) override {}
    void BindVertexBuffer(uint32_t, idGpuBuffer, size_t) override {}
    void BindIndexBuffer(idGpuBuffer, size_t, bool) override {}

    idGpuTexture CreateTexture(int, int, int, idGpuTextureFormat, uint32_t, const char*) override { return {}; }
    void UploadTexture(idGpuTexture, int, int, int, int, int, const void*, size_t) override {}
    void DestroyTexture(idGpuTexture) override {}

    idGpuSampler CreateSampler(bool, bool, bool, bool, bool) override { return {}; }
    void DestroySampler(idGpuSampler) override {}

    idGpuBindGroup CreateBindGroup(idGpuPipeline, const idGpuTexture*, int, const idGpuSampler*, int, const idGpuBuffer*, int) override { return {}; }
    void DestroyBindGroup(idGpuBindGroup) override {}
    void BindBindGroup(uint32_t, idGpuBindGroup) override {}

    void Draw(uint32_t, uint32_t, uint32_t, uint32_t) override {}
    void DrawIndexed(uint32_t, uint32_t, uint32_t, int32_t, uint32_t) override {}

    void SetViewport(int, int, int, int, float, float) override {}
    void SetScissor(int, int, int, int) override {}
    void SetStencilReference(uint32_t) override {}

    const char* GetDeviceName() const override { return "OpenGL (GL4ES → WebGL2)"; }
};

idRenderBackend* CreateRenderBackend_GL() {
    return new idRenderBackend_GL();
}
