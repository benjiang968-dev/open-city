# Cached physical sky verification

The visible sky now samples a double-buffered HDR cube of the existing physical atmosphere and cloud shader. Captures update one face per frame, about once per second; a complete cube replaces the visible buffer together. The lighting cube also spreads its six capture faces over six frames before PMREM updates. Boot and explicit forced refreshes capture all faces immediately. Ground bounce remains in the lighting cube and is excluded from the visible sky.

## Controlled production-build measurement

Chromium with ANGLE SwiftShader, Georgetown seed 123, Low preset, 480 × 270 viewport, fixed M Street camera at 15:30. Animation and simulation were frozen. The same scene alternated the original retained physical sky material and the cached material for 12 samples each. Each render ends in `gl.finish()` and synchronous `readPixels`, so timings include queued GPU work. Both variants draw **104 calls and 771,963 triangles**. Raw samples are in [profile-sky-paired.json](profile-sky-paired.json).

| Measured render | Physical source | Cached sky |
| --- | ---: | ---: |
| Sky alone, median | 5.8 ms | 2.7 ms |
| Complete city, median | 1,388.9 ms | 1,377.7 ms |

The sky pass costs 53% less in this software-rendered run. Complete-city timings differ by less than 1%, within run variation; the median paired ratio is 1.008. This demonstrates a targeted sky improvement and no measurable steady-state city regression. It does **not** demonstrate a whole-game frame-rate improvement. City PBR/geometry rendering remains the dominant software-renderer cost. The static-render comparison excludes periodic capture work, which the regression below checks is spread over frames. Hardware GPU performance has not been measured.

## Browser regression

`BUILD_ROOT=work/perf-final node scripts/testSky.mjs` passed against the production build. It compares cached and physical radiance in six directions during clear day, storm night, and return to clear day. All 18 views differ by at most **one 8-bit channel value**. This covers the lower hemisphere as well as zenith and cardinal directions; no fog or scene geometry masks the samples. See [sky-cache.json](sky-cache.json).

The test also verifies one display face and one lighting face maximum per frame after boot, cube target reuse, a below-horizon night sun, lighting refresh after day/weather changes, retained ground bounce, and no browser errors. `npm run build` passed.

Reproduce the timing comparison with `node scripts/profileRender.mjs dist work/render-profile.json` after a production build. SwiftShader is deliberately selected for comparability; these numbers are not representative of a player's hardware GPU.
