# Open City improvement checkpoint — 2026-11-07

Source: owner's pasted request. Preserve Three.js/Rapier/Vite, current features, existing browser settings and progress. No paid services.

## Inspection and implementation plan

- Placement: corner/midpoint sampling and concave roof/hull approximations can cross roads and other footprints. Use polygon envelopes, exact clipping and matching colliders; largest risk is preserving usable real-map footprints.
- Recovery: `max(currentY, groundY) + 1.2` stacks altitude. Anchor recovery to valid ground, clear velocity/forces, require deliberate edge input and cooldown.
- Movement/camera: raise walking/sprint tuning, couple heading/view, fix inconsistent clock and focus clearing; add V first/third-person views with obstruction handling.
- Roads/performance: profile a baseline first; inspect asphalt aggregate, colour spaces and shared material program churn. Keep comparable measurements and distinguish software rendering from hardware.
- Interiors: deterministic marked door transitions to physical furnished rooms with solid floors/walls/stairs. Integrate the existing player and items; do not promise all real-map buildings are enterable.
- Persistent activities: extend the existing item instances/hotbar, add inspect/use, versioned local saves, repeatable jobs and apartment transactions/storage, with witnessed theft/trespass and existing police pursuits.
- Delivery: production build/browser smoke tests, GitHub branch/PR and hosted build if available; no hosting purchases.

## Tracking

| # | Item | Implemented | Tested | Blocked / limitations |
|---|---|---|---|---|
| 1 | Footprint/road/building overlap rules and existing placements | yes | Full 4,713-footprint audit: zero overlaps, roof/collider errors | Drops 93 unusable fragments/duplicates; terrain/bridge layers retained |
| 2 | R recovery exploit | yes | 120 rapid taps + hold, real flat/slope/building poses | Rejects recovery if no clear nearby pose |
| 3 | Faster walking, sprint, fixed-step heading movement | yes | 30/60/120 fps, same 120 physics ticks, 11.0–11.1 m/2s walking vs 17.2 m sprint | Setup teleports settled before measurement |
| 4 | Camera controls, focus, help | yes | Keyboard/mouse heading, view/vehicle transitions, blur release | Pointer lock fallback is right-button drag |
| 5 | Day/night asphalt | yes | Day/night vehicle/asphalt screenshots and shader checks | Procedural art; colour-space and roughness kept coherent |
| 6 | Measured performance fixes | yes, targeted | Isolated comparison: sampled allocation 335→261 KB/frame; CPU median 18→6.8 ms | Software GL stalls remain. Real GPU and chat preview comparison unavailable |
| 7 | Vehicle classes, detail, wheels, driving interiors | yes | All six classes: finite geometry, driver eye/forward sightlines, moving steering; live car view test | Procedural models, simpler parked/traffic LOD |
| 8 | Coherent world visual improvement | incremental | Car/asphalt shots, exact building roof geometry, production browser rendering | Existing people/nature remain procedural; not photorealism |
| 9 | Furnished physical interiors, doors, stairs | six marked sites | Real Rapier floor/wall/door tests in all six; office/apartment stairs up and down; game entry/exit | Door transitions to separate physical rooms, not every imported facade. Old outdoor stair audit has unresolved cases, not claimed fixed |
| 10 | First/third person walking/driving | yes | Both modes, actual driver eye and indoor chase bounds | Hardware/trackpad device feel still needs user feedback |
| 11 | Reusable pickups, inspection/use/drop/save | yes | Identity/weight/size/theft/use/duplication tests; actual browser IDB reload and production game pickup | Eight catalogue object types plus owned/sealed stock; fixed decorative furniture is not universally dismantlable |
| 12 | Several jobs, interior objectives, payouts | four added + taxi retained | Warehouse $50, cleaning $40, repairs $65, delivery $55; exact payouts and repeated E rejects | No new story campaign |
| 13 | Buy/rent apartments and persistent storage | yes | Rent charged once; same-ID storage deposit/retrieval/reload | $90/7 days prepaid, no recurring debit; buy $1,800. Buy/insufficient funds/expiry/duplicate paths tested in transaction fixture; browser covers rent |
| 14 | Shop theft/trespass, existing vehicle theft/pursuit | yes | Production shopkeeper report: heat 18; real unseen pursuit countdown resolves to zero; trespass grace/one-shot report fixture passes | Fixed interior staff/security witnesses; exterior NPC witnesses retained |
| 15 | Production standalone build/deployment | published privately | Production build and standalone Chromium game flows; Sites reports succeeded | GitHub integration cannot enable Pages (403); Sites used instead |

## Required full-flow checks

- [x] Walk → enter → collect → exit → save/reload.
- [x] Enter car → switch view → drive → hold/repeat R → exit (flat/slope/building).
- [x] Job start → all objectives → one correct payout → repeat.
- [x] Apartment rent/buy → store → leave/reload → retrieve.
- [x] Crime → wanted/pursuit → resolve.
- [x] Several city areas: buildings, roads, stairs; browser errors; before/after profile.


## Reproduction and evidence

Run `npm run build`, `npm run test:systems`, `npm run test:placement`, `MAP=georgetown npm run test:controls`, `npm run test:gameplay`.
The controlled distance platform isolates physics from live street contacts; recovery tests use real map roads/terrain/buildings.
Production gameplay setup teleports locations, then exercises the real E/item/objective/transaction/police paths. The reload preserves $270,
four completed jobs, the apartment lease and the same stored collectible ID, with 100 health and a clean console.
See `docs/verification/` for raw before/after profiles and `screenshots/` for browser JSON/screenshots.

### Remaining verification limits

- No hardware GPU or access to Claude's preview process: cannot promise 60 FPS or compare wrappers.
- The broad outdoor stair/road-smoothness/traffic audits from the prior integration remain imperfect; this change validates footprint placement,
  new interior stairs, ground recovery and the listed game flows. It does not claim every outdoor terrain defect is resolved.
- Full map art is still procedural. Six marked interior sites are supported, not all 4,713 imported buildings.
- Browser-local saves belong to each site origin, map and seed; moving the website does not migrate IndexedDB automatically.


## Published checkpoint

Playable private Site: https://open-city-play-benjiang.benjiang968.chatgpt.site . Sign in as the owner.
Sites saved/published source commit `b58a513fc629b66bb7aebed822adf1da391bbc9c`, deployment
`appgdep_6aef225a51d481919d10acd293e7e0bf`, returned `succeeded` on 2026-11-07.
Native deployment success verifies publication; automated game flows were tested against the identical local static production output,
not against an authenticated hosted browser session. GitHub review branch carries the code plus final verification notes.

Final integrated Low production profile (software GL, 480×270, seed123, 120 frames): CPU median6.6ms,
p90 33.8ms, sampled allocations249KB/frame,120 calls/614K triangles,338MB JS heap; worst software render stall1.39s.
Startup39.7s, map build22.7s. This final Low sample is not comparable to the isolated Medium comparison above.
