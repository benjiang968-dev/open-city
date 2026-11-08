# Open City — implementation and verification checkpoint

Source: the owner's complete pasted request. Three.js/Rapier/Vite are retained. The implemented scope and evidence are recorded below; hardware-GPU performance and comparison with the Claude preview cannot be verified in this environment.

## Checklist

| # | Request | Implemented | Tested | Limits / blocked checks |
|---|---|---|---|---|
| 1 | Buildings, roads, pavements and entrances | Exact oriented footprint clipping against roads, corner pavements, paths and neighbours; matching concave roofs/collision; safe stoop rules | All 4,713 source footprints: 4,620 retained, 1,972 clipped, 93 unusable fragments/duplicates omitted; zero remaining overlaps or roof/collider decomposition errors | Numeric tolerance is 0.0001 m²; bridge-height solving preserves valid buildings below decks |
| 2 | R car flying exploit | Absolute supporting-ground recovery, rotated chassis clearance, motion/force/wheel reset and cooldown | 120 rapid taps plus holding R, flat terrain, a roughly 25% slope and building edge; no cumulative altitude | Recovery is refused if no nearby valid pose exists |
| 3 | Faster walking | 5.8 m/s walk, separate sprint, acceleration, fixed physics steps; turning adds no diagonal translation | 30/60/120 simulated fps; 120 physics ticks, about 11 m in 2s walking versus 17 m sprint | Discrete collision-controller settling accounts for small fixture variation |
| 4 | Consistent controls and help | A/D turns view and heading on foot; driving steers independently of mouse look; focus/visibility release; compact HUD and full Esc help | Combined keyboard/mouse heading, blur, V/E entry/exit, steering and view transitions | Physical trackpad/device feel is unverified |
| 5 | Asphalt appearance | Lower aggregate contrast/normal strength, coherent linear colours, matte dry asphalt and restrained wet gloss | Day/night visual fixtures and shader tests | Procedural materials remain |
| 6 | Profile and improve lag | Separate material variants reduce churn; cached physical sky, amortized captures, truthful FPS measurement and loading stages | Comparable allocation 335→261 KB/frame; isolated sky pass 5.8→2.7 ms; 18-view sky parity ≤1/255. Slower shader experiments rejected | Full-city SwiftShader rendering remains slow. No whole-game FPS improvement or hardware 60 FPS claim; actual device GPU and Claude preview comparison blocked |
| 7 | Distinct vehicles and cabins | Hatchback, saloon, SUV, van, sports car and pickup; wheels/steering, mirrors/lights/body details, seats/dashboards/driver eyes and differing handling | All six finite models and driver sightlines; actual first/third-person driving and steering | Parked/traffic LOD is simpler. Fresh starting sedan drives 25m with 120/120 health |
| 8 | Coherent world visuals | Shaped human faces/hands/shoes/clothing and connected vegetation, improved vehicles/asphalt and exact building roofs | 1.78m people, 1,584 triangles/person, five player draw calls, 60 people/nine instanced body batches; near trees ≤414 triangles; inspected screenshots | Original procedural art is stylized, not photorealism or imported Google imagery |
| 9 | Furnished enterable buildings | Fourteen marked shops, offices, warehouses, workshops, cafés and apartments; physical furniture, hinged doors, floors and stairs; rooms persist after exit | All 14 room variants' collision; 272 goods rest on actual support surfaces; all 85 outdoor stairs up/down (170 traversals), zero measured penetration and console errors | Marked entrances use explicit room transitions; unmarked imported facades remain scenery |
| 10 | Both camera views | V switches foot/car views; real eye/driver positions, smooth follow, collision, indoor bounds and close-body hiding with hysteresis | Outdoor and indoor first/third-person transitions; near-camera body hiding and return to third-person visibility | Camera remains within active room bounds even at an open portal |
| 11 | Reusable inventory and pickups | Fifteen catalogue types, 272 physical room goods plus street objects; names/descriptions/icons; size/mass eligibility, inspect/use/drop/store; stable IDs and authored keys | Identity, limits, food/drink once, book/phone use, unpaid-use report, no duplicate seeding, real IDB reload/migration | Nine slots / 12kg; fixed structures are not loose portable items |
| 12 | More jobs | Four spatial shifts (delivery, cleaning, repairs, warehouse) plus existing taxi; objectives, supplies, progress and payouts | All four complete in production at exact pay ($55/$40/$65/$50), repeated E guards; a repeated warehouse shift at a second workplace reuses IDs and pays once; cancellation pays nothing | Work is optional sandbox activity |
| 13 | Buy/rent apartments | Four separately priced furnished homes, purchase/prepaid lease, independent persistent storage | Full browser rent/store/reload/retrieve, second home and book persistence, buy/funds/expiry/duplicate transaction fixtures | Leases $81–$117 for 7 game days, no automatic renewal; buy $1,620–$2,340. Original home remains $90/$1,800; 18 storage slots/home |
| 14 | Fictional crime and consequences | Existing vehicle theft, unpaid shop goods/food, warned warehouse trespass, staff/NPC reports, wanted level and pursuits | Production shop report raises heat18; real unseen countdown resolves pursuit; paid food causes no report; trespass grace and one-shot reporting tested | Interior staff/security reports use the real exterior entrance location |
| 15 | Standalone website and saves | Static production build, versioned browser-local IndexedDB, upgrade preservation | Production build, complete game reloads and actual published-v1 → new build → second reload; cash, NPC relationship, lease, item450 and first20 parked IDs/types/positions retained; new goods appended once | Updated publication pending final packaging; hosted access remains owner-private. No account/device/origin save sync |

## Full flows verified

- Walk/interact → enter → collect/use → exit → save/reload.
- Enter car → both views → steer/drive → rapid/held R → exit, with flat/slope/building recovery.
- Four jobs → physical objectives → exact single payouts; repeat work in a second building without cloned supplies.
- Lease → store → leave/reload → retrieve the same item; second home storage remains separate.
- Paid food → consume once without crime; unpaid merchandise → wanted/pursuit → resolve.
- Published v1 save → upgraded game → save/reload: $710, NPC relationship24, apartment and stored can450 remain; 463 old objects become735 including272 authored objects exactly once. Old parking layout remains stable.

## Reproduction

```bash
npm run build
npm run test:systems
npm run test:placement
MAP=georgetown npm run test:controls
npm run test:stairs
npm run test:sky
npm run test:gameplay
OLD_BUILD=/path/to/published-v1/dist npm run test:upgrade
```

Tests use setup teleports to arrange scenarios, then real E/U/G actions, physics, guarded transactions and browser storage. `test:upgrade` serves both production builds at one browser origin. Scene fixtures and full reports live in `screenshots/`; raw profiles and methodology are in `docs/verification/`.

## Remaining limits

- There is no hardware GPU or connected Claude preview process here. Software GL is slow; real-device performance remains unverified. Measurements distinguish CPU submission, allocation and GPU-drained timing.
- The city uses original procedural assets. Fourteen marked locations are enterable, rather than every imported facade.
- Broad whole-city road-smoothing/traffic audits are not a claim of perfection. The steep 35th St approach remains; fresh starter selection avoids it. Existing saves preserve their original layout and vehicle poses.
- Saves belong to this browser, website origin, map and seed. Unsupported snapshots are protected from overwrite. Clearing site data removes local progress.

## Publication

Owner-private playable URL: https://open-city-play-benjiang.benjiang968.chatgpt.site .
The first publication was source b58a513fc629b66bb7aebed822adf1da391bbc9c. The updated verified release will reuse this URL and access policy; no domain or paid hosting is required.
