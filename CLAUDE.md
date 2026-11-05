# WORKING TITLE: Open City (rename me)

## What this game is
A browser-based open-world life sandbox in the spirit of GTA free-roam crossed with a life simulator, with NO story campaign and NO compulsory missions. The city, its economy and its people ARE the game. The player starts in a realistic, 1:1-scale city district (Georgetown, Washington DC) with a home, a little cash and total freedom. Almost everything solid is solid, almost anything hand-sized can be picked up, every building can be entered, and the world remembers what you did. Everything you do earns, costs or changes something.

The full phased plan, its status and open decisions live in docs/ROADMAP.md. Read it before starting a stage.

## Design pillars (check every feature against these)
1. Freedom first. The player chooses what to do; the game never forces a path. Needs (hunger, energy) nudge, never block.
2. Driving and boating must feel great: responsive, weighty, fun to drift and dock. Vehicle feel stays the number one polish priority.
3. Many ways to earn money, legit and risky. Money buys food, goods, vehicles and property, which opens more ways to earn.
4. A living world of small details: NPC routines, traffic, weather, day and night, shops that open and close, things that react to the player.
5. Talk to anyone. Every NPC can be approached and spoken to in free text. They remember you across days, form relationships, and can offer work, refuse, gossip or call the police.
6. Real systems, not fakes. Solid things collide; loose hand-sized things can be picked up, carried, stored and dropped as the same physical object; doors open; shelves hold real products with prices and owners. No decorative buttons or placeholder animations standing in for gameplay.
7. The world remembers. Inventory, moved objects, property, relationships, NPC memories and game time persist across sessions.

## Non-goals
- No story campaign, no trailer-style intro. The game opens straight into the world. Short contextual animations (3 to 5 s, always skippable: eating, sleeping, arrest, arriving at jail, finishing a job) are allowed; long or story cutscenes are not. (Changed 2026-11-05 at the owner's request; previously "no cutscenes".)
- No copying names, logos, maps, characters or assets from any existing game. Real street names are kept; real business names and brand colours are never used (shops get original names from src/data/poiNames.ts).
- No Google Maps imagery or 3D models extracted, scraped or repurposed as game assets.
- No graphic gore and no realistic weapon or escape procedures; action and crime stay stylised and fictional.
- No multiplayer in v1.

## Look
- A believable, realistic contemporary city, on a browser budget: physically based materials (base colour, normal, roughness), image-based lighting coordinated with the sun, soft shadows, natural exposure and tone mapping, weather and night lighting. Models matter as much as textures: human characters with skeletal animation (idle, walk, run, jump), vehicles with real proportions, wheel arches, windows, lights and interiors, trees with connected trunks and foliage, and facades with real depth (recessed entrances, window frames, roof details, varied ground floors). (Changed 2026-11-05 at the owner's request, twice: previously low-poly vertex colours, then code-generated art only. There is no low-poly or code-only requirement any more.)
- Assets may be generated in code or downloaded: properly licensed textures, models, HDRIs and animations are welcome (CC0 preferred; CC BY, MIT and similar permissive licences allowed with the required credit and licence notice). Never use assets with an unclear licence, ripped from games, or taken from Google Maps. Every downloaded asset is recorded in ASSET_SOURCES.md (exact source URL, author, licence, date fetched, what it is used for, any changes made). Assets ship inside the build (no run-time fetch from third-party hosts) so production loading is reliable.
- Use a small shared library of good textures and modules reused everywhere, scaled by physical size (a brick is a brick everywhere), rather than huge unique textures per object. Correct colour spaces, mipmaps, filtering and anisotropy; distant surfaces must look stable, never like television static.
- Never hide visual problems with heavy fog, bloom, blur, film grain or darkness; fix the cause.
- Graphics quality presets (Low, Medium, High) in the pause menu; Low must stay smooth on a mid-range laptop.

## Core loop
Explore -> spot an opportunity (NPC, notice board, phone, world event, shop, need) -> do it (drive, walk, deliver, shop, cook, work, race) -> get paid or fed or rested -> spend (food, goods, vehicles, property) -> more of the city and more activities open up.

## Money systems
Taxi (done), courier, restaurant and shop work, deliveries, office job with a maths test, towing, fishing, street racing, salvage, property income, risky night runs. Each system lives in its own file under src/systems/economy/ and registers with the JobManager. All payouts and prices live in src/tuning.ts or in data files under src/data/ (item catalogue, menus).

## NPC system
- Every NPC has: name, job, home, workplace, daily schedule, personality, interests, mood, a relationship with the player (score -100 to 100 plus a state: stranger, acquaintance, friend, close friend), short-term memory (recent events) and long-term memory (summarised facts from past conversations and deeds).
- Walk up and press E to talk. The player types free text (quick-reply buttons for touch). The NPC replies with text AND an optional structured action: offerJob, acceptRide, refuse, giveTip, callPolice, trade, sell, invite.
- Dialogue goes through a provider interface in src/npc/providers/. ScriptedProvider (personality templates, memory-aware, zero cost) is the always-available offline fallback. An LLMProvider (Claude or OpenAI) may be added only with the owner's permission, behind a small server proxy. Never put an API key in client code. Do not introduce paid APIs without permission.
- Distant NPCs run a cheap schedule simulation; only nearby NPCs are fully simulated.

## World
- Georgetown and the Potomac waterfront, Washington DC, at 1:1 scale (1 unit = 1 m), about 2 km across, built from legal open data: road network, sidewalks, buildings and places from Overture Maps (OpenStreetMap-derived, ODbL; places CDLA-Permissive-2.0) and terrain from public elevation tiles, with attribution in the pause menu and README. The older hand-authored approximation (scripts/georgetownFromSpec.mjs) and the grid city (?map=grid) remain as fallbacks.
- The generator (src/systems/map/) turns the data into roads with lanes, kerbs, crossings, signals, parking, terrain, water, bridges and buildings with facades. Roads are smooth enough to drive; terrain keeps its natural hills.
- Every building has a working entrance and a deterministic interior generated from its persistent building id (same layout on every visit): real doorway openings with doors that open and close, rooms, floors, ceilings, furniture, interior lighting and reachable stairs to usable upper floors, fitted to the footprint, the exterior's floor heights and the terrain. Building collision is walls, floors, door frames and openings, never one solid box over the footprint. Interiors (and their collision) are built near the player before they can reach the door, and are never unloaded from under the player or an active object.
- Day and night cycle (24 real minutes = 1 game day), weather, traffic AI on the road graph with signals and the roundabout rule, pedestrians on the walk graph with routines, shops and restaurants with opening hours.
- Police respond to crime with a heat level of 1 to 5 stars. They lose you when you break line of sight and change vehicle. Caught: fine or arrest; serious or repeated offences mean jail, a separate scene.
- GPS routes are drawn ONLY on the minimap and the big map. Never place route lines, arrows or markers in the 3D world for navigation.

## Objects, items and persistence
- Three object classes through one component registry: static (roads, buildings, stairs, fixed structures: accurate static colliders), dynamic (loose props: Rapier bodies that sleep and are only simulated near the player), interactive (doors, drawers, cupboards, switches, appliances, beds, counters).
- Items are data-driven: one catalogue of item definitions (name, icon, category, mass, size, stack size, value, use effect) and many item instances (persistent id, definition, owner, container, transform, condition). One pickup / drop / store code path serves every instance; never write a per-product script.
- If a loose object is small and light enough to hold in one hand, it should be pickable. Picking it up removes it from the world; dropping it puts the same instance back with physics.
- Ownership: player, NPC, business or public. Buying transfers ownership; leaving a shop with unpaid goods is a crime the witness and police systems handle.
- Saves are versioned with migrations (IndexedDB, with localStorage only for settings). Persist player state, inventory, moved objects, property, NPC memories and relationships, completed activities, game time and world changes.

## Controls (keyboard and mouse first; touch must stay possible)
- WASD / arrows move or drive, Shift run, Space jump / handbrake, mouse look (click to lock).
- E interact: enter or leave a car, talk, pick up, open doors, use furniture, buy at a counter.
- I inventory (mouse to select, inspect, use, move between containers), G drop the held item, 1-9 or wheel hotbar, left click use / throw / swing.
- M or clicking the minimap opens the big map (search, destinations, GPS). Mute lives in the pause menu.
- F3 debug overlay; F4 physics debug view (collision shapes near the player). Esc pause.
- The full controls list lives in the pause / help panel. During play the HUD shows only short contextual prompts ("E open door", "E pick up bottle").

## Tech stack (do not change without asking)
- TypeScript, Vite, three.js, Rapier physics (@dimforge/rapier3d-compat). No game framework on top.
- Static build (npm run build) deployable to GitHub Pages with npm run deploy. Anything needing a server (an LLM proxy) is optional and off by default.
- Must hold 60 fps at 1080p in Chrome on a mid-range laptop on the Medium preset: chunk streaming, LOD, instancing, frustum culling, texture compression, physics activation zones and NPC simulation distance are how we pay for the look.
- Desktop keyboard and mouse first. Touch controls come later; do not block them architecturally.

## Code rules
- One system per file under src/systems/. Shared state in a typed World object. No globals.
- Every tunable number (speed, grip, payouts, prices, spawn rates, needs rates) lives in src/tuning.ts with a comment, or in a typed data file under src/data/. Never hard-code a gameplay number anywhere else.
- Keep the game playable after every change. If a change breaks play, revert it.
- F3 toggles a debug overlay: fps, player position, vehicle speed, current job, heat level, people target/active.
- The world seed comes from the URL (?seed=123) so bugs can be reproduced. The seed may vary cars, people, shop names and interiors' contents, never the map.
- Do not run two incompatible versions of a system (rendering, physics, AI, saves). Extend the existing one or replace it fully.

## Working agreement with Claude Code
- Before anything bigger than a tweak: write a short plan (files, steps, biggest risk), ask at most 5 questions, then build.
- After each feature: run npm run build, open the game in a headless browser (Playwright), save a screenshot to /screenshots/, check the console for errors, fix what you see, then report.
- Keep DEVLOG.md updated: date, what changed, what to test, known issues. Keep the status column of docs/ROADMAP.md honest (done / partial / not started).
- Commit after each working feature with a clear message.
- When feedback arrives as a measurement ("car spins out above 80 km/h"), change only the named tuning value. Do not refactor unrelated systems.
- Never claim something was tested if it was not; say what is complete and what is partial.
