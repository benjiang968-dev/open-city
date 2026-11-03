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
