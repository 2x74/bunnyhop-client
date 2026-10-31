Texture2D<float4> sourceColor : register(t0);
cbuffer CopyRect : register(b0) { int4 offset; };
float4 vs_main(uint vertex : SV_VertexID) : SV_Position {
    float2 corner = float2((vertex << 1) & 2, vertex & 2);
    return float4(corner * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 ps_main(float4 position : SV_Position) : SV_Target {
    return sourceColor.Load(int3(int2(position.xy) + offset.xy, 0));
}
