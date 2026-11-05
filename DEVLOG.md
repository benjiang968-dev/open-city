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

- **M3 traffic and police on Georgetown's road graph (step C1, branch `m3-geo-traffic`, on top of `m3-geo-citymap`):** traffic now follows junction rules, keeps to its lanes, changes lane before a turn and follows the player around; police dispatch and search on the directed graph. Both maps (`?map=grid` keeps its scenarios passing).
  - **Junction control (`src/systems/junctions.ts`, new), built once per map from the CityMap:**
    - **Moves and lane discipline:** every lane-to-lane move through every node, typed straight / right / left / U-turn. Right turns go kerbside lane to kerbside lane, left turns inside lane to inside lane, straight on keeps to the lane that carries on. Parking lanes on multi-lane roads are not traffic lanes. This also stops cars cutting across lanes inside junctions.
    - **Conflicts:** two moves conflict if their junction curves come within `traffic.conflictDist` (2.9 m) or they merge into one lane. A car never starts across a junction while a conflicting move is in it, or while a car given the go is within `boxReserveTime` of its line on one, or while its exit lane is queued (`exitSpace`).
    - **Control per node:** signals, all-way stop, priority (different road classes: `traffic.classRank`, the lower gives way), all-way give way (equal roads: a 0.9 s pause, then first come, first served), ring, dead end, pass-through. Georgetown: 57 signals, 53 stop, 3 priority, 3 all-way, 8 ring, 23 dead ends, 19 pass-through. Grid: 60 all-way, 10 priority (the bay boulevard).
    - **Signals (`TUNING.signals`):** head-on approaches share a phase; the phase with the junction's biggest road gets the long green. Actuated: detectors at the stop lines (AI cars and your car) call a phase; green lasts at least 6 s, is held while traffic keeps coming (up to 18 s, 10 s for side phases) or while nobody waits elsewhere; then amber 3 s and all-red 1.5 s. The two K St mid-block crossings keep a fixed walk phase. (Fixed-time cycles had side streets waiting 33 s at K St / Whitehurst.)
    - **Amber:** asked again every check while approaching. A car goes only if it reaches the line before red (`amberMargin`) or can't stop where waiting cars stand. On red, anyone who can still stop does (`redCommitSpeed`). A left turner that waited at the line clears on amber.
    - **Waiting position:** front bumper `stopBehindLine` behind the line, further back where another approach's curve passes close (`stopClearance` 2.3 m, at most `stopBackMax` 8 m). At tight Georgetown junctions, turning cars were clipping waiting ones.
    - **Roundabout:** entering cars yield to circulating cars heading for their entry (closer than 34 m along the ring and under 3.6 s away, or within 10 m), except ones leaving there on a clear move. Circulating cars never wait at the ring's nodes, run at most `ringSpeed` 8.5 m/s, and go round again rather than exit into a queue. The data flags the circle's entries as signals; the ring rule wins (`props.ts` already drew no heads there).
  - **Signal lights (`src/systems/signalHeads.ts`, new):** the world already drew poles and heads (`props.ts`). Their lenses are now dark glass, and one InstancedMesh of small glowing squares lights the lens each approach is shown. Only heads whose light changed are rewritten, without allocation; 1 extra draw call. `GeoWorld.signalHeads` exports each head's place, yaw, junction and arm.
  - **Traffic (`src/systems/traffic.ts`):**
    - **Planning:** on entering a lane, a car picks a random allowed move at the next junction. If that move leaves from another lane, it changes lanes first (`laneChangeMinRoom`, `laneChangeGapAhead/Behind`, sideways at `laneChangeRate`), else it picks a move its own lane may make.
    - **Approach:** it asks `junctionHold` within braking distance + `decideDist`, then brakes (`approachDecel`) for its waiting spot or for the curve's speed (`turnLatAccel`, `turnSpeedMin`).
    - **Pass-through nodes:** where the lanes shift sideways, the car drifts across, not round a curve over no distance.
    - **Map edges:** dead ends within `mapEdgeRange` of the map's edge are roads leaving it, so cars drive off there (out of sight) instead of U-turning.
    - **Box nudge:** a car stuck in a junction for `boxNudgeTime` stops being held by AI cars not on its own way out.
  - **CityMap:** `LaneEdge.left` / `right` (same from, to and road, lane ± 1), filled by `linkLaneNeighbours` in both maps and checked by `validateCityMap`. `RoadNode.stop` added (the grid sets false).
  - **Population (`src/systems/trafficPopulation.ts`, new):**
    - **Count:** `traffic.countByQuality` gives low 18 / medium 26 (as M2) / high 34 cars. All 34 are built at boot, and the extras wait out of the world. The pause-menu switch takes effect live.
    - **Moving cars:** these cars are moved, at most one per frame, to a lane 110–300 m from the player:
      - cars more than `despawnRadius` 340 m from the player
      - stranded cars (shoved off the road, gridlocked, or driven off the map)
    - **Where they go:** the lane is picked by length × `densityByClass`. It is never in sight (view cone plus one ray against buildings and hills) and never within `spawnClearance` of another car, and the car starts already moving.
    - **Stranded in sight:** a car stranded in sight is moved after 50 s anyway.
  - **Police (`src/systems/police.ts`):**
    - **Dispatch:** onto a traffic lane about `spawnDistance` away, behind the camera when possible, never in sight, and with a directed route to your last known lane.
    - **Search:** once there with no sight of you, they cruise to lanes within `searchRadius` 160 m of it.
    - **Direct chase:** they drive straight at you only within `directChaseLevelGap` 3 m of your height.
    - **Sight rays:** these reuse one Ray instead of a new one per check.
    - **Losing them:** unchanged.
  - **Audit (`src/systems/trafficAudit.ts`, new):**
    - **Always on:** signal crossings, red-light runs, ring entries and entries that did not yield, lane changes, recycles, respawns, cars driven off the map.
    - **With `w.trafficSim.measure` on (tests):** a per-step check of every AI car:
      - against its lane
      - off its intended path (beyond a lane change's offset)
      - off its level
      - AI cars overlapping
      - still for more than 20 s
      - stopped on the ring
    - **F3:** a new traffic line (at red, giving way, lane changes, red runs, ring entries).
  - **New scenario `geodrive`** (`MAP=georgetown node scripts/shot.mjs x geodrive`):
    - **The drive:** your car drives Key Bridge → M St east → Pennsylvania Ave → once round Washington Circle (outer lane) → K St west to Thomas Jefferson St (3.39 km). It is one teleport at the start, then a pure-pursuit autopilot pressing only W/A/S/D/Space.
    - **Driving rules:** it takes the inside lane where it may and changes lanes along the road where it must. It stops for red lights and at stop signs, yields entering the circle and keeps its distance.
    - **What it measures:** the route, everything above, an independent check of every AI car's lane-to-lane moves, CPU per frame and the traffic / police profiler sections.
    - **Screenshots:** `28-traffic-{keybridge,mst,signals,circle}`.
  - **Other scenario changes:**
    - `mapcheck`: a lane change is not a choice, off-lane is measured beyond the lane-change offset, and the followed car is kept.
    - `geoplay`: places its ring cars with `__ocTraffic.placeOnEdge`.
    - **Test hooks:** `window.__ocTraffic`, `w.trafficSim`, `w.junctions`.
  - **Test:** `npm run build`, then `node scripts/shot.mjs x <scenario>` (`MAP=georgetown` for Georgetown). All runs below exited 0 with a clean console.
    - **geodrive, final code:**
      - The route was completed in 401 s with no damage and no red-light runs by your car.
      - AI cars:
        - 0 wrong-way moves, and 0 illegal moves out of 579 checked.
        - 0 red-light runs out of 340 signal crossings.
        - 0 of 18 circle entries failed to yield; 0 stops on the ring.
        - 2 cars still for more than 20 s, both at red lights (longest 22.6 s, at the 3-phase signals at I St / 24th St / New Hampshire Ave and at K St / Whitehurst).
        - 1.26 m at most off their path.
        - 0 AI collisions.
        - 1 car off its level (see known issues).
        - 72 lane changes.
      - Profiler, unthrottled: traffic 0.18 ms per frame, police 0.05, traffic-ctl 0.01.
    - **geodrive, earlier runs:** two runs on the same rules (before the last steering fix) took 414 and 464 s. They had 0 red-light runs out of 339 and 386 crossings, 0 of 24 and 0 of 33 circle entries failing to yield, 2 and 8 AI collisions, and 1 and 4 cars still for more than 20 s not at a red light. The second run's wrong-way move (a car that pulled up past its lane's end and steered back to it) is what the last fix cured.
    - **Georgetown:**
      - mapcheck: 4 of 4 runs passed. Each made 30 choices with 0–1 recycles and 0.42–1.23 m off lane.
      - geoplay: 6 cars flowing round the circle at 31 km/h; police first saw you at 22–29 s and you lost them by 47–48 s; the attribution and quality switch are fine.
      - Others: taxi (3 of 3 fares), theft (unseen: 0 stars; witnessed: 1 star, 2 calls), witness, police (no stars, as on C0: no witness called), crashspikes.
    - **Quality presets:** traffic switches between 18, 34 and 26 cars live.
    - **Grid:** traffic2, police (seen at 7–13 s, lost by 45–60 s), witness, gate2, crashspikes and mapcheck pass (30 choices, 0 jumps, 0.15–0.65 m off lane).
    - **handling (grid):** the runs that got into the car gave numbers identical to the C0 build's, every snapshot. 2 of 4 runs on this branch never got into the car: the prompt was empty with no person, item or other car near, which means the game hadn't started yet or the player was down. I didn't confirm which. The traffic now gathers round the player, who stands in a live lane of the boulevard in that test.
  - **Performance against M2 (529a13c):** 4x CPU throttle, Medium, 3 interleaved rounds, using the C0 reviewer's perfab2 method. The machine was shared at load average 13–16 on 4 cores, so frames over 33 ms show up in every build, M2 included.

    | CPU ms per frame, no render | M2 grid | C0 Georgetown | this branch, Georgetown | this branch, grid |
    |---|---|---|---|---|
    | median on foot | 5.9–6.4 | 6.4–8.6 | 7.4–7.6 (one run 1.9, an outlier) | 5.2–6.0 |
    | median driving | 5.8–6.3 | 7.2–10.1 | 8.5–9.2 | 5.1–6.0 |
    | traffic on foot / driving | 0.43–0.82 / 0.61–1.11 | 0.55–0.75 / 0.51–0.75 | 0.55–0.69 / 0.66–0.77 | 0.54–0.86 / 0.66–1.46 |
    | traffic-ctl (new: population, signal lights) | – | – | 0.07–0.11 | 0.07–0.10 |
    | police section (witnesses, police, health) | 0.24–0.35 | 0.19–0.52 | 0.18–0.28 | 0.19–0.95 |
    | physics on foot | 2.7–2.9 | 4.2–5.8 | 4.0–4.3 | 2.4–3.0 |
    | frames over 33 ms per 600, on foot | 8–16 | 5–14 | 6–12 | 1–10 |
    | garbage per frame on foot | 65–70 KB | 65–67 KB | 65–71 KB | 57–62 KB |
    | draw calls / triangles | 135–151 / 188–193k | 638–643 / ~1.0M | 626–635 / ~1.0M | 161–190 / 192–195k |

    - **Result:** traffic and police CPU is the same as before within the noise. Georgetown as a whole is still well above M2 (physics, draw calls and triangles from the world, as reported in C0). Software GL gives no fps figure.
  - **Known issues:**
    - **Pennsylvania Ave bridge, east deck end (473, 233):** a kerb corner stands about 1 m into the eastbound kerbside lane 229. AI cars there get thrown up 2.5 m (the one "off its level" per run), and your car stalls on it in that lane. This is world geometry (the C0 builder listed it); the autopilot keeps to the inside lane there.
    - **Washington Circle's K St entry (849, 447):** the K St lane is 25 m long, too short to wait clear of the ring's curve. Circulating cars clip cars waiting there (5 of the 8 collisions in one run, 0 in the final run).
    - **3-phase signals:** at 5-arm junctions, a side road can wait just over 20 s at red: 22.6 s at most, seen at I St / 24th St / New Hampshire Ave and at K St / Whitehurst.
    - **Other collisions:** in tight turns and on the Rock Creek Parkway under the bridges (static geometry in the lanes, as C0 reported), 0–8 AI collisions in 6–8 minutes of driving.
    - **M St:** effectively one traffic lane each way, since C0 made the kerbside lane the parking lane, so M St has no lane changes. Lane changes happen on Key Bridge, Pennsylvania Ave, K St, the freeway, the parkway and L St.
    - **Key Bridge / M St / Whitehurst Freeway (node 5):** not signalised in the data, so it runs as an all-way give way. It is a busy junction for that.
    - **Sparse traffic:** 26 cars around the player (the M2 budget) look thin on Georgetown's longer streets, and `28-traffic-circle` caught few cars on the circle.
    - **Spikes:** unthrottled frames over 33 ms land in random sections (physics, peds, hud, traffic), on a machine at load 12–16. The interleaved A/B shows them in M2 as well, so they can't be pinned on traffic here. This needs a quiet machine.
    - **Gaps:** traffic doesn't pull over for police, and people don't obey signals.

- **M3 traffic and police review (step C1 review, branch `m3-geo-traffic`):** an independent check of the entry above, with my own probes and fixes. Most of it holds up. Stress tests found collisions at Washington Circle's K St links, police that could not reach a player on Key Bridge, and cul-de-sacs that jammed.
  - **What I checked:**
    - **Signal phases (static, all 57 signals):** only head-on approaches share a phase. Within a phase, 99 pairs of moves count as conflicting, all head-on straight or right turns against straight on narrow streets, where the two curves pass within `conflictDist` 2.9 m. That makes cars wait for the box to clear more than they need to; it never lets crossing flows go together. Left turns on green give way to oncoming traffic.
    - **One-way streets:** the map's own one-way check passes on every boot, and no geodrive or stress run showed a traffic car driving against its lane.
    - **Washington Circle at high density (`ring` probe, 300 s, 18 or 30 cars kept round the circle and fed back in on the approaches):** an independent check of every entry against the circulating cars in the same or an outer lane found 0 entries with such a car under 1.2 s away, as built and after my changes. The yield rule works. The collisions were elsewhere at the circle: see the fixes.
    - **Decks (`deck` probe, 30 cars kept on Key Bridge, the Whitehurst Freeway and the other decks and on the roads under them, 180 s):** 55,808 car-steps, 33,348 of them on decks. There was 1 car off its level, at the known Pennsylvania Ave kerb (476, 233); 0 collisions, 0 wrong-way, 0 stuck.
    - **Police on Georgetown (`pol` probe, 2 stars):** dispatch, sight, routing, search and losing them, on foot on M St and on the Key Bridge deck.
  - **Fixes (8 commits on the branch):**
    - **Washington Circle, K St links:** the two links from K St onto the circle are 25 m long, between the underpass junctions (nodes 113 and 114, signals) and the ring, and leave 2–3 m of lane.
      - They were treated as narrow streets with parking, so their two lanes ran 2.3 m apart. A link onto a roundabout now gets no parking (`georgetownMap.ts`), and its lanes are 3.4 m apart.
      - Cars were told to give way on the link at speed and stopped in the ring lane. Lanes too short to stop on are now marked at build (`junctions.shortLane`). A car crosses into one before a roundabout no faster than `ringEntryCreep` 3.5 m/s, and stops at the entry if the ring is busy. It enters one before a signal only on green (with `shortLaneGreenLeft` 3 s left at a fixed-time crossing). A circulating car doesn't leave into one while that light isn't green; it goes round again.
    - **Washington Circle, entries and exits:**
      - Every roundabout entry is approached at `ringEntryCreep` at most, so a circulating car that turns up late can still be given way to.
      - A car given the go while standing back from an entry looks at the ring again before it joins.
      - A car leaving from an inner lane goes round again when a car in an outer lane is level with it or up to `ringExitGap` 10 m behind. Inner-lane exits used to cut across the outer lane.
      - A circulating car's choice to leave or go round is final `ringExitFreeze` 4 m before the node, and entering cars only rely on an exit plan from there.
    - **Turning cars:**
      - A car waiting on our exit lane is now an obstacle (it was skipped like any waiting car).
      - In a turn, the car ahead is found near our curve, not in the straight-ahead band (rear-ends in tight turns), plus anything straight ahead within `turnTouchGap` 1.5 m.
      - The exit lane's heading is cached with the curve, so checking every object ahead against the curve makes no garbage.
    - **Police dispatch and routing:** with you standing on the Key Bridge deck at 2 stars, both cars went to the same spot on Water St, on top of each other, or to the fallback lane 1.2 km away. The route to the nearest lane started at the Virginia end, a 1.9 km drive. They never got near, and you lost both stars in 33 s by standing still.
      - Police now route to the nearest lane or the lane the other way along the same road, whichever is the shorter drive, and reaching either counts.
      - Dispatch takes lanes in the band clear of other cars. The best `spawnRouteChecks` 8 out of sight get a route check, and the drive length counts against them.
      - If the best drive is over `spawnMaxDrive` 700 m, dispatch looks out to 3 × `spawnDistance`, then accepts a spot in view.
    - **Cul-de-sacs:** with four cars sent in to turn round at each of the three dead ends inside the map, 1 of 12 got out in 60 s. The car that had turned saw the queue in the other lane (2.3 m away on a narrow street) as in its way, and the queue waited for it.
      - Traffic no longer turns into a cul-de-sac (`junctions.culDeSac`) while another move is open.
      - An oncoming car whose side clears ours by `passGap` 0.05 m is passing, not an obstacle.
      - After the fix, N St and 24th St cleared; Water St still jams when four cars are put there.
    - **Test harness:**
      - `S.start` in `shot.mjs` now waits until the game has started. On a loaded machine the first frame after Enter can take longer than the 1.5 s wait, and E pressed before it did nothing. That was the handling scenario's "never got into the car".
      - geodrive's autopilot stops for the signal at the end of a lane too short to stop on. It no longer holds once over the line: it had stopped in the circle's entry and the ring stopped for it.
      - It counts people only in the road (AI traffic's 1.7 m band).
      - It logs each hit your car takes (`damageEvents`).
  - **Test:** `npm run build`, then `node scripts/shot.mjs` (`MAP=georgetown` for Georgetown). Every run below exited 0 with a clean console.
    - **Probes:** run with `node probe.mjs <dist> <file.js> georgetown`. The probe files are in the review scratchpad, not the repo.
    - **ring, as built → reviewed (same probe):**
      - With 18 cars: collisions 8 → 0, circle entries 108 → 99 in 300 s, longest wait 27 → 58 s.
      - With 30 cars: collisions 6 → 0 (3 runs), entries 138 → 101–108, longest wait 27 → 94–235 s.
      - Red-light runs 0 and wrong-way 0 throughout. Under saturation the circle is safer now, but slower.
    - **Police:** seen at 7.4 s and 3.7 s on M St, and at 12.4 s and 14.1 s on the Key Bridge deck (never before). After moving out of sight, you lose them in 19–27 s.
    - **geodrive, as built:** done in 430 s; AI 5 collisions, red 0 of 359, circle 16 of 16 yielded, 3 cars still for more than 20 s (all at red, longest 30 s).
    - **geodrive, final code, 3 runs:**
      - Done in 367–414 s with no damage, and 1 red run by your car in one run.
      - AI: 0 wrong-way, 0 illegal moves of 528–644, 0 red-light runs of 298–355, all 15–29 circle entries yielded.
      - 0–3 collisions and 2–4 cars still for more than 20 s (longest 25–46 s).
    - **geodrive, earlier on the review:** one run stalled 60 s behind a person at the kerb edge at Key Bridge's north end (-766, 179), who kept walking into the stopped car (screenshot in the scratchpad).
    - **Georgetown:** mapcheck, geoplay, taxi (3 fares), theft, witness, crashspikes and police all pass.
    - **Grid:** traffic2, police, witness, gate2, crashspikes and mapcheck pass. handling: 2 runs with the harness fix, both in the car, every snapshot identical to the build as made. One run before the fix never got in.
  - **Performance against M2 (529a13c):** 4x CPU throttle, Medium, the C0 reviewer's perfab2 method, 3 interleaved rounds per build. The machine was quiet for this pass (load 4.4–4.8 on 4 cores); an earlier pass at load 19–37 gave the same picture with more noise.

    | CPU ms per frame, no render | M2 grid | C1 as built, Georgetown | reviewed, Georgetown | reviewed, grid |
    |---|---|---|---|---|
    | median on foot / driving | 4.9–5.4 / 4.7–5.8 | 6.5–7.7 / 6.4–7.9 | 7.0–7.6 / 6.3–7.6 | 4.7–5.1 / 4.3–5.0 |
    | traffic on foot / driving | 0.34–0.43 / 0.33–0.55 | 0.51–0.60 / 0.46–0.67 | 0.57–0.70 / 0.52–0.75 | 0.50–0.54 / 0.51–0.81 |
    | traffic-ctl on foot | – | 0.09–0.12 | 0.07–0.08 | 0.07–0.10 |
    | police section on foot / driving | 0.20–0.22 / 0.16–0.27 | 0.22–0.25 / 0.21–0.30 | 0.24–0.25 / 0.19–0.25 | 0.20–0.25 / 0.14–0.20 |
    | frames over 33 ms per 600, on foot | 0–2 | 1 | 0 | 0–1 |
    | garbage per frame, on foot / driving | 70–71 / 73–85 KB | 66–74 / 73–80 KB | 66–73 / 71–81 KB | 53–61 / 69–73 KB |
    | draw calls / triangles | 124–136 / 188k | 631–634 / 997k | 632–634 / 997k | 169 / 192k |

    - **Traffic CPU:** the review's extra checks cost about 0.05 ms per frame at 4x throttle over the build as made (within the run-to-run spread). The C1 traffic costs about 0.2 ms more than M2's, about 0.05 ms unthrottled.
    - **Garbage:** a sim-only A/B (1800 fixed steps, high preset) first showed the review adding 5–6 KB per step; caching the exit heading brought it back level with the build as made (30–33 vs 31–36 KB).
    - **Police dispatch:** the worst frame (5 stars, one car dispatched per frame, 4x throttle, loaded machine) was 5.4–15.7 ms as built and 9.5–16.4 ms with 12 route checks, before they were capped at 8.
    - **Georgetown overall:** still above M2 (physics, draw calls, triangles: the world, as C0 reported). Software GL gives no fps, so whether it holds the M2 frame rate on your laptop is still unmeasured.
  - **Known issues:**
    - **Pennsylvania Ave deck kerb (473, 233):** still throws AI cars up 2.5 m, 0–5 times per geodrive. It is world geometry; `m3-geo-art-review` has a "deck ends meet their junctions" fix that may cover it, and needs checking after the merge. Cars on the Rock Creek Parkway under K St (379, 439) were also thrown once.
    - **Saturation:** with 30 cars kept round the circle, queues back up through Pennsylvania Ave's junctions (nodes 104–107) and cars wait in the box for minutes. In play, `stuckRecycle` moves them after 25 s.
    - **Lane drops:** 9 places where two lanes merge into one; 4 of them are uncontrolled (nodes 16, 94, 142, 143), so two cars can merge side by side.
    - **Other collisions:** at tight turns where two cars leave one lane on different moves, or where two junction curves pass closer than the cars' bodies allow.
    - **Water St cul-de-sac (-911, 266):** still jams if several cars are placed in it; traffic no longer drives in, but respawns can put one there.
    - **Narrow streets:** opposing straight moves count as conflicting at junctions, so cars cross one at a time.
    - **Lane discipline:** Key Bridge lane 606 has no allowed move at node 5, so a car on it takes any move.
    - **geodrive:** it reports `stuck` without failing the run (the harness fails only on console errors), so read its `completed` field.
- **M3 Life on Georgetown's streets (branch `m3-geo-life`, step C2):** crowds that follow the map, parked cars that match the street, three dealerships, taxi fares to named places, a readable minimap and seeded items kept in sane spots. Built on `m3-geo-citymap` (merged in). Everything works on both maps; `?map=grid` stays the default.
  - **Crowd density from the map** (`src/systems/pedDensity.ts`, numbers in `TUNING.peds.density`):
    - Every walk link gets a number of people per metre. Sidewalks start from the class of the road beside them; towpath, park paths, waterfront and plazas from their kind. Each shop, cafe, restaurant, bar or market within 40 m adds `perShop`. Each part follows its own day curve: `shops` (lunch rush, then dinner), `homes` (commutes, quiet nights), `waterfront` (evenings) and `outdoor` (early joggers, after-work walks).
    - Around you, the links within `radius` (90 m) add up to a real-world head count. At lunch that is about 1 person per 8 m of pavement on M St at Wisconsin Ave and 1 per 41 m on 29th St.
    - The head count is scaled to the quality's `pedBudget`. `fullBudgetAt` is the count that fills the whole budget: 100 on Georgetown (M St at lunch), 24 on the grid, whose places each stand for a row of shops. There are never fewer than `minActive` (4).
    - People appear and leave out of view to follow the target. Spawn points are picked by the same scores. Walkers who get past `recycleDistance` (100 m, was 230 m) out of view are moved back to a busy spot. People on a busy street often head to a shop nearby (`errandChance`), so the crowd stays where the shops are.
    - Dog walkers and joggers spawn 8x more on the towpath, 5x on the waterfront and 3x on park paths. Their routes count those links at half length (`WalkRouter.path` takes per-node cost factors), and most of their trips end at a towpath or waterfront spot.
    - The budgets are unchanged (Low 30, Medium 45, High 60). Georgetown already uses more CPU than the M2 build (below), so there was no room to raise them. Kids still only come out with their parent and stay invulnerable.
    - F3 has a new line, e.g. `people  target 45 (real 115 in 90 m, budget 45) · active 44 · near 41`.
  - **Parked cars by street class** (`src/systems/parkedCars.ts`; `TUNING.vehicles.parkedCarsPer100m` by map and street class):
    - **Georgetown densities, cars per 100 m of kerb:** primary 11 (M St, Wisconsin Ave, K St, Pennsylvania Ave, Canal Rd), secondary 7, tertiary 6, residential 3.5, service 2, parkway 0.
    - **Car parks:** `lotFill` 0.5; car parks by the river get `waterfrontLotFill` 0.95.
    - **Kerb spots:** Georgetown's are now every 6.5 m (`map.kerbSpotSpacing`; was 13 m). Each spot says how much kerb it stands for (`ParkingSpot.span`). The grid keeps its old numbers.
    - **Measured on Georgetown:** 1,957 parked cars, 1,303 at the kerb and 654 in car parks. Per 100 m of kerb: M St 11.0, Wisconsin Ave 10.9, N St 3.6, Prospect St 4.0. 29th St has none: it is one-way with one lane, so it has no parking lane. The three car parks by the river are 90–95% full; the other two are 51% and 67%.
    - **Far from you:** a parked car is only drawn, as one instance of a shared InstancedMesh within `parkedDrawDistance` (Low 150, Medium 210, High 300 m). Each car type has two meshes: the paint shell, coloured per instance, and the glass, trim, lights and tyres. The car has no physics body.
    - **Near you:** within `parkedLiveRadius` (26 m), and within 16 m of where your car will be in 1.6 s, a parked car gets a real drivable car from a pool. `parkedPool` holds 10 hatchbacks, 10 sedans and 8 pickups, never more than there are parked cars of that type.
      - The pooled car is repainted, put exactly where the parked car stands and left asleep.
      - It is still drawn as the instance until it is driven, dented or broken into; then its own meshes show.
      - An untouched one goes back to the pool once you are past `parkedReleaseRadius` (45 m), and the parked car keeps the spot it was pushed to.
      - A parked car within 9 m always gets one, so E works on every parked car. Beyond that, `parkedPromotePerFrame` (3) are handed out per frame, nearest first.
    - **Your cars and dealership stock** are also drawn as instances while untouched.
    - **Ownership:** every parked car belongs to a local (locked at `theft.lockedFraction`) or, at `abandonedFraction`, to nobody. Each grown-up among the simulated people owns the parked car nearest their home or work (`theft.ownerHomeRange`). The prompt says "a local's car".
    - **The owner can show up:** when you take a local's car, there is a `localOwnerNearby` chance (0.35) that the owner is right there. One of the people within 35 m who can see the car becomes the owner, then chases, shouts, calls 999 and remembers you.
  - **Dealerships** (`economy/dealership.ts`):
    - **Where:** car dealers come first (the data's `shop=car`, now on `Poi.cat`), then the biggest car park as a used-car lot, then garages, then shops, up to `maxSites` (Georgetown 3, grid 2).
    - **Showroom:** a dealer or used-car lot shows its cars in a row of car-park bays, with its sign in the next bay. The others show theirs at the kerb.
    - **Georgetown:**
      - the car dealer on K St, in its car park;
      - a used-car lot in the big car park off Water St;
      - a garage on Pennsylvania Ave, at the kerb.
      - With seed 1337 they are Long Haul Autos, Gull Point Autos and Wrench Works. Names vary with the seed.
    - **Fixed:** restocking takes an idle car from the parked-car pool, so the car list no longer grows with every sale. It held at 42 through a sale and a restock.
    - **Fixed:** the minimap draws the dealership and taxi rank badges on top at a fixed size (8 px and 6 px). They used to be painted into the base image, where they shrank to a pixel or two.
    - **Fixed:** on the grid, every POI whose name is on a shop sign is now `signed`. A dealership keeps the name painted on its building ("Grease Monkey Garage") instead of adding a second name.
  - **Taxi, minimap and items:**
    - **Taxi:** destinations are shops, restaurants, hotels, museums, churches and parks. Homes come up only at `taxi.homeDestShare` (0.15; it was about a third).
      - The HUD names the place, its street and the nearest cross street, e.g. "Drop Bram at Brick & Basil (M St NW at Thomas Jefferson St NW)".
      - A fare who asked for a ride in conversation shows as "Name, street".
      - A fare taken from off-stage at a quiet hour is brought on-stage.
    - **Minimap street labels:**
      - drawn with rounded stroke joins (mitred joins drew spikes round the letters);
      - major streets first;
      - a label is left out if it would overlap another label or a badge, run past the rim, or repeat the same name within 110 px;
      - the " NW" is dropped.
    - **Seeded items** (`scatterItems`):
      - never inside a building, in the water, or in the carriageway (cones excepted);
      - only on level ground, so never at the edge of a deck, pier, kerb or stair (`items.waterClearance`, `edgeProbe`, `maxStep`, `wallProbe`);
      - items on a bridge deck land on the deck;
      - bags and boxes sit 0.75–0.8 m out from a shop's pavement spot instead of 1.0–1.1 m, because they stuck into walls on Georgetown.
      - On Georgetown 411 items are placed and 354 spots are skipped. None is in a building, in water or beside a drop.
  - **Test:** `npm run build`, then `MAP=georgetown node scripts/shot.mjs x geolife` (new) or `node scripts/shot.mjs x <scenario>` on the grid. `parkcheck` (new, any map) reports parked cars by class and the stand-ins near you.
    - **geolife, final run, crowds:** each place was held at one hour for 40 s of game time (60 s on the towpath). The F3 target and the active count are the whole crowd near you; "in window" counts people within 60 m.

      | | in window | F3 target / active | real head count |
      |---|---|---|---|
      | M St at Wisconsin Ave, 12:30 | 21 | 45 / 44 | 115 (1 per 8 m) |
      | 29th St between N and P, 12:30 | 4 | 13 / 14 | 30 (1 per 41 m) |
      | M St at night, 02:30 | 5 | 4 / 5 | 4 |
      | Waterfront, 19:30 | 8 | 12 / 11 | 27 |
      | Towpath, 07:30 | 3 | 14 / 13 | 31 |

      - M St at lunch is 5.3x busier than 29th St in the window (3.5x by target). Across five runs the window ratio was 3.6–9.
      - Dog walkers and joggers were a third of the people near you on the towpath (50% in two earlier runs), against 10% on M St.
    - **geolife, other checks:**
      - **Parked car hit:** I drove into a parked car on M St at about 50 km/h. Its drivable stand-in was there when my car was 37 m away. It was pushed 18 m and dented, and then showed its own meshes.
      - **Taxi:** 3 of 3 fares, to a supermarket, an ice cream shop and a bakery, with addresses like "K St NW at 30th St NW".
      - **Unseen theft** on O St (residential, nobody near): 0 calls, 0 stars, and the owner remembers it.
      - **Witnessed theft** of a locked car on M St with 4 people on the pavement: a 3.03 s smash, 4 calls, 2 stars. The owner chased, phoned and remembers.
      - **Dealership:** I bought a hatchback at Long Haul Autos for $900. The minimap showed 3 dealerships and 2 owned cars. The slot restocked out of the pool, with 42 cars before and after.
      - **Seeded items:** 0 bad.
      - **Console:** clean.
      - **Screenshots** (all looked at): `29-life-mst-lunch`, `29-life-29th`, `29-life-towpath`, `29-life-f3`, `29-life-dealer`.
    - **Georgetown regression scenarios:** world, walk, drive, taxi, police, witness, theft, dealership, crashspikes, geoplay and mapcheck exit 0 with a clean console.
      - taxi: 3 of 3 fares, to a pharmacy, a restaurant and a gallery.
      - police: 0 stars, because no witness called (as in C0).
      - dealership: 3 sites, a purchase, 2 owned cars on the minimap.
      - mapcheck: pass, with 30 choices, 0 jumps, 1.71 m off lane, 20/20 walks and 0 height mismatches. There are now 3,920 parking spots.
      - seed 123: 2,001 parked cars (1,957 with the default seed) on the same map.
      - theft: the first run failed in the scenario. At 15:00 fewer than four people were out near the car it picked, and the scenario only looked at people already out. It now brings witnesses on-stage. Rerun: unseen 0 calls / 0 stars; on M St 3 calls, 1 star, owner memory.
    - **Owner memory fix:** an owner who is off-stage now also remembers their stolen car (`npcMemory.ts`). With the crowd following the density, most owners are elsewhere when their car goes, and before this they never found out.
    - **Grid:** life, crowd, witness, theft, dealership, taxi, gate2, crashspikes and mapcheck exit 0 with a clean console.
      - crowd: 41 active at the start, the shove works, 44–45 on High.
      - gate2: 30 active on Low, 59 on High.
      - theft: unseen 0 stars; witnessed 4–5 calls, 2–3 stars, owner memory.
      - mapcheck: pass, 0.47 m off lane.
      - Theft, dealership, taxi, witness and crowd were run again after the last parked-car change, and theft after the owner-memory fix.
      - `23-dealership` shows that the shop sign and the showroom sign now match.
    - **Frames over 33 ms** (crashspikes, unthrottled, 3 interleaved rounds against the pre-C2 build 75c14a5): Georgetown 2, 1 and 3 (pre-C2: 4, 3 and 0), with p99 10.6–11.4 ms (pre-C2 9.9–19.2). Grid 2, 0 and 0 (pre-C2: 2, 1 and 0). Spikes of 50–190 ms hit both builds alike, in physics, peds, weather, player or traffic, so they are the busy machine, not one system.
  - **Performance against the M2 build (529a13c):** 4x CPU throttle, 3 interleaved rounds, on foot at the spawn at 12:30 (the crowd at its lunchtime target). CPU per frame is without rendering; ranges are the 3 runs' medians. The machine was shared and busy (load ~8 on 4 cores), so frames over 33 ms showed up in every build, M2 included.

    | | M2, Low | Georgetown, Low | M2, Medium | Georgetown, Medium | this branch's grid, Medium |
    |---|---|---|---|---|---|
    | CPU per frame | 4.3–5.4 ms | 5.3–6.8 ms | 1.2–5.4 ms | 6.0–8.0 ms | 3.3–4.3 ms |
    | physics | 1.7–2.6 | 3.1–4.3 | 2.0–2.6 | 3.5–5.2 | 1.5–2.3 |
    | people (`peds`) | 0.22–0.46 (30) | 0.29–0.36 (26) | 0.39–0.74 (45) | 0.40–0.57 (40) | 0.33–0.45 (44) |
    | parked cars (`parked`) | — | 0.07–0.09 | — | 0.11–0.16 | 0.03–0.05 |
    | garbage per frame | 46–47 KB | 49–55 KB | 47–52 KB | 56–60 KB | 40–42 KB |
    | draw calls | 85–98 | 98–105 | 134–141 | 170–172 | 116–118 |
    | triangles | 133k | 483k | 188k | 1.0M | 179k |
    | heap | 45–77 MB | 177–199 MB | 43–77 MB | 153–161 MB | 48–85 MB |

    - **Draw calls:** the parked cars brought Georgetown from ~640 (the C0 review's figure, with 42 parked cars) to ~170, with 1,957 parked cars. That is now close to M2 (~140).
    - **CPU:** Georgetown still uses about 1.3–1.5x M2's CPU per frame. The gap is physics (the world's ~10,800 static colliders), not the crowd or the parked cars.
    - **The crowd's cost:** the same pages with every pedestrian taken off.
      - The `peds` section drops by 0.2–0.5 ms at 4x.
      - Unthrottled, the frame median drops by about 0.1 ms (1.4 to 1.3 ms) and `peds` from 0.14–0.36 ms to 0.03–0.09 ms.
      - It is 12 draw calls (170 to 158).
    - **fps:** software GL can't time the GPU, so there is no fps figure. With 5x M2's triangles and more CPU, Georgetown very likely still runs below M2 on the same quality.
  - **Known issues:**
    - **The crowd is the budget:** the computed density on M St at lunch is real-world (1 per 8 m), but what you see is the quality budget (45 at Medium) spread over the 90 m around you. M St reads busy and 29th St quiet, but at real-world density M St would be much fuller.
    - **Window counts are noisy:** the M St / 29th St ratio ranged from 3.6 to 9 across five runs, and the towpath count from 0 to 4.
    - **Drawn-only parked cars have no physics:** traffic, police or a thrown item further than 26 m from you (and outside the 16 m round the point 1.6 s ahead of your car) passes through them. Traffic keeps out of the parking lanes, so this mostly matters for police in a direct chase.
    - **Touched stand-ins stay full cars:** a driven, dented or broken-into stand-in keeps its own meshes (~15 draw calls) and never goes back to the pool. The pool grows if it must; it never did in the tests.
    - **Small drop on waking:** a drawn parked car is pitched to the slope of its street, but its stand-in sleeps at its spawn height until something wakes it. It can then settle a few centimetres.
    - **The used-car lot counts as a waterfront car park,** so the rest of that car park is 90% full.
    - **The Long Haul Autos sign** stands on the grass at the end of its car park.
    - **Fewer seeded items on Georgetown:** 354 spots are skipped there, so Georgetown has only 48 bottles and cans of the 70 litter items.
    - **The grid follows the clock too:** its crowd now follows the day curves, so it is quiet at night (the M2 grid kept its full budget all day).
    - **Most taxi pickups are ranks:** only someone who asks for a ride is picked up elsewhere.

- **M3 Life on Georgetown's streets review (step C2 review, branch `m3-geo-life`):** an independent check of the entry above, with fixes. I read the code and wrote my own probes (not committed): every person who appears or is moved, checked the frame it happens; the people the gameplay camera actually sees; every parked car against lanes, crossings, junction boxes, levels and each other; AI cars driving through drawn-only parked cars; quality and hour sweeps; seeds.
  - **What held up:**
    - **The density really comes from the map.** Each walk link's people per metre is its road class (or path kind) times that zone's hourly curve, plus `perShop` × min(shops within 40 m, 14) times the `shops` curve. The target is that real head count within 90 m × `pedBudget` / `fullBudgetAt`, capped at the budget. Nothing is hard-coded per street.
    - **Hours and qualities** (Georgetown, the build as handed over, 30 s at each hour; target / active / people within 60 m):

      | | Low (30) | Medium (45) | High (60) |
      |---|---|---|---|
      | M St at Wisconsin, 03:00 | 4 / 6 / 1 | 4 / 9 / 0 | 4 / 7 / 0 |
      | M St at Wisconsin, 12:30 | 30 / 29 / 19 | 45 / 44 / 17 | 60 / 59 / 32 |
      | M St at Wisconsin, 18:00 | 30 / 29 / 17 | 45 / 44 / 21 | 52 / 53 / 10 |
      | 29th St, 12:30 | 9 / 9 / 6 | 16 / 15 / 7 | 19 / 19 / 9 |
      | 29th St, 21:00 | 4 / 9 / 4 | 9 / 10 / 4 | 12 / 16 / 6 |

      - The computed density is 1 per 7–8 m on M St at lunch and 1 per 31–32 m on 29th St (it has a few shops within 40 m). Q St is 1 per 60 m.
      - M St hits the budget at every quality (its real count, 105–118, is above `fullBudgetAt` 100), so the contrast with 29th St is set by the budget, not by the map.
    - **Where people appear** (5 places × 5 hours × 3 qualities, 30 s each; every activation and every move of more than 4 m, 282 in all): 0 on screen, 0 in a building, 0 in the water, 0 at the wrong level. 6 were on the carriageway (fixed, below). After the fixes, 248 more: 0 on screen and 0 anywhere wrong. Driving along M St at up to 115 km/h: 35 placements, 0 on screen.
    - **Parked cars** (1,921 after the fix below): per 100 m of kerb primary 11.0, secondary 7.4, tertiary 5.7, residential 3.6, service 2.7, against tuning 11 / 7 / 6 / 3.5 / 2. No car overlaps another, a starting car or dealership stock. None sticks into a traffic lane or another road's lane, stands on a crossing, inside a building, in water, on a bridge deck, or more than 0.35 m off the ground under it. E gave a steal or break-in prompt on 30 of 30 random parked cars across the map. Grid: 17 cars, all clean, 30 of 30.
    - **Driving into parked cars:** at 110 km/h along M St the parked car's stand-in was ready when my car was 59 m away.
    - **Seeds:** seeds 1 and 2 give identical parking spots, walk graph, places, density and route costs. Parked car types and paint (1,895 against 1,879 cars), people and shop names differ, and so do two dealership names.
    - **Kids:** grid `hurtfx`: a car at a kid, a thrown bottle and a bat swing all leave it at 100 health. `hurtfx` can't run on Georgetown (it is written for the flat grid and its car never reaches the scene), so I drove a car at a kid standing in an M St lane at 43, 54 and 65 km/h: each time the kid jumped clear (closest 1.9 m), never went down and kept 100 health.
  - **Fixed:**
    - **The street you look at was nearly empty.** People only appear out of view, and nothing sent them into it. From the gameplay camera on M St at Wisconsin at lunch (Medium: 44 active, 31–33 within 80 m), only 3.6–5.8 people were on screen on average over 90 s; after turning the camera round, up to 25 were. The F3 numbers and the frozen-camera screenshots (`lifeShot`) hid this. Now 80% of the people who appear or are moved back near you (`peds.density.intoViewChance`) set off for a busy spot in view: a walk node on a link in view, picked by the links' head counts (dog walkers and joggers by their outdoor weights).
      - On screen, same probe with the player pinned: M St 11.5–15.2 (was 3.6–5.8), 29th St 3.4 (was 0.5), the grid spawn 8.2 (was 1.4; the M2 build: 1.6).
      - `geolife`: M St at lunch 32 people within 60 m (was 21–25), the towpath at 07:30 10 (was 1–3).
      - Dog walkers and joggers near the towpath are on the towpath or waterfront 98% of the time, other people 22%. Before the fix it was 32% against 16%.
      - `screenshots/29-review-mst-camera-before.png` and `-after.png` are the gameplay camera, same spot, same settle.
    - **People appeared on zebra crossings, in the road.** 5 of 86 (Medium) and 1 of 137 (High) placements were on a crossing link. Crossing links still count towards the head count, but nobody appears on one now. A kid and a dog are now placed along the pavement rather than 0.8 m and 1.2 m east of the parent, which once put a kid in the carriageway. Rerun: 0 of 248.
    - **Police drove through the parked cars.** On multi-lane streets the kerbside lane is the parking lane, and police aimed for it (it is the lane nearest a player on the pavement), spawned in it and rejoined it. Away from you most parked cars have no physics, so police cars ghosted through them.
      - Probe, on foot on M St, 2 then 3 stars, 60 s each: police in a parking lane 145 + 1,012 car-frames before, 0 after (two runs). Police overlapping drawn-only parked cars: 56 + 441 frames (36 cars) before; after, 0 + 0 in the final build, and 99 + 42 frames (9 cars) in the first run after the fix, from police in a traffic lane brushing parked cars, mostly beyond the 210 m draw distance (one at 28 m).
      - The fix is in `police.ts` (`offParking`: the lane beside it instead). The C1 branch has the same `goalLane` and spawn code, so the merge must keep it.
    - **Parked cars in the turn-round room at dead ends.** With 6.5 m spots, 8 cars stood inside the 12 m where traffic U-turns at a road leaving the map (the gap used the road poly's trim, 0 there). Now 0. Georgetown has 1,921 parked cars (was 1,957).
    - **Wrong toast:** taking a local's car said "You stole an abandoned Sedan" whenever the owner didn't turn up (65% of the time). It now says "a local's".
    - **Minimap:** the badge font strings are built once, not per badge per frame.
  - **Test:** `npm run build`, then `MAP=georgetown node scripts/shot.mjs x <scenario>` and `node scripts/shot.mjs x <scenario>` for the grid.
    - **Georgetown, final build:** geolife, theft, police, crashspikes, geoplay, world, walk, drive, parkcheck, dealership, taxi and witness exit 0 with a clean console. `hurtfx` exits 1 (it is a grid scenario, above).
      - **geolife:** M St at lunch 32 within 60 m (target 45, active 44, real 105), 29th St 6 (13 / 14 / 30): 5.3x. M St at 02:30 4, waterfront at 19:30 9, towpath at 07:30 10 (30% dog walkers and joggers). Parked: M St 11.2 and Wisconsin Ave 11.1 per 100 m, the car hit at 50 km/h had its stand-in at 37 m. Taxi 3 of 3 (a cafe, a restaurant, a clothes shop; "Wisconsin Ave NW at Q St NW"). Dealership: bought for $900, restocked from the pool, 42 cars before and after. Items: 416 placed, 0 bad.
      - **theft:** unseen on N St: 0 calls, 0 stars, owner remembers. Locked car on M St with 4 people out: 2 calls during the smash, 2 stars, the owner chased and remembers.
      - **police:** 0 stars, because no witness called (as in C0 and the C2 entry). **geoplay** (2 stars set directly) passed. **taxi:** 3 of 3 fares (a bookshop, a fast-food place, an office).
      - **mapcheck:** passed 2 of 3 runs (0.93 m and 1.32 m off lane, 0 jumps). The first run failed on its drive: the AI car it follows was 3.3 m off its lane once and was recycled once. The handed-over build passed 2 of 2 (2.26 m, 0.34 m). The drive follows a random AI car, so this part of the gate is noisy; `validateCityMap` passed every time (0 errors, 0 warnings, 0 height mismatches, 3,869 parking spots).
    - **Grid, final build:** life, gate2, witness, theft, taxi, police and bust exit 0 with a clean console. (Before the last fix, also dealership, crashspikes, mapcheck and hurtfx.)
      - gate2: 30 active on Low, 59 on High. theft: unseen 0 calls / 0 stars; witnessed 5 calls, 2 stars, owner memory. taxi: 3 of 3. police: 3 stars, chase and escape as before. bust: 0 stars at once and no bust, the same on the handed-over build (the scenario's direct `policeCalled` events no longer raise heat since the witness system).
      - **crowd fails** on its last screenshot (180 s timeout, after it switches to High) on the handed-over build, on this build and on the pre-C2 build 75c14a5 alike, so it is this machine's load, not C2.
  - **Performance against the M2 build (529a13c):** 4x CPU throttle, 3 interleaved rounds of the M2 build and this branch's final build on Georgetown. CPU is per frame without rendering; ranges are the 3 runs' values. The machine ran at a load of 18–26 on 4 cores the whole time, so the ranges are wide.

    | | M2, Low | Georgetown, Low | M2, Medium | Georgetown, Medium |
    |---|---|---|---|---|
    | CPU per frame, on foot at the spawn | 4.5–5.3 ms | 6.4–6.8 ms | 4.5–5.4 ms | 6.6–7.4 ms |
    | physics | 2.0–2.2 | 3.8–4.1 | 2.2–2.6 | 4.6–6.5 |
    | people (`peds`; how many active) | 0.21–0.41 (30) | 0.29–0.34 (26) | 0.41–1.05 (45) | 0.36–0.54 (40) |
    | parked cars (`parked`) | — | 0.10–0.12 | — | 0.08–0.15 |
    | garbage per frame | 45–46 KB | 50–61 KB | 47–49 KB | 53–54 KB |
    | draw calls | 93–97 | 104–107 | 136–139 | 169–172 |
    | triangles | 133k | 484k | 188k | 1.0M |
    | heap | 45–54 MB | 159–176 MB | 45–77 MB | 165–188 MB |

    - **M St at lunch, on foot** (Georgetown only, 44 people out at Medium): 7.1–8.1 ms, `peds` 0.51–1.37 ms, 183–185 draw calls, 56–60 KB of garbage per frame.
    - **Driving at up to 119 km/h along M St** (Medium): `peds` 0.71–1.39 ms (M2 driving: 0.38–1.32), `parked` 0.21–1.19 ms.
    - **The review's crowd change costs nothing measurable:** unthrottled, 3 interleaved pairs on M St at lunch, `peds` was 0.26–0.36 ms before and 0.12–0.34 ms after, with 18–21 people within 35 m (was 10–20). The `parked` section is 0.015–0.05 ms unthrottled with nobody driving.
    - **The gap to M2 is still physics** (the map's static colliders, from C0), then triangles and draw calls. Georgetown very likely runs below the M2 build on the same quality; software GL here can't give an fps figure.
  - **Known issues (still open):**
    - **The crowd is still the budget:** M St reads busier than 29th St, but 45 people over 90 m is far below 1 per 8 m.
    - **People ahead of a moving car:** nobody appears in view, so the street ahead of you while driving fills only from the sides and from people already walking there.
    - **Walkers bunch up:** several people heading for the same busy spot can walk in a line.
    - **The crowd can sit above its target for a while** when the hour drops, because people in view never leave.
    - **Drawn-only parked cars still have no physics:** a thrown item or a car that isn't yours further than 26 m away passes through them. In 3.5 minutes of probing that was 1 traffic car stuck on Q St, more than 1 km from the player.
    - **Frames over 33 ms** can't be judged here: the machine ran at a load of 18–26 on 4 cores, and both builds had them (`crashspikes` on the grid: 13 frames over 33 ms, the worst 205 ms in `sync`).
    - The towpath ahead of you is still often empty when you stand on it: most of the people counted there are on M St and K St, which are inside the 90 m.

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

### Stairs and universal collisions (Stage 1 item 1, branch `s1-physics`)

- **The bug.** The owner could walk through stairs. The house stoops (about 2,600 on Georgetown, 2 to 13 steps each) were drawn with no collider at all. The canal steps ran up into the sidewalks of the streets they climb to, so their top half was buried under the pavement, and the canal's retaining wall stood across them: they could not be climbed. Many other solid things had no collider either: benches, bus shelters (except the back panel), gravestones, most trees (only those within 9 m of a road), lock gates, moored boats, arcade and portico columns, the metro canopy, the stair middle hand rail and the canal coping. The statue plinth had one box over all its tiers (an invisible wall round the 0.5 m first tier). On the grid: benches, street-sign posts, taxi-rank posts and boats.
- **Solid kinds registry** (`src/systems/objects/solidKinds.ts`): every prop and structure kind declares its Stage 2 class (static / dynamic / interactive), its collider shape (trimesh, box, cylinder, hull, ramp, boxes, own body, none), whether it must stop the player, an audit tolerance and its F4 colour. The instanced props' colliders are data there too (`PROP_COLLIDERS`: lamp base and pole, bench legs + slats + back, the six parts of a bus shelter, gravestone, signal pole, stop post, tree trunk, the grid's bench and posts). They are placed with `PhysChunks.placeProp`. Every static collider is tagged with its kind (`CityMap.solidTags`). Stair ramps, stair walls, parapets, decks and arches are separate per-chunk trimeshes by kind. Stage 2 can give a kind its own body (a bin, a chair) without touching the generators. Nothing of pickup, inventory or interiors is built.
- **Physics audit** (`src/systems/physicsAudit.ts`, scenario `physaudit`, run with `QUERY=physaudit=1`): with `?physaudit=1` the map records every box, cylinder and wall it draws, with its kind. The audit then compares the drawing with Rapier and prints each mismatch with coordinates:
  - horizontal rays at every drawn solid face, every instanced prop's own triangles and every facade (MISSING / SHORT / LONG);
  - vertical rays at 3,000 random points, inside every solid part and along every stair, against the drawn triangles (UNSOLID: drawn within reach above the physics floor; UNDRAWN: a physics floor with nothing drawn);
  - per stair, the drawn-vs-ramp height and the largest jump in the physics surface.

  | | before (f13af69) | after |
  |---|---|---|
  | Georgetown side-probe mismatches (solid kinds) | 26,965 | 3 (stair risers 0.13–0.17 m set back) |
  | Georgetown floor mismatches | 3,714 | 8 (metro canopy 5, a bench edge 1, stair flights 2) |
  | grid side-probe mismatches | 329 (292 street-sign posts, 36 benches, 1 tree) | 2 (two trees, 0.10 m) |
  | grid floor mismatches | 45 (benches) | 0 |
  | stairs: largest physics step between samples 0.1 m apart | up to 3.06 m | 0.066 m |
  | stairs: ramp vs drawn tread | −0.17 to +0.6 m | −0.115 to +0.113 m |

- **Colliders added or fixed (Georgetown):**
  - stoops: one convex ramp each (flat landing, then down through the middle of every tread, a half-riser lip at the foot) and a thin slab for each iron rail;
  - every tree trunk; lamps (base and pole); benches; bus shelters; gravestones; signal poles to their full 6.3 m;
  - lock gate leaves, balance beams and posts; moored boats; the round fountains' pedestals;
  - Washington Harbour's arcade columns and setback tiers; the mansion portico's platform and columns; the smokestack's tapered stack;
  - the steel freeway columns as boxes (the round collider stuck out 0.17 m); the statue plinth as its four tiers; the cemetery railing per 2.4 m bay, following the slope; the gate leaves;
  - the metro canopy as thin glass slabs (its ends stay open); the canal coping's top and outer face; deck edges; the stone arches' undersides and spandrels, abutments and cutwaters;
  - the stair walls as solid slabs; the Exorcist Steps' middle hand rail;
  - benches on the boardwalk now stand on it (they were drawn on the ground under it).
- **Stairs:**
  - the ramp runs half a riser above the risers' feet (tread error ±0.09 m, was 0 to −0.17 m);
  - landings and the flat top are drawn (they were holes);
  - a stair's footprint is cut out of the terrain, sidewalks, junction corners and canal aprons (render and physics). The canal retaining walls stop either side, and the side walls stand a balustrade (0.9 m) above the ground outside;
  - stair ends are cut back out of carriageways. A stair too short for its rise gets a longer foot (`geo.stairMaxSlope` 0.84, `geo.stairMaxExtend` 3.5 m, never into water);
  - footbridge ends land on the canal bank (the north end hung 0.8 m above it).
- **Grid:** benches, street-sign posts, taxi-rank posts (moved a metre along the kerb, off the rank's spot where the player starts) and moored boats.
- **Character controller:** its numbers moved to `TUNING.player`:
  - `ccOffset`;
  - `autostepHeight` 0.45;
  - `autostepMinWidth` 0.2 (was 0.25);
  - `snapToGround` 0.45 (was 0.4);
  - `maxSlopeDeg` 52 (was 50);
  - `minSlopeSlideDeg` 52 (new: standing on a 32–40° stair no longer creeps);
  - `groundedVy`.
- **F4 collision view** (`src/systems/physicsDebug.ts`): wireframes of the colliders within 22 m of the player, coloured by kind, bright in front of geometry and faint behind it, rebuilt 4 times a second. When it's off, nothing is built or added to the scene. The help line and the pause-menu controls mention it. Its numbers are `TUNING.debug.phys*`.
- **Test:** `npm run build`, then:
  - `QUERY=physaudit=1 MAP=georgetown node scripts/shot.mjs x physaudit` (and `MAP=grid`);
  - `MAP=georgetown node scripts/shot.mjs 31-physics-stairs stairs`: every stair up and down with held keys, a footbridge, stoops of 2, 3, 5, 7 and 10 steps (and sideways into the rail), a kerb, the statue plinth (jump twice), a bench (jump onto the seat), Key Bridge and the freeway deck, and into one of every solid prop kind;
  - `SAMPLES=3000 MAP=georgetown node scripts/shot.mjs x fallthrough` (and `SAMPLES=2000 MAP=grid`);
  - `MAP=georgetown node scripts/shot.mjs x physf4`: the `31-physics-f4-*` screenshots;
  - in the game: press F4 and walk up a stoop, the Exorcist Steps (Prospect St at 36th St) or the canal steps from the towpath.
- **Results (final build):**
  - `physaudit`: the table above.
  - `stairs` on Georgetown: pass, no failures.
    - All 8 built stairs were walked up and down holding W. The Exorcist Steps (8.56 m rise) took 6.7 s up and 4.7 s down. The six canal steps (3.65–3.72 m rise) took 2.75–3.0 s up and 1.6–1.7 s down. The short path stair has a 0.15 m rise.
    - The feet never went below the collider surface.
    - Standing 3 s mid-flight: 0.010 m creep, 0.015 m jitter.
    - Stoops of 2/3/5/7/10 steps: the landing is reached in 0.32–1.35 s, and walking sideways into the rail stops the player.
    - The footbridge was crossed, and the kerb walked up and down.
    - Statue plinth: each tier stops the player, and two jumps reach the top (1.04 m each).
    - Bench: one jump lands on the seat.
    - Key Bridge: 32.7 m along the sidewalk at a constant height. Whitehurst Freeway deck: 33.7 m, no sinking.
    - Props: lock gate, railing, column, monument, wall, lamp, tree, bench, signal pole, sign post, bus shelter and gravestone stop the player 0.04–0.08 m from their collider. Fountain, boat, building and tower are skipped, because the scenario finds no clear straight approach to one; the audit covers them.
  - `stairs` on the grid (props only): pass. Bench, railing, kiosk, column, lamp, tree and sign post stop the player at 0.04 m. Building, fountain, boat and container are skipped.
  - `fallthrough` on Georgetown (3,000 drops, 1,898 on land): fails its own criteria.
    - 1,876 within 5 cm of `map.heightAt`; 0 below the surface; 0 inside a building; 0 not settled.
    - 1 on a parked car, and 3 resting on a ledge's edge.
    - 15 (0.8 %) where `map.heightAt` is 5–19 cm off the collider. The limit is 0.2 %.
    - 3 hovering (the limit is 0): (699.7, −467.2) 0.26 m up on a steep slope; (681.1, −333.2) and (568.2, −319.7) 2.0 m above the floor with nothing found under the capsule. These two are not explained yet.
  - `fallthrough` on the grid (2,000 drops, 823 on land): 815 ok, 5 on piers, 2 on cars. It fails on 1 drop that sank 5.3 cm into the big ground box at (37.8, −384).
  - `physf4`: 4 screenshots, wireframes in each.
  - `world walk drive handling crashspikes gate2 mapcheck theft`:
    - Grid, on the final build: all exit 0 with a clean console. Walk 4.8 m (as on the base). Crashspikes: 0 frames over 33 ms.
    - Georgetown, on the 766cd44 build (the later commits change only the grid generator and the scenario scripts): all exit 0 with a clean console.
    - Georgetown crashspikes: 11 frames over 33 ms, worst 150 ms (physics, the wreck test). The base build spikes the same way (worst 148 ms, physics).
- **Performance against the base (f13af69).** Georgetown, 4x CPU throttle, after a 600-frame warm-up, 3 interleaved base/new runs. Medians, with the range in brackets:

  | | base | s1-physics |
  |---|---|---|
  | colliders | 10,779 | 24,180 |
  | boot to first frame | 19.0 s | 21.4 s |
  | Rapier step alone | 7.2 ms (4.7–8.7) | 7.6 ms (7.4–8.4) |
  | frame CPU on foot | 11.9 ms (11.3–14.6) | 13.1 ms (12.8–15.2) |
  | physics section on foot | 7.7 ms (7.2–9.5) | 10.2 ms (7.7–11.0) |
  | frame CPU in a car | 12.5 ms | 9.2 ms |
  | garbage per frame | 68.9 KB | 66.2 KB |
  | draw calls / triangles in view | ~640 / 1.0 M | same |

  - With F4 on, one rebuild every 0.25 s costs 0.4–20 ms (at 4x throttle). With F4 off it costs nothing.
  - Grid (runs without the warm-up): colliders 1,836 → 1,972; step 2.0 → 2.1 ms; frame on foot 9.6 → 10.0 ms.
  - An earlier experiment that removed the prop colliders at runtime made no measurable difference to the step. The on-foot physics section is up to 2.5 ms slower at 4x throttle (about 0.6 ms unthrottled), but the base and new ranges overlap, so it is not proven either way.
- **Known issues:**
  - Three of the eleven stairs in the (knowledge-based) data run along carriageways for their whole length (by Rock Creek and under the freeway) and are no longer built: (495.3, 119.4), (664.2, −330.5) and (724.8, −479.2). Their walk links remain. One more is cut to 5 m with a 0.15 m rise.
  - Every tree is solid now, so trees the data puts on footpaths (Dumbarton St, Potomac St) block the player there.
  - `map.heightAt` is 5–19 cm off the collider at 0.8 % of the fallthrough points, all within 2.5 m of a band edge (kerbs, sidewalk skirts: the 1 m raster smooths the 0.15 m step). People placed by `heightAt` float or sink that much there. On the Whitehurst Freeway deck, the map's walk height is 0.3 m above the collider.
  - Over the top 3 m of the canal steps by Wisconsin Ave, `map.heightAt(x, z, top)` returns the bridge sidewalk (10.15) above the stair (9.25–9.95). The bridge footprint in the map query overlaps the stair.
  - Two unexplained fallthrough hovers (above), and the grid's 5.3 cm sink.
  - The canal steps climb at up to 40°, steeper than real steps, because the data gives them little room between the towpath and the street.
  - The footbridges still can't be entered from the north: their north end is on the canal's north bank, behind the retaining wall (known since the C0 review).
  - Stairwell walls are plain boxes. Where a stair runs below a sidewalk, they read as a tall wall along the pavement.
  - The audit leaves:
    - 3 stair risers 0.13–0.17 m behind their drawn face;
    - the metro canopy's curved glass against its slabs (up to 0.4 m);
    - one bench-edge sample;
    - two stair-flight samples.
  - The capsule rests up to 0.16 m above a slope, and on ledge edges with its centre over a lower floor. This is inherent to a capsule.
  - The `stairs` scenario does not walk into a fountain, boat, building or tower (no clear approach found). The audit's side probes cover them.
  - Boot to first frame on Georgetown is 2.4 s longer at 4x throttle (about 0.6 s unthrottled): the extra colliders and the stairwell clipping.
  - Crashspikes on Georgetown spikes up to 150 ms in physics in both the base and this branch. `gate2` and `handling` on Georgetown don't reach their test conditions in the base either.

### Review of item 1 (stairs and collisions), independent check and fixes (branch `s1-physics`)

- **Merge.** main (8192ea1: traffic and police on the lane graph, life on the streets) is merged into `s1-physics`. The conflicts in `main.ts`, `world.ts`, `scenarios.mjs` and this file keep both sides.
- **The owner's walk-through stairs** were the house stoops (no collider at all before this branch) and the canal steps (buried under the sidewalks, the canal wall across them). Checked on the merged build: 186 of 189 stoops sampled across Georgetown (every 13th of 2,606) are walked up to the landing and back down with W held. The 3 flagged ones are the test's own start position (put against a kerb face or beside a tree), and one stoop whose foot sits in a frontage strip 0.35 m below the sidewalk on a steep street (that was there before; on the base the strip is 0.4–0.5 m lower). All 8 stairs and the 5 stoop heights in `stairs` pass.
- **`map.heightAt` is now the collider surface** (new `src/systems/map/surfaceIndex.ts`). The ground, kerbs, sidewalks, lots, canal aprons and stair ramps are trimesh colliders; their triangles are kept when the trimeshes are built (`PhysChunks.keepTriangles`) and indexed in 4 m buckets. `heightAt` takes the highest one there (with a height, the highest at most `map.levelStep` above it), and the raster only where no triangle covers the point (inside buildings, open water). Deck carriageways, their kerbs and sidewalks, deck junctions and the footbridges are now `deck` colliders (they were `ground`, so the ground under a bridge would have read as the bridge), and the walk surface reads the deck triangles (with the analytic deck profiles where a deck runs off the map edge past its last triangle) and the boardwalk piers. No allocation per query.
  - 200,000 random points: heightAt was more than 5 cm off the collider at 1.6 % of the walkable ground (up to 1.3 m by the canal); now 0 of 128,303 points differ by more than 2 cm.
  - Every bridge lane every 2 m (24,163 points across Key Bridge, the freeway and the street bridges): 61 % were more than 5 cm off (Key Bridge a kerb high, the freeway up to 0.5 m); now 0.
- **Grid sink.** The grid's ground was one 1 km cuboid. Rapier's shape casts are about 9 cm wrong on a shape that size, and the character sank 5 cm into the ground standing still at a third of the spots tried (not only at the one fallthrough found). The ground and sea floor are now 120 m tiles, one per static body: 0 of 81 spots sink.
- **Fallthrough's 2 m "hovers"** were the test dropping the capsule inside a bridge deck and a bridge pier (it dropped from 2 m above the terrain under them). It now drops 2 m above whatever covers the spot (`raised`), waits until the player has actually stopped moving (a capsule that lands on a steep bank slides for a few frames: the 0.26 m hover), resets knock-back and keys between drops, and finds a capsule resting on a step's or ledge's edge from the floor under its whole round bottom, skin gap included. `FALL_SEED=<n>` picks another set of points. The criteria are unchanged.
- **Street trees and lamps.** The synthesized data (`meta.synthetic`) put 137 trees right on the sidewalks' walk links (81 on Dumbarton St, 42 on Potomac St): its sidewalk lines and the generator's road widths differ. A synthesized tree or lamp on a sidewalk now stands in the furnishing strip (`TUNING.geo.streetTreeKerbOffset` 0.7 m, `streetLampKerbOffset` 0.45 m from the kerb) at the same distance along the street. A moved tree is dropped at a junction corner, a driveway, within 7 m of a crossing or 2 m of a lamp or another tree (4,810 trees, was 5,227). Real data is left as it is. Trees within a capsule's reach of a walk link: 137 → 9, all beside diagonal links to corners and crossings; nowhere is a walkway blocked across (no spot without a free 0.7 m gap).
- **Footbridges from the north.** Both canal footbridges ended on the narrow north bank under the retaining wall (2.7 m and 0.7 m below the land behind it). The north end now runs on just over the wall's coping and, where the land beyond is lower, a short ramp (at most 0.3 rise per metre) takes it down. Walked with W held from both ends of both footbridges: all four get across.
- **Holes to the safety floor.**
  - Every canal step's foot had a 5 cm slit down to the safety floor: the stairwell ran on 5 cm past the ramp. The builder's last change (uncommitted when they stopped) fixes it: the stairwell stops exactly where the ramp stops, and at a bend both run on past the joint. A 0.1 m scan of every stair: 0 slits (was 11–128 points per stair).
  - The 0.3–1 m gaps between neighbouring houses had no floor at all (the raster marks them as building, and the terrain under buildings was dropped). The terrain under buildings is now kept, at natural height capped to the band surfaces next to it, not dipped. 400,000 random points: 68 holes, 23 where a dropped player fell in; now 3 holes, 1 fall. This costs 49,000 ground triangles (render +3 %, ground trimesh +18 %).
- **Canal steps "up to 40°"**: measured on the collider, every canal step climbs at 31.8° (the drawn treads 32°). 40° is `geo.stairMaxSlope`'s limit, which the current data never reaches. Nothing to fix.
- **Audit leftovers.** The two "stair flight" floor samples were the towpath under the foot of two canal steps: a drawn face within the upper floor's own tolerance under it now belongs to it. The three stair risers are by design (the ramp runs half a riser above the risers' feet, so a riser face is up to 0.085 / 0.62 = 0.137 m from it): the stair tolerance is 0.14 m. The one-step "stair" left after cutting a data stair back out of a carriageway (0.15 m rise) is a plain path now (`geo.stairMinRise` 0.3 m). Grid tree colliders match the five-sided trunk (0.19 × scale; two probes were 0.10 m out).
- **Seeded items.** With `heightAt` exact, the item placement's 0.35 m edge probe stopped seeing ledges 0.4–0.6 m away (the raster had smoothed them into it): 23 Georgetown items lay beside a drop of more than 0.5 m (`geolife`'s check). A second probe (`TUNING.items.dropProbe` 0.6 m, `maxDrop` 0.5 m) rules those spots out: 0 now, as on main.
- **Also tried and checked:** drove the player's car with W held into a building, lamp, bench, signal pole, sign post, bus shelter, railing, wall and column at 34–45 km/h: it stops with its bumper at the collider every time, nothing is passed through. Dropped the player from 40 m at 300 random spots per map: none falls through or ends below the map surface; 7 come to rest with no floor under the capsule's axis, and rerun one by one, 6 of those rest on a building (a roof edge next to the wall they fell along) and 1 on the ground. F4 has no cost when off (one key check).
- **Test:** `npm run build`, then (each also with `MAP=grid`):
  - `SAMPLES=3000 MAP=georgetown node scripts/shot.mjs x fallthrough`, and `SAMPLES=10000 FALL_SEED=4242` for another set of points;
  - `QUERY=physaudit=1 MAP=georgetown node scripts/shot.mjs x physaudit`;
  - `MAP=georgetown node scripts/shot.mjs 31-physics-stairs stairs` and `... x physf4`;
  - in the game: walk onto either canal footbridge from the north side (33rd St, by the old warehouses); walk Dumbarton St's sidewalk (the trees stand by the kerb); press F4 on a bridge (decks are their own colour now).
- **Results (final build):**
  - `fallthrough`: pass on both maps. Georgetown, 3,000 drops: 1,898 landed, 0 below the surface, 0 where `heightAt` is off the collider (was 15), 0 hovering (was 3), 0 inside a building, 0 not settled; 6 drops raised over a deck or pier. With 10,000 drops on another seed: 6,397 landed, all of those 0 as well, 5 resting on a step's edge. Grid, 2,000 drops: 823 landed, 0 below (was 1); 6,000 on another seed: 2,357 landed, 0 below.
  - `physaudit`: grid 0 probe and 0 floor mismatches (pass). Georgetown 0 probe mismatches, 6 floor samples: the metro canopy's curved glass against its slabs (5) and a sample between a bench's slats (1).
  - `stairs`: pass on both maps (all 8 stairs, now 7 after the one-step one became a path; the stoops; footbridge 17.2 m long now; kerb; plinth; bench; Key Bridge and the freeway deck, where the map's walk height now matches the deck: 0.3 m above it before).
  - `mapcheck` on both maps: pass (0 height mismatches). (Two intermediate versions of the deck fallback failed it on Georgetown, Key Bridge's lanes 14.7 m off at the map edge, or put 399 bridge-end points a kerb off; the final rule passes both checks.)
  - `world walk drive handling crashspikes gate2 mapcheck theft taxi police witness life` on both maps, and `geodrive geolife` on Georgetown: all exit 0 with a clean console. Grid walk 4.8 m as before. `crashspikes` can't be judged here (other sessions kept the 4-core machine at a load of 16 to 20): grid 11 frames over 33 ms, worst 463 ms in a random section; the merged base had 8, worst 1,376 ms.
- **Performance.** Georgetown, 4x CPU throttle, 600-frame warm-up, 4 interleaved rounds of main (8192ea1), the builder's work merged (239573a) and this review (d5cc9a9). Medians (range); the machine was loaded by other sessions throughout, so small differences are noise:

  | | main | builder's work | review |
  |---|---|---|---|
  | colliders | 10,778 | 24,179 | 23,772 |
  | ground triangles (physics) | 287 k | 296 k | 345 k |
  | triangles drawn (whole map) / in view | 1.557 M / 1.005 M | 1.556 M / 1.004 M | 1.593 M / 1.004 M |
  | draw calls in view | 151 | 150 | 150 |
  | boot to first frame | 19.0 s (18.0–19.5) | 19.8 s (17.1–21.3) | 21.0 s (17.4–21.4) |
  | Rapier step alone | 3.2 ms | 2.9 ms | 3.1 ms (0.9–5.5) |
  | physics section on foot | 3.1 ms (1.8–3.6) | 3.8 ms (3.1–7.7) | 3.8 ms (3.1–5.3) |
  | physics section in a car | 3.9 ms (3.1–4.8) | 4.0 ms (2.5–5.5) | 5.2 ms (3.2–5.5) |
  | frame CPU on foot | 5.3 ms | 5.0 ms | 6.1 ms (1.8–7.5) |
  | garbage per frame | 82 KB | 81 KB | 72 KB |
  | JS heap after boot | 147 MB | 165 MB | 187 MB (191 MB before the index was slimmed) |

  - Grid, 3 rounds: colliders 1,806 → 2,050; step 1.1 → 1.1 ms; physics on foot 3.5 (2.1–4.1) → 2.2 ms (2.2–2.3); frame on foot 5.2 → 4.1 ms.
  - The surface index costs about 22 MB of heap (its triangles and bucket lists) and nothing measurable per frame (a query is a few dozen edge tests in one 4 m bucket). The in-car physics section may be about 1 ms higher at 4x (about 0.3 ms real) since the ground trimesh grew by 17 %, but the ranges overlap.
- **Known issues (left):**
  - A 20 m slot to the safety floor where the canal meets Rock Creek ((359..378, 266..267), and a narrow one along the creek at x 375–378): the corridor's end and the creek don't meet. A player who walks in falls and is put back on the pavement by the safety check. Two more single holes in 400,000 points.
  - On steep streets the strip between a house and the sidewalk can lie up to 0.45 m below the sidewalk (0.4–0.5 m on the base too); a stoop's foot then sits in that strip, a step down from the pavement.
  - 9 street trees stand within a person's reach of a walk link (the diagonal links to corners and crossings); none blocks a walkway.
  - The metro canopy's curved glass is 0.1–0.4 m off its collider slabs (out of reach from the ground).
  - The terrain under buildings is drawn (49 k triangles, mostly hidden inside the buildings).
  - The `stairs` scenario still skips the fountain, boat, building and tower (no clear approach); the audit covers them, and the car was driven into a building.

### Real 1:1 map data, roads and terrain (Stage 1 items 2 and 3, branch `s1-realdata`)

- **Real 1:1 Georgetown from open data (Stage 1 items 2 and 3, branch `s1-realdata`):** `src/data/georgetown.json` is now real data: OpenStreetMap via Overture Maps (release 2026-10-21.0) and USGS 3DEP terrain, in the same `open-city-osm-1` format and frame as before (origin 38.9065, -77.061, x east, z south), so old and new positions compare 1:1. The default map is still the grid (`?map=georgetown` picks it).
  - **Importer:** `npm run import-overture` (`scripts/importOverture.mjs`, plain Node) reads the cache in `data/overture/` (gitignored). When the cache is missing it runs `scripts/fetchOverture.py` (pyarrow + shapely, `OVERTURE_PYTHON`), which reads only the parquet row groups whose bbox column meets the download box, and the terrarium tiles (z15, 3.7 m per pixel). Deterministic: two runs differ only in `generatedAt`.
  - **Crop:** -77.0726, 38.8986 to -77.0483, 38.9157: 2108 m x 1898 m, from the Key Bridge landing and the Georgetown University campus to 22nd St NW past Washington Circle, and from the Potomac to north of R St. Kalorama beyond the Rock Creek valley and the Virginia shore (with Roosevelt Island) are dropped and become woodland, so streets end at the woods or the river there. The west, north-west, east and south-east edges still cut the street grid (no natural edge there; `docs/m3-suspicious-areas.md`, "Crop edges").
  - **Three files, three licences:** `georgetown.json` (2.28 MB, ODbL: roads, paths, buildings, water, parks, car parks, street furniture, terrain), `georgetown-places.json` (140 KB, CDLA-Permissive-2.0: 1,623 place categories and positions) and `georgetown-buildings-ccby.json` (19 KB, CC BY 4.0: the 129 footprints whose geometry comes from Esri Community Maps; a CC BY 4.0 footprint inside an ODbL database would need a waiver we cannot rely on). `loadGeoDoc` (`geoDoc.ts`) loads and merges them. Places with an Apache-2.0 (Foursquare) source (708 in the download box) are dropped, and the importer stops on any source licence it does not know. 2.44 MB in all (the target was under 3 MB).
  - **Attribution** (pause menu, README, `src/data/georgetown.LICENSE.md`): "Real map data: © OpenStreetMap contributors via Overture Maps Foundation (release 2026-10-21.0), ODbL 1.0; places © Overture Maps Foundation, CDLA-Permissive-2.0; some building footprints © Esri Community Maps contributors, CC BY 4.0; building heights include USGS 3DEP lidar and Microsoft ML Buildings; elevation: USGS 3DEP via AWS Terrain Tiles."
  - **Contents:** roads 1,071 pieces (80 km), footways 2,024 (sidewalks, crossings, 120 steps, paths, the towpath, plazas), 4,713 buildings, 1,623 places, 30 water areas, 179 parks, 107 car parks (2,736 spaces), 65 bridge entries, 8,534 props.
  - **Roads:** Overture segments split at every linear-referenced rule (bridge, tunnel, level, subclass, surface, speed, access); connector vertices kept so graphs match by coordinates; one-way from access restrictions, max speed from speed limits; USPS-abbreviated names ("M St NW"). Overture has no lane counts: width is measured from the mapped sidewalk lines either side for 425 pieces (`est: 2`), else a class estimate (`est: 1`). Washington Circle is found as a loop of same-name pieces and written as one closed one-way counter-clockwise roundabout (Overture keeps no junction tag). Service roads are cut where they enter a building (39 cut, 18 dropped) and 85 alleys are narrowed to the gap between buildings.
  - **Signals and stop signs (real):** 83 signalled junctions. Overture keeps `highway=stop` but not `stop=all` or the direction, so a stop sign mapped on the junction vertex is an all-way stop (89: P St at 26th-31st, K St under the Whitehurst Freeway) and one mapped on an approach (25, `stop_arm`) stops only that approach, which then gives way (O St at Wisconsin Ave, 35th St at M St, 23rd St at O St). Before, every stop sign was an all-way stop, so M St and Wisconsin Ave traffic stopped at alleys.
  - **Buildings:** heights from Overture (1,915, OSM or USGS lidar), building parts (1), floor counts (49), the median of same-kind neighbours (855) or class defaults (2,172; houses 10 m). 96 % of rowhouses are 2-4 storeys. A footprint 60 % or more inside a larger one is dropped (13).
  - **Places:** categories only, mapped from the Overture taxonomy to the OSM `key=value` categories of `poiNames.ts`; confidence 0.55 or more, offices 0.8 or more and at most 2 per building; no names or brands.
  - **Water:** the Potomac, the C&O Canal (one centre line, the four lock chambers from the data, pound levels from the terrain: 11.0, 8.6, 4.0, 1.4, 0 m) and Rock Creek (water level per vertex from the terrain).
  - **Terrain:** 5 m grid from the DEM, relative to the river surface (0.13 m NAVD88): -2 (river bed) to 64.5 m.
  - **Props:** real signals, stop signs, lamps, benches, bins, bus stops, hydrants, bike racks and trees; synthesized ones flagged with a 4th element `1` (street trees every 12 m on shopping streets, lamps every 30 m, benches, bins, hydrants, woodland and park trees), never within a set distance of a real feature.
  - **Fallbacks:** `npm run gen-georgetown` (the knowledge-based map) and `?map=grid` still work.
- **World generator on real topology** (`roadNet`, `roadMesh`, `georgetownWorld`, `georgetownMap`, `lots`):
  - Widths from the data; sidewalks detected 1-5 m beyond the kerb; kerb radii 2 m at driveways and alleys, 4.5 m at residential corners; junction plateaus capped at 12 m at sharp merges.
  - **Profiles:** junction heights relaxed until a piece's free length takes the height difference at 10 % (main roads), 15 % or 20 % (service); roads leave each flat plateau with zero grade and ease into the street's grade over 10 m; a smaller road on a bigger one's carriageway within 2.5 m of its height takes the bigger road's height; car-park aisles take the lot's plane. New today: a road whose carriageway runs over another junction's plateau takes that plateau's height (a 0.36 m step across Washington Circle's arc at the Pennsylvania Ave / K St junction), a bridge deck no longer has to clear its own street one short piece beyond its end (`geo.deckJoinHop`; K St's bridge over the Rock Creek parkway stood 6 m above the junction 6 m away), and a ground junction beside a raised deck end rises up to 3 m to meet it (`geo.approachMaxLift`).
  - **Decks:** junctions inside a bridge take heights interpolated along it, not the DEM; their surfaces are in the deck index; a final deck pass with frozen node heights makes every plateau match its junction; the ground under every deck is cut below it.
  - **Tunnels** (the K St underpass, the Potomac Freeway portal) are left out and their approach ramps pruned. New today: lane directions that cannot reach a map-edge exit get no lanes (the pruned approaches ended in a node nothing leaves, and traffic circled there).
  - **Map:** driveways, parking aisles and alleys are drivable surfaces, not routes. New today: lanes lie on the collider surface (`roadSurfaceAt` nearest the lane's height; lanes on their own profile floated or sank up to 2.5 m where carriageways overlap), car-park bays where a footway or kerb sets the surface are left out (`geo.stallSurfaceTol`), synthesized crossings take the walk surface's height.
- **Traffic, police and life on the real map** (after merging main 8192ea1 into the branch):
  - **Signals:** a car held before a lane too short to stop on now calls the signal at that lane's end (cars queued at the Key Bridge north end for a green the M St detector never asked for: geodrive and the AI were stuck for ever).
  - **Turn curves:** the corner point must lie before the exit lane's start (a ring exit diverging at 5 degrees hooked back past the K St lane start), and an exit lane that starts up to `traffic.overlapStartMax` behind the stop line (inside of a bend through a node with tiny plateaus) is joined with no curve. Curves ending against their exit lane fell from 168 to 61 of 3,887 moves (the rest are U-turn bulges).
  - **A car tests follow** (`keep`) that reaches a one-way road off the map starts again elsewhere (it waited at the edge for ever, so mapcheck counted 1 choice).
  - **geodrive** adapted to real data: the Washington Circle entry and the K St exit are picked by an arm coming in / going out (each carriageway meets the ring at its own node).
- **Road audit and drive test** (limits in `TUNING.geo.roadLimits`): `roadaudit` casts rays at the colliders along every lane (centre and wheel tracks every 0.5 m), across every junction and along every walk link; `roaddrive` drives the player's car physically along every major street measuring the cabin's vertical acceleration and wheel airtime. Results: limits still exceeded in places, but every metric improved on the handed-over branch and the walls the gate drive hit are gone. Medians: grade 1.8 %, grade change 0.001/m, kink 0, cross-slope 0.

      | metric | over the limit before (handed over) | over the limit now | p99 now | max now |
      |---|---|---|---|---|
      | grade | 5,454 of 291,901 samples (1.9 %) | 5,285 of 286,826 (1.8 %) | 0.232 | 1.44 (was 1.53: K St at Rock Creek, now a service ramp at the Whitehurst west end) |
      | grade change per m | 2,658 | 2,437 | 0.039 | 0.41 |
      | kink (0.5 m) | 2,808 | 2,662 | 0.035 m | 2.97 m (a service road) |
      | cross-slope | 2,288 | 2,168 | 0.123 | 1.0 |
      | lane-to-surface gap | 4,799 | 3,947 | | |
      | junction kinks | 260 of 7,608 paths | 248 of 7,558 | | 3.1 m |
      | walk steps over 0.3 m | 1,549 of 14,702 links; 614 over 0.45 m | 1,558 of 14,741; 623 over 0.45 m | | 3.3 m |
      | holes under a lane | 3 | 3 (Key Bridge south end at the map edge) | | |

    - **roaddrive:** 48 major-street chains, 24.4 km. Worst cabin acceleration 32.4 m/s² (Canal Rd at the Whitehurst Freeway west end, -827, 158; it was 31.8 on Pennsylvania Ave at the Rock Creek bridge, now 9.6). K St at Rock Creek 19.2 (was 31.6), the Whitehurst east end 18.1 (was 29.8), the Key Bridge north approach 19.2 (unchanged). 12 of 48 runs stay inside both limits (was 11), 10 end in a collision (was 15), 2 airtime events over 0.08 s (was 4; the worst, 0.82 s, is a run that starts on the north map edge). M St 10.1 and 8.3 m/s² (two chains), Wisconsin Ave 8.7 and 7.4, 34th St 10.4 (was 11.6). Limit: 4.5 m/s², 0.08 s.
- **Scale check (1:1):** lanes 3.3 m (3.4 m on primaries), residential streets 9.5 m kerb to kerb, sidewalks 3 m, kerbs 0.15 m, storeys 3.2 m (data median 3.6 m with the roof), rowhouses 2-4 storeys, doors 1.1 x 2.2 m, people 1.75-1.8 m, car colliders 5-10 % short of real cars, Washington Circle radius 59 m. The table and the only fixes it needed (road widths from the mapped sidewalks, alleys narrowed) are in `docs/m3-suspicious-areas.md`, part 0.
- **Differences from the old map** and the data problems with coordinates and lat/lon: `docs/m3-suspicious-areas.md`, part 0. The largest moves: Key Bridge (old line 78 m off), R St (78 m), Dumbarton St (50 m), 37th St (48 m), Rock Creek (70 m); Washington Circle moved 38 m east; M St at Wisconsin Ave is 9.5 m higher (21.1 m).
- **Test:** `npm run build`, then `MAP=georgetown node scripts/shot.mjs x <scenario>` (and `MAP=grid`). Final build (d497d4d) unless noted; every run below exited 0 with a clean console unless noted.
    - **Georgetown, final build:**
      - **geodrive:** completed Key Bridge > M St > Pennsylvania Ave > once round Washington Circle (counter-clockwise, outer lane, 12 ring pieces) > K St > the waterfront, 3,284 m in 347 s of game time, no damage, no red lights run by the test car. AI: 0 illegal lane moves (of 1,145), 0 failed yields (17 ring entries), 1 red-light run of 277 signal crossings (a car committed on amber at Canal Rd), 13 wrong-way moves (5 and 6 in the two runs before; mostly at K St near 24th St, 608, 429, where the lanes jump sideways at a width change and cars swerve, and cars pushed back after contacts), 14 AI-AI contacts.
      - **mapcheck: pass.** 0 errors, 0 height mismatches, 93.5 % of lanes one-way-connected, 100 % walk connectivity, 30 lane choices, 0 jumps, 0 U-turns away from dead ends, 0.43 m off lane. (On the handed-over branch it failed: a car-park bay 0.5 m off the surface; then on this work's first build a crossing node 0.85 m off and a test car stuck at a one-way map exit.)
      - **taxi:** 3 of 3 fares (Key Bridge and M St at Wisconsin Ave ranks).
    - **Georgetown, earlier builds of today (same road surfaces):** geolife (M St at Wisconsin Ave at lunch 7 m of pavement per person, 29th St 48 m, M St at night 207 m; waterfront evening 10 m), parkcheck (1,516 parked cars, M St 11.2 per 100 m of kerb), theft (unlocked car stolen; locked one broken into, alarm, owner chases, witnesses call, 3 stars), dealership (3 dealers, a car bought and driven), world, walk, drive (see known issues), handling, crashspikes (0 frames over 33 ms), life, crowd, police (0 stars: nobody called it in, as on main's knowledge map), roadaudit, roaddrive. gate2 and witness crashed on the real map (no suitable person near the bottle yet); the scenarios now let the crowd fill in, and both pass (1 star, call completed).
    - **Grid** (`MAP=grid`): world, walk, drive, handling, crashspikes (0 frames over 33 ms), gate2, mapcheck (pass: 30 choices, 0.27 m off lane, 100 % connected), theft, taxi (3 of 3), dealership, life, crowd, witness, police (2 stars, chase, escape): all exit 0 with a clean console; mapcheck, gate2, witness, police and drive again on the final build.
    - **Fallback map** (`node scripts/georgetownFromSpec.mjs`, built to a scratch folder with this branch's generator): world and drive exit 0 with a clean console; mapcheck 0 errors and 0 height mismatches, 100 % connected; its drive passed on the second run (30 choices, 0.18 m off lane) and stopped at 14 choices on the first. Main's knowledge map passed mapcheck in the same session (30 choices, 1.21 m).
- **Performance against main 8192ea1** (the knowledge-based Georgetown, `?map=georgetown`): 3 interleaved rounds per build and preset, page load and map build unthrottled, frames at 4x CPU throttle (240 frames on foot at the spawn, 240 driving). The machine ran at a load of 8-12 on 4 cores the whole time, so the CPU medians overlap and say little; the structural numbers are exact.

    | | main, Low | real, Low | main, Medium | real, Medium |
    |---|---|---|---|---|
    | page load to the first frame | 10.8-22.6 s | 28.0-38.3 s | 14.8-25.8 s | 24.3-25.7 s |
    | map build (`buildStats.totalMs`) | 3.5-6.0 s | 11.3-18.9 s | 4.7-7.2 s | 9.3-10.2 s |
    | CPU per frame on foot (median) | 1.7-4.5 ms | 5.4-6.4 ms | 4.6-8.4 ms | 1.4-6.0 ms |
    | CPU per frame driving (median) | 1.6-5.3 ms | 4.3-5.8 ms | 1.2-6.0 ms | 1.6-6.3 ms |
    | draw calls at the spawn | 109-112 | 112-113 | 146-151 | 145-148 |
    | triangles drawn at the spawn | 496k | 656k | 812k | 0.99-1.01M |
    | triangles in the world | 1.56M | 2.43M | 1.56M | 2.43M |
    | static colliders | 10,778 | 8,350 | 10,778 | 8,350 |
    | geometry buffers | 74 MB | 121 MB | 74 MB | 121 MB |
    | JS heap | 182-203 MB | 231-248 MB | 154-206 MB | 226-289 MB |

    - **Map data:** 1.02 MB (179 KB gzipped) before, 2.56 MB in three files (583 KB gzipped) now.
    - The real map costs about 5-7 s more to build at load (roads, raster and buildings: 4,713 real footprints instead of 3,986 boxes), a third more triangles drawn at Medium, and 50-90 MB more memory; it has fewer colliders. Garbage per frame read 0 or about 80 KB depending on when the collector ran, in both builds (not comparable).
- **Screenshots:** `32-real-aerial`, `32-real-mst`, `32-real-keybridge`, `32-real-circle`, `32-real-canal`, `32-real-hills` (preview page, Medium, 13:00). The `28-traffic-*` and `29-life-*` screenshots still show the knowledge-based map (test runs on the real map were not kept).
- **Known issues:**
  - **Key Bridge north end and the Whitehurst Freeway west end:** the bridge end stood at 38 m (the real deck meets M St at about 21 m) with a 15 % ramp down to M St, and the freeway's west ramps fell 7 m in 8 m to M St and Canal Rd. *Fixed in the review below (a clearance ratchet between the freeway's own carriageways, not the data's layers).*
  - **Road smoothness** is still over the limits in places (numbers above): service-road mouths, steep street pieces between flat plateaus, the Rock Creek / K St / Whitehurst / Potomac Freeway interchanges.
  - **Tunnels:** the K St underpass and the Potomac Freeway portal are in the data but not rendered; the pruned approaches leave a sunken grass strip between the K St service lanes east of 24th St.
  - **Edges:** the west, north-west, east and south-east crop edges cut the street grid.
  - **Lanes:** lane counts are class estimates (Overture has none); two-way residential streets with one lane each way park on one kerb only.
  - **Traffic on the real map:** geodrive's AI counters are not all zero: 5-13 wrong-way moves per drive (cars swerving where the lanes jump sideways at a width change, K St near 24th St, and cars pushed back after contacts) and 0-1 red-light runs (a car that committed on amber and crossed as it turned red, at Canal Rd or Pennsylvania Ave); failed yields and illegal lane moves were 0 in every run. AI cars bump into each other at the Whitehurst Freeway west end ramps. 39 lanes have no legal move out (two-way dead ends where cars turn round, and roads leaving the map).
  - **Load time:** the real map takes 5-7 s longer to build than the knowledge-based one (numbers above).
  - **Walking:** about 620 walk links have a step over 0.45 m (paths over retaining walls, the towpath at the lock steps, some crossings on hills).
  - **Props:** bins, hydrants, bike racks, post boxes and the other new kinds are in the data, but the world draws only trees, lamps, benches, bus stops, signals and stop signs.
  - **Buildings:** facades are drawn as `levels` x 3.2 m plus the ground floor, not at the data's lidar height; 2,172 heights are class defaults; thin real footprints show as tall narrow walls.
  - **Stairs:** the 120 real steps go through the existing stair builder; they were not audited here (the physics branch owns stairs).
  - **drive** on Georgetown: the parked car it takes drives straight for 3 s into the dead end of 34th St south of M St and loses most of its health (the scenario does not check that).
- **Review of the real map (verify-realdata, on `s1-realdata`):** every claim above re-run on the builder's head (1e89980) and after the fixes below, plus new probes (one-ways against the raw Overture records, seed invariance, roadway obstacles, keyboard drives of every major street, traffic watches).
  - **Checked and fine:** one-way directions match Overture's access restrictions on 1,054 of 1,064 pieces; the other 10 are the Rock Creek Parkway's rush-hour one-ways (`during` Mo-Fr 15:45-18:30), correctly two-way the rest of the day. Washington Circle is one closed ring driven counter-clockwise (signed area positive on a north-up map), centre 38.90255, -77.05008 (the real circle's centre), radius 59 m, 8 spokes (23rd St N and S, Pennsylvania Ave W and E, K St W and E, New Hampshire Ave NE and SW). Landmarks sit where they are in Georgetown: M St at Wisconsin Ave (-147, 155, 21 m), the canal between M St (z 134-170) and K St (z 430-445), the Whitehurst Freeway above K St, Rock Creek and its parkway at x 330-390, the waterfront park, the hill rising north (P St 32 m, R St 57 m, Book Hill 59 m). Seeds 1, 123 and 456 give identical colliders and road, walk and building graphs; only the shop-sign boards and awnings differ (their width follows the invented name). The licence split and the credit lines are present and consistent in the pause menu (screenshot checked), the README and `georgetown.LICENSE.md`. 36 data footprints reach into a carriageway; the world builder clips footprints off roads and sidewalks, and a scan of every traffic lane and turn path found no building on any lane but service roads.
  - **Fixed:**
    - **Key Bridge north end at 38 m:** not the data's layers but a clearance ratchet: the Whitehurst Freeway's two carriageways drop to layer 1 for 28 m under the bridge, 8 m apart, and each half's layer-2 deck cleared the other half's layer-1 piece, so both climbed to 37 m and the bridge, clearing them, to 38 m (35 % ramps). A deck no longer clears its own street's other carriageway (no named road crosses itself on another layer in the data). Key Bridge now 20 m over the river, 23.7 m at its north end, 21.5 m at M St; the freeway 16-17 m at its west end, falling to 9.9 m at 29th St (`georgetownWorld.ts` makeProbe).
    - **Ridge across L St and Pennsylvania Ave** (622, 300): at a sharp merge the junction plateau's outline curved out 20 m beyond the arms' trims while the arms still climbed to it, a 0.39 m step across both roads (geodrive's car took 16 hp there, the keyboard drive crashed at 54 km/h). At sharp merges (under 35 degrees) the outline now stops at the trims (`roadNet.ts`).
    - **K St sagging onto its bridge over the Rock Creek parkway** (466, 431): the abutment node sat at 10.5 m between 12.4 and 12.0 m, a V that launched cars at 60 km/h. An abutment lower than both the street's next junction and the deck's far end (within `TUNING.geo.sagFillSpan`) rises to the line between them, bounded by `approachMaxLift` (`roadNet.ts`).
    - **Invisible walls of concave buildings:** a building collider that is not a box was the convex hull of its footprint, so 1,674 L- and U-shaped real footprints filled their notches (134,000 m2 of invisible wall over courtyards, driveways, alleys and pavements; one hull added 960 m2). Concave footprints are cut into convex pieces (triangulated, merged while convex, notches under `TUNING.geo.footprintNotchTol` = 0.3 m filled). Static colliders 7,787 -> 13,672.
    - **Things standing in the road:** a church tower stood in Q St (the end of an irregular footprint's long axis lay outside it): towers now stay on the footprint and off the road; a bus shelter's end stood 2 m into Wisconsin Ave beside a driveway mouth: shelters are placed only where all four corners are off roads and buildings (`facades.ts`, `props.ts`).
    - **Cars circling at the map edge:** a car on a one-way road leaving the map reached the end at turn speed with no next lane and drove round in circles on the spot for as long as the player watched (and mapcheck's followed car did so for the rest of its run: the builder's "mapcheck passes" was 1 of 3 runs). It now pulls up at the end (`traffic.ts`).
    - **A real business name as a place:** park places included "Thompson's Boat Center" (a boathouse business) and a university's initials ("GW GroW Garden"), which the taxi and NPC chat use. Only public open-space names are used now (14 of 17).
  - **Test** (`npm run build`, then `MAP=georgetown node scripts/shot.mjs x <scenario>`; numbers are the builder's head 1e89980 -> the reviewed head; the machine ran other agents' builds at load 12-15 on 4 cores, so CPU timings are noise):
    - **roadaudit:** grade samples over the limit 5,285 -> 2,994 (worst 144 % -> 64 %, now the Q St bridge's east end at 803, -461), grade change 2,437 -> 1,080, kinks 2,662 -> 2,298, cross-slope 2,168 -> 1,993, lane-to-surface gaps 3,947 -> 1,875, junction kinks 248 -> 235 (worst 3.1 m, the bus shelter, -> 1.6 m on a service road), walk steps over 0.3 m 1,558 -> 1,525 (over 0.45 m 623 -> 589), holes 3 -> 3 (the Key Bridge's south end at the map edge and a pinhole on Pennsylvania Ave at 309, 160, both already there).
    - **roaddrive:** 48 chains, 24.9 km: worst cabin acceleration 32.4 -> 21.0 m/s2 (K St at 242, 444, where the freeway's eastbound carriageway comes down onto it), samples over 4.5 m/s2 1,784 -> 1,379, runs inside both limits 9 -> 11, runs ending in a collision 10 -> 8. The Key Bridge (19.2), Canal Rd (32.4) and Whitehurst west end spikes are gone.
    - **Keyboard drive** (new probe: every major-street chain driven with W/A/S/D only at 55 km/h, 70 on parkways, slower in curves, traffic removed; 50 chains, 24 km): runs ending in a crash 17 -> 13, airtime events over 0.08 s 4 -> 1, worst cabin acceleration 33.3 -> 14.1 m/s2 (leaving out the start beyond the north map edge, where the car falls), runs over 10 m/s2 15 -> 12.
    - **geodrive:** builder's head: completed, 16 hp lost on the L St ridge, 5 AI wrong-way moves, 0 red runs. Reviewed head, two runs: completed with no damage, no red light by the test car, AI 0 illegal moves of 1,324, 1 red run of 316 (a car committed on amber at the Key Bridge / M St signal), 0 failed yields in 15 ring entries, 4 wrong-way moves; the second run got stuck on K St at 411, 438 (see known issues).
    - **mapcheck:** 0 errors, 0 height mismatches, 93.5 % of lanes one-way-connected, 100 % walk connectivity, 20 of 20 walks, every place with a kerb point, in every run. Its drive part is flaky: on the builder's head it failed (the car circling at the Canal Rd exit); with this review's fixes it passed once (after the first three fixes, 0.19 m off lane) and failed twice (later builds, the reviewed head included: 3.0 m and 7.7 m off lane, after AI contacts and on the short lanes at the Key Bridge / M St junction; 30 choices reached in two of the three). The same drive run four times in one session on an intermediate build: 4.3, 76 (a re-placed car), 4.5 and 0.5 m.
    - **taxi** 3 of 3 fares; **walk**, **world**, **drive** exit 0. The builder's head also ran roadaudit, roaddrive, world, walk, drive, handling, crashspikes, gate2, witness, police, theft, dealership, geolife, parkcheck, life and crowd on Georgetown: all exit 0 with a clean console.
    - **Grid** (the reviewed code without the sag fix, which only runs on real data): world, walk, drive, handling, crashspikes, gate2, mapcheck (pass, 30 choices, 0.3 m), theft, taxi (3 of 3), dealership, life, crowd, witness, police (3 stars, chase): all exit 0 with a clean console.
    - **Traffic watches** (new probe: you stand still, 5 game minutes at the preset's density): Washington Circle 55 ring entries, 0 failed yields, 0 red runs in 344 signal crossings, no contact on the ring (14 elsewhere, mostly where K St meets 27th St at 675, 430); M St at Wisconsin Ave (an intermediate build of this review, same traffic code) 149 signal crossings, 0 red runs, 5 contacts (two opposing left turns on Wisconsin Ave), one car stood 88 s at the junction's two nodes while its exit was blocked. On the builder's head the circle gave 45 entries, 0 failed yields, 0 red runs.
    - **Seed invariance:** collider, road-graph, walk-graph and building hashes identical for seeds 1, 123 and 456 on both heads.
    - **Performance** against the builder's head (3 interleaved rounds per preset, `?map=georgetown`): draw calls Low 112-114 -> 110-116, Medium 142-148 -> 140-145; triangles drawn 656k -> 655k (Low), 1.010M -> 1.009M (Medium); geometry 121.2 -> 121.3 MB; colliders 8,350 -> 14,233 (static 7,787 -> 13,670); map build at load 5.4-9.4 s -> 6.2-7.4 s (Low) and 6.0-9.8 s -> 7.0-7.6 s (Medium); page to first frame 13.8-24.1 s -> 18.7-19.1 s (Low); JS heap 238-241 -> 242-248 MB (Low). Frame CPU at 4x throttle on foot, median per run: Low 6.3-8.1 -> 9.3-11.4 ms, Medium 5.3-11.6 -> 8.7-9.6 ms; driving Low 4.3-5.6 -> 5.9-8.2 ms. A section breakdown on foot (2 alternating rounds, 4x): physics 5.4 / 5.9 ms on the builder's head, 9.9 / 5.8 ms reviewed (the 9.9 ms round was slow in every section, player and camera too); the extra colliders may cost a little physics time, but on this loaded machine it is not separable from noise. The pause menu shows the full credit line (screenshot checked).
  - **Known issues after the review:**
    - **K St westbound at 396-415, 437:** the Whitehurst Freeway's slip road onto K St (a primary_link) overlaps the inner lane and its surface stands 0.32 m above the lane where they part (0.2 m before this review); geodrive's car drove into it at 39 km/h and stuck there in one of two runs.
    - **Whitehurst Freeway east end** (371-409, 425): it still climbs from 12.4 to 19.4 m in 38 m because it clears K St running alongside it (8 m apart) as if K St were beneath it; roaddrive's second-worst spike (17.7 m/s2).
    - **mapcheck's drive** passes about one run in three on the real map (above); the graph, walk, height and place checks pass every time.
    - **Map edges:** lanes run on past the invisible boundary walls; the Rock Creek Parkway chain that starts beyond the north wall (243, -1027) falls off the terrain, and a car driving out on Wisconsin Ave meets the wall in mid-street.
    - **Colliders:** the convex pieces add 5,885 static colliders (13,672 in all); service roads mapped within a metre of a wall still graze it (about 30 short stretches, AI cars only).
    - **The seed varies shop-sign widths and awning colours** (render only: no collider, graph or walk change).
    - **Fallback map** (`georgetownFromSpec.mjs`) not re-run in this review; the collider, tower, shelter and map-exit changes apply to it too.

### PBR look (Stage 1 item 4, branch `s1-look`)

- **S1.4 PBR look (branch `s1-look`):** the city is now drawn with physically based materials and lighting instead of flat vertex colours. Everything new lives in `src/systems/render/`; generator files change only where a material is assigned.
  - **Procedural textures, baked on the GPU at boot** (`bakeShaders.ts`, `texBake.ts`): 27 surfaces drawn from noise, cells and parametric layouts (original by construction, nothing downloaded): asphalt with aggregate, wear, crack networks and tar-sealed cracks; worn road paint; concrete slabs; Georgetown herringbone brick pavers; granite; granite setts; grass; soil; gravel; bark; leaf clusters; timber decking; painted and bare metal; board-formed concrete; dressed stone; brick in running, Flemish (burnt headers) and common bond; painted brick; stucco; clapboard; slate; standing-seam metal; tar roofing; awning canvas; water ripples. Each bakes albedo + tint mask and normal + roughness + occlusion into two texture arrays with mipmaps and anisotropy, plus a macro-variation texture. One program per surface: a single shader with all of them ran every branch on software GL (110 s bake; now 1.5–5 s there, milliseconds on a real GPU).
  - **World materials** (`worldMaterial.ts`, `surfaces.ts`, `palette.ts`): one patched `MeshStandardMaterial` per chunk layer reads a per-vertex surface id (`aSurf`) and projects that surface in world space (from above for ground, along the face for walls and roofs), tinted by the vertex colour relative to the surface's reference colour, with large-scale macro variation so tiles never repeat visibly. Surfaces come from tagged palette colours (`surf()` in the road, terrain and lot colour tables) or are inferred from the generators' existing palette colours, so bridges, waterworks, props and monuments needed no edits. Chunk batching and draw calls are unchanged.
  - **Facades** (`facadeMaterial.ts`, facade tiles now 256 px with relief normals and window-reveal occlusion): walls show the building's own surface (brick bond, painted brick, stucco, clapboard, ashlar, chosen per building from its id), plinths are dressed stone, frames and doors have relief, and windows are glass: a sharp sky reflection (Fresnel) over a room behind it (interior mapping: back wall, side walls, floor, ceiling, furniture, blinds or curtains per window), dim by day and warm when lit at night.
  - **Lighting** (`sky.ts`, `dayNight.ts`): three's Preetham sky with clouds and the sun where the clock puts it; the sky (without the sun disc, plus a warm ground bounce) captured into a 128 px cube and prefiltered as the scene environment, refreshed only when the sun moved 1.5° or the weather changed; a `SunLight` with two shadow cascades out to 320 m (Medium) or 650 m (High), soft PCF edges; ACES filmic tone mapping; deep blue night sky with city glow; grey, dimmer sky under cloud. All levels in `TUNING.look`.
  - **Trees** (`trees.ts`): within `treeNear` (110 m Medium, 200 m High) a detailed tree replaces the far crown: tapered bark trunk, branches, a dense inner crown and 38–46 rounded alpha-to-coverage leaf cards; far crowns get bark and leaf textures and hide inside the ring in the vertex shader (no buffer rewrites).
  - **Water** (`water.ts`): river, canal and creek mirror the sky with three scrolling layers of baked ripple normals over the existing swell.
  - **Night** (`nightLights.ts`): real point lights at the 6 (Medium) or 10 (High) street lamps nearest the camera, a fixed pool so no shader ever recompiles; lit rooms; headlights as before.
  - **Rain and snow:** porous surfaces darken, upward faces turn glossy and puddles form in the dips of the macro field (`uWet` from the weather); snow settles on upward faces.
  - **Vehicles and people** (`vehicleMaterials.ts`): car paint under a clearcoat, dark glass, trim and lamps sorted per vertex colour; rubber tyres and polished hubs; people in cloth with a soft sheen (shapes unchanged).
  - **Grid city** (`gridLook.ts`): the same materials, applied after it is built.
  - **Presets** (`TUNING.quality`, pause menu): Low = 256 px textures without normal maps, no shadows, no near trees, no lamp lights, 70 % resolution; Medium = 512 px, two 1536 px cascades to 320 m, near trees to 110 m, 6 lamp lights; High = 1024 px, 2048 px cascades to 650 m, near trees to 200 m, 10 lamp lights. GPU memory of the bake: 19 MiB (Low), 73 MiB (Medium), 289 MiB (High), plus 16 MiB of facade tiles and the shadow cascades (Medium 2 x 1536², 18 MiB; High 2 x 2048², 32 MiB). Download grows by about 100 KB of code; no texture files.
  - **No first-draw stalls:** after `renderer.compile()`, `warmup.ts` draws one representative of every material and mesh kind on screen behind the title, because some drivers (and software GL entirely) finish a program only at its first draw.
  - **Test:**
    - `npm run build && node scripts/lookShots.mjs --dist <base dist> --prefix 33-look-before` and `node scripts/lookShots.mjs --prefix 33-look-after mst rowhouses keybridge waterfront circle night`: the same preview cameras before and after (`screenshots/33-look-before-*.png`, `33-look-after-*.png`, side by side in `33-look-mst-before-after.png`); `texsheet` as a view shows every baked map.
    - In the game: `MAP=georgetown node scripts/shot.mjs x lookgame "1337&quality=low&lookhour=15.5&lookout=33-look-low"` (also `weather=rain`, `lookhour=21.6`).
    - `node scripts/shot.mjs x lookstall` (and with `MAP=georgetown`): no new shader program by day, at night or in the rain after boot.
    - `node scripts/lookPerf.mjs --base <base dist>`: boot, draw calls, triangles and CPU per frame per preset, base vs this build, interleaved.
  - **Measured** (`lookPerf.mjs`, base = main 8192ea1, Georgetown, M St at 15:30, 640 x 360, medians of 2 interleaved rounds; software GL on a shared 4-core machine at load 6-14, so frame times say little about a real GPU):

    | Preset | Draw calls | Triangles | CPU per frame | CPU per frame, 4x throttle | Page start to first frame | Bake |
    |---|---|---|---|---|---|---|
    | Low | 92 -> 93 | 0.46 -> 0.46 M | 8.7 -> 4.5 ms | 29.1 -> 37.1 ms | 3.7 -> 9.7 s | 2.3 s |
    | Medium | 159 -> 259 | 0.88 -> 1.38 M | 10.2 -> 6.1 ms | 34.9 -> 44.7 ms | 3.6 -> 15.3 s | 4.6 s |
    | High | 242 -> 418 | 1.13 -> 2.01 M | 10.0 -> 13.5 ms | not run | 3.7 -> 29.6 s | 14.2 s |

    - Medium's extra draw calls and triangles are the second shadow cascade and the near trees.
    - The throttled CPU rise is the render call waiting for software GL, not script: a JS profile of 30 Low frames on a 64 x 36 canvas took 551 ms (base) and 524 ms (new), 72 % of both in native GL calls. CPU-side cost per frame is unchanged within noise.
    - Software GL frame at 1280 x 720 Medium on M St: about 1.5-2 s before, 7-10 s now; the first street-level frame after boot about 35 s before, 110-200 s now. `scripts/shot.mjs` timeouts are raised to match.
    - The bake and the boot times above are software-GL times (27 shader compiles plus the passes); on a real GPU the passes take milliseconds.
    - No new shader program while visiting 7 places by day, at night and in the rain (`lookstall`: 46 programs before and after on Georgetown, 41 on the grid).
  - **Known issues:**
    - Frame times on a real GPU are not measured; only software GL is available here.
    - No screen-space ambient occlusion on High (occlusion is baked into the textures and window reveals only).
    - Shapes are unchanged: cars and people are still low-poly boxes, buildings keep their extrusions; the rooms behind windows are interior mapping, not enterable.
    - Leaf cards very close to the camera show speckled edges; far canopies are solid crowns with a leaf texture.
    - Under heavy rain with a bright overcast the wet streets still read light.
    - Mortar colour is the same on every brick building (bond, brick colour and paint vary).
    - The in-game shots show the taxi job's fare beacon (an existing 40 m light column) at the end of M St.
    - Headless runs are slower (see above): budget minutes for a scenario's first rendered frame.

- **S1.4 PBR look, independent review (verify-look, branch `s1-look`):** every claim re-run, screenshots at street level and from the air at dawn, day, dusk, night and in rain, perf against main 8192ea1, shader stalls while driving, grid regressions. Seven fixes, each its own commit:
  - **Leaf cards mirrored the sky.** The detailed trees lit their leaf cards with the rounded canopy normal but without the back-face flip, so at the rim and on the far side of every crown the normal faced away from the camera, Fresnel went to 1 and the leaves showed the bright sky: pale, speckled "frost" on every backlit tree (all street-level M St shots). Normals now bend toward the viewer, leaves keep 60 % of the sky reflection, sunlight passes through backlit leaves (translucency, inside three's sun loop so it keeps the sun's shadow), and edge-on cards fade (`TUNING.look.leaf*`, `worldMaterial.ts`).
  - **Black sky at 19:00.** `sunDirection()` set the sun at 18:00 while the day/night keys keep dusk light until about 19:45, so the physical sky went black and starry and the sun switched to the moon while the hemisphere light, fog and exposure still said dusk. Sunrise and sunset are now `TUNING.look.sunrise/sunset` (6.0 and 19.8): golden hour at 19:00, blue hour at 19:30, night by 20:00.
  - **Rain sky with dark blue holes.** Cloud coverage only reached 0.95; three's Sky varies it by ±0.3 per region, so the overcast greying turned the gaps into slate patches. Coverage now goes to 1.25 and density to 0.85 at full cloud (`skyCloudOvercast`, `skyCloudDensity*`).
  - **Tar roofs repeated a 4 m lattice of dark oval pairs** (the bake's repair patches inside one 4 m tile), plainly visible from any height. Patches are now rare and faint.
  - **Entering a parked car recompiled every lit shader.** The headlight was parented to the driven car's mesh, which stays hidden while an untouched parked car is drawn as an instance; the light count dropped and 15-16 programs (world, facades, trees, water, sky, cars, people) compiled mid-game: frames of 2-3 s in software GL, and no headlight while sitting in the car. It now stays in the scene and copies the car's pose.
  - **Shadow-pass program churn.** One shared depth material for instanced and plain casters made three re-derive program parameters per draw; with every prop casting and two cascades that was about 155 KB of garbage per frame on Medium (main: 89 KB). Instanced casters now have their own depth materials (`render/shadowCasters.ts`): 59 KB per frame.
  - **TUNING.look comments** (`interiorDay`, shadow biases).
  - **Test:**
    - Screenshots of the review: `screenshots/34-look-review-{trees,dusk,rain,roof,aerial}.jpg` (builder build vs review fixes, Medium, 1280 x 720, the game itself).
    - Stalls: in the game, get into a parked car at night: no hitch, headlight on. Scripted: a drive over the whole map (50 lane points on Georgetown, 40 on the grid; day, dusk, night, rain) compiles 0 new programs on either map (before the headlight fix: 16 on Georgetown).
    - `node scripts/shot.mjs x lookstall` and `MAP=georgetown node scripts/shot.mjs x lookstall`.
    - Grid regressions after the fixes, all exit 0 and console clean: `world`, `walk` (4.8 m walked, 0.64 m jump), `drive` (31 km/h after 3 s, turn, brake), `handling` (83 km/h after 4 s, handbrake slide recovers), `crashspikes` (930 frames, 0 over 33 ms, worst 10 ms), `gate2`, `mapcheck` (pass, 0 warnings), `theft`, `lookstall` (41 programs before and after); Georgetown `lookstall` 46 before and after (its final page screenshot timed out after 300 s in software GL; the scenario itself passed).
  - **Measured** (base = main 8192ea1, Georgetown at M St 15:30, software GL, interleaved runs, medians):

    | | Low base | Low new | Medium base | Medium new |
    |---|---|---|---|---|
    | CPU per frame, 4x throttle, 480 x 270 (3 rounds) | 19.9 ms | 19.6 ms | 33.3 ms | 28.6 ms |
    | frames over 33 ms of 20, same runs | 0 | 0 | 10 | 3 |
    | software-GL frame, 960 x 540, GPU drained (2 rounds) | 566 ms | 1311 ms | 1033 ms | 5307 ms |
    | draw calls / triangles | 92 / 0.46 M | 92 / 0.46 M | 156 / 0.88 M | 256 / 1.39 M |
    | page start to first frame | 8.6 s | 11.3 s | 9.5 s | 18.0 s |
    | baked texture memory | - | 19.3 MiB | - | 73.3 MiB |
    | garbage per frame (heap sampling, 30 frames) | | | 291 KB | 322 KB after the fixes (515 KB before) |

    - CPU per frame is not worse on either preset; Low is not slower than main on the CPU.
    - GPU cost is the open risk: software GL needs 2.3x main's work on Low and 5.1x on Medium (two 1536 px cascades, 6 point lights evaluated by every lit pixel all day, PBR texture fetches, sky light, interior-mapped windows). Software GL over-weights texture fetches, so real GPUs will scale differently, but Low cannot be called as cheap as main until it is measured on a real laptop.
  - **Known issues (not fixed):**
    - From the air the city reads as a toy model: flat pastel roofs and identical window grids come from the generator's palettes and facade tiles; the existing 180-750 m fog hides the city entirely from 300 m up.
    - The asphalt aggregate is coarse and high-contrast (sandpaper at 10-30 m).
    - Leaf cards still speckle at the crown edge (alpha to coverage), and a backlit crown shows its dark inner sphere.
    - Stars appear while the 19:30 sky is still blue; blue hour is short (about 19:30 to 20:00).
    - The 6 (Medium) or 10 (High) lamp point lights stay in every lit shader by day at intensity 0 (no recompiles, but every pixel pays for them).
    - Pre-existing on main, still there: `carMaterial` is shared by instanced parked cars and plain traffic cars, and the crowd shares one material between coloured and plain parts, so the main pass still re-derives programs per draw (about 44 KB per frame); weather keeps 30 % of the sun under rain (hard shadows on an overcast day).
    - The committed `33-look-*` shots predate these fixes (frosty trees, old sun angle).
    - Changing the quality preset changes the light count; materials then compile lazily as they come into view after the menu closes.

### Stage 1 integration (branch `s1-integrate`, from main 8192ea1)

- **Merges, in order:** `s1-research` (731c18c), `s1-physics` (17c3625), `s1-realdata` (76ea1bd), `s1-look` (cf8e768). All four branches existed. Conflicts and how they were kept on both sides:
  - `facades.ts`: concave footprints cut into convex pieces (real data) and every building collider tagged `building` (physics).
  - `roadMesh.ts`: deck junctions collide as `deck` triangles and corners know they are on a deck (physics), plus the deck junction underside (real data); the look's surface-tagged colours (`surf(SURF.*)`) on every palette.
  - `georgetownWorld.ts`: stairwell holes, the surface index, the audit recorder and the props' `standAt` (physics) with the real-data road topology (`omittedRoads`, `planLots` / `conformToLots`) and the look (`createLook`, world and facade materials, upgraded water and props, tree LOD).
  - `loadMap` / `gridMap` / `georgetownMap` / `cityGen`: map factories take both the audit flag and the look: `(..., quality, audit, look)`.
  - `main.ts`, `world.ts`, `scenarios.mjs`, `DEVLOG.md`, `ROADMAP.md`: both sides kept.
- **Integration fixes** (the physics work had only seen the knowledge-based map; the real map has 86 Overture steps features, overlapping road surfaces and decks over streets):
  - **Stairs climbable on the real map** (`bridges.ts`): stair ends are now fitted to the ground as built round them (`fitStairEnds`: the 5 m terrain mesh, sidewalks, lots, towpath, measured on the ground triangles with `surfaceIndex.ts trianglesNear` and `PhysChunks.soupsOf`), and the flights re-planned (`stairProfile`). The plan came from the 1 m raster before blending and meshing: 65 of 86 real stair ends sat 0.3-2 m off the ground beside them, a ledge nobody could step up. Steps running on into a building stop 0.4 m in front of the facade; steps running off the map stop inside its edge walls; an end landing on another stair takes that stair's height there (`joinStairEnds`); a side wall is left out where it would stand in another stairwell (another stair, the same stair's next piece at a sharp bend, another stair's end). New tuning: `geo.stairEndProbe`, `stairEndFit`, `stairDoorGap`, `stairJoinDist`, `stairEndClear`.
  - **Lanes on the surface that is drawn** (`georgetownMap.ts`): where another road's or a sidewalk's surface overlaps a lane a little higher (about 35 lane points, up to 1.1 m: carriageway meshes meeting at different heights on Virginia Ave, the Rock Creek Parkway under the bridges, the Whitehurst west end, a sidewalk over a service road), the lane and walk nodes go up onto it, as the exact `map.heightAt(x, z, y)` from s1-physics reports. mapcheck height mismatches 5 -> 0.
  - **No bridge abutment across a street under a deck's end** (`bridges.ts`): real data ends the Whitehurst Freeway deck over K St; the abutment wall (drawn on s1-realdata, solid since s1-physics) stood across K St and stopped the gate drive (55 hp crash at 44 km/h at 158, 433). Abutments are built in pieces and left out over road cells.
  - `buildDeckIndex(null, piers)` no longer reads the road net's overlay stretches and deck nodes when there is no net (a type error after the merge); the dead-end caps' skirt is tagged `decor` for the physics audit.
  - Scenarios: `stairs` steers along bent stair lines (real ones bend; W alone walked into the wall) and walks the longest footbridge (real data has 0.1 m footbridge stubs); `shot.mjs` loads `?map=grid` for scenarios written for the grid city (`GRID_SCENARIOS`) when MAP is not set.
- **Default map:** `TUNING.map.defaultMap` is now `georgetown` (the real map); `?map=grid` keeps the grid city. README updated; the pause menu shows the data's attribution line (`meta.attribution`, the same text as the README's).
- **How to test:** `npm run build`, then `node scripts/shot.mjs x <scenario>` (Georgetown unless the scenario is in `GRID_SCENARIOS`), `MAP=grid` / `MAP=georgetown` to force a map, `QUERY=physaudit=1` for `physaudit`. The runs below used copies of the build (`dist` + `scripts`) so a rebuild never changed a running test. The machine ran at a load of 10-22 on 4 cores the whole evening (other sessions plus up to four of these browsers): several scenarios lost their final or mid-run 1280x720 screenshot to the 300-420 s timeout, and every CPU figure is noisy.
- **Stage 1 tests on the real map (Georgetown), final build unless noted:**
  - `stairs`: 85 data stairs built; 79 climbed up and back down with held keys (W, steering along bent lines). Not walkable end to end: #5 and #6 (off a canal footbridge deck, behind its railing, -349, 240), #24 (switchback, -934, -24), #39 and #43 (overlapping pieces, 252, -770), #56 (69-degree bend, 228, -888). Before the integration fixes 28 of 86 failed. The Exorcist Steps climb in 11.6 s (the test calls that slow). Stoops: 2, 3, 5, 7 and 10 steps all climbed to the door, rails hold; 3 of them come back down to a ground 0.17 m below where they started (the steep-street frontage strip). The scenario's other checks fail on real terrain: the statue plinth and a fountain stand on slopes, so their lowest tier is stepped up from the uphill side; the bench jump; the kerb test at the spawn finds the pavement 0.39 m below the road there. `pass: false`.
  - `fallthrough` (2,000 drops, f3 build): 1,303 landed, 0 below the floor, 0 off `heightAt`, 0 inside a building, 0 not settled, 1 hover (-352.6, 302.5: the capsule rests 0.27 m up touching nothing the rays see). `pass: false` (hover must be 0).
  - `physaudit` (f3 build): 29,142 colliders; 504 side-probe mismatches (railing 178 missing + 43 short, stair 194 short: riser offsets up to 0.29 m on the re-planned flights, lamp 44 / bench 25 / tree 11 / building 6 colliders 0.1-0.47 m long, 2.9 m on two waterfront benches) and 140 floor mismatches (railing 105, stair flights 32, ground 3). On the knowledge-based map the physics review had 0 and 6. `pass: false`; not fixed here.
  - `physf4`: pass on both maps (4 views on Georgetown, 1 on the grid).
  - `mapcheck`: graph, walk, places and heights clean (0 height mismatches, was 5 after the merge); its drive part (an AI car within 3 m of its lane over 30 choices) failed at 3.02 m and 6.4 m off lane in two runs (it passed about 1 run in 3 on s1-realdata).
  - `roadaudit`, `roaddrive`: not re-run to completion on the integrated build (see below); s1-realdata's own numbers stand: limits still exceeded in places.
  - Look presets: Low / Medium / High screenshots `34-stage1-quality-*`. Low -> Medium through the pause menu re-baked the surface maps (12.4 s / 5.3 s at 640x360) with a clean console.
- **Milestone 3 gate on the real map:**
  - `geodrive` (f5 = final code): completed Key Bridge -> M St -> Pennsylvania Ave -> Washington Circle -> K St -> waterfront, 3,284 m in 362 s, 0 damage, 0 red lights by the test car. AI over the run: 0 failed yields in 15 circle entries, 0 red-light runs in 244 signal crossings, 0 illegal lane moves in 1,177, 5 wrong-way moves (K St / 30th St, the Rock Creek interchange), 23 AI contacts, 0 cars stuck over 20 s. F3 spikes in the drive window 0; 260 of 21,680 frames over 33 ms (load 11-20; worst 862 ms in physics). The run before the abutment fix (f4) crashed into the abutment wall on K St (55 hp) and stopped at 95.9 %.
  - `taxi` (f4): 3 of 3 fares between real places: Key Bridge rank -> O St NW, Washington Circle rank -> a place whose street is shown as "Georgetown" (no street name), M St at Wisconsin Ave rank -> O St NW.
  - Theft (`geolife` at 640x360, final): an unlocked sedan on N St NW (residential) with nobody near: 0 calls, 0 stars, the owner remembers ("stole my sedan"). A locked pickup on M St NW with four people on the pavement: window smashed in 3.1 s, alarm, 4 calls started and completed, 2 stars, the owner chases, then phones, remembers ("stole my pickup right in front of me") and refuses to talk. `theft` on 33rd St (f4): the same pattern, 5 calls, 2 stars.
  - People at 12:30 (`geolife`): M St at Wisconsin Ave 25 people in the 60 m window (F3 target 45, real-world estimate 147, active 44, a person every 7 m of pavement); 29th St between N and P 10 (target 10, a person every 48 m). Night on M St 5, waterfront at 19:30 30, towpath at 07:30 9. 430 seeded items, 4 placed badly (2 in blocked cells, 2 near a drop; main had 0).
  - Seeds 1, 123, 456: static colliders (28,575) and the road, walk and building graphs hash identically; the shop names differ, and so do the drawn meshes, by the shop signs only (about 500 vertices of 6.47 M).
  - F3 spikes: 0 in the gate drive window. `crashspikes` (f4, load 11): 11 of 930 frames over 33 ms, worst 293 ms in physics during a traffic pile-up.
- **Regressions:**
  - Grid (`MAP=grid`; the integration's later changes are Georgetown-only): world, walk, drive (31 km/h after 3 s), handling, crashspikes (1 of 930 frames over 33 ms, worst 85 ms in the weather / sky-light refresh), gate2, theft, taxi (3 fares), dealership, life, witness, police (3 stars, lost in 57 s), chat, mapcheck (pass), stairs (pass), fallthrough (823 landed, 0 below, 0 hover), physf4 (pass): all exit 0 with a clean console. `crowd` did not finish: the browser's renderer was killed (the session's memory limit; "the kernel killed a process for lack of memory") after the scenario switches the preset to High; the same happens with the s1-look build alone, so it is not from the integration.
  - Georgetown (`MAP=georgetown`): world (the default map, no MAP: loads Georgetown at the spawn), walk, drive, handling, gate2 (1 star, escaped in 28 s), theft, dealership (3 dealerships, a hatchback bought and driven), life, chat, roadaudit, pause, witness and police (these two at 640x360: their 1280x720 screenshots timed out at a load of 20) exit 0 with a clean console. `crowd`: renderer killed as on the grid. `police` on Georgetown: the scripted run-over misses both people (they stay idle), so there is no chase to judge (the grid run chases and loses 3 stars). `drive`: the starting car hits the corner pole within 20 m (120 -> 52 hp, carried over from s1-realdata). `handling`: the test car runs off K St into a building at (100, 422) after 2 s.
  - `roadaudit` (f4 build): grade samples over the limit 3,017 (s1-realdata review 2,994), grade change 1,164 (1,080), lane-to-surface gaps 612 (1,875: the lanes now lie on the drawn surface), junction kinks 234 (235), walk steps over 0.3 m 1,647 (1,525), holes 3 (3). `roaddrive` was not run on the integrated build.
- **Performance against main 8192ea1** (main's `?map=georgetown` is the knowledge-based map without PBR or the new colliders; this build is the real map with all of Stage 1). `node perf.mjs` (scratch tool): interleaved base/new runs, 960x540, page load unthrottled, then 4x CPU throttle; 60 rendered frames on foot at M St and 60 driving; garbage over 300 unrendered frames between forced GCs. 3 rounds on Low and Medium, 1 on High, 1 on the grid; the machine was at a load of 12-20 throughout, so CPU medians are rough and frames over 33 ms are mostly the machine. Medians:

  | | Low main | Low new | Medium main | Medium new | High main | High new |
  |---|---|---|---|---|---|---|
  | Page ready (s) | 13.6 | 33.5 | 16.6 | 49.4 | 24.7 | 95.3 |
  | Map build (s) | 3.9 | 13.6 | 4.2 | 23.0 | 4.9 | 40.0 |
  | Draw calls at M St | 91 | 92 | 156 | 264 | 243 | 422 |
  | Triangles at M St (M) | 0.46 | 0.54 | 0.88 | 1.89 | 1.13 | 2.61 |
  | CPU per frame on foot, 4x throttle (ms, median / p90) | 18.6 / 42.2 | 25.9 / 46.3 | 29.3 / 43.8 | 28.7 / 45.3 | 41.7 / 75.8 | 34.4 / 71.9 |
  | CPU per frame driving (ms, median / p90) | 17.7 / 39.4 | 25.4 / 87.8 | 23.3 / 42.0 | 33.7 / 74.9 | 33.5 / 93.3 | 52.1 / 99.3 |
  | Frames over 33 ms of 60, foot / car | 8 / 6 | 16 / 19 | 19 / 9 | 21 / 30 | 45 / 32 | 31 / 51 |
  | Garbage per frame (KB) | 74 | 62 | 5-105 | 77 | 94 | 85 |
  | Baked texture memory (MiB) | - | 19.3 | - | 73.3 | - | 289.3 |
  | JS heap after the runs (MB) | 153 | 299 | 166 | 277 | 164 | 280 |
  | Shader programs | 26 | 44 | 29 | 47 | 29 | 47 |
  | Static colliders | 10,778 | 29,146 | 10,778 | 29,146 | 10,778 | 29,146 |

  Grid Medium (2 rounds): ready 7.1 -> 47.8 s (the texture bake), draw calls 126 -> 230, triangles 0.18 -> 0.24 M, CPU on foot 19.0 -> 19.2 ms (p90 56 -> 98), in a car 20.9 -> 24.4 ms, colliders 1,806 -> 2,050. Stage 1 costs more almost everywhere: twice the draw calls and triangles on Medium, a three-to-four times longer boot (texture bake plus a bigger real map and three times the colliders), about 130 MB more JS heap, and frame times that are higher on Low and in a car (software GL also pays the PBR shading in the CPU-side numbers here). Real-GPU frame times are still unmeasured.
- **Screenshots** (in-game, 1280x720, Medium unless named, final build): `34-stage1-keybridge` (on the deck), `34-stage1-mst-lunch`, `34-stage1-rowhouses` (29th St), `34-stage1-circle-traffic` (Washington Circle), `34-stage1-waterfront`, `34-stage1-stair-f4` (a stair with the F4 collision view), `34-stage1-night` (M St at 21:36), `34-stage1-f3` (the overlay: its spike counter shows the software-GL frames of the screenshot run, 40 s each under load), `34-stage1-minimap`, `34-stage1-quality-{low,medium,high}` (M St).
- **Known issues after the integration** (places in `docs/m3-suspicious-areas.md`, part 0):
  - 6 of 85 real stairs are not walkable end to end; `physaudit` is not clean on the real map (504 + 140); `fallthrough` 1 hover in 1,303.
  - AI traffic: 5 wrong-way moves per gate drive (the gate wants 0), 23 AI contacts; mapcheck's drive part fails about 2 runs in 3.
  - Road smoothness still over the limits in places (roadaudit above); `roaddrive` not re-run.
  - The starting car hits a pole within 20 m of the spawn; the kerb by the spawn sits 0.39 m below the road.
  - The `crowd` scenario's switch to High gets the browser's renderer killed for memory in this container (also on s1-look alone); the High preset bakes 289 MiB of surface maps.
  - Synthesized street trees on M St and Wisconsin Ave are not moved to the kerb strip on real data: 136 trees and 60 posts stand within a person's reach of a walk link (none blocks a walkway).
  - The taxi can name a destination's street as "Georgetown" when the place has none.
  - Boot is 3-4 times slower than main (texture bake, bigger real map, three times the colliders); Stage 1 costs more draw calls, triangles, heap and frame time than main; real-GPU numbers are still unmeasured.
