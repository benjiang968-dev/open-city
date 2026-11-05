# Google Photorealistic 3D Tiles in Open City?

Stage 1, item 5 (research). Written 2026-11-05. Question: can Google's Photorealistic 3D Tiles (Map Tiles API) be
used in Open City, a free static browser game on GitHub Pages, either for gameplay or as an optional live viewer?

**Short answer.** Not for gameplay. That is ruled out by the terms (no extraction, no derived content, no caching,
no use next to a non-Google map) and also by the data itself (one photogrammetry skin with no buildings, doors or
collision meaning). An optional live fly-over viewer is **legally doubtful, not clearly allowed** (fact-check,
2026-11-05): a page that shows nothing but Google's tiles risks 3.2.3 (d) ("must contain substantial, independent
value and features beyond the Google products") and the ToS definition of a Customer Application ("material value
independent of the Services"), while adding our own map or city to it runs into 3.2.3 (e). It would also need the
owner's own Google Cloud billing account with a non-EEA billing address, a restricted browser key, hard quota
caps, Google's logo and attribution, and a terms and privacy notice. It brings little to the game and adds a
running cost and a compliance burden. My recommendation is not to build it; if the owner wants it anyway, get
written confirmation from Google (Maps sales or support) first (section 10).

## How this was researched (read this first)

- **Read in full on 2026-11-05** from cloud.google.com, downloaded and searched as text:
  - Google Maps Platform Terms of Service, "Last modified August 26, 2026" [T1]
  - Service Specific Terms, "Last modified October 28, 2026" [T2]
  - EEA Terms of Service, "Last modified August 26, 2026" [T4]
  - EEA Service Specific Terms, "Last modified October 28, 2026" [T3]
  - The list of covered services, "Last modified October 28, 2026" [T5]
  - The 3DTilesRendererJS README and plugin API docs, from raw.githubusercontent.com [R1]
  - The npm registry entry for `3d-tiles-renderer` [R2]
- **Not reachable from this environment:** `developers.google.com` (DNS refused by the session's network policy)
  and `mapsplatform.google.com` (proxy 403). The Map Tiles API documentation, policies, billing page and price
  list live there. I read those pages **only through web-search extracts** on 2026-11-05 [D1–D8]. The URLs are
  cited so the owner can open them. Where search extracts from different page versions disagreed, I say so.
  **Confirm every price and quota in the Google Cloud console before relying on it.**
- No API key was used, so nothing below was measured against the live service.
- **Fact-check pass (2026-11-05, second reader).** T1–T5 were downloaded again from cloud.google.com and every
  quote below was matched against the text (dates confirmed: ToS and EEA ToS Aug 26, 2026; both Service Specific
  Terms and the services list Oct 28, 2026). The npm entry [R2] was re-read. The developers.google.com items
  [D1–D8] and the forum and blog posts [B1–B4] were re-checked by fresh web searches only; the hosts stay blocked
  (cloud.google.com/blog redirects to the blocked mapsplatform.google.com, and community.cesium.com is refused
  too). Changes from that pass are marked "fact-check".

## 1. What the product is

- **What it is.** Photorealistic 3D Tiles are Google's photogrammetry mesh of the world, served as an OGC
  3D Tiles tileset with glTF/GLB payloads [D2]. They are the same kind of mesh Google Earth shows. Washington
  DC is covered, but I could not verify coverage because the coverage pages are on the blocked hosts.
- **How a renderer gets them.** It fetches a root tileset (`https://tile.googleapis.com/v1/3dtiles/root.json?key=…`),
  then follows child URLs. Every child request must carry the API key and the `session` value from the
  root response [D5]. One root request opens a session that lasts **at least three hours**. After that the
  renderer needs a new root request [D3].
- **Attribution data.** Each tile's glTF carries its data attribution in `asset.copyright`. A renderer has to
  collect these from every visible tile, sort them by how often they occur and show them [D5].

## 2. Terms of service relevant to a game

All quotes are from the non-EEA Terms of Service [T1] unless marked. "Customer" is the owner, as holder of the
Google Cloud account. "Customer Application" is Open City.

- **Map Tiles API is a covered "Core Service".** The services list [T5] includes "Map Tiles API". In the ToS,
  "Services" and "Google Maps Core Services" are defined together as the services on that list. So every
  Core Service restriction below applies to 3D Tiles.
- **No service-specific terms for 3D Tiles.** The non-EEA Service Specific Terms [T2] (Oct 28, 2026) have no
  Map Tiles API section at all. Its general rules still apply: "Customer will comply with the Documentation"
  (A.1) and "Customer will attribute all the Services in accordance with the Documentation" (A.2). The EEA
  Service Specific Terms [T3] have a Map Tiles API section (9.1), but it covers Street View tiles only.
- **The policy pages are binding, not advice (fact-check).** ToS 4.2: "The Documentation may specify
  restrictions (e.g. attribution or HTML restrictions) on how the Services may be used and Customer will comply
  with any such restrictions specified", and T2 A.1 says the same. So the Map Tiles policies [D1] and the renderer
  page [D5] count as part of the deal.
- **Attribution clause (3.2.2 b, fact-check).** "Customer will display all attribution that (i) Google provides
  through the Services (including branding, logos, and copyright and trademark notices); or (ii) is specified in
  the Maps Service Specific Terms. Customer will not modify, obscure, or delete such attribution."
- **No scraping (3.2.3 a).** "Customer will not export, extract, or otherwise scrape Google Maps Content for
  use outside the Services. For example, Customer will not: (i) pre-fetch, index, store, reshare, or rehost
  Google Maps Content outside the services; (ii) bulk download Google Maps tiles…". *Consequence: no tiles in
  the build, no pre-fetch script, no IndexedDB tile cache, no offline mode.*
- **No caching (3.2.3 b).** "Customer will not cache Google Maps Content except as expressly permitted under
  the Maps Service Specific Terms". The Service Specific Terms permit nothing for Map Tiles; only Google IDs may
  be cached [T2 §A.3].
- **No content created from Google Maps Content (3.2.3 c).** "Customer will not create content based on
  Google Maps Content". Its examples include "(i) trace or digitize roadways, building outlines… from the Maps
  JavaScript API Satellite base map type; (ii) create 3D building models from 45° Imagery from Maps JavaScript
  API; (iii) build terrain models based on elevation values from the Elevation API". The examples name other
  APIs, but the rule itself covers all "Google Maps Content", which the ToS defines as "any content provided
  through the Services… including map and terrain data, imagery". The Map Tiles
  policy page says the same for 3D Tiles. You may overlay your own 3D objects only "as long as the 3D objects
  aren't extracted, traced, or otherwise derived by hand or machine from Photorealistic 3D Tiles" [D1].
  Google's 3D Tiles FAQ blog adds: "programmatically reading and recording measurements (heights,
  distances, elevations, etc.) from our 3D imagery is considered derivative and is prohibited". That reaches
  me only as a search extract of the blog post [B2]; the blog is not formal policy.
  *Consequence: no collision meshes, no ground heights, no building heights or footprints, no road placement
  and no texture sampling taken from the tiles, not even at build time.*
- **Visualisation only.** The Map Tiles policy says applications "should use Map Tiles API for map
  visualizations" and lists non-visualisation uses it excludes: image analysis, machine interpretation,
  object detection [D1]. Gameplay that raycasts against the tiles (driving on them, line of sight, placing
  NPCs) is machine interpretation of the mesh.
- **No use with or near a non-Google map (3.2.3 e).** "Customer will not use the Google Maps Core Services
  with or near a non-Google Map in a Customer Application. For example, Customer will not (i) display or use
  Places content on a non-Google Map, (ii) display Street View imagery and non-Google Maps on the same screen, or
  (iii) link a Google Map to non-Google Maps Content or a non-Google Map." Open City's minimap and big map are
  drawn from OpenStreetMap/Overture data, so they are non-Google maps. Our own Georgetown 3D city is arguably one
  too. *Consequence: a viewer must be its own screen, with no minimap, big map or OSM-based 3D city on it. This
  is the clause that most clearly rules out mixing Google tiles into the game.* Fact-check: example (iii) also
  makes a **link** between the viewer and our maps a risk, and "near" is undefined; the ToS does not say that a
  separate page of the same site is far enough. The EEA ToS [T4] does not contain this clause (it was dropped
  there along with "No Re-Creating Google Products"). That does not help, because of the EEA point below.
- **No re-creating Google products (3.2.3 d, fact-check).** "Customer's product or service must contain
  substantial, independent value and features beyond the Google products or services", and Customer will not
  "re-distribute the Google Maps Core Services or pass them off as if they were Customer's services". The ToS
  licence is "to use the Services in Customer Application(s)", and a Customer Application is "any web page or
  application… that has material value independent of the Services". *Consequence: a stand-alone page that only
  shows Google's tiles of Georgetown (essentially what Google Earth already shows) is hard to square with
  3.2.3 (d), while putting our own map or city on it breaks 3.2.3 (e). That squeeze is why the short answer
  calls the viewer legally doubtful.*
- **EEA availability.** Google's EEA notice for the Map Tiles API says Photorealistic 3D Tiles are not
  available to projects created after 8 July 2025 that are linked to an EEA billing address, or to projects
  that left the "Unmodified State" after that date. Such projects get HTTP 403 [D6]. A developer report says a
  key-settings change was enough to trigger it [B3]. *If the owner bills from the EU/EEA, the viewer is simply
  not possible.* UK, US and Swiss billing addresses are outside the EEA terms.
- **Your app must carry Google's terms (3.2.2 a).** The game's own terms of service must "(A) notify users
  that the Customer Application includes Google Maps features and content; and (B) state that use of Google
  Maps features and content is subject to the then-current versions of the: (1) Google Maps End User
  Additional Terms of Service… and (2) Google Privacy Policy". Open City has no terms page today.
- **Data goes to Google (4.4 a).** Google "collects and receives data from Customer and End Users… including
  search terms, IP addresses, and latitude/longitude coordinates". The game would need a privacy notice for
  the viewer page.
- **Other limits that apply to us.**
  - Customer Applications that would be deemed a "Website or online service directed to children" under COPPA
    are excluded (3.2.1 c vi). Open City is not meant for children, but a colourful game is judged by its
    content and audience, so the owner would have to confirm this (fact-check: softened from "is not").
  - Benchmark results may only be published with full reproduction details (3.2.4).
  - Google may ask to review the app (3.2.2 c).
  - The key holder "is responsible for… any use of its API key(s)" and for "ensuring that only authorized
    domains and applications use the Services" (1.2).
- **Derivative works of the Services.** 3.2.1 (a) forbids "copy, modify, create a derivative work of… any or
  all of the source code". That is about Google's software. The content rules are 3.2.3 (a)–(c) above.

## 3. Caching, storage and offline

Nothing may be stored beyond what the browser's own HTTP cache does with Google's response headers. That means:

- no service worker or IndexedDB tile store
- no "download Georgetown for offline play"
- no shipping tiles in `dist/`
- no saving tiles from a dev machine to speed up the build

Cesium staff give the same answer on their forum: "it is not possible to clip or use Google's 3d tiles offline".
Cesium ion's Clips feature is explicitly unavailable for Google tiles "due to their terms of use" [B1]. (Both
quotes reach us as search extracts; community.cesium.com is refused from this environment.)

## 4. Extracting geometry (collision, heights, footprints)

**Not allowed** under 3.2.3 (a) and (c) and the hybrid-3D rule in the Map Tiles policy (section 2).

It would also be a poor source technically. The mesh is a single surface with these baked in:

- trees, parked cars and street furniture
- capture-time shadows

It has no separate objects, no ground below overhangs, and no semantic classes. Raycasting it for driving
would give bumpy, melted road surfaces. That is the opposite of the owner's "roads must not contain strange
artificial bumps" requirement.

## 5. Attribution and logo

Required whenever tiles are on screen:

The binding rule is ToS 3.2.2 (b) (section 2): show all attribution Google provides, including logos, and do not
modify, obscure or delete it. The details below come from the policy pages, as search extracts only.

- **Google logo.**
  - Unaltered.
  - Bottom-left of the map; the policy extract says "You should place the Google logo in the bottom left-hand
    corner of the map, and you should place the attribution information in the right-hand corner" [D1]. The
    renderer page puts the data attribution "usually [in] the bottom right corner" [D5].
  - No other logo (for example a renderer's) may overlap or obscure it, with "a reasonable buffer distance"
    between Google's logo and a third-party logo [D1, D5].
  - The logo file is said to be supplied on the policy page (not seen; unconfirmed).
  - Where a cinematic 3D experience cannot place it, the logo must appear "at the beginning or end or both
    ends" [D1].
- **Data attribution.**
  - The aggregated `asset.copyright` strings of the visible tiles, sorted by frequency and joined with
    semicolons.
  - Visible, not cropped or hidden, and not covered by any logo.
  - Third-party credits (ours: OpenStreetMap and Overture) must not overlap or obscure Google's data attribution
    and must be "clearly… disassociated" from it (wording differs between page versions in the extracts) [D1].
  - Where the tiles carry third-party data, "Google" alone or the logo alone is not proper attribution; the text
    names Google and the data providers [D1, D5].
- **The strings change with the view.** They must be read from the tiles at runtime, never hard-coded [D1].
- **Promotional videos** of the viewer must be marked "for promotional purposes only". One version of the
  policy also caps them at 30 seconds with no Street View imagery; the page versions in the search extracts
  disagree on this [D1].
- **Library support.** 3DTilesRendererJS's `GoogleCloudAuthPlugin` collects the per-tile attributions and can
  add a logo image (`logoUrl`) to its attribution output [R1].

## 6. Billing, prices and free tier

- **A Google Cloud billing account is required** (credit card on file) to create a production key [D3].
- **Maps Demo Key.** Google now offers a "Maps Demo Key" with no billing account. It has small daily
  quotas, is "intended for testing and prototyping purposes only, and is not designed for production use",
  and covers a limited list of APIs. I could not confirm that Map Tiles API is on that list [D8]. It is not a
  route to a published game in any case.
- **SKU.** "Map Tiles API: Photorealistic 3D Tiles" is an **Enterprise** SKU [D3, D4].
- **What is billed.** The root tileset request. The tile requests the renderer makes inside a session do not
  count toward the daily quota [D3]. A Cesium forum post from the preview era describes the same model at
  "$6 per 1000 3D root tiles" [B4].
- **Free monthly usage (since March 2025).** The $200 monthly credit ended on 28 February 2025. Since then
  each SKU has its own free monthly cap: Essentials 10,000, Pro 5,000, Enterprise **1,000** [D4, B5]. These are
  the figures for "most Core Services SKUs"; a footnote gives 2D Map Tiles and Street View Tiles 100,000. The
  1,000 for Photorealistic 3D Tiles was confirmed again in the fact-check search of the price list [D4].
- **Prices per 1,000 billable events (USD), from search extracts of the official price list [D4]:**

  | Monthly volume | Price per 1,000 |
  |---|---|
  | first 1,000 | free |
  | 1,001–100,000 | $6.00 |
  | 100,001–500,000 | $5.10 |
  | 500,001–1,000,000 | $4.20 |
  | 1,000,001–5,000,000 | $3.30 |
  | above 5,000,000 | $2.40 |

- **Daily quota.** Page versions disagree. Some list "10,000 root tileset queries per day" under the 3D
  section, others only under the 2D and Street View section; one also gives a rate limit of 12,000 queries per
  minute [D3]. Unconfirmed for 3D Tiles; check the Quotas page in the console.
- **What a viewer would cost.** One viewer visit is roughly one root request, plus one more per three hours on
  screen.

  | Viewer opens per month | Billable | Cost per month |
  |---|---|---|
  | 1,000 | 0 | $0 |
  | 10,000 | 9,000 | about $54 |
  | 100,000 | 99,000 | about $594 |

  A public link that goes viral, or a scraped key, scales this without limit unless quotas are capped
  (section 7).

## 7. API key exposure on a static site

GitHub Pages has no server, so the key ends up in the shipped JavaScript. Anyone can read it. Google's model
for browser keys is "public but restricted" [D7]:

1. **Application restriction.** HTTP referrers, for example `https://<owner>.github.io/open-city/*`. Referrer
   checks can be bypassed by non-browser clients, so they are not enough on their own [D7].
2. **API restriction.** Map Tiles API only, so a leaked key cannot call expensive Places or Routes SKUs [D7].
3. **Hard quota caps.** In the console's Quotas page, set the root-tileset requests per day and per minute to
   something the owner can afford (for example 300 a day is at most about 9,000 a month, so about $48 after the 1,000 free). Budgets and alerts
   only notify; **only quota caps stop spending.**
4. **A separate key and a separate Cloud project** for the viewer, so a leaked key cannot touch anything else.
5. **Do not commit the key.** Inject it at build time from a GitHub Actions secret or a local `.env` that is
   never committed. It will still be visible in the built bundle; that is expected for browser keys.
6. **Session tokens are not secrets.** The `session` parameter only ties tile requests to one root request. It
   does not protect the key. 3DTilesRendererJS's `GoogleCloudAuthPlugin` adds key and session to each request
   and can refresh the session on 4xx errors (`autoRefreshToken`) [R1].
7. **Alternative: "bring your own key".** The viewer asks the visitor for their own key, kept in their
   browser's localStorage. The owner then pays nothing and holds no key. Each visitor becomes a Google customer
   bound by the terms; in practice that is only reasonable for a developer tool, not for players.

An LLM-style server proxy (as planned for NPC chat) would not help here. The tiles must still stream to the
browser, so a proxy would be rehosting Google content, which 3.2.3 (a) forbids.

## 8. Technical fit with three.js and with our city

- **Library.** `3d-tiles-renderer` 0.5.4 (npm, released 2026-11-03, Apache-2.0, peer `three >= 0.167`, so it
  works with our three 0.187) [R2]. It has:
  - a three.js `TilesRenderer`
  - `GoogleCloudAuthPlugin` (key, session, attribution, logo)
  - `ReorientationPlugin` (moves a lat/lon to the origin with +Y up)
  - LoD fade, a Draco/KTX2-capable glTF path, and an LRU cache with byte limits [R1]

  Its official examples include "Google Photorealistic" and "Google Globe" demos. Adding it would be a **new
  dependency**. That needs the owner's OK under CLAUDE.md's tech-stack rule.
- **Coordinate frames.**
  - Tiles are in ECEF (Earth-centred, metres; values around 6.4 × 10⁶). They must be re-centred to avoid
    float32 jitter; `ReorientationPlugin` does this.
  - Our frame (`src/data/georgetown.json` `meta`) is equirectangular around lat 38.9065, lon −77.061, with
    x east, **z south**, y up, and heights in metres above the Potomac (river = 0).
  - Over a 2 km district the difference between that frame and a local ENU tangent plane is tiny: about
    1.4 × 10⁻⁴ scale change in x per km north-south, so about 0.15 m at the map edge.
  - Google heights are ellipsoidal (WGS84). The vertical offset to our river datum is roughly the local geoid
    separation (about −33 m in DC, from general knowledge, not measured here) plus the river level.
  - We would need a z flip and a one-off vertical offset. Aligning by eye is fine; **aligning by measuring
    the tiles is not** (section 4).
- **No buildings, doors or interiors.** One continuous skin: no per-building objects, entrances, floors or
  windows. Our pillars (every building enterable, doors that open, solid things solid) cannot be served by it.
  Hiding our own buildings and showing Google's instead would break interiors, collision and the
  "same object everywhere" rules.
- **Lighting.** Textures carry the capture-day sun and shadows. They cannot be relit by our day/night cycle or
  weather, so night and rain would look wrong. Mixing them with our PBR city in one frame would show two
  different lighting models.
- **Ground level.** Aerial photogrammetry is built for views from above. At pedestrian eye height facades smear
  and cars and trees melt into the road (well known from Google Earth; not measured here without a key).

## 9. Performance on laptops

- **Not measured** (no key).
- The renderer streams tiles continuously as the camera moves. Detail is set by `errorTarget` and memory by the
  LRU cache's `maxSize` / `maxBytesSize`.
- The library's README warns that the cache limits "are hard caps": when the view needs more than fits,
  coarser tiles are shown and refinement stops [R1].
- A fly-over viewer on its own page should run on a mid-range laptop at a moderate `errorTarget`.
- Running it *inside* the game would add a second streaming system to our draw calls, texture memory and CPU
  budget, on top of our own chunks. That is one more reason to keep it separate.

## 10. Recommendation

- **Gameplay: no.** Not for collision, terrain, heights, footprints or roads. Not as a backdrop in the game
  view, and not even as a reference to trace. The terms forbid it (3.2.3 a, c, e; Map Tiles policy) and the data
  cannot do it.
- **Optional live viewer: legally doubtful (section 2, 3.2.3 d and e). Only if the owner explicitly asks, only
  after Google confirms in writing that the planned page is acceptable, and only under all of these conditions.**
  1. A separate page (for example `viewer.html`, "Real Georgetown fly-over") with no Open City minimap, big
     map or game city on that screen. Fact-check: the earlier "a link from the pause menu to it is fine" was not
     supported. 3.2.3 (e) example (iii) forbids linking a Google Map to a non-Google map, so any link between
     the viewer and the game is part of what to ask Google about. The page must also offer something of its own
     beyond Google's imagery (3.2.3 d).
  2. The owner's own Google Cloud project and billing account with a **non-EEA** billing address, and the
     Map Tiles API enabled.
  3. A key restricted to the GitHub Pages referrer and to Map Tiles API only, hard daily quota caps, a budget
     alert, and a separate project.
  4. Google logo bottom-left plus live aggregated tile attribution, not overlapping and clearly disassociated
     from our own credits (section 5).
  5. A terms page and privacy notice for the site with the wording 3.2.2 (a) requires.
  6. No caching, no offline, no screenshots or measurements fed back into the game.
  7. The owner accepts a new dependency (`3d-tiles-renderer`).
- **What the owner would have to do:**
  - create the project, attach billing (credit card) and enable Map Tiles API
  - create and restrict the key and set quotas
  - store the key as a build secret
  - approve the dependency
  - accept the Google terms on Open City's behalf, publish a terms and privacy notice, and keep an eye on
    usage
- **What the owner would pay:** $0 up to about 1,000 viewer opens a month. After that about $6 per 1,000
  opens (about $54 at 10,000 a month), capped by whatever daily quota is set. Prices must be checked in the
  console first.

## Sources (all read or searched on 2026-11-05)

- [T1] Google Maps Platform Terms of Service, last modified 2026-08-26. https://cloud.google.com/maps-platform/terms
- [T2] Google Maps Platform Service Specific Terms, last modified 2026-10-28. https://cloud.google.com/maps-platform/terms/maps-service-terms
- [T3] Google Maps Platform EEA Service Specific Terms, last modified 2026-10-28. https://cloud.google.com/terms/maps-platform/eea/maps-service-terms
- [T4] Google Maps Platform EEA Terms of Service, last modified 2026-08-26. https://cloud.google.com/terms/maps-platform/eea
- [T5] Google Maps Platform Core Services list, last modified 2026-10-28. https://cloud.google.com/maps-platform/terms/maps-services
- [D1] Map Tiles API Policies (search extracts only; host blocked here). https://developers.google.com/maps/documentation/tile/policies
- [D2] Photorealistic 3D Tiles overview (search extracts only). https://developers.google.com/maps/documentation/tile/3d-tiles
- [D3] Map Tiles API Usage and Billing (search extracts only). https://developers.google.com/maps/documentation/tile/usage-and-billing
- [D4] Google Maps Platform core services pricing list (search extracts only). https://developers.google.com/maps/billing-and-pricing/pricing
- [D5] Work with your own 3D Tiles renderer (search extracts only). https://developers.google.com/maps/documentation/tile/create-renderer
- [D6] Map Tiles API adjustments for EEA customers (search extracts only). https://developers.google.com/maps/comms/eea/map-tiles
- [D7] Google Maps Platform security guidance (search extracts only). https://developers.google.com/maps/api-security-best-practices
- [D8] Maps Demo Key (search extracts only). https://mapsplatform.google.com/maps-demo-key/
- [R1] NASA-AMMOS 3DTilesRendererJS README, plugin guide and API (read in full). https://github.com/NASA-AMMOS/3DTilesRendererJS (raw: README.md, src/three/plugins/API.md, src/core/plugins/API.md)
- [R2] npm registry, `3d-tiles-renderer` 0.5.4. https://registry.npmjs.org/3d-tiles-renderer
- [B1] Cesium community threads on offline use and Clips with Google tiles (secondary; search extracts only, host refused here). https://community.cesium.com/t/how-can-i-download-photorealistic-3d-tiles-for-cesium-js-react-offline-self-hosted/26293 and https://community.cesium.com/t/tiles-for-offline-terrain-server/40557
- [B2] Google Maps Platform blog, "Commonly asked questions about our recently launched Photorealistic 3D Tiles" (search extract only). https://cloud.google.com/blog/products/maps-platform/commonly-asked-questions-about-our-recently-launched-photorealistic-3d-tiles
- [B3] OSGeo discourse, "Google satellite 2D Tiles stopped working for EEA developers" (secondary). https://discourse.osgeo.org/t/google-satellite-2d-tiles-stopped-working-for-european-economic-area-eea-developers/149688 and blosm issue #644: https://github.com/vvoovv/blosm/issues/644
- [B4] Cesium community, "Google 3D Tiles Cost" (secondary, preview era, search extract only). https://community.cesium.com/t/google-3d-tiles-cost/27625
- [B5] Woosmap, "Google Maps API Pricing 2026" (secondary, confirms per-SKU caps since March 2025). https://www.woosmap.com/blog/google-maps-api-pricing-breakdown
