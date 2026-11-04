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
