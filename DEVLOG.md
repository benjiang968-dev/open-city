# DEVLOG

Format: date · what changed · what to test · known issues.

## 2026-11-02

- **Step 1: Scaffold.** Vite + TypeScript + three.js + Rapier. `npm run dev` opens the game. The title is one line, "press any key", drawn over the live, orbiting city. Test: load the page, press any key, and the HUD appears. Known: the Rapier WASM is inlined, so the bundle is about 2.5 MB.
- **Step 2: World.** Seeded coastal district (`?seed=`) with:
  - a 9×6 downtown grid with towers in the centre, shops on the bay row and warehouses in the SE
  - the Bayfront Blvd, a beach, Saltwind Marina with moored boats, a drivable Old Pier and a container dock with cranes
  - street lights, trees, parks with fountains, street-name and shop signs (one canvas atlas)
  - a day/night cycle (24 min/day), lit windows at night, and a third-person orbit camera that pulls in near walls

  Test: `?seed=1` vs `?seed=2` give different cities.
- **Step 3: On foot.** Kinematic character controller: walk, Shift to run, Space to jump, collides with buildings, poles and trees. Test: run into a wall, then jump.
- **Step 4: Cars.** Rapier raycast vehicles: hatchback (FWD), sedan (RWD) and pickup (4WD). Suspension, engine fade, brakes, a handbrake that drops rear grip, steering limited by grip at speed, downforce, a yaw-stability assist and per-car health from impacts. All numbers are in `src/tuning.ts`. Scripted test (`node scripts/shot.mjs x handling`) measured:
  - sedan 0–83 km/h in 4 s
  - S-curve at 80 km/h holds about 1.6 g with no spin
  - handbrake at 60 km/h rotates about 95° then recovers
  - braking from 100 km/h reaches 26 km/h in 2 s

  Test: press E by a car, drive, Space to drift, R to flip upright.
- **Step 5: Traffic and pedestrians.**
  - **Traffic:** 26 AI cars on the road graph. They are dynamic bodies steered by velocity, so you can shove them. They drive on the right, stop at every junction, take one car per junction at a time, keep a following gap and stop for people. They honk when you block them, swerve and honk when you charge at them, and recycle out of sight if knocked off their lane or stuck.
  - **Pedestrians:** 40 people with name, job, personality and a daily routine (home → work → leisure → home) on the pavement graph. They wait at kerbs for passing cars, dodge cars heading at them, get knocked down (fly, lie down, get up, flee), and flee from violence nearby.
  - Measured: 26/26 cars and 40/40 people moving after 20 s; average traffic speed 7–8 m/s over 2 minutes with no gridlock.
  - Test: stand in the road in front of a car (it honks), then drive at people.
- **Step 6: Money and the taxi job.**
  - HUD shows cash (counts up), wanted stars and the clock. The job banner shows the target, distance and a countdown.
  - A fare waits waving at a taxi rank, under a yellow beacon and minimap dot. Stop beside them in any car and they get in and name a POI 280–900 m away (green beacon).
  - Stop at the kerb there to get paid: base + $/m + a speed bonus for beating the time allowance + a 25% tip. The tip is lost if the car takes 3+ hp of damage, and pay drops 40% if you're very late. Getting out mid-ride abandons the fare. A new fare appears 2 s later at another rank.
  - Scripted test: 3 fares paid $55, $57 and $54; the last lost its tip after a crash.
- **Step 7: Talk to anyone.** Walk up to anyone and press E. A chat box opens; type free text.
  - **Provider interface** (`src/npc/providers/provider.ts`): `reply(request) → { text, action?, relationshipDelta?, moodDelta? }`. Actions are `offerJob`, `acceptRide`, `refuse`, `giveTip`, `callPolice` and `trade`; game code applies them.
  - **`ScriptedProvider`:** 6 personalities (friendly, grumpy, nervous, chatty, posh, laid-back) with hand-written lines, keyword intents, and grudges: someone you ran over refuses rudely and eventually calls the police. NPCs keep a memory of the last 5 things you did near them (they bring it up), gossip about what others saw, give tips that mark taxi ranks or places on the map, and accept rides (they become a fare where they stand).
  - **`LLMProvider` stub:** posts to a server proxy and falls back to scripted. It is not enabled, and there is no key in the client.
  - Scripted test: two full conversations, plus a pedestrian knocked down at 35 km/h who refuses to talk afterwards.
- **Step 8: Police.**
  - **Heat:** knocking someone down +40, ramming traffic +14, ramming police +30, an NPC calling the police +25; 40 heat per star, max 5.
  - **Chase:** for 14 s after a crime, police know where you are. After that they need line of sight (raycast against buildings). Police cars (1 per star) spawn about 160 m away behind the camera, chase along roads using BFS toward your last seen position, and ram you directly when close and in sight.
  - **Escape:** stay unseen for 8–22 s (by star level) to drop a star. Switching cars unseen clears half the timer.
  - **Busted:** stopped next to a police car for 3.5 s costs a 20% fine and releases you at Precinct 4.
  - Scripted tests: got busted when standing still; lost 2 stars about 12 s after hiding in a different car.
- **Step 9: Polish.**
  - **Minimap:** rotates with the camera and shows roads, buildings, parks, the pier and marina, taxi ranks, job markers (pinned to the edge when far) and flashing police dots.
  - **WebAudio (no files):** a 3-oscillator engine with a fake gearbox, band-passed noise tyre screech driven by lateral slip, two-tone horns from traffic and the player (H), crash/hit thuds, a siren that swells with the nearest police car, and a cash chime. M mutes.
  - **Other:** F3 debug overlay (fps, seed, position, speed/hp/slip, job, heat, clock, entity counts, draw calls); `?seed=` changes the city; player headlight at night; additive light pools under street lamps.
  - Measured: game logic 1.5 ms/frame; 136 draw calls, 169k triangles.
  - Known issue: real GPU fps can't be measured headless (SwiftShader). Needs a check on real hardware.
- **Step 10: Deploy (partly blocked).**
  - `npm run deploy` builds and pushes `dist/` to `gh-pages`. Relative base, `.nojekyll` included. A local `gh-pages` branch already holds the current build.
  - **Blocked:** pushing to `benjiang968-dev/open-city` was refused because this session has no linked GitHub account.
  - **Stopgap:** the same build is published as a private playable page: https://claude.ai/artifact/AqU3Z46r4MKgcvjQpStCzV

### Known issues (end of day 1)
- AI traffic and police are velocity-driven bodies, not raycast vehicles. They get shoved on impact and recover, but don't skid realistically.
- Real-GPU 60 fps is unverified; headless SwiftShader only manages about 10 fps.
- No rain yet (the weather field is fixed to `clear`). Shops don't open or close yet.
- Pedestrians don't collide with the player on foot (you walk through them).
- The three starter cars are parked nose-to-tail, so it's easy to bump the one in front when pulling out.
- **2026-11-03: Stats key.** Backtick (`) now toggles the debug/stats overlay as well as F3, because F3 is often taken by the browser or is a laptop media key. Test: press ` in game.

## 2026-11-03

- **Tank-style movement on foot.** W/↑ walks forward the way the character faces, S/↓ backs up (55% speed), A/D/←/→ turn the character (3 rad/s). The camera swings behind the character unless you're moving the mouse. Tuning: `player.turnSpeed`, `player.backSpeedFactor`, `camera.footRecenterSpeed`. Test: A then W should walk left.
- **Chat tap buttons.** Quick replies (Hi, How are you?, Any work?, Need a ride?, Got any cash?, Trade?, Gossip?, Sorry, Bye) and a ✕ close button, sized for touch. On touch devices the text box isn't auto-focused, so the keyboard doesn't cover the buttons.
- **Weather.** Clear, cloudy, fog, rain, storm and snow change every 2.5–7 real minutes, using tuned transition odds, and blend in over 25 s.
  - Clouds dim the sun and grey the sky. Fog cuts visibility to 90 m.
  - Rain and snow particles follow the camera. Roads get darker and shinier when wet, and snow builds up on the ground.
  - Tyre grip ×0.82 in rain, ×0.75 in a storm, ×0.62 on snow.
  - Storms flash lightning, followed by thunder after a delay. Rain has its own sound. Stars and a moon appear on clear nights.
  - HUD shows a weather icon by the clock. NPCs talk about the actual weather.
  - N cycles the weather; `?weather=rain` forces one. All numbers are in `TUNING.weather`.

## 2026-11-03: Day 2, Milestone 1

- **M1.1 Crash stutter.** Diagnosed with a new per-system profiler. F3 now shows CPU ms per frame, the count of frames over 33 ms in the last 10 s, and the worst frame with its top 3 systems. Benchmark: `THROTTLE=4 node scripts/shot.mjs x crashspikes` runs 10 wall crashes at 20–120 km/h, 3 traffic rams (police spawn) and 1 wreck, with the CPU throttled 4× to stand in for a laptop.
  - **Causes found:**
    - The physics step jumped from 0.5 to 5–50 ms on impact. Rapier CCD was running against one fixed body holding about 1,500 static colliders; an isolated Node test showed a 98 ms worst-case step.
    - Garbage-collection pauses of 5–20 ms landed in random systems. Traffic and pedestrians made about 2,000 allocating `translation()` calls plus Quaternion/Euler/array allocations every frame.
    - Water normals were recomputed every frame for nothing (it's flat-shaded).
  - **Fixes:**
    - Static colliders split into one fixed body per 120 m area.
    - CCD off for AI cars and player cars. At ≤50 m/s a 4.5 m car moves 0.83 m per step, so it can't tunnel (`vehicles.playerCcd`).
    - Positions cached once per physics step.
    - Scratch objects reused in traffic, police and pedestrian code.
    - Water normals no longer recomputed.
    - Shaders (including police cars and a shared wreck material) pre-compiled at load, so a crash never compiles one.
  - **Before → after (4× throttle, 930 frames):** frames over 33 ms 1–2 → 0; worst frame 38–60 ms → 31.6 ms; 99th percentile 18–25 → 17 ms; heap growth 5 MB → about 0 MB.
  - **Known issue:** GPU-side stalls can't be measured headless; check F3 "spikes" on the laptop.
- **M1.2 Visible crash damage.** Car bodies are subdivided (4²) at spawn so dents bend panels smoothly; the body, bumpers, two headlights and a windscreen-crack overlay are all built at spawn.
  - Impacts push vertices near the impact point inward. Depth scales with impact speed, and each vertex is capped at 0.4 m from where it started.
  - A bumper hangs loose at 7 m/s, falls off at 12 m/s (or on a second hit) and tumbles into a pooled debris slot (24 slots, cleared after 45 s).
  - Headlights break per side at 6 m/s (the night beam dims accordingly). The windscreen cracks at 9 m/s.
  - No allocations at impact; thresholds are in `TUNING.damage`.
  - Test: `node scripts/shot.mjs x dent` crashes at 55 and 75 km/h with 0 frames over 33 ms (worst 7.8 ms).
- **M1.3 Player health.** Health runs 0–100, shown as a heart bar under the stars when below 100.
  - **Crashes:** you're always belted, so impacts under 13 m/s don't hurt. Above that you lose 3.2 hp per m/s; a 70 km/h wall hit costs about 22 hp.
  - **On foot:** a car hitting you costs 5 hp per m/s of its speed and throws you clear (an 11 m/s car takes 40 hp).
  - **Recovery:** after 8 s without damage you heal 0.6 hp/s. A clinic door gives a full heal for $0.6 per missing hp, capped at your cash.
  - **Below 40 hp:** run speed ×0.6, the camera sways and a red vignette appears; hits also flash the vignette.
  - All numbers are in `TUNING.health`.
- **M1.4 Knocked out.** At 0 hp you drop, the screen fades to black with "LIGHTS OUT", and you wake at the clinic. When you wake:
  - Full health; 30 minutes of game time have passed.
  - Bill = min(cash, $120), so you can never be trapped by money.
  - Taxi fare cancelled, police heat cleared.
  - Inventory kept (no inventory yet; the hook is in `wakeUp`).
  - Gate test (`node scripts/shot.mjs x gate1`): 10 crashes at 25–70 km/h, 0 frames over 33 ms (worst 9.4 ms), dents visible. Died after two 140 km/h crashes and woke at the clinic with full health and a $120 bill. Hit by traffic on foot: 100 → 60. Clinic heal cost $24.

## 2026-11-03: Milestone 2

- **M2.0 Pause menu and quality:** Esc or P (or losing the mouse lock) pauses the world. The menu has Resume, Sound, controls, and Graphics quality Low / Medium (default) / High, which sets resolution scale (70% / 100% / 100% up to 2× DPR), shadows (off / 1024 / 2048) and the pedestrian budget (30 / 45 / 60, applied in M2.9). The choice is saved per browser, `?quality=low` forces one, and presets are in `TUNING.quality`. Test: Esc → Low → Resume.
- **M2.5–6 Items and hotbar:** 9-slot hotbar (1–9 or the mouse wheel select, Q drops as a physics object, hands start empty, rendered 3D icons, selected item visible in the right hand). E picks up the looked-at item (yellow marker), nearer than any person or car. About 170 seeded world items, all sleeping Rapier bodies drawn with one instanced mesh per type: bottles, cans and bags on pavements; bags and boxes by shops; cone lines at kerbs; brick piles; bats by 2 gyms; wrenches at the garage. Collision groups keep car wheels off litter. Numbers are in `TUNING.items`. Test: `node scripts/shot.mjs x items`.
- **M2.7 Throwing and melee:** left click (or F, for trackpads and frames without mouse lock) with a throwable: hold to charge (0.9 s), and an arc plus landing ring shows exactly where it goes (aimed where the camera looks). Release throws a real physics object (CCD while flying). Hitting someone: damage by item and speed, a flinch, then by personality they flee, square up (walk over and shout) or yell; a heavy item or a repeat hit counts as assault. Bat/wrench: click to swing; it hurts people, dents and damages parked cars, and makes traffic honk. Numbers are in `TUNING.combat`/`reactions`/`items`. Test: `combat` scenario (bottle at 5 m hits; a grumpy NPC flinches, then confronts; 3 bat swings dent a hatchback by 0.48).
- **M2.9 Crowd:** people are drawn with about 13 shared instanced meshes (body parts plus phone, camera, parcel, cane, dog); draw calls 131 with 60 people, game logic median 1.4 ms. 60 people exist; the quality budget activates 30/45/60, and anyone >230 m away and out of view walks back in 70–170 m from you, out of sight. Archetypes: adult, jogger (2.3× speed, parks and the beach), delivery worker (carries a parcel between shops), tourist (slow, landmarks, stops to take photos), elderly (0.6× speed, cane, short trips from home), parent and kid (the kid follows at their side), dog walker (the dog trots alongside and barks at you). Every person has a kinematic capsule (collision groups: only you and thrown items touch it): walking into someone shoves them, they stumble and complain, and three shoves count as harassment. Kids and dogs can never be hit, knocked down or targeted. Test: `crowd`/`lineup` scenarios.
- **M2.8 Witnesses and 999:** heat now only comes from being seen. A police car with line of sight adds it instantly; otherwise witnesses have to call. Each crime (car hits a person, assault, harassment, vandalism, waving a weapon near people, ramming) is checked against the 8 nearest people with line of sight. They call, film, run or confront, weighted by archetype (tourists film, elderly people call, joggers run, delivery workers confront) and personality. A call shows the phone and a 📞 bubble with a progress bar for 2–3 s, then adds heat and sends police to where it happened (20 s search, escape timer paused). Knocking out the caller first cancels it. Victims call after flinching (posh/friendly almost always, grumpy rarely). NPCs threatening to call in conversation now visibly call too. Numbers are in `TUNING.witness`. Test: `witness` scenario (bottle → posh victim calls → 1 star → hidden for about 27 s → 0 stars; a caller knocked down mid-call → no report).
- **M2 perf (GC):** a sampling heap profile (`scripts/heapprof.mjs`) measured 308 KB of garbage per frame. Most came from Rapier 0.21's `World.step()` walking every body and collider through JS callbacks each step (~2,000 colliders), and from boxed doubles in traffic's `obstacleAhead`. Fixes: skip that per-step walk (create/remove already keep Rapier's maps in sync; no soft bodies), flat allocation-free `obstacleAhead`, people's capsules only updated within 35 m, and traffic/police rotation only written when the heading changes. Now 87 KB/frame (−72%). 4× throttled crash bench: before, median 6.9 ms, 99th percentile 23 ms, worst 41.7 ms, 1 frame over 33 ms; after, two runs gave median 5.0 / 5.2 ms, 99th percentile 15 / 18.5 ms, worst 31.1 / 33.7 ms, frames over 33 ms 0 / 1. Known issue: that one marginal 33.7 ms frame only appears with the CPU slowed 4×; unthrottled there are 0.
- **M2 gate (scripted, 4× CPU throttle):** picked up a bottle with E, threw it by holding F, and a friendly NPC flinched, called 999 (phone visible 2–3 s), then ran: 1 star. Lost the police after hiding for 28 s. One bat swing dented a parked sedan. Low (31 people) median 5.6 ms, worst 12.9; High (60 people) median 5.7 ms, worst 13.3; 0 frames over 33 ms in either. Regression checks pass: taxi 3 fares, chat, handling unchanged, police (heat now arrives through witness calls).

## 2026-11-04: Milestone 3 (map-independent parts)

- **M3 OSM importer:** `node scripts/importOsm.mjs [file.osm|.osm.gz]` (or `npm run import-osm`, or `--overpass`; plain Node, no new dependencies) turns an OpenStreetMap download into `src/data/georgetown.json`. Where to put the file and how to get it: `data/osm/README.md`. What it writes: the crop runs from Key Bridge to Washington Circle and from the Potomac to just north of R St (about 2.0 × 1.5 km), in metres with x east and z south. It holds roads (oneway, lanes, bridge, layer, km/h limit, sidewalk; junction vertices are kept so the road graph can be rebuilt), footways, buildings (heights from tags, levels × 3.2 m, or an estimate by type), POIs as a category only (real business names are never copied; the game names them from `src/data/poiNames.ts`, 97 categories of invented names), water, the canal and towpath, parks, car parks, bridges and street props. Water areas that run past the download box are closed along the crop edge on the side with no roads or buildings. The run prints counts, the file size and suspicious spots with lat/lon. Test: `node scripts/testImportOsm.mjs` (14 checks on the synthetic fixture `scripts/fixtures/tiny.osm`, writes to a temp folder). A synthetic scale run of 107k nodes took about 1 s and gave 1.3 MB. Known issues: not yet run on the real Georgetown file (Overpass is unreachable from here), and the game doesn't load the JSON yet.
- **M3 importer review fixes:** drive-through, parking-aisle and driveway names are no longer kept (they are business names even when they contain "Lane" or "Drive"); a cut-off download or a file holding an Overpass error now stops the importer before it writes anything; six invented names that were close to real brands were replaced in `poiNames.ts`. Test: `node scripts/testImportOsm.mjs` (14 checks).
- **M3 Part C, hurt feedback (branch `m3-hurt`):** every injury shows a short burst of small red dots and leaves a few small flat red stains (`src/systems/hurtFx.ts`: one pooled InstancedMesh of 192 dots, 3 + 1.6 per m/s of impact up to 36, a ballistic fall that shrinks away in about 0.6 s and travels with a flung victim; up to 3 stains per hit from a pool of 32, fading over 60 s). It covers car hits on people, thrown items, melee and the player (a crash bursts from the driver's window with no stains; being hit on foot leaves stains). Dogs can now be hurt by your car, thrown items and melee: they yelp (synth), tumble, limp back to their owner and recover after 9 s (they can't die). Hurting one is a serious crime (`dogAttack`: 60 heat = 2 stars, 45 m radius). The owner screams and then always calls 999 unless knocked down. Bystanders call or confront far more, hear the yelp within 14 m without line of sight, and remember it. Kids are still untouchable. Numbers are in `TUNING.hurtFx`/`dogs`/`witness`. Test: `node scripts/shot.mjs x hurtfx` (screenshots `22-hurt-*`): all four kinds of injury fire dots and stains, the owner's own call goes through (heat 60 at the first call), kids take no damage from a car, a bottle or a bat, and all stains are gone after 62 s. Idle cost is zero: both meshes are hidden and the new `fx` profiler section reads 0.00 ms; idle frame median is 0.9 ms against 0.9–1.1 ms on the previous build; gate2 and the crash bench still have 0 frames over 33 ms. Known: the `chat` scenario fails at its second conversation, on the previous build too.
- **M3 Part C review fix:** a dog owner who was filming on their phone when their dog got hurt screamed but then never called 999 (the witness phone loop dropped the film and wiped their new report in the same pass). `ownerCalls` in `witness.ts` now drops the film itself, so the owner always calls unless knocked down. Test: a filming owner whose dog is hit by the car now goes yell → phone → call completed. Known: if a second crime makes the screaming owner run (e.g. the same car also knocks someone down nearby, `npcMemory.ts` pedHit), their dog report is never made.
- **M3 B6 Car ownership, theft and dealerships:** every drivable parked car has an owner (a local, or nobody if abandoned) and only the first car at the starting rank is yours (`ownedAtStart`); half of locals' cars are locked. E on an unlocked car steals it at once; on a locked one you smash the side window for 3 s (elbow strikes rock the car, the glass cracks, a synthesized smash, then a 12 s car alarm that makes everyone within 55 m stop and stare). Taking a car is a new `carTheft` crime (30 heat, 24 m witness radius, 55 m while the alarm sounds); the owner remembers it (`stoleMyCar`, then refuses to chat) and, within 60 m, runs over shouting "Hey! That's my car!" and may phone 999 afterwards. Two dealerships (garage/shop POIs on the grid, data-driven from POI ids, with a kerb sign) show 3–4 display cars: E shows price and stats and buys (hatchback $900, sedan $1,600, pickup $2,200), and bought cars are yours (no theft, no alarm) with a green marker on the minimap. Parked cars follow `parkedCarsPer100m` per street class (boulevard = main, other streets residential, `waterfrontLot` waits for the real map): 24 drivable cars instead of 12, and parked cars now sleep in Rapier and are skipped, so garbage fell from 82.5 to 70.8 KB/frame and vehicle CPU from 0.2 to 0 ms. Tested: `theft` (unlocked car on an empty street: 0 calls, 0 stars; locked car with 4 people around: 3.0 s smash, alarm, all 4 people stop to look, 4–7 completed 999 calls and 2–3 stars over 4 runs; the owner shouts, refuses to talk, and phoned 999 in 3 of the 4 runs) and `dealership` ($900 deducted, owned, no theft/alarm/calls, 2 owned-car markers); handling, taxi, police, witness and gate2 unchanged. Known issues: `chat` is flaky on main too (the second chat sometimes closes early), and the garage building keeps its old shop sign.

- **M3 B6 review fixes:** a wrecked display car could still be bought for full price; now its prompt says it is wrecked and the showroom drops it from stock. A parked car that fell asleep in Rapier on its roof never auto-righted (the new sleep skip froze its upside-down timer); it is now updated until righted, then sleeps again. Test: `theft`, `dealership`, `handling`, `gate2` re-run clean; `chat` fails on main too (2 of 2 runs) at the second conversation.

- **M3 Georgetown map from knowledge (branch `m3-georgetown-data`):** Overpass can't be reached from here, so `src/data/georgetown.json` is now generated from a hand-authored spec instead of an OSM download.
  - **Spec:** `data/georgetown-spec.json` holds 61 streets, the Potomac shore, the canal, Rock Creek, 14 areas, 29 landmarks, street character, 47 spot heights and 101 noted uncertainties, all as lat/lon. It was written from general knowledge, not OSM, so expect 20–80 m of error. It is pretty-printed so coordinates, lanes and one-ways can be edited by hand.
  - **Generator:** `npm run gen-georgetown` (`scripts/georgetownFromSpec.mjs`, plain Node, seeded) writes the importer's format (`open-city-osm-1`; extras are `meta.synthetic`, `synth: true` on buildings, `heights`, and `capacity` on car parks). The crop is the spec bbox (2255 × 1665 m); a real import with `--crop -77.074,38.899,-77.048,38.914` uses the same frame.
  - **Synthesized:**
    - about 3,960 buildings along the street frontages by street character: rowhouses, shop fronts, waterfront and West End blocks, mansions, a Georgetown University campus and 29 landmark buildings
    - about 710 POIs as categories only, including a car dealer with its lot, fuel, car repair, police, a fire station and 3 public car parks
    - sidewalks with corner joins and 419 crossings
    - the towpath with steps up to every canal bridge, the waterfront promenade and boardwalk, piers, park paths and the Rock Creek Trail
    - about 6,500 props
    - a 10 m heightfield fitted to the spot heights (rms misfit 0.5 m)
  - **Validation (printed by the generator):**
    - The road graph is 1 component and 1 strongly connected component; a synthetic parkway ramp joins Rock Creek Pkwy to K St.
    - Washington Circle is a closed one-way loop with 8 spokes.
    - There are 119 intersections.
    - 0 buildings overlap a road, a sidewalk buffer, each other, water or parks.
    - The file is 0.97 MB.
  - **Preview:** `npm run preview-map` (`scripts/previewMap.mjs`) draws the data to `screenshots/24-map-preview.png` (2400 px, via Playwright).
  - **Test:** run both commands, then open the PNG.
  - **Known issues:**
    - The geometry is approximate and some one-way directions are majority guesses.
    - East of Rock Creek between M and P St there are no spec streets, so it is empty land.
    - The canal is not cut into the heightfield.
    - The game doesn't load this file yet.

- **M3 Georgetown map, geography check (2026-11-04):** an independent check of the spec against the real place. The main layout holds up: Key Bridge, M St into Pennsylvania Ave, the canal, the waterfront, the Whitehurst, the street order, Rock Creek and Washington Circle are all where they should be. Four fixes:
  - **Wisconsin Ave north of P St** now leans further NNW. The R St junction moved about 80 m west, to -77.0657, so the avenue sits a block west of 32nd St and Dumbarton Oaks. The Q St junction and the spot heights at both junctions moved with it.
  - **Car Barn:** moved to the east side of the Exorcist Steps, facing the Key Bridge landing.
  - **Georgetown Library and Book Hill Park:** the library moved to the south side of R St at Wisconsin Ave (3260 R St). Book Hill Park moved from north of R St to the slope below the library, facing Wisconsin Ave.
  - **Mount Zion church:** moved to the west side of 29th St.
  - **Validation after the fixes:** unchanged. The road graph is 1 strongly connected component with 119 intersections. There are 0 bad buildings and 5 footway groups. All 29 landmarks are placed, and the Car Barn no longer needs shrinking.
  - **Test:** `npm run gen-georgetown && npm run preview-map`, then look at the top centre and the Key Bridge end of the PNG.
  - **Still uncertain:**
    - The Virginia shore and the tip of Roosevelt Island probably reach into the south-west corner of the box, but the map shows open river there.
    - The canal west of Key Bridge may lie closer to Canal Rd.
    - It is unclear whether Oak Hill Cemetery reaches down to Rock Creek.

- **M3 map core (branch `m3-map-core`):** every system now reads the city through one graph-based interface, `CityMap` (`src/systems/map/cityMap.ts`: directed lane edges with junction, roundabout, dead-end, one-way, bridge and twin data; walk graph; places with door and kerb heading; parking spots tagged by road class; named street lines; building footprints; heightAt/isRoad/isBlocked/isWater; allocation-free nearestLane/kerbPoint/nearestWalk on spatial hashes; A* road and walk routers; validateCityMap). The grid city produces it through `gridMap.ts` (cityGen.ts unchanged) and `?map=` picks the map (`loadMap.ts`: default grid, unknown names warn and load the grid; the seed never picks the map). Traffic follows lane edges with junction curves and never U-turns except at dead ends; police route on the directed graph to the lane where you were last seen; people route on the walk graph and slide off walls, water and the map edge; parked cars come from parking spots by class; taxi kerb stops come from kerbPoint and the time allowance from the road route; sinking a car lands you on the nearest pavement; anything placed on the ground uses heightAt; the minimap paints the map's own base plus street names along the roads; the pause menu shows the map's attribution · Test: `node scripts/shot.mjs x mapcheck` (any map: `MAP=<id>`) passes on the grid (validate ok, 30 lane choices, 0 jumps, max 0.5 m off lane, 20/20 walks); handling, combat and dealership give main's numbers; world, taxi, police, witness, bust, theft, hurtfx, lineup, dent, gate1, gate2, crashspikes pass with a clean console (screenshot `25-mapcore-grid`). 4× throttled, 3 interleaved runs each against main: crashspikes median 4.5–5.5 ms (main 4.6–5.4), frames over 33 ms 0–3 (main 0–2, and 2–6 in two earlier runs), gate2 medians 3.4–4.6 ms (main 3.4–5.3), garbage 70.5–72.2 KB/frame (main 70.0–71.5) · Known issues: cones and brick piles sit elsewhere (the boulevard's parking spots joined the map's list, which shifts the item generator's random picks); police and pedestrian routes differ in detail (shortest directed route, shortest walk by distance); `chat` is still flaky as on main.

- **M3 map core review fixes:** the interface now handles levels and local water: `nearestLane`, `kerbPoint` and `nearestWalk` take an optional height and prefer lanes and walk nodes within `map.levelTolerance` of it (the Whitehurst Freeway or Key Bridge deck, not the road or towpath below), and `heightAt(x, z, y)` returns the deck under a point at height y. People, dogs, debris, the throw arc, the camera floor and rain pass their own height; police remember the height where they last saw you. `waterLevelAt(x, z)` gives each water body its own surface (the canal sits above the river) for the drowning check and swim-back. Cars on a roundabout ring no longer slow to 1 m/s at every ring node. The taxi time allowance took the nearest lane in whichever direction it pointed, so routes averaged 1.19x the Manhattan distance main used (worst 2.37x); it now takes either direction at each end (1.01x, worst 1.4x; allowances 1.01x main's formula). The grid has one level, so it plays as before · Test: `mapcheck`, world, taxi, police, witness, gate2, handling, theft, dealership, hurtfx, crashspikes pass with a clean console; handling, dealership, hurtfx and crash damage match main · Known issues: a roundabout yield only waits for cars turning at that node, not cars already on the ring; there are no left/right lane neighbours for lane changes yet.

- **M3 world generator v2 (branch `m3-georgetown-art`, in main as 569fbde; the builder was cut off before writing this entry, so it was written by the reviewer from the code and the builder's own numbers):** `src/systems/map/` turns `src/data/georgetown.json` into the 3D Georgetown world. Entry point: `buildGeorgetownWorld(scene, RAPIER, physics, doc, { seed, quality })` in `georgetownWorld.ts`, which returns a `GeoWorld`. That object holds the height, road and water queries, the road polygons with lanes, the junctions, decks, car-park stalls and lamp positions, the day/night materials, `update()` and `setQuality()`. The game does not load it yet; `preview.html` shows it on its own.
  - **Terrain:** a 1 m height and kind raster built from the 10 m data heightfield answers `heightAt`, `isRoad`, `isBlocked`, `isWater` and `waterLevelAt`. The ground is blended into gentle cuttings and embankments along the roads. A 5 m terrain mesh is coloured for parks, the cemetery, steep earth and the shore. Low hills continue past the map edges.
  - **Roads:** the data's roads are split into edges at junctions, with 3.3 m lanes from the lane count and one-way tags. Junctions get outlines with 6 m kerb radii and flat plateaus, and the height profiles follow the smoothed terrain. Washington Circle is a true circle. The K St underpass is left out.
    - Sidewalks are raised 15 cm (brick in Georgetown, concrete in the West End), with corner sidewalks and paving out to the building line.
    - Markings: lane lines, zebra crossings from the data, stop lines, one-way arrows and the old streetcar rails on O St.
  - **Decks:** Key Bridge (arches and river piers), the Whitehurst Freeway (steel columns; its east end moved 15.6 m north so it runs beside the K St bridge, not on it), the Rock Creek bridges and the canal road bridges, all with solid parapets. Deck profiles clear whatever passes under them: 5 m over roads, 2.4 m over water, 7 m for the freeway, with approaches at 7.5 % at most.
  - **Water:** the Potomac with animated waves. The C&O Canal is a stone-walled cut with the towpath, pounds stepping from 5.2 m down to 2.0 m at the locks (mitre gates and balance beams) and footbridges. Also Rock Creek in its valley, fountains, the Washington Harbour plaza, and the boardwalk and piers with boats.
  - **Buildings:** about 3,960 footprints, extruded with a facade shader. It draws window bays from a texture array, a door on the side facing the nearest street, shopfronts with awnings and invented shop names (`poiNames`, varied by the seed), rowhouse colours, stoops with iron rails, cornices, and flat, hip, gable or steep roofs. Landmarks get their own shapes: a clock tower, steeples, the smokestack, the Car Barn, the Old Stone House, Washington Harbour's tiers, the banded apartment block, cupolas and a portico.
  - **Car parks and props:** car parks have painted bays and a stall list (793 stalls). Props are instanced: trees (from the data, plus street trees every 12 m on M St and Wisconsin Ave), globe lamps with pools of light at night, benches, mast-arm traffic signals, stop signs, bus shelters and gravestones.
  - **Chunks:** meshes are merged per 240 m chunk and per layer (ground, decals, facades, near detail), with a draw distance set by the quality level. Static physics uses one fixed body per 120 m chunk: trimesh ground, boxes and cylinders.
  - **Numbers (builder's run):** boot 1.7 s with 330 meshes, 1.56 M triangles built, 10,209 colliders and 291k trimesh triangles.

    | View | Low | Medium | High |
    |---|---|---|---|
    | M St, street level | 46 draw calls, 0.39 M triangles | 97, 0.86 M | 184, 1.12 M |
    | Whole map from the air | 276, 0.92 M | 283, 1.14 M | 283, 1.20 M |

  - **Test:** `npm run build && node scripts/previewShots.mjs` writes the `26-geo-*` screenshots and `26-geo-perf.json`, and fails on any console error. `preview.html` has a free-fly camera with WASD, Q/E, drag and 1–9 for views.
  - **Known issues:** see the review entry below.

- **M3 world generator v2 review fixes (branch `m3-geo-art-review`):** an independent review of world generator v2. The main tool is `scripts/geoAudit.mjs`, which casts Rapier rays over a 1.5 m grid of the whole map and along every lane, and compares the colliders with `heightAt`, `roadSurfaceAt` and `walkSurfaceAt`, the queries everything in the game is placed with. It also checks lanes for steps and grades, finds floating and buried props, and checks how footprints and building colliders sit against the streets. Each problem it found was fixed in `src/systems/map/`.
  - **Canal:** each raster cell now takes its nearest segment of the line the mesh is built from. Before, segments overwrote each other near every bend, so towpath cells sat over open water, 2.7 m off. Bank heights now ramp across lock steps the way the mesh does, and there are no end caps.
  - **Holes:** terrain triangles that are the only ground over a gap are kept. Gaps under 5 m between sidewalks and buildings, and alleys, were holes down to the safety floor (about 8,500 m²). The paving behind the sidewalk now runs under facades set less than 1 m back; before, a 0.5 m slot opened there.
  - **heightAt matches what is drawn:** natural cells take the height of the 5 m mesh, which sits up to 0.3 m below the raster beside every road; canal apron cells take the apron height. A natural vertex next to a road may not stand above the road, so the Rock Creek bank no longer pokes 0.8 m through the Parkway. A step-distance raster gives exact kerbs and canal walls instead of smearing them over 1 m.
  - **Junctions:** road profiles are flat at the node height inside the junction plateaus, and there is a profile sample at every trim. `GeoLane` heights through junctions were up to 1.1 m off, and steep streets met the junctions with steps and see-through cracks. These change the `roadNet.ts` output: lanes, centres and kerbs gain one point at each trim, and their heights inside the trims are now the node height.
  - **Bridge approaches:** an at-grade edge leaving a raised deck end is held to `maxGrade` by raising the next node, up to 4 hops. The M St bridge over Rock Creek came off at 20 % with a launching crest; that stretch is now at most 13 %.
  - **Decks:** the deck index covers a sidewalk only on sides that have one, raised by the kerb. Before, `walkSurfaceAt` was 15 cm low on every bridge sidewalk and found decks in mid-air beside one-sided decks.
  - **Canal footbridges:** the side rails are now per-segment slabs; before, one box ran down the middle of the walkway.
  - **Buildings:**
    - Footprints that reach into a carriageway, its sidewalk or a junction are cut back to the back of the sidewalk: 43 overlapped before, 0 now. 207 were trimmed (most by under 0.5 m) and 1 was dropped. `doc.buildings` is edited in place.
    - 185 skewed footprints get a prism collider instead of a box that stuck out over the sidewalk.
    - Stoops take their rise from the pavement in front of their own door: 400 bottom steps floated up to 0.75 m and 58 were buried.
  - **Grass colour:** two octaves of value noise; before, it read as a checkerboard from the air.
  - **Preview:** 26 review viewpoints (`--review`, `26-geo-r-*.jpg`). `GeoWorld.audit` is an optional new field.
  - **Audit, before → after:** samples off by more than 5 cm, out of the totals shown.

    | Check | Before | After |
    |---|---|---|
    | Terrain | 61,392 of 711k | 11,354 |
    | Places with no ground under natural cells | 3,798 | 1 |
    | Sidewalks and paths | 13,452 of 100k | 5,350 |
    | Carriageway | 7,485 of 118k | 661 |
    | Canal banks | 2,102 of 6,008 (mean 51 cm) | 594 (mean 5 cm) |
    | 0.25 m either side of a kerb | 4,459 + 6,199 | 12 + 48 |
    | `GeoLane` heights | 14,991 of 167k (max 1.12 m) | 105 (max 0.37 m) |
    | `roadSurfaceAt` on lanes | 541 | 19 |
    | Bridge sidewalks | 714 of 831 | 13 |
    | Steps over 15 cm along lanes | 24 | 9 |
    | Trees floating | 63 (up to 0.89 m) | 2 (up to 0.11 m) |
    | Building overlaps | 43 | 0 |

  - **Perf:** `previewShots.mjs`'s own ray check is 37,999 samples, 0 off by more than 12 cm, 0 lips on decks, as before. Draw calls and triangles are the same as the builder's (M St, street level: Low 46 calls / 0.39 M triangles, Medium 97 / 0.86 M, High 184 / 1.12 M; the whole map from the air: 276 / 283 / 283 calls). `GeoWorld.update` costs 0.002–0.15 ms at 4× CPU throttle and allocates nothing: 0 bytes of heap growth over 5,000 calls, the same as before.
  - **Test:** `npm run build && node scripts/geoAudit.mjs` (numbers above, clean console); `node scripts/previewShots.mjs --review` (`26-geo-*.png`, `26-geo-r-*.jpg`, `26-geo-perf.json`; clean console); `THROTTLE=4 node scripts/geoPerf.mjs`. The places still wrong, with coordinates and lat/lon, are in `docs/m3-suspicious-areas.md`.
  - **Known issues:**
    - Grades up to 30 % on the side streets between M St and Prospect St. The data's spot heights make that hill very steep, and flat junctions push the climb into mid-block.
    - 9 lane steps of 0.15–0.39 m remain: at the Pennsylvania Ave bridge end, on K St west of Washington Circle, at 31st St by the canal steps, at 23rd St south of the circle, and at the N St dead end.
    - The sidewalk is missing around parts of Washington Circle's outer edge.
    - `heightAt` still smears the plaza quay wall and the Exorcist Steps edges.
    - Boot is over the 2.5 s budget, and the fixes made it slower. Building the world takes 9.06–9.17 s at 4× CPU throttle after the review, against 7.09–8.60 s before (3 interleaved runs each); unthrottled here it is about 2.3–2.5 s against 2.1 s. The Milestone 2 game reaches its first frame in 5.8–8.1 s at 4× (4.0 s unthrottled), so the Georgetown world alone already takes longer than the whole M2 boot. Moving the building and raster work into a worker, or caching the built geometry, is the next step.

- **M3 Georgetown is playable (branch `m3-geo-citymap`, step C0):** `?map=georgetown` loads the hand-authored Georgetown map as a full `CityMap` (`src/systems/map/georgetownMap.ts`, built on the world generator v2). The default map and `?map=grid` are unchanged. The Georgetown code and data are separate chunks, fetched only when that map is picked (`loadMap` is now async).
  - **Road graph:** one lane edge per lane of every road piece the world draws: 166 nodes, 645 lane edges, 23 dead ends, 37 bridge lanes, 94 lane-km. The K St underpass is left out.
    - Junction plateaus are the lane trims. A node where two different streets meet, or where a street bends more than `map.passThroughMaxBend`, counts as a corner junction. Only a street running on fairly straight is a pass-through with no trim.
    - Roads leaving the map get `map.deadEndTurnRoom` to turn round in.
    - Lane points inside a junction sit at the junction's height.
    - Every one-way lane (62) runs the way the data says.
    - Washington Circle is a one-way ring of 24 lanes, all counter-clockwise seen from above, with 8 spokes.
    - The whole graph is one strongly connected component.
  - **Parking:** the data's carriageways are lanes x 3.3 m with no parking lane, so parked cars and traffic don't both fit on most streets.
    - On roads with two or more lanes each way the kerbside lane is now the parking lane (`LaneEdge.parking`): traffic keeps out of it and routes avoid it (`map.parkingLaneCost`).
    - Narrow two-way streets park on one kerb and both traffic lanes move over.
    - Cars only park beside a pavement, never on bridges, the freeway, the parkway, the ring, junction boxes, crossings, taxi ranks or bus stops.
    - That gives 2,307 spots: 1,514 at the kerb plus 793 car park bays.
    - Georgetown has its own coarse densities (`vehicles.parkingByMap.georgetown`), which put 42 cars on the map. They are held low on purpose because of draw calls (see Performance).
  - **Walk graph:** 6,835 nodes in one connected network: sidewalks along every kerb with a pavement, corners round each junction, the data's zebras plus crossings where an arm had none, paths, steps, footbridges, the towpath, the promenade, the boardwalk and the harbour plaza. Two boathouse piers that touch nothing were left out.
  - **Places (888):**
    - the data's 711 POIs, named with the same invented name as their shop sign, so a fare to "Brick & Basil" stops at the "Brick & Basil" sign. Dealerships keep those names (`Poi.signed`).
    - 160 homes on rowhouse streets, 9 parks and 3 waterfront spots.
    - 5 taxi ranks: M St at Wisconsin Ave, Key Bridge, the waterfront (K St), Pennsylvania Ave by Washington Circle and upper Wisconsin Ave.
    - The two dealerships are the data's car dealer and a garage.
    - You start on the M St pavement a block east of the Key Bridge landing, facing east, with your car at the kerb.
  - **Minimap, attribution, quality:** the minimap is painted from the data (11 ms). The pause menu shows `meta.attribution`. The quality switch changes the world's draw distance, detail and trees.
  - **Map core gaps closed:** `validateCityMap` checks lane points, walk nodes and parking spots against `heightAt(x, z, y)`. Georgetown has 0 mismatches, also with the art review branch merged in. Parked cars spawn at their spot's height. The taxi route start, police sight and witness sight use heights.
  - **Traffic on hills:** AI car bodies now have rounded edges. Their pitch is locked, so sharp boxes dug into slopes and kerbs and got shoved off their lanes: 185 times in two minutes before the change, about 6 after. A car only counts as "in my lane" if the two bodies actually overlap sideways.
  - **World fixes:**
    - Lamp posts no longer stand in lanes. Washington Circle had been snapped onto a few data lamps, and the Whitehurst Freeway's lamps stood in its kerbside lane; they now sit on the parapet.
    - `Poi.signed` needed `facades.SIGN_CATS` exported.
  - **Fix: the simulation froze after a slow start.** The first animation frame after a long boot could carry an older timestamp, which wound the step clock back and froze the game for as long as the boot took. It showed under 4x CPU throttle on Georgetown and would also bite on a slow laptop.
  - **Scenarios:** they ask for real places through `__mh.place('M St at Wisconsin Ave' | 'Key Bridge north end' | '29th St between N and P' | 'Washington Circle' | 'waterfront')`, which falls back to spots near the centre on the grid. Bodies and cameras are placed above the ground. `walk` and `drive` press real keys but count game seconds. The new `geoplay` scenario takes the screenshots, checks the pause menu and the quality switch, and runs a police chase. `shot.mjs` waits up to 180 s, because software GL renders a Georgetown frame in about 3 s.
  - **Test:** `npm run build`, then `MAP=georgetown node scripts/shot.mjs x <scenario>`.
    - On Georgetown, world, walk, drive, taxi, police, witness, theft, dealership, crashspikes and geoplay pass with a clean console. Final runs: mapcheck passed 3 of 4 (validate ok, 0 height mismatches, 30 lane choices with 1-2 recycles, 0.6-1.2 m max off lane, 20/20 walks, every place has a kerb); the fourth also made 30 choices, but one car swung 3.13 m off its lane coming out of a tight junction (the limit is 3 m; the grid's worst is 0.4 m); taxi 3 of 3 fares; witness: call, 1 star, lost; theft: unseen 0 stars, in front of people 1-2 stars with 4 callers and the owner chasing; dealership: bought, no crime; crashspikes: 930 frames, 0 over 33 ms, median 1.4 ms, worst 9.8 ms; geoplay: Key Bridge deck 14.6 m over the river, 7 cars flowing round Washington Circle, police see you after 16 s and you shake two stars 20 s after getting away.
    - On the grid (`node scripts/shot.mjs x <scenario>`), world, mapcheck, taxi, police, witness, gate2, handling, theft, dealership, hurtfx and crashspikes pass with a clean console. Handling numbers are identical to main's.
    - Screenshots: `27-geo-play-spawn`, `-mst-drive`, `-keybridge`, `-circle`, `-f3`, `-minimap`.
  - **Performance (4x CPU throttle, Medium, 3 interleaved runs, on foot at the spawn):**
    - CPU per frame without rendering: Georgetown 7.0–7.7 ms against 5.3–5.9 ms for the M2 build (529a13c) and 4.6–5.0 ms for this branch's grid. The gap is physics (4.1–4.4 ms against 2.3 ms): the world has 10,800 static colliders.
    - Frames over 33 ms: 0 on Georgetown; garbage 69 KB a frame (M2: 72 KB).
    - Draw calls and triangles: Georgetown ~648 calls and 926k triangles at the spawn view, against 137 and 189k for M2. About 490 of those calls are the 42 drivable cars (15 meshes each, plus shadows); the world itself is about 85 calls and 850k triangles.
    - Boot to first frame: 9.7–11.8 s on Georgetown (map build 7.7–9.2 s), 2.4–2.8 s on the grid. Unthrottled it is 2.8–3.9 s.
    - JS heap: 154–182 MB on Georgetown against 70 MB for M2.
    - Software GL can't measure GPU frame time, so I couldn't measure fps directly. With roughly 5x the draw calls and triangles of M2, Georgetown will very likely run below the M2 build on the same laptop and quality.
  - **Known issues:**
    - **Performance:** Georgetown misses the "never below M2 fps" bar. The two biggest levers are one merged mesh per parked car, as AI cars already have (about 450 fewer calls at the spawn), and a triangle budget for the world at Medium.
    - **Parking:**
      - Parking costs traffic a lane on M St, Wisconsin Ave and the other multi-lane roads.
      - On narrow two-way streets the moved lanes run over the painted centre line.
      - One-way single-lane streets (29th, 30th, 33rd, 34th St) have no kerbside parking at all.
      - The real fix is parking lanes in the world's carriageway widths.
    - **Lane obstructions:** some static geometry still sits in lanes and recycles the odd traffic car:
      - the K St and M St bridge decks over the parkway's kerbside lane at (375..385, 416..455) and (485..490, 103..128)
      - a Whitehurst column in Water St at (-249, 391)
      - Pennsylvania Ave's deck end at (473, 232)
      - something low on 30th St at (165, 276..286) that stops cars there
    - **mapcheck:** it follows one random car for 900 s, so these obstructions make it fail now and then (2 of 4 runs failed before the corner and lamp fixes, 1 of 4 after). Cars also swing up to ~3 m wide coming out of Georgetown's tight, skewed junctions.
    - **Traffic:**
      - Traffic ignores signals.
      - A roundabout yield only waits for cars turning at that node.
      - There are no lane changes, so traffic never passes a parked or broken-down car.
    - **Your car on hills:** a car with no throttle rolls back on Georgetown's hills (no hill hold).
    - **K St bridge:** the world drops the north sidewalk where the freeway runs beside the bridge, but the export doesn't say so, so a few walk nodes stand there.
    - **Taxi:** about a third of fares go to homes (160 of the 888 places).
    - **Police scenario:** its hit-and-run only gets stars if a witness calls, which sometimes doesn't happen. `geoplay` sets two stars directly for its chase.

- **M3 Georgetown CityMap review (step C0 review, branch `m3-geo-citymap`):** an independent audit of the map the entry above describes, with fixes. The checks are my own: every one-way lane against the data's `oneway` tag on every segment; Washington Circle's direction; sinks, sources and U-turn traps; level joins; every lane point against `roadSurfaceAt` and against the physics colliders; a car-sized box swept along every lane and every junction movement; a person-sized capsule swept along every walk link; parking spots against junctions, crossings, each other, traffic lanes and colliders; POI names; seed invariance; driving and walking with real key presses.
  - **What held up:**
    - All 62 one-way lanes run the data's way on every segment. The K St underpass has no lanes.
    - The 24 ring lanes run counter-clockwise on all 354 segments, and all 8 ring nodes are flagged roundabout.
    - There are no sinks, sources or U-turn traps, and no node joins a deck lane to the road below (the largest height spread at a node is under 0.6 m).
    - None of the 24,949 lane points is more than 0.3 m off `roadSurfaceAt`.
    - No parking spot is in a junction, within 3.5 m of a crossing, on top of another spot or on a deck.
    - Lanes, walk nodes, footprints, parking spots, POI positions and all 10,181 static colliders hash the same for seeds 1, 123 and 456. Only the shop names differ, plus the sign boards and awnings sized and coloured from them.
    - There is no real business or brand name in the in-game names, the data or the bundle.
  - **Fixed, traffic:**
    - **Levels:** the car-ahead test ignored height, so a car on the Whitehurst Freeway stopped for good behind one parked on K St 9 m below. Anything more than `traffic.levelGap` (+ `levelGrade` per metre ahead) above or below now counts as another level.
    - **Turning deadlock:** a turning car looked straight along its heading, across the junction. It waited for a car queuing at another approach, which in turn waited for the junction to clear: a 25 s deadlock until a recycle. Turning cars now measure the gap to their own curve and the lane after it.
    - **Narrow streets:** these flag their single lane each way `parking` (cars park along it), though its points keep clear of the parked cars. Traffic, spawning and routes avoided those lanes, so cars hardly ever drove that way along N, O, P or Prospect St. A parking lane is now avoided only when another lane goes the same way, as the contract says.
    - **Dealership in a lane:** the repair garage on 30th St (one-way, one lane) was a dealership, and its display pickup stood in the only lane. This was the "something low on 30th St" in the entry above. Dealerships now use POIs whose display slots keep out of the traffic lanes, and drop any slot that doesn't.
    - **Column in a lane:** a Whitehurst column stood in Water St's westbound lane at (-249, 391). Columns now keep `geo.columnRoadClear` from any carriageway below.
  - **Fixed, map:**
    - **Dropped buildings:** the CityMap listed 23 buildings that the world drops under decks (in the minimap, homes, POIs and MapIndex). They are now left out (`GeoWorld.droppedBuildings`), along with the 11 POIs that stood in them.
    - **Paths through buildings:** ground paths by the west waterfront ran through synthesized buildings, and path ends were then joined straight through them. Paths now stop at buildings, and joins skip links that cross one. Three piers whose only way in ran through a building are dropped.
    - **Parking spots:** 13 spots had a tree, a lamp or a slope where the car would stand. Every spot is now tested against the world's colliders (`map.parkingCheckClearance`). The test costs about 18 ms, and it moves the first physics step (the collider tree build) into the map build.
  - **Fixed, towpath:** the side walls of the canal steps started on the towpath's centre line, so they blocked the towpath under the 33rd St, Wisconsin Ave, 31st St, Thomas Jefferson St, 30th St and 29th St bridges. They now start once the stair has risen `geo.stairWallFrom`.
  - **Test:** `npm run build`, then `MAP=georgetown node scripts/shot.mjs x <scenario>`.
    - **Georgetown, final code:** world, walk, drive, taxi (3 of 3 fares), police (2 stars, lost), witness, theft (unseen 0 stars; in front of people 2 stars, 4 calls), dealership (K St and Pennsylvania Ave), crashspikes (0 of 930 frames over 33 ms, median 1.8 ms) and geoplay all exit 0 with a clean console.
    - **mapcheck:** 2 of 4 runs passed. One reached 25 choices before the 900 s limit after a recycle; the other made 30 choices with 0 recycles, but a car swung 3.94 m off its lane leaving a junction.
    - **Recycles:** same seeds, 900 s each, 26 cars: 21 and 18 on the code before this review (25 of them cars stuck, 14 crashes into static things), 9 and 11 now (3 stuck, 17 crashes, 1 of them car into car during a turn).
    - **Grid:** all 37 scenarios (every one but `perf`) exit 0 with a clean console. `chat` failed once (the known flake) and passed on the rerun. mapcheck: 30 choices, 0 recycles, 0.42 m off lane. The dealership sites are unchanged.
    - **Keyboard drive:** with real key presses I drove from the south end of Key Bridge, over it, onto M St and east to 31st St. All four wheels stayed on the ground the whole way, with no damage. The colliders under the car were within 0.006 m of `roadSurfaceAt`, and the car stayed at most 3.1 m from the route line (at the landing turn).
    - **Keyboard walk:** the towpath from (-552, 234) to (-341, 241) now gets through; before the fix it stopped at the 33rd St steps. Screenshots `28-c0review-*`.
  - **Performance against the M2 build (529a13c):** 4x CPU throttle, Medium, 3 interleaved rounds of M2 / Georgetown / this branch's grid.
    - **CPU per frame, no render (median):**

      | | M2 | Georgetown | this branch, grid |
      |---|---|---|---|
      | on foot at the spawn | 5.1–5.9 ms | 7.5–8.3 ms | 4.5–4.8 ms |
      | driving | 5.1–6.3 ms | 8.4–10.6 ms | 4.5–5.0 ms |
      | physics on foot | 2.1–2.5 ms | 4.5–4.9 ms | |

    - **Frames over 33 ms, no render:** 0–2 for M2, 0–2 for Georgetown.
    - **Garbage per frame:** 69–97 KB for M2, 65–79 KB for Georgetown.
    - **Draw calls:** 135–149 for M2, 637–645 for Georgetown.
    - **Triangles:** 188–192k for M2, about 1.0M for Georgetown.
    - **Heap:** 53–56 MB for M2, 162–181 MB for Georgetown.
    - **First frame:** 11.2–11.8 s on Georgetown, 2.3–2.8 s on the grid.
    - Georgetown still very likely runs below the M2 build at the same quality.
  - **Known issues:**
    - **Traffic engineer:**
      - **Corner lamps:** 35 of 2,204 junction movements sweep into a lamp or wall at 13 junctions, for example (-153.8, 394.9) at K St / Wisconsin Ave, (-749.4, 142) at the Key Bridge landing, (-717.6, -702.1) at 35th / R St, and New Hampshire Ave at L St and at 22nd St. 98 movements put a wheel 3 m or more off the carriageway. Most remaining recycles come from these.
      - **Parkway:** the Rock Creek Parkway bank stands 0.4 m into its kerbside lane under the K St, M St and Pennsylvania Ave bridges.
      - **Canal Rd:** its bank rises within 1 m of the westbound lane's centre.
      - **Lane changes at junctions:** cars change lane while crossing a junction, which takes them past other cars waiting side by side (33 movements).
      - **Turn collisions:** the turning test can now let a car clip one waiting at a narrow junction (once in 30 minutes).
      - **Narrow streets:** only 0.025 m spare between a pickup and a parked pickup.
      - **mapcheck:** it fails on any single recycle or a 3 m swing.
    - **Art engineer (also on the art review branch, merged and tested):**
      - **Footbridge entrances:** the canal's north retaining wall stands 0.6–1.0 m tall across each footbridge's north entrance ((-564, 216), (-330, 216)), so the footbridges can't be entered from the north.
      - **Footbridge rails:** this branch's single rail box runs down each footbridge's centre line and blocks the towpath at (-564, 233) and (-330, 241). The art review branch moves the rails to the sides, but its rail slabs reach the towpath where the bridges land, and still block it (`28-c0review-towpath-footbridge-rails-merged`).
      - **Lock step:** the towpath has a 0.8 m step at the lock near x 36, so you can't walk it westward.
      - **Trees on footpaths:** trees and lamps stand on the footpath centre lines on Dumbarton St and Potomac St, blocking 114 walk links for a person.
      - **Low bridges:** the camera goes inside the deck of the low canal bridges when you walk under them.
    - **Merge note:** merging `m3-geo-art-review` conflicts in `georgetownWorld.ts` (keep both `droppedBuildings` and `audit`; that branch already adds its street-clipped drops to the same set) and in DEVLOG.md.

## 2026-11-05: Stage 1 (fix the foundation)

- **S1.5 Research (branch `s1-research`, documents only, no game code):** three write-ups in `docs/research/`, with sources and the date each was read.
  - **`google-3d-tiles.md`:**
    - **Gameplay: no.** The Maps Platform ToS (Aug 26, 2026) forbids:
      - scraping, pre-fetching and caching (3.2.3 a, b)
      - creating content from the tiles, including collision, heights or footprints (3.2.3 c, plus the Map Tiles policy's hybrid-3D rule)
      - using them "with or near a non-Google Map" (3.2.3 e), which our minimap and OSM-based city are
    - **Data:** the tiles are one photogrammetry skin with baked lighting, so no buildings, doors or collision meaning.
    - **Optional viewer:** only on a separate page, only with the owner's own billing account (non-EEA; EEA projects created after 8 July 2025 get 403), and only with:
      - a referrer- and API-restricted key with hard quota caps
      - the Google logo and live tile attribution
      - a terms and privacy notice
    - **Cost:** Enterprise SKU, 1,000 root requests a month free, then about $6 per 1,000, so about $54 a month at 10,000 viewer opens.
  - **`map-data.md`:** Overture `2026-10-21.0` over raw OSM, which is unreachable here.
    - **Licences per theme:**
      - transportation, buildings and base are ODbL
      - places are CDLA-Permissive-2.0, plus Apache-2.0 (Foursquare) and CC0 records
      - addresses are per source
    - **Licence obligations:** `georgetown.json` is an ODbL derivative database, so we publish it, or the importer plus the release id, with notices. Places go in a separate CDLA file with categories only.
    - **Schema:** field-by-field mapping to the generator's needs, read from the real Parquet footers of the release.
    - **Georgetown fill rates** (measured by range-reading only the matching row groups):
      - transportation: 2,898 segments; one-way on 327 of 1,000 drivable segments; speed limits on 33%; width on 0.1%; no lanes field
      - steps, sidewalks, crosswalks: 235 steps, 442 sidewalks, 267 crosswalks
      - base infrastructure: 848 crossings, 102 signals, 117 stop signs
      - buildings: 4,720, with heights on 39% (USGS lidar and Microsoft), 140 footprints under Esri CC BY 4.0, 0 entrances
      - places: 3,822, of which 336 rely on Foursquare/Apache-2.0
    - **Terrain Tiles:** USGS NED/3DEP 1/9″ DC 2008 at z15 (3.7 m/px; z16 is 404), Terrarium encoding, bare earth with bridges removed, river surface about 0–0.2 m.
    - **Strings:** ready-to-paste pause menu, README and `DATA-LICENSE.md` text.
  - **`textures-and-assets.md`:**
    - **CC0 sources:** ambientCG and Poly Haven need no attribution (Poly Haven's API ToS asks for a credit only when its live API is used inside an app); TextureCan, 3DTextures.me, Kenney; per-model care for Poly Pizza and Sketchfab. (ShareTextures removed by the fact-check below.)
    - **Procedural PBR:** techniques for our `WebGLRenderer` (TSL noise and triplanar exist in r187 but need `WebGPURenderer`).
    - **Compression:** three r187 already ships the Basis transcoder and `KTX2Loader`, which picks BC7 on desktop. `ktx2-encoder` (npm, WASM, MIT) encodes at build time; glTF-Transform's `etc1s`/`uastc` need KTX-Software.
    - **Network:** the exact hosts the owner would allow, under Network access → Custom with the default list kept.
  - **How to test:** read the three files; every number is reproducible from the commands and URLs they cite.
  - **Known issues:**
    - `developers.google.com`, `mapsplatform.google.com`, `docs.overturemaps.org`, `osmfoundation.org`, `openstreetmap.org`, `opendatacommons.org`, `cdla.dev` and every texture site are blocked from this environment. Google's Map Tiles policies and prices, the OSMF attribution and produced-work guidelines, and the texture sites' licence pages were read only as web-search extracts (marked in the docs); licence texts were read from SPDX copies.
    - Google prices and quotas must be checked in the Cloud console before any spending.
    - Nothing was measured against the live Google service (no key).
    - The README's current "Map data © OpenStreetMap contributors" line describes data that is still synthetic.
- **S1.5 Research fact-check (same branch, documents only):** a second reader re-checked every legal, licence, price and attribution claim in `docs/research/*.md` against primary sources where reachable (Google terms re-downloaded from cloud.google.com; SPDX licence texts; Overture docs, joerd and AWS registry files from GitHub; npm registry; three's own files; the Claude Code docs) and by fresh web searches where the host is blocked. Corrections are marked "fact-check" in the docs.
  - **Google viewer:** downgraded from "legally possible" to "legally doubtful". A page with only Google tiles is hard to square with ToS 3.2.3 (d) (product "must contain substantial, independent value and features beyond the Google products") and the Customer Application definition, while our own map on it breaks 3.2.3 (e); example (iii) of 3.2.3 (e) also covers linking, so "a link from the pause menu is fine" was withdrawn. Added the binding attribution clause 3.2.2 (b) and the clauses that make the policy pages binding (ToS 4.2, SST A.1). Prices ($6.00 per 1,000 after 1,000 free, Enterprise SKU) and the EEA 8 July 2025 cut-off are confirmed again by search extracts only.
  - **Map data:** the 140 Esri Community Maps footprints are CC BY 4.0; putting them in the ODbL `georgetown.json` needs a waiver of CC BY §2(a)(5)(B) that, as far as I can find, Esri gave to OpenStreetMap and its users only (unconfirmed). Recommendation now: drop them or keep them in a separate CC BY file. Attribution strings rewritten: ODbL 4.3 hyperlinks, CC BY licence link and "modified" note, AllThePlaces is CC0 (not CDLA), Mapzen added (joerd lists it as required for the hosted tiles). 3DEP 1/9″ starts at z11, not z10. Licence counts in the clipped Georgetown data recounted and confirmed.
  - **Textures:** ShareTextures now states a "Custom CC0 ... with specific restrictions" licence, so it is marked avoid. Shipping three's Basis transcoder means shipping its Apache-2.0 licence text with it. Network-settings steps now follow the current Claude Code page.
  - **How to test:** read the "fact-check" notes in the three documents; the commands are in the fact-check report (re-download of the five Google terms pages, SPDX texts, `sources[]` recount with pyarrow on the clipped Parquet files, HEAD on three terrain tiles).
  - **Known issues:** the Map Tiles policy, price and quota pages, Esri's waiver post, the Foursquare NOTICE page, the OSMF guidelines and the texture sites are still read only as search extracts; none of the Google statements was tested against the live service.
