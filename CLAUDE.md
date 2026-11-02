# WORKING TITLE: Open City (rename me)

## What this game is
A browser-based open-world sandbox in the spirit of GTA free-roam, with NO story, NO cutscenes and NO scripted missions. The city, its economy and its people ARE the game. The player is dropped into a coastal city with a little cash and total freedom. Everything you do earns, costs or changes something.

## Design pillars (check every feature against these)
1. Freedom first. The player chooses what to do; the game never forces a path.
2. Driving and boating must feel great: responsive, weighty, fun to drift and dock. Vehicle feel is the number one polish priority.
3. Many ways to earn money, legit and risky, on land and water. Money buys vehicles, property and access, which opens more ways to earn.
4. A living world of small details: NPC routines, traffic, weather, day and night, shops that open and close, things that react to the player.
5. Talk to anyone. Every NPC can be approached and spoken to in free text. They remember you and can offer work, refuse, gossip or call the police.

## Non-goals
- No story campaign, no cutscenes, no trailer-style intro. The game opens straight into the world.
- No copying names, logos, maps, characters or assets from any existing game. All content is original.
- No photorealism. Clean, colourful low-poly built in code.
- No multiplayer in v1.

## Core loop
Explore -> spot an opportunity (NPC, notice board, phone, world event) -> do it (drive, boat, walk, deliver, race, tow, fish) -> get paid -> spend (vehicles, upgrades, property) -> more of the city and more jobs open up.

## Money systems (roadmap, build in this order)
1. Taxi: pick up an NPC, drive to their destination, paid by distance and time. [Day 1]
2. Courier: package from A to B, bonus if undamaged. [Day 1 if time]
3. Boat taxi across the bay. [Day 2]
4. Towing: find broken-down cars, tow them to a garage.
5. Fishing: from the pier or a boat, sell the catch at market; prices move with supply.
6. Street racing: entry fee, winnings, police attention.
7. Scrap and salvage: wrecks you cause become sellable salvage.
8. Property: buy a garage, then a shop; passive income and upgrades.
9. Risky work: night smuggling runs by boat; high pay, high police heat.
Each system lives in its own file under src/systems/economy/ and registers with a JobManager. All payouts and prices live in src/tuning.ts.

## NPC system
- Every NPC has: name, job, home, daily routine, mood, a relationship score with the player (-100 to 100), and a memory of the last 5 notable things the player did near them.
- Walk up and press E to talk. The player types free text. The NPC replies with text AND an optional structured action: offerJob, acceptRide, refuse, giveTip, callPolice, trade.
- Dialogue goes through a provider interface in src/npc/providers/. V1 uses ScriptedProvider: hand-written personality templates plus keyword matching, zero API cost. An LLMProvider (Claude or OpenAI) is added later behind a small server proxy. Never put an API key in client code.

## World
- A coastal city generated from a fixed seed: downtown grid, beach strip, marina, industrial dock, highways between them. V1 is one district of roughly 1 km squared; the generator must be able to scale 10x later.
- Day and night cycle (24 real minutes = 1 game day), weather (clear, rain), traffic AI on a road graph, pedestrians with routines.
- Police respond to crime with a heat level of 1 to 5 stars. They lose you when you break line of sight and change vehicle.

## Tech stack (do not change without asking)
- TypeScript, Vite, three.js, Rapier physics (@dimforge/rapier3d-compat). No game framework on top.
- All art generated in code (BufferGeometry, simple materials, vertex colours). No downloaded models or textures in v1.
- Must hold 60 fps at 1080p in Chrome on a mid-range laptop.
- Desktop keyboard and mouse first. Touch controls come later; do not block them architecturally.
- Static build (npm run build) deployable to GitHub Pages with npm run deploy.

## Code rules
- One system per file under src/systems/. Shared state in a typed World object. No globals.
- Every tunable number (speed, grip, payouts, prices, spawn rates) lives in src/tuning.ts with a comment. Never hard-code a gameplay number anywhere else.
- Keep the game playable after every change. If a change breaks play, revert it.
- F3 toggles a debug overlay: fps, player position, vehicle speed, current job, heat level.
- The world seed comes from the URL (?seed=123) so bugs can be reproduced.

## Working agreement with Claude Code
- Before anything bigger than a tweak: write a short plan (files, steps, biggest risk), ask at most 5 questions, then build.
- After each feature: run npm run build, open the game in a headless browser (Playwright), save a screenshot to /screenshots/, check the console for errors, fix what you see, then report.
- Keep DEVLOG.md updated: date, what changed, what to test, known issues.
- Commit after each working feature with a clear message.
- When feedback arrives as a measurement ("car spins out above 80 km/h"), change only the named tuning value. Do not refactor unrelated systems.
