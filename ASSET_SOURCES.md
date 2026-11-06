# Asset sources

Every downloaded asset that ships in this repository, with its exact source, author, licence, the date it was fetched,
what the game uses it for and what was changed. Assets are bundled by Vite (no run-time fetch from any third-party host).
Credits that a licence requires (CC BY, MIT notices) are also shown in the pause menu (`src/data/credits.ts`) and the
README. Map data has its own record: `src/data/georgetown.LICENSE.md`.

## Textures (`src/assets/textures/`, used through `src/data/textureSets.ts`)

All CC0 1.0 (public domain dedication: https://creativecommons.org/publicdomain/zero/1.0/). No credit is required; it is
given anyway: "Textures from ambientCG.com and cgbookcase.com (CC0 1.0)".

How they were obtained (all sets): the hosts ambientcg.com and cgbookcase.com were not reachable from the build
container on 2026-11-05, so the sets were taken from the public mirror MrBrax/Source-2-Public-Domain-Textures on
GitHub (repository licence: Unlicense; its README states "Contains assets from ambientCG.com, licensed under CC0 1.0
Universal"), which holds the 2K originals compiled for the Source 2 engine (`.vtex_c`, BC7 + LZ4). They were decoded
to PNG (mip level 1 = 1024 px) by the asset scout's tools (`vtex2png.py`, `make_set.py`); the Source 2 packed normal
map (hemi-octahedral RG + roughness in B) was converted back to a standard OpenGL (+Y) RGB normal map and a separate
roughness map. Licence evidence: the mirror's README; ambientCG licence page https://docs.ambientcg.com/license/ and
cgbookcase licence page https://www.cgbookcase.com/license (both state CC0 for every asset; neither page could be
re-read from the container on 2026-11-05/06; the ambientCG API https://ambientcg.com/api/v2/full_json?id=Asphalt010
confirms the asset id exists).

Changes made for the game (all sets): re-encoded as WebP, colour 1024 px (quality 80), normal map 1024 or 512 px
(quality 78), roughness 512 px greyscale (quality 72) (`scratchpad` tool `mkwebp.py`, Pillow 11 / libwebp 1.6). At run
time each set is resampled into the game's baked surface arrays (`src/systems/render/texLibrary.ts`): its average colour
is moved to the surface's palette colour where `mean` is set, its contrast scaled (`contrast`), its normal slopes and
roughness scaled, and it is laid out at the real-world tile size measured on the image (`tile`).

| Files (`<id>_col/_nrm/_rgh.webp`) | Original | Author | Mirror path (fetched 2026-11-05) | Used for | Tile (m) |
|---|---|---|---|---|---|
| Asphalt010 | https://ambientcg.com/view?id=Asphalt010 | Lennart Demes / ambientCG | https://raw.githubusercontent.com/MrBrax/Source-2-Public-Domain-Textures/main/materials/cc0textures/Asphalt010/ | roads (asphalt layer) | 3 x 3 |
| PavingStones029 | https://ambientcg.com/view?id=PavingStones029 | Lennart Demes / ambientCG | .../materials/cc0textures/PavingStones029/ | concrete slab sidewalks | 3 x 3 |
| Concrete003 | https://ambientcg.com/view?id=Concrete003 | Lennart Demes / ambientCG | .../materials/cc0textures/Concrete003/ | granite kerbs, sills, steps | 1.5 x 1.5 |
| PavingStones070 | https://ambientcg.com/view?id=PavingStones070 | Lennart Demes / ambientCG | .../materials/cc0textures/PavingStones070/ | granite setts (cobbled streets, alleys) | 1.4 x 1.4 |
| Grass001 | https://ambientcg.com/view?id=Grass001 | Lennart Demes / ambientCG | .../materials/cc0textures/Grass001/ | lawns, verges, terrain grass | 2.5 x 2.5 |
| Ground036 | https://ambientcg.com/view?id=Ground036 | Lennart Demes / ambientCG | .../materials/cc0textures/Ground036/ | soil, tree pits, terrain soil | 2.5 x 2.5 |
| Gravel006 | https://ambientcg.com/view?id=Gravel006 | Lennart Demes / ambientCG | .../materials/cc0textures/Gravel006/ | towpath, park paths | 2 x 2 |
| Metal003 | https://ambientcg.com/view?id=Metal003 | Lennart Demes / ambientCG | .../materials/cc0textures/Metal003/ | bare / galvanised steel (rails, poles, sign backs) | 1.5 x 1.5 |
| Concrete034 | https://ambientcg.com/view?id=Concrete034 | Lennart Demes / ambientCG | .../materials/cc0textures/Concrete034/ | cast concrete (bridges, modern walls) | 3 x 3 |
| Bricks059 | https://ambientcg.com/view?id=Bricks059 | Lennart Demes / ambientCG | .../materials/cc0textures/Bricks059/ | red brick, running bond (compressed horizontally to 215 mm bricks) | 0.9 x 1.2 |
| Bricks023 | https://ambientcg.com/view?id=Bricks023 | Lennart Demes / ambientCG | .../materials/cc0textures/Bricks023/ | old hand-made brick (common bond walls) | 0.9 x 0.9 |
| WoodSiding009 | https://ambientcg.com/view?id=WoodSiding009 | Lennart Demes / ambientCG | .../materials/cc0textures/WoodSiding009/ | painted clapboard | 2.4 x 2.4 |
| RoofingTiles003 | https://ambientcg.com/view?id=RoofingTiles003 | Lennart Demes / ambientCG | .../materials/cc0textures/RoofingTiles003/ | slate roofs | 2.4 x 2.4 |
| WhiteStuccoWall01 | https://www.cgbookcase.com/textures/WhiteStuccoWall01 | cgbookcase.com | https://raw.githubusercontent.com/MrBrax/Source-2-Public-Domain-Textures/main/materials/cgbookcase/WhiteStuccoWall01/ | stucco / render (tinted per building) | 2 x 2 |

Surfaces without a photo set (road paint, brick pavers, Flemish bond and painted brick, ashlar stone, wood, painted
metal, standing-seam metal, roof felt, canvas, bark, leaves, water) are procedural (generated in code at boot,
`src/systems/render/bakeShaders.ts`); so is every layer whose file fails to load.
