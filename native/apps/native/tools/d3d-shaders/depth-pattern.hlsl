float4 vs_main(uint vertex : SV_VertexID) : SV_Position {
    float2 corner = float2((vertex << 1) & 2, vertex & 2);
    return float4(corner * float2(2, -2) + float2(-1, 1), 0, 1);
}
float ps_main(uint sample : SV_SampleIndex) : SV_Depth {
    return .625 - float(sample) * .125;
}
