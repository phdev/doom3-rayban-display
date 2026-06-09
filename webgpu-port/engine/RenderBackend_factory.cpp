/*
================================================================================

RenderBackend_factory.cpp — Selects which backend implementation to instantiate
based on a cvar / build-time flag. Defined separately so RenderBackend_GL.cpp
and RenderBackend_WebGPU.cpp can be compiled independently and the cutover
can be controlled at runtime.

================================================================================
*/

#include "RenderBackend.h"

idRenderBackend* renderBackend = nullptr;

// Forward decls — defined in the respective backend .cpp files.
idRenderBackend* CreateRenderBackend_GL();
idRenderBackend* CreateRenderBackend_WebGPU();

idRenderBackend* CreateRenderBackend(idGpuBackendKind kind) {
    switch (kind) {
        case idGpuBackendKind::GL:     return CreateRenderBackend_GL();
        case idGpuBackendKind::WebGPU: return CreateRenderBackend_WebGPU();
    }
    return nullptr;
}
