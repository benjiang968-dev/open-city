# World shader investigation

No additional world/facade shader change is included. The tested guards skipped room tracing and auxiliary facade sampling on opaque wall pixels, and skipped zero-strength normal reconstruction at Low. A separate compile-time Low specialization was also investigated and discarded.

The final guard comparison used a pinned production Georgetown build, seed 123, Low, 480 × 270, the same frozen camera, Chromium ANGLE SwiftShader, eight alternating frame pairs, and synchronous GPU readback. Original material sorting was fixed across both variants: changing a material clone's ID can otherwise change opaque draw order and overdraw. Both variants submitted **98 calls and 770,645 triangles**.

| Drained render p50 | Time |
| --- | ---: |
| Original world/facade shaders | 1,244 ms |
| Rejected guards | 1,320 ms |

The profiler uses the upper middle sample for p50. The guards were slower in seven of eight pairs, so they were removed. Clear and snow/night images matched exactly; rain differed in two of 254,016 channels by one 8-bit value. The browser reported no errors. Raw samples are in [profile-shader-guards-rejected.json](profile-shader-guards-rejected.json).

Material-category isolation identified world PBR rendering as the largest remaining cost in this software renderer. The accepted performance changes include the cached physical sky (see [sky-performance.md](sky-performance.md)) and earlier CPU/allocation work. Full-city GPU rendering remains slow under SwiftShader. These results do not establish a hardware GPU frame rate or that all random stalls are resolved. No draw-distance or fog reduction was used to obtain the accepted result.
