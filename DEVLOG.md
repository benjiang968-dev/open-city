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
