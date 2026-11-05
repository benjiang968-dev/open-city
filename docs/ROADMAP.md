# Open City roadmap

Source: the owner's master prompt of 2026-11-05 ("Open City — complete open-world game development master prompt"), merged with the earlier milestone plan. Status values: **done**, **partial**, **not started**. Keep this honest; DEVLOG.md has the details and test steps.

## Where the project stands (2026-11-05)

| System | Status | Notes |
|---|---|---|
| Rendering | partial | three.js with a procedural PBR material system (27 surfaces baked on the GPU at boot, world-space projection, per-building variation), physically based sky with sky light (PMREM), a sun with two shadow cascades, ACES tone mapping, reflective water and glass with lit rooms behind it, street-lamp lights at night, wet streets in the rain, Low/Medium/High presets (src/systems/render/). Shapes of buildings, cars and people are still low-poly; no screen-space AO; real-GPU frame times not yet measured. |
| Physics | partial | Rapier. Raycast vehicles, kinematic character controller (autostep 0.45 m, slope 50°), static colliders per 120 m chunk, thrown items as dynamic bodies. Stairs collide as smooth ramps; some stair-like geometry (stoops, entrance steps) may have no collider (owner reports walking through stairs). No physics debug view. |
| World | partial | Georgetown map from a hand-authored knowledge spec (20 to 80 m error), world generator v2 (terrain, roads, kerbs, sidewalks, junctions, Key Bridge, Whitehurst Freeway, canal, waterfront, ~4,000 buildings with facades, props, trees). Grid city at ?map=grid. |
| Traffic and police | partial | Lane graph with one-ways, signals, stop signs, roundabout yield, lane changes; police dispatch and search on the graph; heat 1 to 5 stars. No arrests, fines or jail yet. |
| People | partial | Instanced crowd with busyness-based density, dog walkers, joggers, kids (invulnerable), witnesses who call 999, film, flee or confront. |
| NPC talk | partial | Free-text chat with ScriptedProvider, relationship score, memory of 5 events, gossip. No long-term memory, relationship states or schedules worth the name. LLMProvider stub only. |
| Items | partial | Hotbar of 9, a short list of item types (E pick up, Q drop, throw, melee). Not universal, no weights, no containers, no persistence. |
| Economy | partial | Taxi job, car dealerships, car theft with owners and alarms. |
| Map | partial | Minimap with street labels and markers. No big map, search or GPS. |
| Saves | not started | Only the quality setting is stored (localStorage). |
| Interiors, needs, homes, restaurants, shops, jail, phone, cutscenes | not started | |

## Stages

Stages follow the owner's implementation order. Each stage ends with build, Playwright screenshots, console check, DEVLOG, a playable published build and a status update here.

### Stage 1: fix the foundation
1. **Stairs and collisions** (priority). Audit every solid thing in the world against its collider: stairs of every kind, stoops and entrance steps, landings, railings, parapets, walls, benches, bins, lamps, signal poles, trees, monuments, piers, fences. Fix the character controller (grounding, step climbing, slopes, jumping, never falling through). F4 physics debug view. Automated stair tests. *Status: in progress.*
2. **Real 1:1 map data.** Replace the knowledge-based Georgetown with real data: Overture Maps (roads with names, classes, one-ways, bridges and levels; sidewalks, crossings, steps and paths; building footprints and heights; places by category; water and land use) and real terrain from public elevation tiles. About 2 x 2 km with a clean edge. Real street names, invented shop names. Attribution in the pause menu and README. *Status: in progress.*
3. **Roads and terrain.** Correct widths and lane counts, logical connections, crossings, signals, parking, alleys; smooth drivable road surfaces with no artificial bumps or broken seams; keep natural hills off the road. *Status: in progress (with item 2).*
4. **PBR look.** A material system with procedural PBR textures (asphalt, worn markings, concrete, Georgetown brick sidewalks, granite kerbs, brick in several bonds and colours, painted brick, stone, stucco, clapboard, slate and metal roofs, glass with reflections, window frames, metal, wood, grass, bark, cobbles and old tram tracks), image-based lighting from the sky, filmic tone mapping, soft shadows that cover the city, fog and haze, night lighting, Low/Medium/High presets, no repetition across buildings. *Status: partial. Done: material system with 27 procedural surfaces (src/systems/render/), PBR on roads, markings, sidewalks, kerbs, terrain, lots, facades (three brick bonds, painted brick, stucco, clapboard, ashlar per building), roofs (slate, standing seam, tar), windows (sky reflections, interior-mapped rooms, lit at night), props, two-level trees, water, bridges, the grid city, cars (clearcoat paint, glass, tyres, hubs) and people (cloth sheen); Preetham sky + PMREM sky light refreshed on sun movement; two-cascade soft sun shadows; night lamp lights; rain wetness and puddles; presets with texture resolution, shadow reach, near trees and lamp lights; draw warm-up at boot. Open: no screen-space ambient occlusion; frame times on a real GPU unmeasured (only software GL here); building, car and people shapes unchanged; distant leaf cards shimmer.*
5. **Research.** Google Photorealistic 3D Tiles (licence, attribution, billing, technical fit), OpenStreetMap vs Overture, texture sources. Written to docs/research/. *Status: in progress.*

### Stage 2: make the world interactive
Universal object components (static / dynamic / interactive); dynamic props that sleep and activate near the player; universal pickup and drop (E, G) for anything loose and hand-sized; inventory screen (I) with icons, categories, weight and size limits, stacking, inspect, use, containers; the held item visible in the hand; persistent object ids and transforms; save system (IndexedDB, versioned, migrations); ownership (player, NPC, business, public); reusable building entrances and procedural interiors (deterministic per building id, multi-floor, colliding stairs, furniture, shelves stocked with products). *Status: not started (current hotbar items are the seed of it).*

### Stage 3: make the city navigable
Minimap upgrade (orientation, nearby roads, destination, businesses), big map on M or minimap click (zoom, pan, names, search, click buildings and businesses, favourites, home, set and clear destination), GPS routing on the road graph (driving) and walk graph (walking) with re-routing; routes drawn only on the maps. *Status: not started (minimap and both routers exist).*

### Stage 4: make the city alive
NPC personalities, interests, jobs, homes and workplaces; daily schedules (work, home, shops, meals, sleep, meeting other NPCs) with cheap off-screen simulation; short- and long-term memory with summaries; relationship states (stranger, acquaintance, friend, close friend) that grow from varied interactions, not repetition; NPCs who recognise you and start conversations; offline ScriptedProvider upgraded to use memory; optional LLMProvider behind a server proxy only with the owner's permission. *Status: partial (chat, score, 5 memories).*

### Stage 5: daily life
Health, hunger, energy and money in a clean HUD; hunger and tiredness that nudge but never block; sleep suggestion; starting home (sleep, store items, furniture, decorate); renting or buying property; restaurants (menu, order, pay, eat animation, hunger restored; different menus, prices, interiors, hours); shops and supermarkets with physical products, checkout and receipts; business opening hours. *Status: not started.*

### Stage 6: consequences and activities
Wanted levels with clear transitions; police on foot and in cars; arrest interaction (short non-graphic sequence, also from inside a vehicle); fines scaled to severity and finances; jail as a separate scene (cells, corridors, yard, NPCs, sentence timer, simple activities, release back to the city, optional fictional puzzle escape); shoplifting and trespass as crimes; death ends the run: standard mode with checkpoints, hardcore mode; optional jobs (taxi, deliveries, restaurant work, office job with a maths test, errands, vehicle challenges, property management); short skippable contextual animations. *Status: partial (heat, police chase, witnesses, taxi, death screen).*

### Stage 7: polish
Performance (streaming, LOD, compression, pooling, activation zones), graphics and audio, environmental detail (signs, crossings, street furniture, ambient sound), expanding the city beyond 2 km with coherent procedural surroundings, persistence and integration testing. In-game phone (contacts, messages from NPC friends, maps and GPS, jobs, money, notifications). *Status: not started.*

## Required integration tests (from the master prompt)
1. Physics: stairs, floors, rooms, objects without falling through. (Stage 1-2)
2. Pickup: bottle from a shop shelf to inventory, outside, drop with working physics. (Stage 2)
3. Persistence: book on a table survives save and reload in place. (Stage 2)
4. GPS: map, pick a restaurant, follow the map-only route, arrive. (Stage 3)
5. Buildings: residential and commercial entrances, stairs, rooms, collisions. (Stage 2)
6. Restaurant: order, pay, eat animation, hunger and money change. (Stage 5)
7. NPC memory: talk, leave, return, they remember. (Stage 4)
8. Day/night: night, sleep suggestion, go home, sleep, time and energy change. (Stage 5)
9. Police: wanted event, arrest, penalty, jail and back to the city. (Stage 6)
10. World performance: drive several neighbourhoods and enter buildings with no streaming stalls, missing geometry or broken physics. (every stage)

## Decisions taken (owner can overturn)
- **Map data: Overture Maps + public elevation tiles.** OpenStreetMap and Overpass are blocked from the build container, but Overture's open data (OSM-derived roads and buildings, ODbL; places CDLA-Permissive-2.0) and AWS Terrain Tiles are reachable, so Georgetown becomes real geometry. The knowledge-based generator stays as a fallback.
- **Textures generated in code for now.** CC0 texture sites (ambientcg.com, polyhaven) are blocked by the container's network policy. Procedural PBR maps are original by construction; CC0 photo textures can be added if the owner allows those hosts.
- **Google Photorealistic 3D Tiles: research only.** They need a Google Cloud billing account and an API key served to the browser, mandatory Google attribution, no caching or extraction, and the mesh has no separate buildings, doors or collision meaning. Not used for gameplay; at most an optional viewer later, only with the owner's explicit go-ahead. Full write-up: docs/research/.
- **Interiors in place.** A building's interior is generated inside its own footprint when the player approaches its door (deterministic from the building id), so doors line up with the street and no loading screen is needed; one or two interiors exist at a time.
- **Controls change.** M opens the map (mute moves to the pause menu), G drops (Q stays as an alias), I opens the inventory.
- **No paid APIs.** NPC conversations stay offline (ScriptedProvider) until the owner approves an LLM provider and a small proxy server.

## Open questions for the owner
1. Allow the CC0 texture hosts (ambientcg.com, dl.polyhaven.org, api.polyhaven.com) in the environment's network settings for photo-based textures?
2. Later (Stage 4): approve an LLM provider and a tiny server proxy for NPC conversations (it costs money per conversation), or stay offline?
3. Should the city stay Georgetown and grow outward (Burleith, Foggy Bottom, Rosslyn across the river), or would you like a different real district?
