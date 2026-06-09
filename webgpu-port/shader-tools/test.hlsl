// Minimal standalone HLSL fragment shader for validating the
// HLSL → SPIR-V → WGSL conversion pipeline. Uses explicit
// Vulkan-style [[vk::binding(slot, set)]] decorators to avoid the
// register-overlap issue that confused naga on the first attempt.

[[vk::binding(0, 0)]] Texture2D tex;
[[vk::binding(1, 0)]] SamplerState samp;
[[vk::binding(2, 0)]] cbuffer Uniforms {
    float4 tint;
};

struct PS_IN {
    float4 position : SV_Position;
    float2 texcoord : TEXCOORD0;
};

struct PS_OUT {
    float4 color : SV_Target0;
};

void main(PS_IN i, out PS_OUT o) {
    o.color = tex.Sample(samp, i.texcoord) * tint;
}
