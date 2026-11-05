# Textures and 3D assets for a realistic look: sources, procedural techniques, compression

Stage 1, item 5 (research). Written 2026-11-05. Supports Stage 1 item 4 (PBR look) and the CLAUDE.md rule:
"Textures are generated in code (procedural PBR maps) or come from appropriately licensed sources (CC0
preferred). Every non-procedural asset is listed with its source and licence in assets/LICENSES.md."

**Short answer.**

- **Keep procedural PBR maps as the base.** They are original by construction, need no network and no
  licence bookkeeping. Bake them at build time and ship them as KTX2.
- **CC0 photo-scanned sets would lift realism most** for ground and wall materials (asphalt, brick, concrete,
  cobbles, bark). ambientCG and Poly Haven are the two best-documented CC0 libraries, and attribution is not
  required for either. Both are blocked by this environment's network policy today (section 5 lists the hosts
  the owner would allow).
- **Compression:** three r187 already ships the Basis Universal transcoder and `KTX2Loader`. The npm package
  `ktx2-encoder` (WASM, no native binary) can encode at build time. On a desktop GPU that means BC7 at
  1 byte/pixel instead of 4.

## How this was researched

- **Read directly on 2026-11-05:**
  - Poly Haven's API Terms of Service and README (raw.githubusercontent.com) [P1, P2]
  - the SPDX CC0-1.0 text [L1]
  - the npm registry entries for the tools in section 4 [N1]
  - three.js 0.187.0 in `node_modules`: `KTX2Loader.js`, `libs/basis/`, `exporters/KTX2Exporter.js`,
    `objects/Sky.js`, `environments/RoomEnvironment.js`, `build/three.tsl.js` exports
  - the Claude Code cloud-environments documentation (network access) [C1]
- **Blocked here (proxy 403):**
  - ambientcg.com and polyhaven.com (by policy)
  - sharetextures.com, cgbookcase.com, texturecan.com, 3dtextures.me, kenney.nl, quaternius.com, poly.pizza
  - creativecommons.org

  For these sites' licence statements I used **web-search extracts** of their own licence or FAQ pages,
  marked [S].
- Nothing was downloaded from any asset site.

## 1. Legally safe sources

CC0 1.0 waives copyright and related rights, including database rights, "to the greatest extent permitted",
and needs no attribution. But "No trademark or patent rights held by Affirmer are waived" (CC0 §4 a [L1]). So
a CC0 photo of a branded shopfront is still unusable for us (CLAUDE.md: no logos or brand colours).

| Source | What | Licence (as stated by the source) | Attribution | Notes |
|---|---|---|---|---|
| **ambientCG** (ambientcg.com) | Large library of PBR materials (albedo, normal, roughness, AO, displacement) at 1K–8K, HDRIs, some models (library size not verified) | "All ambientCG assets are provided under the Creative Commons CC0 1.0 Universal License"; this covers "the downloadable files and the preview renders" [S: docs.ambientcg.com/license] | Not required ("appreciated"; suggested wording on that page) | API v2 is frozen; "new projects should use v3". Each asset has a `downloadLink` that logs the download, then redirects to the raw file [S: docs.ambientcg.com/api/v2] |
| **Poly Haven** (polyhaven.com) | Photo-scanned PBR textures, HDRIs, 3D models (props, furniture, street items) | CC0. The FAQ says the only thing you cannot do is claim authorship or re-license [S: polyhaven.com/faq, /license] | **Assets: none**. "CC0 assets carry no attribution requirement whatsoever, now or ever" [P1 §2.5]. **Live API use only:** a visible "Powered by Poly Haven"-style credit [P1 §2.5] | API free for any use including commercial [P1 §2.1–2.3]. Calls must send a unique `Referer` or User-Agent naming our software [P1 §2.4]. Download once and self-host, so the credit clause does not apply |
| ShareTextures | ~1,500+ PBR textures | "All our textures are released under the CC0 license" [S] | No | |
| TextureCan | ~650 PBR textures | "Creative Commons CC0 1.0 Universe License" [S: texturecan.com/terms] | No | |
| 3DTextures.me | ~1,300 texture sets | "All textures on this site are licensed as CC0" [S: 3dtextures.me/about] | No | |
| cgbookcase | ~550 PBR textures | CC0 per launch coverage; **no primary licence page seen** [S] | No | Verify on the site before use |
| Kenney | 3D/2D game kits (city, furniture, vehicles; stylised low-poly) | "public domain licensed (CC0)"; logo reserved [S: kenney.nl/support] | No ("Kenney" appreciated) | Style is low-poly; useful for placeholders and interiors, not the realistic look |
| Quaternius | Stylised low-poly models | CC0 per pack (seen on OpenGameArt listings) [S] | No | Check each pack |
| Poly Pizza | Aggregator of low-poly models | **Per model**: many CC0, some CC-BY [S] | Only for CC-BY models | Check each model page; record the licence |
| Sketchfab and other marketplaces | Mixed | Per model (CC-BY, CC-BY-NC, editorial, store licences) | Usually yes | **Avoid** unless the model is CC0, or CC-BY with credit added. Never NC or ND (the deploy is public) |

**Avoid entirely:**

- Google Maps / Street View / Earth imagery or meshes (see `google-3d-tiles.md`).
- Photos of real Georgetown shopfronts, signs or logos.
- Any "free for personal use" pack.
- Sites whose licence forbids redistributing the raw files. A static web game ships the files to every visitor,
  so they are extractable from `dist/`.

**Bookkeeping (required by CLAUDE.md).** `assets/LICENSES.md` gets one row per file:

- source URL, author or site, licence (SPDX id), date downloaded
- SHA-256 of the original
- what we changed (resized, re-packed channels, recoloured)

Keep the original archives out of the repo or in a separate `assets/src/` folder.

## 2. Procedural textures that look real (WebGL, three.js r187)

**Constraint.** The game uses `WebGLRenderer` (`src/main.ts`; ACES filmic tone mapping, `PCFShadowMap`).
three's node-material language TSL has ready-made functions:

- `mx_noise_*`, `mx_fractal_noise_*`, `mx_worley_noise_*`, `mx_cell_noise_*`
- `triplanarTexture(s)`, `textureBicubic`

All are confirmed in `build/three.tsl.js`. **They only run under `WebGPURenderer`** (which has its own WebGL2
fallback). Switching renderers is a rendering-system change; CLAUDE.md says to "extend the existing one or
replace it fully". So for Stage 1 the practical path is GLSL in `ShaderMaterial` / `onBeforeCompile`, and
baking.

**Where to compute them.**

1. **Bake at build time (recommended for Medium and High).**
   - A Node script draws each material's maps (albedo, normal, ORM = occlusion/roughness/metalness, optional
     height), deterministically from a fixed seed, at 2048² and below.
   - It writes PNG, then encodes KTX2 (section 4).
   - Zero runtime cost, reproducible, original.
   - Done in plain JS on typed arrays, so it needs no GPU in CI.
2. **Bake at load time on the GPU (good for Low and for variety).**
   - Render a full-screen `ShaderMaterial` into a `WebGLRenderTarget`, generate mipmaps, then use the target's
     texture.
   - About a millisecond per 1K map on a laptop GPU (estimate, not measured here); budget it during the
     loading screen, never per frame.
   - Lets Low use 512² maps with no download.
3. **Shade fully procedurally per pixel.** Only for cheap large-scale variation (macro noise, wetness,
   dirt), because full procedural shading costs fragment time on every pixel every frame.

**Techniques per material** (all original, built from noise, cells and parametric layouts):

- **Brick.**
  - Parametric bonds (running/stretcher, English, Flemish, common/American with a header course every 5–7
    rows), US standard brick size 203 × 57 mm plus 10 mm joints.
  - Per-brick colour from a hash of the brick index (hue, value, burnt headers).
  - Chipped edges from Worley noise on the brick mask.
  - Mortar recess in the height map, then a normal map via a Sobel filter.
  - Painted-brick and soot or efflorescence variants from masks driven by height and a noise
    "water run-off" streak.
- **Asphalt.**
  - Aggregate as a Worley speckle plus fine fBm, with a darker binder.
  - Crack networks from Worley cell borders thresholded by a low-frequency mask.
  - Sealed-crack tar lines; patch rectangles.
  - Polished wheel paths from lane-aware UVs (roads already have lane geometry).
  - Markings as a second texture with a wear mask, not baked into the asphalt, so one asphalt serves every
    road.
- **Concrete and sidewalks.**
  - Slab joints every 1.5 m.
  - Speckle, stains and gum spots from a Poisson-disc scatter.
  - Georgetown brick sidewalks: herringbone and basket-weave layouts.
  - Granite kerbs: low-contrast noise plus a chamfer in the normal map.
  - Cobbles and old tram tracks: Voronoi stones with per-stone height and colour.
- **Stucco, stone, clapboard, slate, standing-seam metal, wood, bark:** layered fBm, ridged noise, stripe and
  plank layouts with per-plank random offsets.
- **Glass and windows.**
  - Reflections from the sky environment map (PMREM).
  - Roughness varied per pane.
  - **Interior mapping** for fake rooms behind the glass: a ray-box intersection in the fragment shader,
    J. van Dongen, 2008 [T3]. Good from the street at almost no geometry cost. Real interiors replace it near
    the player.
  - Night lighting by an emissive window mask with per-window random on/off.

**Hiding repetition** (the owner asked that "buildings should not all have identical textures"):

- Per-building tint, brightness and roughness offsets in an instance attribute or vertex colour, so one
  texture serves many buildings.
- Random UV offset and rotation per facade, in world units, so brick size stays real.
- A **macro variation** layer: a large-scale noise multiply over the tiled texture.
- A **detail** layer at a different frequency.
- **Stochastic / hex tiling** for ground materials:
  - Heitz & Neyret, HPG 2018, histogram-preserving blending [T1]
  - Mikkelsen, JCGT 2022, "hex-tiling", three taps with no preprocessing [T2]
  - I. Quilez's "texture repetition" article [T4] is a cheaper variant (not re-read today)
- Texture **arrays**. `KTX2Loader` returns a `CompressedArrayTexture` when the file has several layers (seen in
  the r187 source). Many facade variants can then share one material and one draw call, with the layer index
  as an attribute.

**Lighting that sells it** (from three r187, all present):

- `PMREMGenerator.fromScene()` on the `Sky` object (`examples/jsm/objects/Sky.js`) gives sky image-based
  lighting. Regenerate it every few game minutes, not every frame.
- `RoomEnvironment` for interiors.
- Keep ACES or switch to AgX tone mapping.
- Shadow cascades or a camera-following shadow frustum to cover the city.
- Fog and haze tied to weather.

## 3. Why compress and what it buys

GPU memory per 2048 × 2048 map (mips add one third):

| Format | Bytes per pixel | 2048² without mips | 2048² with mips |
|---|---|---|---|
| RGBA8 (PNG/JPEG after decode) | 4 | 16 MiB | 21.3 MiB |
| BC7 / ASTC 4×4 (from UASTC or ETC1S on desktop) | 1 | 4 MiB | 5.3 MiB |
| BC1 / ETC1 / ETC2 RGB | 0.5 | 2 MiB | 2.7 MiB |

Example: 16 ground and wall materials × 3 maps at 2K is about 1 GiB as RGBA8 with mips, against about 256 MiB
as BC7. The download is also smaller, because ETC1S is much smaller than PNG. JPEG is small to download but
expands to RGBA8 in VRAM.

## 4. KTX2 / Basis in three.js: what we have and what we would add

**Already in the repo's three 0.187.0** (no new dependency):

- `examples/jsm/libs/basis/basis_transcoder.js` (57,529 B) and `basis_transcoder.wasm` (527,333 B), Apache-2.0.
  Copy them to `public/basis/` and call `ktx2Loader.setTranscoderPath('basis/')`.
- `examples/jsm/loaders/KTX2Loader.js`. `detectSupport(renderer)` chooses the GPU format per device. From its
  `FORMAT_OPTIONS`:
  - ASTC (UASTC only)
  - BC7 (ETC1S priority 3, UASTC priority 2)
  - BC1/BC3 (4/5)
  - ETC2 (ETC1S priority 1)
  - ETC1
  - PVRTC

  So on a typical Windows or Mac laptop with `EXT_texture_compression_bptc`, both ETC1S and UASTC files become
  **BC7**. The loader also handles UASTC HDR (BC6H or ASTC HDR) and cube and array textures. It also has a
  workaround for Mesa drivers that advertise ETC and ASTC they cannot decode in hardware.
- `examples/jsm/exporters/KTX2Exporter.js` writes *uncompressed* KTX2 from a DataTexture (not Basis).
- `examples/jsm/libs/ktx-parse.module.js` (container parser).

**Encoders from npm** (registry checked 2026-11-05 [N1]):

| Package | Version / date / licence | What it is | Fit |
|---|---|---|---|
| `ktx2-encoder` | 0.6.0, 2026-07-19, MIT | Basis Universal compiled to WASM: "KTX2(.ktx2) encoder for browser applications", "Support both Browser and Node.js"; options `isUASTC`, `generateMipmap`; has a glTF-Transform transform | **Best fit**: pure npm, no native binary, runs in the container and CI |
| `@gltf-transform/cli` | 4.5.1, 2026-09-28, MIT | `etc1s` / `uastc` commands | Its own help says it depends on **KTX-Software** (`toktx`/`ktx` CLI from github.com/KhronosGroup/KTX-Software), which is not on npm |
| `basis_universal` | 1.16.4-1, 2025-08-24, MIT | "runs the basis_universal executable" (`npx basisu`), 5 files, 4.3 MB | Bundles a native encoder binary; platform coverage not checked |
| `basisu` | 1.16.3, 2023-01-03, ISC | encoder binaries | Older |
| `sharp` | 0.35.5, 2026-09-27, Apache-2.0 | resize, channel packing, mip prep | Prebuilt native binaries via npm |
| `ktx-parse` | 2.0.0, 2026-09-05, MIT | KTX2 parse and serialise | Already vendored inside three |

Any of these is a **new dev dependency** (build time only, nothing shipped to players). That needs a line in the
plan per CLAUDE.md.

**Settings that work:**

- **Albedo and ORM:** ETC1S (smallest) for distant and large-area materials; UASTC + zstd for close-up
  materials.
- **Normal maps:** always UASTC. ETC1S blocks are visible in normals. Store XY only and reconstruct Z.
  Mark non-colour maps linear and albedo sRGB.
- **Mipmaps:** always. Anisotropy 4 on Low, 8 on Medium, 16 on High.
- **Preset resolutions:** Low 512–1K, Medium 1K–2K, High 2K. Pick the folder by preset at load.

## 5. What the owner must allow in the environment's network settings

Today the session's policy refuses `ambientcg.com`, `dl.polyhaven.org`, `api.polyhaven.com` and
`www.openstreetmap.org`. The agent proxy's own failure log shows these as 403 at 2026-11-04 23:55 UTC. The other
CC0 sites above are refused too.

**How the owner changes it** (Claude Code docs, "Cloud environments → Network access" [C1]):

1. Open the cloud environment's settings (environment menu → Edit) and choose **Network access → Custom**. Newer
   app versions call it Limited, with an "Allowed domains" field.
2. Tick **"Also include default list of common package managers"** so npm, PyPI and GitHub keep working.
3. Add one domain per line. A leading `*.` matches subdomains.
4. Existing sessions pick up the change within about a minute.

**Domains to add:**

```
ambientcg.com
*.ambientcg.com
polyhaven.com
api.polyhaven.com
dl.polyhaven.org
cdn.polyhaven.com
```

- `*.ambientcg.com` covers docs and API v3. ambientCG's download links redirect to a raw-file host that I could
  not see from here. If a download fails, read the proxy status and add the redirect host.
- `polyhaven.com` is for the licence and FAQ pages. `dl.polyhaven.org` serves the files. `cdn.polyhaven.com`
  serves thumbnails and is optional.

Optional:

- `sharetextures.com`, `www.sharetextures.com`, `texturecan.com`, `kenney.nl`
- for licence pages: `creativecommons.org`
- for the research sources this session could not open: `developers.google.com`, `mapsplatform.google.com`,
  `docs.overturemaps.org`, `osmfoundation.org`, `www.openstreetmap.org`, `opendatacommons.org`, `cdla.dev`

**No-network alternative.** The owner downloads the chosen zips on their own machine and adds them to the repo
(or to a folder the session can read). We process them offline.

**Either way:**

- Self-host the processed KTX2 files in `dist/`. Never hotlink asset sites from the game: it adds a runtime
  dependency, and for Poly Haven's live API it would trigger the credit clause.
- Send a User-Agent such as `OpenCity-asset-fetch/1.0` from any fetch script [P1 §2.4].

## 6. Recommendation for Stage 1 item 4

1. A build-time bake script (`scripts/bakeTextures.mjs`) for ~16 procedural materials. Exactly the list in
   ROADMAP item 4: asphalt, worn markings, concrete, brick sidewalks, granite kerbs, three brick bonds × colours,
   painted brick, stone, stucco, clapboard, slate, metal roof, glass and frames, metal, wood, grass, bark,
   cobbles and tram tracks.
2. Output KTX2 via `ktx2-encoder` (new dev dependency), transcoded by the copy of three's Basis transcoder.
3. Hide repetition with per-building instance variation plus macro noise and hex tiling on ground materials.
4. If the owner allows the CC0 hosts, swap in scanned asphalt, brick, concrete and cobbles from ambientCG or
   Poly Haven. They go through the same KTX2 pipeline, and every file is listed in `assets/LICENSES.md`.

## Sources (read or searched on 2026-11-05)

- [P1] Poly Haven API Terms of Service (read in full). https://github.com/Poly-Haven/Public-API/blob/master/ToS.md
- [P2] Poly Haven Public API README (read in full). https://github.com/Poly-Haven/Public-API
- [S] Search extracts of: https://docs.ambientcg.com/license · https://docs.ambientcg.com/api/v2/ · https://polyhaven.com/license · https://polyhaven.com/faq · https://www.sharetextures.com/ · https://texturecan.com/terms/ · https://3dtextures.me/about · https://kenney.nl/support · https://opengameart.org/content/5-low-poly-animals (Quaternius) · https://poly.pizza/bundle/Restaurant-Bits-ejkcnWf78Q
- [L1] CC0 1.0 Universal (SPDX copy, read in full). https://raw.githubusercontent.com/spdx/license-list-data/main/text/CC0-1.0.txt (canonical: https://creativecommons.org/publicdomain/zero/1.0/legalcode)
- [N1] npm registry: https://registry.npmjs.org/ktx2-encoder, /@gltf-transform/cli, /basis_universal, /basisu, /sharp, /ktx-parse, /3d-tiles-renderer; glTF-Transform CLI source (KTX-Software dependency text): https://github.com/donmccurdy/glTF-Transform/blob/main/packages/cli/src/cli.ts
- [C1] Claude Code docs, Cloud environments: network access. https://code.claude.com/docs/en/cloud-environments#network-access
- [T1] E. Heitz, F. Neyret, "High-Performance By-Example Noise using a Histogram-Preserving Blending Operator", HPG 2018 (cited via search results; see also the Unity write-up https://unity.com/vn/blog/engine-platform/procedural-stochastic-texturing-in-unity)
- [T2] M. Mikkelsen, "Practical Real-Time Hex-Tiling", JCGT 11(3), 2022. https://jcgt.org/published/0011/03/05/
- [T3] J. van Dongen, "Interior Mapping: A new technique for rendering realistic buildings", CGI 2008 (from general knowledge, not re-read today)
- [T4] I. Quilez, "Texture repetition". https://iquilezles.org/articles/texturerepetition/ (from general knowledge, not re-read today)
- three.js 0.187.0 source in node_modules: `examples/jsm/loaders/KTX2Loader.js`, `examples/jsm/libs/basis/README.md`, `examples/jsm/exporters/KTX2Exporter.js`, `examples/jsm/objects/Sky.js`, `examples/jsm/environments/RoomEnvironment.js`, `src/extras/PMREMGenerator.js`, `build/three.tsl.js`
