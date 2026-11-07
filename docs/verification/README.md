# Verification notes — 2026-11-07

Measurements are from standalone production builds in Chromium with SwiftShader software GL, seed 123, Georgetown, Medium, 480×270, 120 rendered frames at M St. They are not laptop-GPU FPS results and do not establish a 60 FPS target.

The isolated material fix comparison preserved baseline map/game code while separating plain/instance-colour material variants:

| Metric | Before | Materials fix |
|---|---:|---:|
| Sampled allocation per frame | 335 KB | 261 KB |
| CPU median | 18.0 ms | 6.8 ms |
| CPU p90 | 58.4 ms | 36.3 ms |
| JS heap | 270 MB | 269 MB |
| Draw calls | 260 | 262 |
| Triangles | 1.888 M | 1.888 M |

The software renderer still stalls for seconds when its GPU queue drains. These stalls remain; CPU medians exclude neither outliers nor rendering submission. Full raw samples contain the worst frames. This is a targeted allocation/CPU improvement, not a claim that all lag is eliminated. The chat preview and a real hardware GPU were unavailable for comparison.

Placement regression audits every shipped footprint against real oriented road/pavement/path envelopes, neighbours, roof triangulation and convex collision decomposition. The full audit includes 4,713 source footprints, keeps 4,620, clips 1,972, and omits 93 slivers/duplicates. It detects zero remaining intersection areas above numerical tolerance. Runtime bridge-height solving can change counts while preserving low buildings beneath elevated roads.

System tests use real Rapier (item identity, container consistency, doors, floors, walls and stair ascents/descents). The game browser scenarios use setup teleports, then normal input/guarded transactions. A production game browser reload checks the combined save. Test reports/screenshots are in `screenshots/`.

The final integrated Low run is recorded separately in `profile-final-low.json`: 6.6 ms CPU median, 33.8 ms p90, 249 KB sampled allocation/frame, 120 calls, 614K triangles. Heap is 338 MB and startup is 39.7 seconds under software GL. It is not an apples-to-apples Medium comparison; geometry validation and larger authored activity registries add startup/heap cost.
