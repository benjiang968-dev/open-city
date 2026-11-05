# Visual audit: causes of the owner's five complaints (Stage A, 2026-11-05)

The owner played the preview build (artifact Lyhb23SQNciG4AURUfPtET, code = branch `before-preview`, c109c1c) and
listed five visual problems: grainy asphalt and markings, flat repetitive facades, block-shaped people and vehicles,
patchy disconnected foliage, washed-out artificial lighting. This document finds the causes in the code, proves each
one with a controlled experiment, and sets the acceptance standard the render, people, vehicles and facade lanes will
be judged by. It changes no game code.

The causes in brief (details, file:line and proof in sections 3-7):
- **Grainy asphalt:** the baked asphalt is a 6.6:1 contrast of near-black binder and pale 1-2 cm stones with
  per-texel noise; mipmaps, filtering, anisotropy, colour spaces and the metre-scaled projection are all correct, and a
  4x finer bake (High) leaves the screen grain unchanged. Not shadow acne, not normal maps, not z-fighting (markings
  do lie under other road surfaces at some junctions: a small roads issue).
- **Flat facades:** each wall is one flat quad per band with windows, doors and frames painted into a tile; the only
  relief is a weak normal map; one tile for every upper bay of a building.
- **Block people and cars:** they are literally boxes: 7 boxes per person with rigid swinging limbs; two boxes per car
  with box wheels (round wheels only on the car you drive).
- **Patchy foliage:** single 6-9 cm leaves under an alpha test on ~40 big plates around an opaque dark ball; branch
  ends poke out; near trees cast no shadow; 20-face gems beyond 110 m; and a random 20 % (Medium) or 55 % (Low) of all
  trees is never drawn, even next to you.
- **Washed-out light:** the sky is reflected and lets in diffuse light everywhere with no occlusion (no AO, no
  buildings in the environment, the bright horizon reflected at street level); removing either its reflection or its
  diffuse part alone raises the street frame's saturation from 0.23 to 0.30; shade is lit by blue sky alone; clear-day
  fog from 180 m milks every
  elevated view. Tone mapping, exposure and colour management are not the cause.

## 1. What was compared, and how

| | build | how it was made |
|---|---|---|
| BEFORE | `scratchpad/before-dist` (the bundle the owner played; c109c1c = s1-look + s1-realdata) | served read-only |
| base | s1-integrate 7183f1f (Stage 1 integration), built in this branch | `npm run build` |

The render code is identical in both: `git diff before-preview s1-integrate -- src/systems/render` is empty. The base
build differs only in geometry and collision (stoop colliders, stairwell holes, bridge fixes, solid-kind tags), so
every cause below is present in both builds; the BEFORE and base screenshots of the same view look the same apart from
where people and traffic happen to be (section 9).

Tools (both new in this branch):
- `scripts/viewShots.mjs`: reproducible views of the running game from any dist folder. Fixes seed (1), game time
  (11:00, held within one game minute), clear weather, preset (Medium), resolution (1280x720, device pixel ratio 1;
  `--hd` for 1920x1080), the camera position and look-at (absolute heights pinned to the base build's ground, so a
  build that moves the ground by a few cm is still shot from the same point; `--follow-ground` to use the shot build's
  ground instead), the sky's cloud clock; hides the player and the HUD (the canvas is read back, no DOM overlay); seeds
  `Math.random` and holds the game's own loop from the moment it publishes `__oc`, so the whole simulation is stepped
  with fixed steps by the script and nothing moves between steps. It uses only hooks that the BEFORE build already has
  (`__oc`, `__ocRun`, `__ocFrames`, `cam.override`). Reproducibility is measured in section 10.
- `scripts/viewExperiments.js`: in-page experiments run through `viewShots.mjs --exp`, with variants
  (`view@variant`): mip level 0 only, tile-average albedo, normal maps off, macro variation off, mip-level false
  colour, shadows off, alpha to coverage off, leaf cards off, wireframe, every lighting term on/off, sky reflections
  and sky diffuse light off separately, and an overlap / z-fighting probe of the road meshes (`zfight`). It reads the
  baked texture arrays back from the GPU level by level.

Test conditions, stated honestly: headless Chromium (Playwright) with SwiftShader (software Vulkan through ANGLE), no
GPU; MSAA 4x (`gl.SAMPLES` 4), max anisotropy 16; Medium preset unless stated (512 px surface maps, anisotropy 8,
1536 px shadow cascades to 320 m, near trees to 110 m); 1280x720 at device pixel ratio 1; a shared 4-core machine (load
13-14 during the first experiments x1-x3, 0-7 during the final captures). SwiftShader renders the same pixels a GPU
would for everything measured here except speed (no frame time in this document is meaningful) and possibly the exact
alpha-to-coverage pattern. Image metrics come from `scripts/viewMetrics.py` (luminance of the sRGB PNG; "grain" = the
standard deviation of the luminance minus its 2 px Gaussian blur, x1000, in three fixed road regions of `road-far`:
near 3-8 m, mid 10-20 m, far 60-150 m).

Reproduce (each line is one browser; run them one at a time):

    npm run build
    node scripts/viewShots.mjs --dist <before-dist> --prefix 40-before rep street2 street3 door people car tree road-far aerial spawn
    node scripts/viewShots.mjs --dist dist --prefix 40-base rep street2 street3 door people car tree road-far aerial spawn
    python3 -I scripts/viewMetrics.py compare screenshots 40-before 40-base
    # experiments (x1 road, x5 lighting and overlap, x4 Low, x6 High, x7 junction)
    node scripts/viewShots.mjs --dist dist --prefix x1 --out <scratch> --exp scripts/viewExperiments.js \
      road-far@texinfo road-far road-far@nomip road-far@avgalb road-far@nonrm road-far@nomacro road-far@miplod road-far@noshadow road-far@env0
    node scripts/viewShots.mjs --dist dist --prefix x5 --out <scratch> --exp scripts/viewExperiments.js \
      rep rep@env0 rep@envspec0 rep@envdiff0 rep@hemi0 rep@sun0 rep@onlysun rep@skydiff1 rep@exp1 rep@agx rep@neutral rep@nofog \
      rep@noshadow rep@avgalb road-far road-far@zfight road-far@envspec0 road-far@avgalb road-far@nonrm aerial aerial@nofog tree tree@nocards
    node scripts/viewShots.mjs --dist dist --prefix x2 --out <scratch> --exp scripts/viewExperiments.js \
      tree tree@a2coff tree@nocards door@wire door@nonrm people@wire car@wire
    node scripts/viewShots.mjs --dist dist --prefix x4 --quality low --out <scratch> --exp scripts/viewExperiments.js rep tree road-far road-far@texinfo aerial
    node scripts/viewShots.mjs --dist dist --prefix x6 --quality high --out <scratch> --exp scripts/viewExperiments.js rep tree road-far road-far@texinfo
    node scripts/viewShots.mjs --dist dist --prefix x7 --out <scratch> --exp scripts/viewExperiments.js junction junction@zfight junction-top
    python3 -I scripts/viewMetrics.py stats <scratch>/x5-*.png

(x1 and x2 were shot before the script pinned camera heights and held the loop from boot; their cameras differ from
the final ones by under 1 cm, and the static pixels of road-far match the final capture: grain 95.5 / 34.0 / 28.2 in
both. x2's tree shots used the earlier tree framing, FOV 62 and look-at 3.1 m.)

## 2. The views

Coordinates: x east, z south, y up, metres; camera heights are given above the ground under the camera, and the
script pins them as absolute heights measured on the base build (camera / look-at y: rep 22.743 / 24.016, street2
27.023 / 33.889, street3 24.315 / 31.756, door 29.185 / 29.585, people 22.775 / 22.130, car 23.018 / 22.118, tree
22.720 / 24.720, road-far 22.243 / 22.243), so every build is shot from the same point. Game time 11:00, clear, seed 1.

| view | camera -> look-at | what it is for |
|---|---|---|
| **rep** | (-277.3, +1.7, 141.0) -> (-200, +2.8, 151.5) | **The representative street**: M St NW, 3200 block (between Wisconsin Ave and Potomac St), north pavement at the kerb, eye height, looking east. It is on the spawn street (the spawn is at (-648, 170) on M St by Key Bridge, 370 m west) and it is the block with the most of what the owner judges at once. Chosen from a scan of every 60 m of 13 streets (M St, Wisconsin Ave, N St, O St, P St, Prospect St, Dumbarton St, 29th-31st St, 33rd St, Potomac St) counting street trees, parked cars, shops and buildings within 35 m: the stretch at (-266, 150) has the most street trees (10, both kerbs, about 12 m apart) and the most parked cars (16) of all of M St, with 15 shops and offices in 14 two- to four-storey Federal rowhouse fronts with signs and awnings, lamps, a four-lane carriageway with lane markings and a double yellow line, and the busiest pavements in the game (M St at lunch is the crowd's busiest place). |
| street2 | (-446, +1.7, -27.2) -> (-560, +5, -35) | N St NW, 3300 block: residential rowhouses with stoops, uphill. (No data trees on this block.) |
| street3 | (-147, +1.7, 104.5) -> (-158, +6, 20) | Wisconsin Ave NW between M St and Prospect St: the main shopping street, uphill, trees both sides. |
| door | (-512.12, +1.6, -25.2) -> door at (-512.12, -21.2) | a rowhouse front door with a five-step stoop and iron rails, N St, from the pavement 4 m away. |
| people | (-267.5, +1.65, 140.6) -> (-259.5, +1.0, 139.0), FOV 55 | six people placed idle 4-8 m away on the M St pavement. |
| car | (-245, +1.6, 138.4) -> (-241, +0.7, 141.4), FOV 55 | the parked sedan at (-241, 141.4) on the M St north kerb from 5 m, three-quarter front. |
| tree | (-265.4, +1.6, 139.3) -> tree at (-271.3, 140.2) | an M St street tree from 6 m. |
| road-far | (-300, +1.7, 147.3) -> (-80, +1.7, 145.4) | M St carriageway at eye height; the road recedes past 200 m (the "television static" test). Traffic hidden. |
| aerial | (-420, 190, 380) -> (-200, 21, 140), FOV 55 | over the waterfront looking north-east at M St and Wisconsin Ave. |
| spawn | the game's own follow camera at the spawn | what the game shows when it starts (player visible). |

## 3. Complaint (a): grainy asphalt and road markings

**Symptom.** The carriageway is salt-and-pepper: light specks on near-black, high contrast, at every distance a
player sees it (on foot the first 15 m, from the car's chase camera much more). The pattern has no structure, so it
crawls when the camera moves.

**Root causes.**
1. *The asphalt texture is white noise at texel scale, with extreme contrast.* `asphalt()`
   (src/systems/render/bakeShaders.ts:82-108) builds the albedo from 22 mm stones (line 84), 9 mm grit (86) and 4 mm
   noise (88), with near-black binder (89, sRGB 0.21) against stones up to sRGB 0.60 (90), times two more noise
   factors (93). The 4 m tile (src/systems/render/surfaces.ts:106) is baked at 256/512/1024 px per preset
   (src/tuning.ts:864-866), i.e. 15.6/7.8/3.9 mm per texel: the 4 mm and 9 mm features are smaller than two texels at
   Medium and the 22 mm stones are under three texels. The bake evaluates each texel once at its centre
   (src/systems/render/texBake.ts:90 renders one full-screen pass per layer, no supersampling), so those features
   are point-sampled into independent random values per texel.
2. *Mipmaps, filtering and projection are correct*: they average the noise away with distance as they should, but
   the first three mip levels (all of the road within ~15 m at eye height) keep most of the contrast.
3. The same class of under-sampled detail is in other surfaces (scan of every `cyc()` feature size against the texel
   size, `scratchpad/av/tools/features.py`): at Medium, granite has 2 of 3 features under two texels (stoop steps and
   kerbs show the same speckle, see the door view), and grass, concrete slab, brick paver sand, setts, stucco,
   clapboard, roof tar, brick walls and canvas have one each.
4. Road markings are geometry, not noise: decal strips lifted 12 mm (src/systems/map/roadMesh.ts:16) with a polygon
   offset (src/systems/render/worldMaterial.ts:196), drawn with the paint layer, whose own texture is smooth
   (neighbour correlation 0.92). Their grain is the asphalt showing through the worn areas: `paint()` mixes the asphalt
   albedo in where worn (bakeShaders.ts:110-126). Markings and decal paths vanish beyond 0.6 x the chunk draw distance
   (src/systems/map/georgetownWorld.ts:434), a visible pop.

**Experiments** (road-far view, Medium; grain x1000 in three regions of the road: near 3-8 m, mid 10-20 m, far 60-150 m):

| variant | near | mid | far | reading |
|---|---|---|---|---|
| as built | 95.3 | 33.8 | 27.8 | |
| `avgalb`: every albedo replaced by its tile average | **11.2** | 20.9 | 27.7 | the grain is the albedo texture (8.5x less near) |
| `nonrm`: normal/roughness/occlusion maps off | 87.3 | 31.6 | 26.5 | normal maps contribute ~8 % |
| `noshadow`: sun shadows off | 95.2 | 33.7 | 27.7 | no shadow acne |
| `nomacro`: macro variation off | 94.2 | 33.7 | 27.4 | not the macro field |
| `nomip`: mip level 0 only | 106.3 | **97.9** | **80.2** | what broken mipmaps would look like: 3x the mid/far grain, so mipmaps work |
| `env0`: sky light off | 100.6 | 43.4 | 42.3 | sky reflection is not the grain source |

The far region's 27.7 is geometry (cars, kerbs, markings) in the region: it does not change when the albedo goes flat.

GPU read-back of the baked asphalt (`texinfo`; linear luminance of layer 0, Medium):

| mip level | size | mean | sd | sd/mean | 10th-90th pct | neighbour corr. |
|---|---|---|---|---|---|---|
| 0 | 512 | 0.097 | 0.072 | **74 %** | 0.032-0.210 (6.6x) | **0.30** |
| 1 | 256 | 0.097 | 0.047 | 48 % | 0.044-0.163 | 0.03 |
| 2 | 128 | 0.097 | 0.024 | 25 % | 0.069-0.128 | 0.01 |
| 3 | 64 | 0.097 | 0.012 | 12 % | | |
| 9 | 1 | 0.098 | | | | |

The standard deviation halves per level with the mean preserved and neighbouring texels uncorrelated: a correct mip
chain of a texture that is independent noise per texel. Texture setup is correct for three r187: albedo array sRGB
(SRGB8_ALPHA8), normal/roughness/occlusion array and macro texture linear, `LinearMipmapLinearFilter`, mipmaps
generated once after the last layer (texBake.ts:88/96), anisotropy 8 on Medium, sampled with `textureGrad` on
screen-space derivatives of the world-space uv (worldMaterial.ts:80-84), tiles scaled in metres. The `miplod` false
colour shows level 0 only in the bottom rows of the frame (the first ~3 m), levels 1-2 to ~15 m, 3-4 to ~50 m. Normal
map: mean tilt 0.10 at level 0 (none over 0.3), 0.01 at level 3: modest, no specular sparkle.

*It is not a texture-resolution problem.* The same view on the three presets (x4 Low, x5 Medium, x6 High; Low's
0.7-scale canvas resized to 1280x720 for the metric):

| preset | surface map | texel | asphalt mip 0: sd/mean, 10th-90th pct, neighbour corr. | grain near / mid / far |
|---|---|---|---|---|
| Low | 256 px | 15.6 mm | 74 %, 0.032-0.210, -0.07 (pure per-texel noise) | 52.0 / 17.1 / 16.1 (blurred by the 0.7 canvas) |
| Medium | 512 px | 7.8 mm | 74 %, 0.032-0.210, 0.30 | 95.5 / 34.0 / 28.2 |
| High | 1024 px | 3.9 mm | 74 %, 0.032-0.210, 0.64 (the 22 mm stones resolved) | 94.4 / 32.5 / 28.3 |

Four times the texels per tile resolves the stones but leaves the screen grain where it was: the material itself is a
6.6:1 contrast between near-black binder and pale stones at the 1-2 cm scale, and that is what the eye reads as salt
and pepper. Removing the sky reflection (`road-far@envspec0`) makes the near grain worse (112.5): the reflection
lowers the contrast, it does not cause it.

*Overlapping surfaces and z-fighting* (`zfight` probe on the ground and marking meshes, 0.2 m sample grid, exact
triangle hits; x5/x7):

| study box | ground samples with a 2nd ground triangle within 3 cm of the top one | of which a different surface on top | marking samples under the top ground | marking less than 5 mm above it | paint on paint within 3 mm |
|---|---|---|---|---|---|
| M St 3200 block (rep, road-far) | 2.42 % (2.36 % exactly coplanar) | 0.02 % (painted trim 2 cm over concrete at (-262.5, 138-139)) | 0 of 1,204 | 0 | 0 |
| M St / Wisconsin Ave junction | 2.98 % | 0.21 % | **12.1 %** of 3,472 | 3.6 % | 0 |
| Wisconsin Ave (street3) | 2.70 % | 0.09 % | 5.8 % of 2,356 | 2.3 % | 0.1 % |
| N St 3300 block (street2) | 1.87 % | 0 | 1.8 % of 1,041 | 0.2 % | 4.2 % |

Coplanar ground overlaps are the same surface on both sides (asphalt on asphalt where two carriageway polygons meet at
a junction, or paving on paving) and sample the same world-space texture, so they cannot flicker between two looks.
Markings under another road surface exist at junctions: at M St / Wisconsin 157 samples within 2 cm under (these can
flicker through the decal's polygon offset at grazing angles), 117 at 2-5 cm and 145 deeper (hidden for good, down to
15 m under at (-170, 112.5) and 8 m at (-120.5, 130-134): markings of a road that runs under a raised surface); on
Wisconsin Ave 5-9 cm under at (-146.5, 104.5) and (-136..-133, 104.5). The eye-level and top-down junction views
(x7-junction, x7-junction-top) show clean markings and no flicker in a still frame; a moving-camera check is still
open. Conclusion: overlapping surfaces are not the grain; they are a small road-geometry issue at junctions for the
roads lane (the probe is in the tool to re-run).

**Fix plan (render lane).**
- Replace the asphalt (and the other ground layers) with a restrained material: either a properly licensed CC0 asphalt
  PBR set (albedo, normal, roughness; 2-4 m tile, KTX2) from the asset scout, or a rebuilt bake whose finest feature
  is at least 2 texels at the preset's resolution and that is supersampled (e.g. 4x4 per texel). Target at mip 0:
  linear luminance sd/mean <= 15 %, 10th-90th percentile ratio <= 1.6, mean linear albedo 0.08-0.12.
- Put the interest at the metre scale instead: tyre-polished wheel paths, patch repairs, crack sealing, oil stains,
  kerb-side dirt, as world-space masks; keep the macro field but with a lower amplitude on roads.
- Same rule for granite, concrete, pavers, setts, grass, stucco, clapboard, roof tar, brick and canvas.
- Markings: keep them as geometry; give the paint wear at centimetre scale with clean edges, no aggregate speckle;
  fade distant decal chunks instead of hiding them at 0.6 x draw distance.
- Keep the mip chain, filtering and metre-scaled projection (verified); add specular anti-aliasing (roughness from the
  normal-map variance per mip) when stronger normal maps arrive. A higher bake resolution alone changes nothing
  (High = Medium in grain).
- Roads lane: no marking under another road surface within 5 cm (re-run `zfight` on the four boxes: 0 % under, 0 %
  less than 5 mm above); trim or drop the decals of a road where another surface covers it.

## 4. Complaint (b): flat, repetitive facades

**Symptom.** Walls read as printed wallpaper: windows, doors, frames and shopfronts have no depth; every bay of a
building is the same and so is every storey.

**Root causes.**
1. *Every wall is one flat quad per band.* `fquad()` (src/systems/map/facades.ts:442-453) emits two triangles per wall
   for the ground floor, two for all upper floors together and two for the parapet (calls at facades.ts:243-260).
   Windows, doors, frames and shopfronts are pixels in a tile texture, not geometry. The `door@wire` wireframe shows the
   rowhouse front as a few triangles spanning the whole frame; the only geometry in front of it is the stoop, the
   rails and the door canopy box.
2. *The relief is a weak normal map.* The tile aux map holds a height of -3 cm for frames and -8 cm for glass, blurred
   twice (src/systems/map/facadeTex.ts:290-294), used only as shading normals (facadeMaterial.ts:127-132). No
   parallax, no self-shadowing, no reveal: windows and doors sit flush with the brick. With the surface normal maps
   off (`door@nonrm`) the door view is unchanged: the relief does not register at all.
3. *Interior mapping is inside the glass only.* `fRoom()` (src/systems/render/facadeMaterial.ts:62-101) traces a room
   behind each pane: it gives parallax inside the window but the window itself is still painted on a flat wall.
4. *Repetition.* 24 hand-drawn tiles (facadeTex.ts:6-11, 128 px drawn, 256 px stored, 1.2 cm/px) for the whole
   district; one tile for all upper bays and storeys of a building (`tileUp`, facades.ts:258), one ground tile plus a
   door bay; the bay width is fixed per building type (facades.ts:176-232). Variety comes only from the wall colour,
   the brick bond and a few landmark keys.
5. Some geometric depth exists and is worth keeping: sills (facades.ts:270-283), cornices (facades.ts:262-268), stoops
   with rails, door canopies (facades.ts:322), awnings and signs.

**Fix plan (facade lane).**
- Build walls from modules with real depth: window openings with 10-20 cm reveals (frame, sash, glass set back,
  projecting sill and lintel), recessed doorways (door 20-40 cm behind the face with jambs and a step), shopfronts with
  stall risers, mullions, recessed entrances, fascia and sign band; cornices, parapets, chimneys, roof edges as
  geometry. Instanced or merged per chunk, LOD to the current flat tile beyond ~60-100 m.
- Vary per bay and storey from the building seed (window type, shutters, sill, lintel, blinds, a lit or dark room)
  and per building (bay rhythm from the real frontage, ground floor kind from the POI category).
- Keep interior mapping behind the glass for windows that cannot be entered (and fit it to the new reveals).

## 5. Complaint (c): block-shaped people and vehicles

**Symptom.** People are stacks of coloured boxes with an eye band; cars are two boxes with box wheels.

**Root causes.**
- *People are boxes.* The player is `makePerson()` (src/art/person.ts:16-46): torso, head, hair and eye band boxes
  (lines 19-22), four box limbs pivoting at hip and shoulder (38-41), about 90 triangles. The crowd draws the same
  boxes as instanced parts (src/systems/crowdRender.ts:39-63). Animation is one sine swing of rigid limbs
  (person.ts:48-54, crowdRender.ts:129-133): no skeleton, no knees or elbows, no distinct run, jump or idle.
  Material: flat-shaded cloth with a white sheen (src/systems/render/vehicleMaterials.ts:53-57) that adds a pale rim
  and makes all clothes pastel.
- *Cars are boxes.* `buildCarParts()` (src/art/car.ts:37-89): a body box and a cabin box per type (lines 41-63), glass
  and lamps as flat quads on the box faces, bumpers as boxes. Parked and AI cars get box wheels
  (car.ts:179, src/systems/parkedCars.ts:81-87); only the car you can drive gets 10-sided cylinder tyres with 6-sided
  hubs (car.ts:163-169). No wheel arches, no bonnet or boot slope, no interior. The car material is clearcoat on all
  paint with metalness 0.35 and flat shading (vehicleMaterials.ts:11-15), so each box face is one flat mirror of the
  sky.
- The `people@wire` and `car@wire` wireframes show it directly.

**Fix plan (people and vehicles lanes).**
- People: properly licensed (CC0 / CC BY) rigged human models with skeletal idle, walk, run and jump clips (glTF,
  `SkinnedMesh` + `AnimationMixer`); a few body types with material variants for clothes, skin and hair; near people
  fully animated, mid distance instanced with baked animation or reduced update rate, far as impostors. Keep the
  capsule collider and the existing ped state machine; drive clips from `moveAmount`, state and arm pose. The player
  uses the same rig.
- Cars: real-proportioned models (bonnet, windscreen rake, roof, boot, wheel arches, separate wheels at the physics
  wheel positions, glass with an interior behind it, head and tail lamps); one model per car type, paint as a material
  parameter; wheels as separate instanced meshes driven by the raycast wheel state. Parked and AI cars get the same
  wheels (no boxes). Keep the chassis collider sizes unless the physics lane changes them.

## 6. Complaint (d): patchy, disconnected foliage

**Symptom.** Near trees are a dark ball inside a ring of speckled plates; the speckle crawls; branch ends poke out;
the shadow under the tree is a polygon; trees further than the near radius are faceted 20-face gems (every tree on
Low).

**Root causes.**
1. *The leaf texture is pixel-scale detail under an alpha test.* `foliage()` (bakeShaders.ts:281-297) fills the 1.6 m
   tile with individual leaves 6-9 cm across (worley cells of 0.085 and 0.06 m), with partial coverage between clumps
   (`cover *= mix(0.25, 1.0, clump)`, line 290). On screen a leaf is about 3 px at 6 m and under 1 px at 20 m, cut by
   `alphaTest 0.5` (worldMaterial.ts:198) with the alpha pushed up in smaller mips (worldMaterial.ts:136-146): the
   result is per-pixel speckle. `tree@a2coff` (alpha to coverage off) shows the same speckle: it is not an
   alpha-to-coverage dither, it is the texture.
2. *The canopy is ~40 big flat plates on a shell.* `nearTree()` (src/systems/render/trees.ts:100-160) places 38-46
   cards of 1.2-2.6 m (CROWNS, trees.ts:93-97) tangentially on an ellipsoid at 0.82-1.02 of its radius with random
   tilt. `rep@avgalb` (alpha averaged over the tile) shows them as discs. Seen from the side they stick out of the
   outline as separate patches; between them the sky shows through.
3. *An opaque dark ball fills the middle.* The "inner crown" is an icosphere (detail 1) at 0.72 of the crown radius
   with the leaf texture (trees.ts:120-126); `tree@nocards` shows it alone: a dark faceted ball on a stick.
4. *Branch ends poke out.* Five branches end at up to 0.7 rx sideways and cy + 0.3 + 0.5 ry up (trees.ts:111-117):
   dark sticks above the crown in every tree shot.
5. *Shadows do not match.* Near trees (wood and cards) cast no shadow (trees.ts:202-203); the shadow comes from the
   far LOD crown (an icosahedron, trees.ts:207, src/systems/map/props.ts:456-482), a polygonal blob.
6. *LOD.* Beyond `treeNear` (110 m Medium, 200 m High, **0 on Low**: src/tuning.ts:864-866) a tree is a 6-sided trunk
   under a 20-face icosahedron (props.ts:447-482, flat-shaded material props.ts:175, later given the leaf texture). The
   switch is a hard cut at the radius.
7. *Trees are missing at random, also right next to you.* The quality's tree share (`GEO_QUALITY.*.trees`: Low 0.45,
   Medium 0.8, High 1; src/systems/map/georgetownWorld.ts:39-43, outside tuning.ts) cuts each species' instance count
   (props.ts:432-434) after the instances were sorted by a random rank (props.ts:120, 177), and the near set skips
   the cut instances too (trees.ts:237). So Medium never draws a random 20 % of all trees and Low 55 %, wherever the
   player stands: rows of street trees have gaps. Proof: on Low (`x4-tree`, probe x8) the M St tree 6 m in front of
   the `tree` camera is not drawn at all; the nearest drawn tree is 20.5 m away (0 far-tree instances within 15 m).

**Fix plan (render lane, trees).**
- Use coherent tree models (licensed CC0/CC BY or generated) per species with a connected trunk, branch structure and
  leaf clusters: leaf cards carrying sprigs of 20-40 cm (whole branchlets, not single leaves) placed on the branches,
  a texture whose alpha survives mipmapping (coverage-preserving mips or alpha to coverage with sharpened alpha), no
  opaque inner ball, no branch ends outside the foliage.
- Near trees cast their own shadows (a depth material with the alpha test); mid distance a simplified crown with the
  same silhouette; far an impostor (octahedral or a few crossed billboards) with a dithered cross-fade instead of a
  hard cut. Low gets a cheap but rounded far model, not a gem.
- Thin trees by distance, not at random: every tree within ~150 m is drawn on every preset (a preset may thin the far
  field only); the share moves to src/tuning.ts.

## 7. Complaint (e): washed-out, artificial lighting

**Symptom.** Everything is pale and low in contrast; shadows are flat blue-grey; dark objects (lamp posts, rails,
tyres, asphalt) look light blue-grey; objects look pasted onto the ground; the distance from any height is milky.

**Root causes.**
1. *The sky is reflected everywhere, unoccluded.* The environment map is a capture of the sky plus a uniform grey
   ground disc (src/systems/render/sky.ts:52-63, 89-100): no buildings in it, and no screen-space or baked
   occlusion anywhere (no post-processing at all: main.ts draws `renderer.render(scene, camera)` directly; no SSAO,
   no AO maps). The only occlusion applied is the texture-scale cavity term (worldMaterial.ts:236,
   facadeMaterial.ts:161). So every surface, in a street canyon, under an awning or a tree, reflects the full bright
   sky dome at Fresnel strength. At street level the reflection vector of the road and of every wall points near the
   horizon, which in the capture is the brightest, palest part of the sky and in a real street is the buildings
   opposite. Measured on `rep` (x5; the two halves of the sky light switched off separately, every material):
   the sky light as a whole lifts the mean frame luminance from 0.360 to 0.535 and cuts the mean saturation from 0.351
   to 0.232; its reflection (indirect specular) alone accounts for 0.076 of the luminance and 0.070 of the
   saturation (`envspec0`: 0.459 / 0.302), its diffuse part for 0.073 and 0.067 (`envdiff0`: 0.462 / 0.299). With
   the reflection off, the door, the lamp posts, the car paint and the asphalt take their own colours back (dark
   teal door, saturated paint); with the diffuse part off, everything in shade turns sky-blue, because what is left
   there is the reflection of the sky. Dark painted lamp posts and rails turn light blue (`door`, `rep`), the road
   turns blue-grey, car paint (clearcoat on every car, vehicleMaterials.ts:11-15) turns pastel. Switching the sky
   light off altogether is not the answer: `env0` crushes 22 % of the frame to black (luminance under 10/255).
2. *Shade is lit only by blue sky.* With the sun off (`rep@sun0`) the street is uniformly blue. The sky's diffuse share
   is cut to 0.42 and desaturated to 0.55 (src/tuning.ts:884-889; applied at worldMaterial.ts:234-235) as a stand-in
   for warm bounce light, but there is no bounce light from sunlit facades and pavements and no occlusion, so shaded
   sides are flat, cold and the same everywhere.
3. *No contact shadows / ambient occlusion.* Wall-pavement corners, car undersides, feet, kerbs, steps and window
   reveals get no darkening, so objects float and nothing has weight.
4. *Haze from 180 m.* Clear weather keeps linear fog from 180 m to 750 m in the sky-horizon colour
   (src/systems/dayNight.ts:58, src/systems/weather.ts:22, 152-155). In the street views it has no measurable effect
   (`rep@nofog` identical), but from any height (bridges, the aerial view) half the frame is milky: `aerial` mean
   luminance 0.708 with fog, 0.661 without (x5). Real clear-day visibility is tens of kilometres.
5. *Pale, clipped sky.* The Preetham sky (sky.ts:28-51, turbidity 3.2) goes white towards the horizon under ACES at
   exposure 0.86: 12.9 % of the aerial frame is clipped (any channel > 250).
6. Tone mapping and exposure are not the main cause: ACES (main.ts:60) at 0.86 (src/tuning.ts:899) clips 0.5 % of the
   `rep` frame; AgX gives 0.07 % clipped and a flatter, paler frame (sd 0.184, saturation 0.194); Khronos Neutral
   clips 15.5 %; exposure 1.0 clips 1.9 % and is paler. The hemisphere fill (0.12) has no measurable effect
   (`rep@hemi0`: mean 0.534 vs 0.535). Shadow settings are fine
   (PCF, radius 2.2, two cascades; `noshadow` changes nothing but the shadows). Colour management is correct: vertex
   colours linear, albedo arrays and facade tiles sRGB, data maps linear, sRGB output.

Tone statistics of the `rep` frame (x5, final rep camera; sRGB luminance; `viewMetrics.py stats`):

| variant | mean | sd | 5th pct | % clipped | % crushed (<10/255) | mean saturation |
|---|---|---|---|---|---|---|
| as built | 0.535 | 0.239 | 0.132 | 0.52 | 0.33 | 0.232 |
| `envspec0` sky reflections off | 0.459 | 0.268 | 0.049 | 0.51 | 4.11 | 0.302 |
| `envdiff0` sky diffuse light off | 0.462 | 0.262 | 0.062 | 0.51 | 2.00 | 0.299 |
| `env0` sky light off | 0.360 | 0.297 | 0.000 | 0.50 | 22.17 | 0.351 |
| `onlysun` | 0.359 | 0.297 | 0.000 | 0.50 | 22.28 | 0.347 |
| `sun0` | 0.427 | 0.244 | 0.113 | 0.51 | 0.38 | 0.309 |
| `skydiff1` all sky light on diffuse (game 0.42) | 0.600 | 0.223 | 0.159 | 0.55 | 0.18 | 0.208 |
| `hemi0` | 0.534 | 0.239 | 0.131 | 0.52 | 0.33 | 0.232 |
| `nofog` | 0.535 | 0.239 | 0.132 | 0.52 | 0.33 | 0.232 |
| `noshadow` | 0.551 | 0.232 | 0.137 | 0.52 | 0.31 | 0.233 |
| `exp1` exposure 1.0 (game 0.86) | 0.568 | 0.239 | 0.152 | 1.93 | 0.24 | 0.216 |
| `agx` | 0.528 | 0.184 | 0.208 | 0.07 | 0.07 | 0.194 |
| `neutral` (Khronos) | 0.446 | 0.207 | 0.099 | 15.47 | 0.40 | 0.353 |
| `avgalb` tile-average albedo | 0.536 | 0.236 | 0.136 | 0.51 | 0.11 | 0.225 |

(The first draft of this table was measured on an earlier rep camera 12 m further west; the conclusions were the same.)

**Fix plan (render lane, lighting).**
- Occlusion first: a screen-space ambient occlusion pass (GTAO/SAO class, half resolution on Medium, off or cheap on
  Low) applied to indirect diffuse *and* indirect specular (specular occlusion), plus baked per-vertex or lightmap AO
  where geometry is static (wall bases, under awnings, in window reveals, under cars as a blob shadow).
- Sky reflections that know about the street: at least horizon/canyon occlusion of the environment (e.g. reduce
  indirect specular by the sky visibility estimated from AO or from a coarse height field), and lower specular on
  rough dielectrics (asphalt, brick, painted metal) to physically plausible values; car clearcoat only on paint.
- Bounce light: a warm ground/facade bounce in the environment capture (capture nearby city geometry at low
  resolution, or tint the lower hemisphere by the sunlit ground), so shade is neutral-warm, not blue.
- An HDR sky (properly licensed CC0 HDRI with a matching sun direction and intensity) or a corrected physical sky
  with realistic horizon brightness; sun:sky illuminance about 4-6:1 on a clear day.
- Clear-weather fog: start in the hundreds of metres with a few percent density per kilometre (aerial perspective),
  not full haze at 750 m.
- Keep ACES or AgX with exposure set so the frame's mid-grey sits near 0.18 linear; judge with the tone statistics
  above (not by eye alone).

## 8. Acceptance checklist (what "good" means per view)

Judged on screenshots from `viewShots.mjs` at Medium, 1280x720 (and spot checks at 1920x1080 and on Low/High), always
the same seed, time and camera as the BEFORE shot, plus the numbers stated. A lane may not pass by adding fog, bloom,
blur, film grain or darkness.

Global (every view):
- [ ] No per-pixel speckle on any surface at any distance; no crawling pattern in a 2 s pan (record 10 frames).
- [ ] Shaded areas neutral to slightly warm, readable, darker under overhangs and in corners than in the open; contact
      darkening where walls meet the ground and under cars.
- [ ] Dark materials (asphalt, painted iron, tyres, dark doors) read dark: mean luminance of a sunlit asphalt patch
      0.30-0.45 sRGB (road-far near region: 0.552 now), of a shaded black lamp post under 0.25.
- [ ] Frame statistics on `rep` (`viewMetrics.py stats`): clipped at most 2 % (0.52 now), crushed at most 2 % (0.33),
      mean saturation at least 0.28 (0.232), 5th percentile at most 0.08 (0.132: the shade is too bright and flat),
      luminance sd at least 0.25 (0.239). Turning the sky reflections off reaches the saturation and the 5th
      percentile but crushes 4 %: the fix has to occlude and re-colour the sky light, not remove it.
- [ ] Every preset draws every tree within 150 m (now Medium skips a random 20 %, Low 55 %).
- [ ] No console errors or warnings; frame cost within the performance budget (measured separately).

rep (M St 3200 block):
- [ ] Asphalt grain near/mid (road-far regions) at most 30/24 (now 95.5/34.0; with a flat albedo 11.2/21.1, so 24 is
      the geometry floor plus a little texture); asphalt reads as one material with metre-scale wear, not as noise.
- [ ] Lane markings and the double yellow line with clean edges and subtle wear, no visible speckle, no z-fighting.
- [ ] Facades: window reveals and recessed doors visibly cast shadow; shopfronts with depth; no two neighbouring
      buildings with identical bay layouts; cornices and sills as geometry.
- [ ] Street trees with connected trunk and canopy, no dark inner ball, no sticks through the crown, canopy shadow on
      the pavement matching the canopy.
- [ ] Parked cars with real proportions, round wheels in arches, glass you can see into.
- [ ] People (if in view) as articulated humans.

street2 (N St), street3 (Wisconsin Ave):
- [ ] Same material and lighting standard as rep (they use the same modules, not hand-tuned copies).
- [ ] Rowhouse stoops, doors and windows with depth; roofs with eaves/cornices and chimneys.
- [ ] Brick scale consistent everywhere: a 67 mm course (15 courses per metre), 213 mm brick plus joint, the same
      on every building and next to every door.

door:
- [ ] The door is recessed in a reveal with a frame and threshold; the door leaf has panels with relief; the step,
      stoop and rails read as stone and painted iron (not blue); at 4 m no texture is blurrier than ~2 mm per pixel on
      the door and frame.

people:
- [ ] The people placed in the view (six spots; five are visible in the BEFORE shot, one stands behind another) with
      human proportions, heads, hands, feet, clothing folds or at least shaped clothing; idle pose with weight shift;
      no box silhouettes; walk/run/jump clips verified in motion separately.

car:
- [ ] Wheel arches, wheels at the physics wheel positions touching the ground, rounded body, windscreen rake,
      readable interior (seats, dashboard) through the glass, head/tail lamps with lenses; paint reads as the car's
      colour, not pastel.

tree:
- [ ] One connected tree: trunk tapering into branches into leaf clusters; silhouette with gaps that look like
      foliage, not plates; no speckle; shadow matches; the LOD switch is not visible as a pop when walking away.

road-far:
- [ ] Road stable to 200 m (no shimmer when the camera moves 1 m forward between two shots); markings visible to at
      least 150 m without popping; grain mid at most 24, far at most 29 (now 34.0/28.2; the far region is geometry:
      28.1 with a flat albedo). Markings: 0 % of marking samples under another road surface or less than 5 mm above
      it in the four `zfight` boxes (12.1 % / 3.6 % now at M St / Wisconsin).

aerial:
- [ ] City visible to the map edge on a clear day with gentle aerial perspective; under 2 % of the frame clipped
      (12.9 % now, the white horizon sky); mean luminance with fog within 0.03 of the same frame without fog (0.708 vs
      0.661 now); roofs and streets with material variation, not flat colour.

## 9. BEFORE screenshots

`screenshots/40-before-<view>.png` (from before-dist, the bundle the owner played) and `screenshots/40-base-<view>.png`
(from s1-integrate 7183f1f, the same code as main) for rep, street2, street3, door, people, car, tree, road-far, aerial
and spawn, shot with the final script (pinned camera heights, loop held from boot, seed 1, 11:00, clear, Medium,
1280x720). What each one shows, bluntly:

- rep: flat brick walls with painted doors and windows; the near street tree is a dark faceted ball inside speckled
  plates, its branches poking out; parked cars are two boxes on four box "wheels"; the asphalt is salt and pepper;
  pale blue-grey shade on the pavement; the double yellow line and the lane lines are fine.
- street2: rowhouses as flat walls with painted windows and shutters; a stop sign seen from behind reads as a pale
  blue disc (sky reflection on grey metal); stoop rails light blue.
- street3: the same facades; the shop sign is the only depth on the corner building; trees speckled.
- door: the door, its case and fanlight are paint on a flat wall; the rails read bright blue; the granite steps
  speckle; no contact shadow where the stoop meets the wall.
- people: box people in pastel shirts with an eye band, one arm raised stiffly; no hands, feet or necks.
- car: a pink box on a box, glass and lamps as flat dark and white quads, four black box wheels standing outside the
  body.
- tree: a dark opaque faceted ball, about 40 speckled plates around it, a tapered trunk; the near tree casts no shadow.
- road-far: asphalt grain strong to about 20 m; markings clean; far trees as speckled blobs; parked cars as boxes.
- aerial: the city reads as a model: flat roofs, identical window grids, half the frame milky from the 180 m fog, a
  white clipped horizon, a large empty lawn between M St and the canal around (-300, 220) (not investigated: map
  lane).
- spawn: the box player at the Key Bridge end of M St; traffic signal poles light blue; a soft dark blob under the
  player.

## 10. BEFORE vs base, and reproducibility

The render code is the same in both builds (no change under src/systems/render between before-preview and
s1-integrate), and `viewMetrics.py compare screenshots 40-before 40-base` confirms it: the same tone statistics in
every view, and the pixels that differ by more than 24 levels are actors and a few geometry details, never a material
or the light:

| view | mean abs. difference (0-255) | pixels differing by > 24 | what differs |
|---|---|---|---|
| rep | 0.05 | 0.1 % | two distant pedestrians |
| street2 | 0.33 | 0.5 % | a distant car |
| street3 | 0.25 | 0.4 % | pedestrians |
| door | 2.75 | 4.1 % | the neighbouring rowhouse's window and shutter sit a few cm narrower (a Stage 1 facade change) |
| people | 3.95 | 8.3 % | other people stand on the six spots (the crowd differs between the builds) |
| car | 0.32 | 0.6 % | distant cars |
| tree | 0.19 | 0.3 % | distant cars |
| road-far | 3.45 | 4.4 % | parked car colours, a pedestrian, a red disc on the carriageway in BEFORE only |
| aerial | 0.45 | 0.6 % | cars |
| spawn | 0.93 | 1.3 % | distant people and cars |

So every complaint applies unchanged to the current main: Stage 1 did not change the look.

Reproducibility of the script itself: two separate runs of `people rep` on the same build gave 100.000 % identical
pixels in both views (maximum difference 0). Before the loop was held from boot, two runs differed in the moving
traffic and the crowd (3-7 % of the pixels), because the game ran a variable number of real-time frames before the
first view; before the camera heights were pinned, the BEFORE and base shots of street3 differed in 30 % of the
pixels from a 6 cm camera height difference (the Stage 1 ground under the camera moved). Views in one run share the
game clock, so the people and traffic in a view depend on the views shot before it: compare runs that use the same
view list in the same order (the default list). The sky's cloud clock is pinned per view.
