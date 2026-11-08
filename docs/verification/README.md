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


## Follow-up verification

The expanded production game passes four exact payouts, repeat-input guards, paid food, readable books, four apartment choices,
independent second-home storage, theft/pursuit and reload with $163/four completed shifts intact. A separate actual published-v1
upgrade retains $710, NPC relationship24, the lease, stored can450 and the first20 parked-car identities/positions;272 new physical
objects are appended exactly once across a second reload. See screenshots/36-gameplay-georgetown.json and37-upgrade.json.

All85 exterior staircases traverse both ways (170 traversals), with zero measured floor penetration and no browser errors.
The test finds a collision-free source endpoint where a raw endpoint touches a facade (maximum inset0.4m), without raising reachability
or floor tolerances. All14 interior variants and272 item support surfaces also pass real-Rapier checks.

A fresh starter car now uses an existing M Street slot with a gentle/clear departure, passing25m at120/120health. Legacy saves keep
the previous reservation layout so parked-car IDs/types are not reshuffled. See screenshots/39-initial-drive*.json.

The cached physical sky has an accepted isolated improvement; see sky-performance.md. Full-city readback remains slow in SwiftShader.
Shader guards and compile-time Low specialization were rejected after fixed-sort interleaved comparisons. They are not shipped;
see shader-investigation.md. FPS display now uses wall time, while physics catch-up remains capped separately.
