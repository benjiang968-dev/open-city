// Every gameplay number lives here. Units: metres, seconds, kilograms, Newtons, radians unless noted.
// When feedback arrives as a measurement, change the named value here and nothing else.

const RAW = {
  world: {
    defaultSeed: 1337, // used when the URL has no ?seed=
    blocksX: 9, // downtown grid blocks across (scale this up later for bigger districts)
    blocksZ: 6, // downtown grid blocks deep (north to south, ending at the waterfront)
    blockSize: 82, // edge length of one city block, kerb to kerb
    roadWidth: 14, // full width of a two-lane street
    sidewalkWidth: 3.2, // pavement strip around each block
    waterfrontRoadWidth: 16, // the bay-side boulevard
    beachDepth: 26, // sand strip between boulevard and water
    seaFloorDepth: 6, // how deep the bay is (cars that drive in sink to here)
    waterLevel: -0.7, // height of the water surface
    buildingMinH: 6, // lowest building
    buildingMaxH: 58, // tallest downtown tower
    downtownBias: 2.6, // how strongly buildings get taller toward the centre
    parkChance: 0.08, // chance a block becomes a park
    treesPerPark: 26,
    streetTreeSpacing: 22, // metres between street trees along pavements
    streetLightSpacing: 30, // metres between street lights
    parkedCarChance: 0.3, // chance per kerb slot for a decorative parked car
    pierLength: 150, // public pier reaching into the bay
    marinaPiers: 4, // number of finger piers in the marina
  },

  // The map interface (src/systems/map/): shared by every map implementation (grid city, Georgetown).
  map: {
    defaultMap: 'grid', // map loaded when the URL has no ?map= (or an unknown one); the seed never picks the map
    // cruise speed (m/s) for roads without a maxspeed tag, by road class (the grid city uses traffic.cruiseSpeed)
    classSpeed: { primary: 13.4, secondary: 12.5, tertiary: 11.2, residential: 11, service: 6.7, parkway: 15.6 },
    laneWidth: 3.5, // metres per traffic lane (grid: how many lanes per direction fit a road's width)
    parkingLaneWidth: 2.4, // metres along each kerb kept for parked cars before the first traffic lane (grid)
    stopLineGap: 3.2, // metres from a crossing road's edge to the stop line (grid junction boxes)
    kerbStopGap: 1.6, // metres from the kerb to where a car stops at the kerb (taxi pick-ups and drop-offs)
    kerbSearchRange: 200, // metres: kerbPoint looks for a kerbside lane this far (Georgetown: the boardwalk is ~150 m from K St)
    laneHashCell: 32, // metres per cell of the nearest-lane spatial hash (lookup speed only)
    walkHashCell: 32, // metres per cell of the walk-node spatial hash (lookup speed only)
    buildingHashCell: 32, // metres per cell of the building spatial hash (lookup speed only)
    // levels (bridge decks, elevated roads over other roads; see LEVELS in map/cityMap.ts)
    levelTolerance: 4, // metres: lane / walk lookups given a height prefer lanes and walk nodes this close above or below it
    levelSearchRange: 150, // metres: nearestWalk with a height looks this far for a node on that level before taking any level
    levelStep: 1.2, // metres: heightAt(x, z, y) counts a deck as underfoot if its top is at most this far above y
    minStrongShare: 0.9, // validateCityMap: the largest strongly connected road component must hold this share of lanes
    minWalkShare: 0.95, // validateCityMap: the largest connected walk component must hold this share of walk nodes
    heightCheckTolerance: 0.5, // validateCityMap: lane points, walk nodes and parking spots may be this far (m) off heightAt
    // kerbside parking (real maps; see ParkingSpot / LaneEdge.parking in map/cityMap.ts)
    parkingBand: 2.1, // metres from the kerb kept for parked cars; a parked car's centre sits half of this from the kerb
    parkingMinHalfWidth: 3.2, // metres: a two-way street with one lane each way gets parking (on one kerb) only if this wide
    parkingCrossingGap: 5, // metres of kerb kept free either side of a pedestrian crossing
    parkingRankGap: 18, // metres of kerb kept free either side of a taxi rank
    parkingBusStopGap: 12, // metres of kerb kept free either side of a bus stop
    parkingCheckClearance: 0.35, // metres: a parking spot is dropped if anything solid stands higher than this inside a car's footprint (kerbs and lines are lower)
    parkingCheckHalfHeight: 0.5, // metres: half the height of the box tested above that clearance
    passThroughMaxBend: 0.6, // radians: where two pieces of the same street meet bending less than this, cars run straight on (real maps)
    deadEndTurnRoom: 12, // metres before a dead end (a road leaving the map) where cars turn round (real maps)
    parkingLaneCost: 3, // RoadRouter: driving along a parking lane costs this many times its travel time (routes keep out)
    kerbSpotSpacing: 6.5, // metres between kerbside parking spots along a parking lane (real maps): a car length plus room to pull out
    // walk graph building (real maps)
    walkNodeSpacing: 12, // metres between walk nodes along sidewalks and paths
    walkJoinRange: 10, // metres: a path end joins the nearest walk node this close on its own level
    walkBridgeRange: 30, // metres: a cut-off piece of the walk graph is joined to the main network if this close, else dropped
    walkLevelGap: 1.5, // metres: walk nodes further apart in height than this are on different levels (never joined)
    walkBridgeLevelGap: 3, // metres: a cut-off piece (a pier, a stair foot) may still join the network this far up or down
    homePois: 160, // homes (rowhouses and flats) picked on the Georgetown map for people to live in
  },

  time: {
    realSecondsPerGameDay: 24 * 60, // 24 real minutes = one game day
    startHour: 15, // game opens mid-afternoon; dusk arrives ~3.5 real minutes in
  },

  camera: {
    distanceOnFoot: 5.5, // orbit distance when walking
    distanceInCar: 9.0, // orbit distance when driving
    heightOffset: 1.6, // look-at point above the target origin
    followLerp: 10, // how fast the camera position catches up (per second)
    mouseSensitivity: 0.0024, // radians per pixel of mouse movement
    minPitch: -0.25, // looking up limit
    maxPitch: 1.2, // looking down limit
    autoRecenterDelay: 1.6, // seconds after mouse stops before the car camera swings behind
    autoRecenterSpeed: 2.2, // how fast it swings back behind the car
    footRecenterSpeed: 5, // on foot the camera swings behind the character faster
    fov: 62, // base field of view (degrees)
    fovSpeedBoost: 12, // extra FOV degrees at top speed
  },

  player: {
    walkSpeed: 4.2, // m/s
    runSpeed: 8.5, // m/s with Shift
    jumpVelocity: 6.2, // m/s upward on Space
    gravity: 22, // m/s² for the on-foot controller (snappier than real 9.8)
    turnSpeed: 3.0, // rad/s the character turns with A/D (tank-style controls)
    backSpeedFactor: 0.55, // walking backwards is this fraction of walk speed
    capsuleRadius: 0.35,
    capsuleHalfHeight: 0.55,
    enterCarRange: 3.6, // metres from the car to be able to press E
    talkRange: 3.0, // metres to an NPC to be able to press E and talk
    rescuePavementStep: 2.0, // metres past the kerb onto the pavement where you land after swimming back to shore
  },

  vehicles: {
    gravity: 9.81 * 1.6, // world gravity for physics; slightly heavy for a planted arcade feel
    // Per-type handling. Forward axis is local +Z.
    types: {
      hatchback: {
        label: 'Hatchback',
        mass: 1050, // kg
        halfExtents: [0.85, 0.42, 1.85], // chassis collider half size
        comHeight: -0.45, // centre of mass relative to chassis centre (negative = lower, more stable)
        wheelRadius: 0.34,
        wheelX: 0.78, // half track width
        wheelZFront: 1.22, // front axle position
        wheelZRear: -1.18, // rear axle position
        wheelY: -0.18, // suspension mount height
        suspensionRest: 0.32,
        suspensionStiffness: 34,
        suspensionCompression: 3.4,
        suspensionRelaxation: 4.0,
        maxSuspensionTravel: 0.3,
        maxSuspensionForce: 60000,
        frictionSlipFront: 1.0, // tyre grip front (lateral limit ≈ this × normal load)
        frictionSlipRear: 1.1, // tyre grip rear (higher than front = stable, slight understeer)
        sideFrictionStiffness: 1.0,
        handbrakeRearSlip: 0.42, // rear grip while handbrake held (lower = more drift)
        engineForce: 3600, // N per driven wheel at low speed
        reverseForce: 2000, // N per driven wheel reversing
        brakeForce: 2600, // N of brake per wheel
        handbrakeForce: 3200, // N of rear brake with handbrake
        maxSpeed: 46, // m/s (~165 km/h) engine force fades to zero here
        maxSteer: 0.6, // radians at standstill
        steerAtSpeed: 0.17, // radians at highSpeedSteerAt
        highSpeedSteerAt: 38, // m/s where steering has tightened fully
        steerRate: 3.4, // how fast the wheels turn (rad/s)
        driveFront: true, // FWD hatchback
        driveRear: false,
        health: 100,
        color: 0xe8b23a,
      },
      sedan: {
        label: 'Sedan',
        mass: 1400,
        halfExtents: [0.92, 0.45, 2.25],
        comHeight: -0.5,
        wheelRadius: 0.36,
        wheelX: 0.84,
        wheelZFront: 1.45,
        wheelZRear: -1.4,
        wheelY: -0.2,
        suspensionRest: 0.32,
        suspensionStiffness: 32,
        suspensionCompression: 3.6,
        suspensionRelaxation: 4.2,
        maxSuspensionTravel: 0.3,
        maxSuspensionForce: 80000,
        frictionSlipFront: 1.0,
        frictionSlipRear: 1.08,
        sideFrictionStiffness: 1.0,
        handbrakeRearSlip: 0.38,
        engineForce: 4800,
        reverseForce: 2400,
        brakeForce: 3400,
        handbrakeForce: 4000,
        maxSpeed: 52,
        maxSteer: 0.56,
        steerAtSpeed: 0.15,
        highSpeedSteerAt: 40,
        steerRate: 3.2,
        driveFront: false, // RWD sedan: best drifter
        driveRear: true,
        health: 120,
        color: 0x2e6fd8,
      },
      pickup: {
        label: 'Pickup',
        mass: 1900,
        halfExtents: [1.0, 0.55, 2.55],
        comHeight: -0.55,
        wheelRadius: 0.44,
        wheelX: 0.92,
        wheelZFront: 1.65,
        wheelZRear: -1.6,
        wheelY: -0.25,
        suspensionRest: 0.4,
        suspensionStiffness: 28,
        suspensionCompression: 3.2,
        suspensionRelaxation: 3.8,
        maxSuspensionTravel: 0.38,
        maxSuspensionForce: 110000,
        frictionSlipFront: 0.95,
        frictionSlipRear: 1.05,
        sideFrictionStiffness: 1.0,
        handbrakeRearSlip: 0.42,
        engineForce: 3000, // all four wheels driven
        reverseForce: 1600,
        brakeForce: 4600,
        handbrakeForce: 5200,
        maxSpeed: 44,
        maxSteer: 0.54,
        steerAtSpeed: 0.16,
        highSpeedSteerAt: 36,
        steerRate: 3.0,
        driveFront: true,
        driveRear: true,
        health: 160,
        color: 0xc8402f,
      },
    },
    gripLatAccel: 12, // m/s² of cornering the steering limiter aims for at speed (~1.2 g)
    steerOverGrip: 1.5, // how far past the grip limit the steering may ask (higher = twitchier, more drift)
    playerCcd: false, // continuous collision for drivable cars. Off: at ≤50 m/s a 4.5 m car moves 0.83 m per step, so it can't tunnel, and CCD made impacts cost ~10 ms
    downforce: 3.2, // N per (m/s)² per tonne pressing the car into the road
    yawStability: 2.5, // assist torque damping unwanted spin when not using handbrake (0 = off)
    driftYawAssist: 0.25, // weaker damping while handbrake held, so drifts hold but recover
    angularDamping: 0.6, // body angular damping
    linearDamping: 0.05, // body linear damping (air drag-ish)
    rollingResistance: 220, // N of brake per wheel when coasting (engine braking)
    crashDamageThreshold: 4.5, // m/s of sudden speed change before damage counts
    crashDamagePerMs: 6, // health lost per m/s of impact above threshold
    flipRecoverTime: 2.5, // seconds upside down before the car is auto-righted
    playerCarSpawn: [
      // one of each type parked next to the starting taxi rank
      'sedan',
      'hatchback',
      'pickup',
    ],
    ownedAtStart: 1, // the first N cars at the starting taxi rank are yours; the others belong to locals
    // Parked cars (parkedCars.ts), by map and by the parking spot's street class: drivable parked cars per 100 m of
    // kerb (both kerbs counted; a spot stands for its `span` of kerb, so the most there can be is 100 / span).
    // Georgetown: M St, Wisconsin Ave, K St, Pennsylvania Ave and Canal Rd are 'primary'; 23rd St, New Hampshire Ave
    // and Reservoir Rd 'secondary'; P, Q and R St, Water St and 37th St 'tertiary'; the rowhouse streets 'residential'
    // (most park on one kerb; the one-way single-lane ones, like 29th St, not at all); the parkway and the freeway
    // never have parking. Grid city: the bay boulevard is 'secondary' and every other street 'residential'.
    parkedCarsPer100m: {
      grid: { primary: 0.6, secondary: 0.6, tertiary: 0.3, residential: 0.07, service: 0, parkway: 0 },
      georgetown: { primary: 11, secondary: 7, tertiary: 6, residential: 3.5, service: 2, parkway: 0 },
    } as Record<string, Record<'primary' | 'secondary' | 'tertiary' | 'residential' | 'service' | 'parkway', number>>,
    lotFill: { grid: 0, georgetown: 0.5 } as Record<string, number>, // by map: share of car park bays with a car in them
    waterfrontLotFill: 0.95, // car parks by the river are full: bays within waterfrontLotRange of the waterfront promenade
    waterfrontLotRange: 150, // metres
    parkedTypeWeights: { hatchback: 4, sedan: 4, pickup: 2 }, // how common each car type is among parked cars
    // Near you a parked car is a real drivable car (physics, E to get in), taken from a pool; further away it is only
    // drawn (one instanced mesh per car type), so a street full of parked cars costs a handful of draw calls.
    parkedPool: { hatchback: 10, sedan: 10, pickup: 8 }, // drivable cars per type kept ready (the pool grows if it must)
    parkedLiveRadius: 26, // metres: parked cars this close to you are drivable cars
    parkedAheadTime: 1.6, // seconds: ...and those near where your car will be this far ahead
    parkedAheadRadius: 16, // metres around that point ahead
    parkedReleaseRadius: 45, // metres: untouched ones further than this (and not ahead of you) go back to being drawn only
    parkedMustRadius: 9, // metres: a parked car this close always gets a drivable car, even if the pool has to grow
    parkedPromotePerFrame: 3, // stand-ins handed out per frame beyond parkedMustRadius (spreads the work after a jump across town)
    parkedDrawDistance: { low: 150, medium: 210, high: 300 }, // metres, by quality: parked cars drawn this far from you
    parkedRefresh: 0.25, // seconds between redraws of the far parked cars (sooner after you move 12 m)
    parkedReuseGap: 0.25, // metres: a released car that moved less than this keeps its parking spot's pose
    kerbSlotSpacing: 13, // metres of kerb one kerbside parking spot stands for unless the spot says (grid generator's spacing)
    parkingKerbGap: 1.3, // metres from the road edge to a parked car's centre line (grid boulevard spots)
    parkingJunctionGap: 10, // metres of kerb kept free next to each junction (grid boulevard spots)
    parkedClearOfRank: 16, // metres: no other parked cars this close to the player's spawn (your starting cars stand there)
    parkedClearOfPoi: 12, // metres: kerb spots this close to a POI kerb (taxi stop) stay free (grid boulevard spots)
  },

  theft: {
    lockedFraction: 0.5, // share of locals' parked cars that are locked (abandoned cars are never locked)
    abandonedFraction: 0.12, // share of parked cars nobody owns any more (no owner comes after you)
    breakInTime: 3.0, // seconds to smash the side window of a locked car and get in
    strikeTimes: [0.75, 1.55, 2.35], // seconds into the break-in when the elbow hits the glass
    alarmSeconds: 12, // how long a car alarm sounds once triggered
    lookTime: 3.5, // seconds people stop and stare at a car alarm (plus up to lookTimeRandom)
    lookTimeRandom: 1.5, // extra random seconds of staring, so a crowd doesn't all turn away at once
    lookCheckInterval: 0.25, // seconds between checks for people hearing an alarm
    ownerNoticeRange: 60, // metres: an owner this close who sees it (or hears their alarm) comes after you
    ownerHomeRange: 250, // metres: each grown-up owns the parked car nearest their home or work if it is this close
    localOwnerNearby: 0.35, // a car owned by a local nobody has met: chance its owner is right there (in a shop nearby) when you take it
    localOwnerRange: 35, // metres: that owner is one of the people this close who can see the car
    ownerChaseTime: 14, // seconds the owner chases and shouts before giving up (then may call 999)
    ownerGiveUpDistance: 70, // metres: owner stops chasing once you are this far away
    ownerRunFactor: 0.85, // owner's chasing speed as a fraction of the flee (running) speed
    shoutEvery: 2.4, // seconds between the owner's shouts
    shoveImpulse: 140, // N·s sideways push on the car per strike (it rocks on its springs)
    cancelDistance: 3.5, // metres: the break-in stops if you end up this far from the car
  },

  traffic: {
    cruiseSpeed: 11, // m/s (~40 km/h): the grid city's speed limit (real maps use maxspeed or map.classSpeed)
    accel: 4, // m/s²
    brake: 9, // m/s²
    followGap: 9, // metres kept to the car ahead
    intersectionWait: 0.9, // seconds a car pauses at an uncontrolled junction of equal roads before going (first come, first served)
    laneOffset: 3.1, // metres right of the centre line: the grid city's (innermost) lane centre
    honkDistance: 10, // player within this in front of a stopped AI car = honk
    honkCooldown: 3, // seconds between honks per car
    swerveDistance: 16, // player car approaching faster than swerveSpeed within this triggers a swerve
    swerveSpeed: 14, // m/s
    swerveOffset: 2.4, // metres sideways when swerving
    turnTouchGap: 1.5, // metres: a car crossing a junction stops for anything straight ahead this close, even off its curve (two cars leaving one lane on different turns)
    passGap: 0.05, // metres: an oncoming car whose side clears ours by this much is passing, not in our way (narrow two-way streets)
    sideGap: 0.15, // metres: another car counts as in our path if the gap between the two bodies' sides is less than this
    bodyRound: 0.3, // metres: AI car bodies (pitch locked) have edges this round, so they ride over kerbs and grade changes
    levelGap: 3, // metres: something this far above or below a car (plus levelGrade per metre ahead) is on another level, not in its way
    levelGrade: 0.25, // height change per metre ahead a street can account for (steep hills) before it counts as another level
    spawnMinDistFromPlayer: 25, // metres: at boot no AI car starts closer than this to the player
    // ---- population around the player (trafficPopulation.ts) ----
    countByQuality: { low: 18, medium: 26, high: 34 }, // AI cars driving near the player, by graphics preset (M2 ran 26 everywhere)
    despawnRadius: 340, // metres: a car farther than this from the player (and out of sight) is moved to a lane nearer the player
    spawnMinDist: 110, // metres: a respawned car starts at least this far from the player, out of the camera's sight ...
    spawnMaxDist: 300, // ... and at most this far from the player
    bootSpawnMaxDist: 320, // metres: at boot cars are spread over lanes up to this far from the spawn
    spawnViewMargin: 0.3, // radians added to half the camera's field of view: a lane point inside that cone counts as in view
    spawnClearance: 14, // metres: a car never spawns this close to another AI car
    spawnSpeedFraction: 0.7, // a respawned car starts moving at this fraction of its lane's cruise speed
    populationChecksPerFrame: 3, // cars checked per frame for being far away (round robin)
    respawnsPerFrame: 1, // at most this many cars are moved per frame (each move tries lanes and casts sight rays)
    spawnTries: 50, // lanes tried for one move (the last 30% at any distance out of sight)
    // relative cars per lane-metre by road class (a respawn picks a lane by length x this)
    densityByClass: { primary: 1, secondary: 0.85, parkway: 0.8, tertiary: 0.6, residential: 0.22, service: 0.06 },
    stuckRecycle: 25, // seconds stopped (not at a junction) before a car is moved away (gridlock fallback)
    // ---- junction rules (junctions.ts) ----
    classRank: { primary: 5, parkway: 5, secondary: 4, tertiary: 3, residential: 2, service: 1 }, // at an uncontrolled junction the lower rank gives way
    approachDecel: 3.2, // m/s²: comfortable braking toward a stop line or into a junction curve
    decideDist: 12, // metres beyond the braking distance at which a car starts checking whether it may enter the junction ahead
    turnLatAccel: 2.6, // m/s² sideways on a junction curve: sets the speed of each turn
    turnSpeedMin: 3.5, // m/s: slowest junction curve speed (tight corners, U-turns)
    stopSignWait: 1.1, // seconds stopped at a stop sign before going (then first come, first served)
    yieldPause: 0.25, // seconds a car giving way stands at the line before pulling out into a gap
    gapTime: 4, // seconds: a car with priority this close (in time) to the junction blocks a crossing or turning move
    gapDist: 70, // metres: cars with priority farther than this are ignored by gap acceptance
    maxYieldWait: 12, // seconds: after waiting this long at a give-way line, only cars under 1.5 s away hold a car back
    conflictDist: 2.9, // metres: two junction paths that come closer than this conflict (two car widths and some slack: cars lag their curve a little)
    exitSpace: 3, // metres of free lane needed beyond a car's length past the junction before it enters (never block the box)
    boxReserveTime: 1.2, // seconds: a car given the go this close to its stop line counts as in the junction already
    exitSpaceSpeed: 3, // m/s: a car on the exit lane slower than this counts as queuing there
    amberMargin: 0.3, // seconds: on amber a car goes only if it reaches the stop line this long before red
    redCommitSpeed: 3, // m/s: a car that went for an amber but is slower than this at the line when it turns red stops
    stopBehindLine: 0.5, // metres between a waiting car's front bumper and the stop line
    stopClearance: 2.3, // metres: a waiting car stands back until its front is this far from every other approach's junction curve ...
    stopBackMax: 8, // ... but never more than this many metres behind the line
    boxNudgeTime: 6, // seconds stopped inside a junction after which other AI cars no longer hold a car back (breaks a mutual block)
    uTurnReach: 2.5, // metres a U-turn's curve reaches forward beyond the width it turns across (dead ends)
    mapEdgeRange: 40, // metres: a dead end this close to the map's edge is a road leaving the map (cars drive off it)
    // roundabout (Washington Circle): entering cars yield to circulating ones
    ringSpeed: 8.5, // m/s (31 km/h): top speed on the roundabout ring and through its nodes
    ringYieldDist: 34, // metres along the ring: circulating cars closer than this to an entry ...
    ringYieldTime: 3.6, // ... and under this many seconds away make entering cars wait
    ringYieldNear: 10, // metres: a circulating car this close to the entry always makes entering cars wait
    ringConflictDist: 16, // metres (audit): an entry with a circulating car this close ...
    ringConflictTime: 2, // ... and under this many seconds away counts as a failure to yield
    shortLaneGreenLeft: 3, // seconds: a car enters a lane too short to stop on before a fixed-time signal only with this much green left (else it reaches the line on red)
    ringEntryCreep: 3.5, // m/s: top speed at a roundabout entry line (and reaching it through a lane too short to stop on, K St at the circle): a car can still stop there
    ringExitFreeze: 4, // metres before a ring node: a circulating car's choice to leave or go round again is final from here (entering cars rely on it)
    ringExitDecide: 9, // metres before a ring node: a car leaving the ring from an inner lane checks the lanes outside it from here ...
    ringExitGap: 10, // ... and goes round again if a car in an outer lane is level with it or up to this many metres behind
    // lane changes (multi-lane roads: Key Bridge, Pennsylvania Ave, K St, the freeway, the circle)
    laneChangeRate: 1.5, // m/s sideways while changing lanes
    laneChangeMinRoom: 16, // metres before the stop line: a lane change not started by here is given up (turn from the lane you are in)
    laneChangeGapAhead: 4, // metres kept to a car ahead in the target lane (plus 0.6 s at our speed)
    laneChangeGapBehind: 5, // metres kept to a car behind in the target lane (plus 1.2 s of its closing speed)
    // audit (trafficAudit.ts, only when tests switch it on)
    wrongLevelGap: 2.5, // metres: an AI car this far above or below its lane is on the wrong level
    stuckReport: 20, // seconds stopped that count as stuck (gridlock) in the audit
  },
  signals: {
    // actuated: detector loops at the stop lines (AI cars and your car) call a phase and keep it green while traffic comes
    green: 18, // seconds: longest green for a phase carrying a junction's biggest road
    greenSide: 10, // seconds: longest green for every other phase
    minGreen: 6, // seconds: shortest green
    detectDist: 70, // metres: a car this close to a red stop line calls its phase
    passageDist: 30, // metres: a car still driving toward a green stop line within this keeps the green (up to the longest green)
    checkEvery: 0.5, // seconds between detector checks during a green
    amber: 3, // seconds of amber
    allRed: 1.5, // seconds of all-red between phases
    pedPhase: 7, // seconds of all-red (people cross) at a signal with only one traffic phase (a mid-block crossing)
    oppositeAngle: 2.4, // radians: two approaches this close to head-on share a phase
  },

  peds: {
    maxPopulation: 60, // people created at load (the quality preset's pedBudget caps how many are active: 30 / 45 / 60)
    recycleDistance: 100, // metres: walkers further than this (and out of view) are moved back near you, to a busy spot (just past the density radius)
    // Crowd density from the map (pedDensity.ts): every walk link gets people-per-metre from the road beside it (or
    // its path kind), the shops / cafes / restaurants / bars near it and the hour; the links around you add up to a
    // real-world head count, which is scaled to the quality budget. People appear and leave out of view to follow it.
    density: {
      radius: 90, // metres around you whose pavements set the crowd target (about what you can see on a street)
      shopRadius: 40, // metres: shops, cafes, restaurants and bars this close to a walk link make it busier
      shopKinds: ['shop', 'cafe', 'diner', 'bar', 'market'], // place kinds that count as shops
      perShop: 0.0125, // people per metre of pavement per shop nearby, at the peak of the 'shops' day curve
      shopCap: 14, // shops counted at most per link (a busy block is busy, not absurd)
      crossingShopShare: 0.5, // crossings get this share of their shop term (people cross, they don't linger)
      roadSearch: 16, // metres: a sidewalk takes its road class from the nearest lane this close
      // people per metre at the peak of the link's day curve: sidewalks by the class of the road beside them ('homes'
      // curve), path kinds by kind (towpath and park paths: 'outdoor'; waterfront and plazas: 'waterfront')
      base: { primary: 0.03, secondary: 0.026, tertiary: 0.03, residential: 0.035, service: 0.01, parkway: 0.004, towpath: 0.04, path: 0.022, waterfront: 0.12, plaza: 0.1, crossing: 0.008 },
      // hourly multipliers of those peaks, hour 0..23 (linear in between)
      hours: {
        shops: [0.12, 0.07, 0.04, 0.03, 0.03, 0.05, 0.12, 0.25, 0.4, 0.5, 0.6, 0.8, 1, 1, 0.8, 0.7, 0.7, 0.75, 0.8, 0.8, 0.7, 0.5, 0.3, 0.2], // lunch rush, then dinner
        homes: [0.06, 0.03, 0.02, 0.02, 0.03, 0.1, 0.35, 0.7, 0.8, 0.5, 0.45, 0.5, 0.55, 0.55, 0.5, 0.55, 0.7, 0.85, 0.9, 0.75, 0.55, 0.35, 0.2, 0.1], // commutes, quiet nights
        waterfront: [0.1, 0.05, 0.03, 0.02, 0.02, 0.05, 0.15, 0.25, 0.3, 0.35, 0.45, 0.55, 0.7, 0.7, 0.65, 0.65, 0.7, 0.8, 0.95, 1, 1, 0.85, 0.5, 0.25], // evenings
        outdoor: [0.02, 0.01, 0.01, 0.01, 0.02, 0.15, 0.6, 0.8, 0.6, 0.45, 0.45, 0.5, 0.6, 0.55, 0.5, 0.55, 0.7, 0.9, 1, 0.8, 0.45, 0.2, 0.08, 0.04], // early joggers, after-work walks
      },
      fullBudgetAt: { grid: 24, georgetown: 100 } as Record<string, number>, // by map: the real head count near you that fills the quality's whole pedBudget (Georgetown: M St at lunch); smaller counts scale down in proportion. The grid city has one place per block face (each standing for a row of shops), so its counts run ~4x lower: 24 keeps its downtown afternoon crowd at the full budget, as before
      minActive: 4, // never fewer people than this near you, even at 4 am
      updateInterval: 0.5, // seconds between recomputing the target around you
      changesPerSecond: 4, // people added or removed per second at most while the crowd follows the target
      slack: 1, // the crowd may be this many people off the target before anyone is added or removed
      spawnMinDist: 28, // metres: new people appear at least this far from you, and out of view
      despawnMinDist: 40, // metres: people leave only this far from you, and out of view
      intoViewChance: 0.8, // chance someone who appears (out of view) walks towards a busy spot in view, so the street you look at fills up
      outdoorBoost: { towpath: 8, waterfront: 5, path: 3, plaza: 2 }, // dog walkers and joggers: spawn weight on these path kinds
      outdoorRouteCost: 0.5, // dog walkers and joggers: towpath, waterfront and park paths cost this share of their length (routes prefer them)
      outdoorTripChance: 0.6, // chance a dog walker or jogger heads for a towpath / waterfront spot rather than a park or pier
      outdoorTripRange: 450, // metres: how far away that spot may be...
      outdoorTripMin: 40, // ...and how near (a trip, not a step)
      errandChance: 0.55, // chance someone heads to a shop or cafe near them instead of their routine stop
      errandRange: 150, // metres: how far that shop may be
    },
    kidScale: 0.62, // size of children next to adults
    capsuleRange: 35, // metres: people's collision capsules are only active this close to you
    dogBarkDistance: 7, // metres: dogs bark at you when you're this close
    dogBarkCooldown: 7, // seconds between barks
    wallClearance: 0.4, // metres people keep from walls and water when fleeing, dodging or flung off the pavement
    // archetypes: how common (weight), how fast (x walk speed) and how big (scale range)
    archetypes: {
      adult: { weight: 10, speed: 1.0, scale: [0.92, 1.08] },
      jogger: { weight: 2, speed: 2.3, scale: [0.95, 1.05] },
      delivery: { weight: 1.6, speed: 1.25, scale: [0.95, 1.05] },
      tourist: { weight: 2, speed: 0.8, scale: [0.92, 1.05] },
      elderly: { weight: 2, speed: 0.6, scale: [0.88, 0.96] },
      family: { weight: 1.6, speed: 0.9, scale: [0.95, 1.05] }, // a parent and a kid walking together
      dogwalker: { weight: 1.6, speed: 0.9, scale: [0.95, 1.05] },
    },
    count: 40, // pedestrians walking routines
    walkSpeed: 1.4, // m/s
    fleeSpeed: 4.8, // m/s
    fleeTime: 6, // seconds spent fleeing after a scare
    dodgeDistance: 9, // a car closer than this and heading at them makes them dodge
    dodgeCarSpeed: 6, // m/s car speed that counts as a threat
    hitSpeed: 3.5, // m/s car speed that knocks a pedestrian down
    knockdownTime: 7, // seconds lying down after being hit
    memoryRadius: 35, // NPCs within this distance remember what you did
    idleTimeMin: 4, // seconds idling at a point of interest
    idleTimeMax: 18,
  },

  economy: {
    startingCash: 150, // $ the player starts with
    taxi: {
      baseFare: 12, // $ flag fall
      perMetre: 0.06, // $ per metre of straight-line trip distance
      minTripDistance: 280, // m: destinations are at least this far
      maxTripDistance: 900, // m
      expectedSpeed: 11, // m/s used to compute the time allowance
      routeLaneSearch: 60, // metres: the time allowance follows the roads from the lanes this close to the start and the drop-off
      offRoadDetour: 1.4, // allowance distance = this x the straight line when either end has no lane near it (or no route)
      timeBonusMax: 25, // $ extra for beating the time allowance by a lot
      tipFraction: 0.25, // tip = this fraction of the fare when no crash happened
      crashTipLossDamage: 3, // health lost during a fare that voids the tip
      pickupRadius: 7, // m from marker to count as arrived
      stopSpeed: 2.5, // m/s: must be this slow to load/unload
      nextFareDelay: 2, // s before a new fare appears
      lateAfterFactor: 2.2, // fare is "late" after this multiple of the time allowance (pay reduced)
      lateFareFactor: 0.6, // pay multiplier when late
      homeDestShare: 0.15, // share of fares going to someone's home rather than a shop, restaurant, hotel, museum or park
      crossStreetRange: 160, // metres: the HUD names the destination's nearest cross street within this ("M St NW at 31st St NW")
    },
    dealership: {
      prices: { hatchback: 900, sedan: 1600, pickup: 2200 }, // $ per car type at a dealership
      // what each showroom has on display (2–4 cars, one list per dealership in order)
      stock: [
        ['hatchback', 'sedan', 'hatchback'],
        ['pickup', 'sedan', 'pickup', 'hatchback'],
        ['sedan', 'hatchback', 'pickup', 'sedan'],
      ],
      slotOffsets: [-7.5, 7.5, -15, 15], // metres along the kerb from the dealership's door for each display car
      slotClearance: 6.5, // metres: a display slot must be this far from any other car (and other POIs' taxi stops)
      kerbNudge: 0.3, // metres from a POI's taxi-stop line out to the parking lane, so traffic passes display cars
      laneClearance: 2, // metres: a display slot this close to the centre of a lane traffic uses would block it (left out)
      signOut: 1.2, // metres from the dealership door towards the kerb where its sign stands
      restockSeconds: 600, // real seconds before a sold display car is replaced
      restockMinDistance: 60, // metres: restocking only happens while you are at least this far away
      maxSites: { grid: 2, georgetown: 3 } as Record<string, number>, // dealerships per map: car dealers first, then big car parks (used-car lots), then garages, then shops
      minSiteSpacing: 200, // metres between dealerships
      lotSearch: 140, // metres: a dealership with a car park this close shows its cars in the car park's bays (else at the kerb)
      lotMinBays: 12, // car parks with fewer bays than this are not used as showrooms or used-car lots
      lotSignOut: 2.6, // metres from the first display bay, along the row, to a car-park showroom's sign (the next bay, kept empty)
    },
  },

  police: {
    heatPerPedHit: 40, // heat points for knocking someone down
    heatPerCarHit: 14, // heat points for ramming a traffic car
    heatPerPoliceHit: 30, // heat points for ramming a police car
    heatPerStar: 40, // heat points per wanted star (5 stars max)
    maxStars: 5,
    dispatchTime: 14, // seconds after a crime during which police know exactly where you are
    loseSightTime: [0, 8, 11, 14, 18, 22], // seconds out of sight needed to lose each star level
    vehicleSwapBonus: 0.5, // fraction of the lose timer instantly cleared when you switch cars unseen
    sightRange: 120, // metres police can see you
    carsPerStar: 1, // police cars per star
    maxCars: 5,
    spawnDistance: 160, // metres from player they spawn
    spawnLanesLooked: 24, // dispatch: at most this many of the best spawn lanes (by distance and camera) are looked at (a sight ray each) ...
    spawnRouteChecks: 8, // ... and the best this many of them out of sight get a route check ...
    spawnRoutePenalty: 400, // ... and every this many metres of driving to your last known position counts as much as being in front of the camera vs behind it
    spawnMaxDrive: 700, // metres: a dispatch spot whose drive to you is longer than this is only used if none further out (or in view) is shorter
    spawnFarFactor: 3, // ... looking out to this many times spawnDistance
    chaseSpeed: [0, 14, 17, 20, 23, 26], // m/s by star level
    accel: 7, // m/s²
    directChaseRange: 45, // metres: drive straight at the player when visible this close ...
    directChaseLevelGap: 3, // ... and no more than this many metres above or below (a deck over the road is out of reach)
    searchRadius: 160, // metres: after reaching your last known position, police cruise to lanes within this of it
    offRoadRejoin: 10, // metres off its lane (after a direct chase) before a police car rejoins the nearest lane
    rejoinSearch: 80, // metres: how far a police car looks for a lane to rejoin
    goalLaneRange: 400, // metres: police route to the lane nearest your last known position within this distance
    bustTime: 3.5, // seconds stopped next to police before you are busted
    bustRange: 7, // metres
    bustFineFraction: 0.2, // fraction of cash lost when busted
    callPoliceHeat: 25, // heat from an NPC phoning the police
  },

  npc: {
    relationshipOnHit: -60, // relationship change when you knock someone down
    relationshipOnChat: 2, // per friendly exchange
    relationshipOnInsult: -15,
    relationshipOnCompliment: 6,
    relationshipOnFareNearby: 3, // finishing a fare near someone impresses them
    memorySize: 5, // things each NPC remembers about you
    callPoliceBelow: -70, // relationship at which an angry NPC calls the police
    relationshipOnCarTheft: -65, // the owner of a car you steal (enough to hold a grudge)
    relationshipOnSawTheft: -10, // people who saw you take a car
  },

  health: {
    max: 100,
    beltedSafeImpact: 13, // m/s of crash impact a belted driver takes without injury (~47 km/h)
    crashHurtPerMs: 3.2, // health lost per m/s of impact above that
    footHitMinSpeed: 3, // m/s: a car slower than this just nudges you on foot
    footHitPerMs: 5, // health lost per m/s of car speed when hit on foot
    footKnockback: 0.7, // fraction of the car's speed you are thrown at
    regenDelay: 8, // seconds without damage before healing starts
    regenPerSec: 0.6, // health per second while healing on your own
    injuredBelow: 40, // under this: slower run, camera sway, red vignette
    injuredSpeedFactor: 0.6, // run speed multiplier while injured
    swayAmount: 0.025, // camera sway (radians) while injured
    clinicRange: 4.5, // metres from the clinic door to get treated
    clinicFeePerHp: 0.6, // $ per missing health point at the clinic (capped by your cash)
    deathFade: 2.5, // seconds the screen fades to black
    deathScreen: 4.5, // seconds before you wake up
    deathTimeSkip: 30, // game-world seconds that pass while you're out
    deathFeeCap: 120, // most the hospital bill can ever be (never more than your cash)
  },

  damage: {
    subdivisions: 2, // body triangles are split 4^n times so dents bend panels smoothly
    dentThreshold: 4.5, // m/s of impact before the body dents
    dentPerMs: 0.035, // dent depth (m) per m/s of impact above the threshold
    maxDentPerHit: 0.22, // deepest dent one hit can make (m)
    maxDent: 0.4, // no vertex is ever pushed further than this from its original place (m)
    dentRadius: 0.65, // base dent radius (m)
    dentRadiusPerMs: 0.02, // dent radius grows with impact speed (m per m/s)
    bumperHangSpeed: 7, // m/s impact on the front/rear that knocks a bumper loose
    bumperFallSpeed: 12, // m/s impact that rips it off in one go (or any hit over hang speed once loose)
    headlightBreakSpeed: 6, // m/s front impact that smashes the headlight on that side
    crackSpeed: 9, // m/s front impact that cracks the windscreen (any direction: 1.4x this)
    debrisPool: 24, // fallen-off parts kept in the world at once
    debrisLifetime: 45, // seconds a fallen part lies in the road
  },

  weather: {
    minDuration: 150, // real seconds a weather type lasts at least (150 s = 2.5 game hours)
    maxDuration: 420, // ...and at most
    blendSeconds: 25, // how long a change of weather takes to roll in
    fogVisibility: 90, // metres you can see in fog
    rainGrip: 0.82, // tyre grip multiplier on wet roads
    stormGrip: 0.75, // tyre grip in a storm (standing water)
    snowGrip: 0.62, // tyre grip on snow
    lightningMin: 4, // seconds between lightning strikes (min)
    lightningMax: 14, // ...and max
    // chance weights for what comes next
    transitions: {
      clear: [['clear', 3], ['cloudy', 4], ['fog', 1]],
      cloudy: [['clear', 3], ['rain', 3], ['fog', 1], ['snow', 0.6], ['cloudy', 1]],
      fog: [['clear', 2], ['cloudy', 2]],
      rain: [['cloudy', 3], ['storm', 1.5], ['rain', 1]],
      storm: [['rain', 3], ['cloudy', 1]],
      snow: [['cloudy', 3], ['snow', 1]],
    },
  },

  audio: {
    masterVolume: 0.55,
    engineIdleHz: 38,
    engineMaxHz: 165,
    screechSlipThreshold: 0.25, // lateral slip (m/s ÷ speed) before tyres squeal
    hornVolume: 0.25,
    yelpVolume: 0.32, // a hurt dog's "ki-yi"
    alarmVolume: 0.13, // car alarm loudness right next to it
    alarmRange: 120, // metres until a car alarm fades out
    alarmLowHz: 620, // the alarm hops between these two pitches...
    alarmHighHz: 1040, // ...and the high one
    alarmHopHz: 2.2, // ...this many times a second
    smashVolume: 0.5, // breaking glass
  },

  items: {
    hotbarSlots: 9, // one-hand items you can carry
    pickupRange: 1.8, // metres: how close an item must be to pick it up
    pickupCone: 0.4, // how directly you must face it (dot product; 0.4 ≈ within 66°)
    dropSpeed: 1.4, // m/s an item is tossed forward when dropped with Q
    litterCount: 70, // bottles, cans and bags scattered along pavements
    bagClusterChance: 0.45, // chance a shop/diner/bar has rubbish bags outside
    boxChance: 0.5, // chance it has cardboard boxes
    coneClusters: 5, // roadworks: lines of traffic cones on a kerb
    conesPerCluster: 4,
    brickPiles: 3,
    bricksPerPile: 5,
    batsPerGym: 2, // baseball bats lying by a gym
    gymsWithBats: 2, // how many gyms have bats outside
    wrenchesPerGarage: 3, // wrenches by each garage
    // where seeded items may lie (scatterItems): never in a building or the water, never at an edge
    waterClearance: 0.3, // metres: a spot whose surface is less than this above water is in the water
    edgeProbe: 0.35, // metres out on four sides where the surface is checked (and must be free of buildings)...
    maxStep: 0.12, // ...and must be within this of the item's (no deck, pier, kerb or stair edge right beside it)
    wallProbe: 0.2, // metres: an item this close to a wall (or the map edge) on any side would stick into it: left out
    // per item: mass (kg), throwable with left click, heavy = hitting someone with it is assault,
    // hitDamage = NPC damage from a full-speed throw, melee = left click swings it instead
    defs: {
      bottle: { name: 'Glass bottle', mass: 0.4, throwable: true, heavy: false, hitDamage: 8 },
      can: { name: 'Drink can', mass: 0.3, throwable: true, heavy: false, hitDamage: 4 },
      bag: { name: 'Rubbish bag', mass: 1.5, throwable: true, heavy: false, hitDamage: 2 },
      box: { name: 'Cardboard box', mass: 0.8, throwable: true, heavy: false, hitDamage: 3 },
      cone: { name: 'Traffic cone', mass: 1.2, throwable: true, heavy: false, hitDamage: 5 },
      brick: { name: 'Brick', mass: 2.5, throwable: true, heavy: true, hitDamage: 34 },
      wrench: { name: 'Wrench', mass: 1.0, throwable: false, heavy: true, hitDamage: 20, melee: { damage: 24, reach: 1.5, cooldown: 0.55, dent: 0.1 } },
      bat: { name: 'Baseball bat', mass: 0.9, throwable: false, heavy: true, hitDamage: 18, melee: { damage: 32, reach: 1.9, cooldown: 0.7, dent: 0.16 } },
    },
  },

  combat: {
    chargeTime: 0.9, // seconds to charge a throw to full power
    throwMinSpeed: 7, // m/s of a quick tap throw
    throwMaxSpeed: 19, // m/s of a fully charged throw
    throwBaseElevation: 0.32, // radians upward when the camera is level
    throwPitchFactor: 1.0, // how much looking up/down (camera pitch) changes the throw angle
    throwMinElevation: -0.15,
    throwMaxElevation: 0.95,
    minHitSpeed: 3, // m/s: slower items don't count as hitting someone
    pedHitRadius: 0.42, // metres: how close a thrown item must pass to a person's centre line
    thrownDentPerMomentum: 0.004, // dent depth (m) per kg·m/s of a heavy thrown item
    swingTime: 0.32, // seconds for a full bat/wrench swing
    swingHitAt: 0.45, // fraction of the swing when it connects
    swingArcDot: 0.35, // how wide the swing reaches (dot product with facing)
  },

  reactions: {
    flinchTime: 0.55, // seconds someone staggers after being hit
    stumbleTime: 0.6, // after being shoved
    confrontTime: 9, // seconds a brave person squares up to you
    confrontDistance: 1.8, // metres they stop from you
    yellTime: 2.5,
    knockoutTime: 14, // seconds lying down at 0 health
    healthAfterGettingUp: 45,
    fleeBelowHealth: 45, // hurt people always run
    repeatWindow: 30, // seconds: a second hit within this counts as assault
    shoveCooldown: 1.2, // seconds between complaints when you bump into someone
    shovesToHarass: 3, // shoving the same person this many times is harassment
    shovePush: 0.07, // metres a person is pushed per physics step while you walk into them
    relationshipOnAssault: -55,
    relationshipOnHarass: -20,
    relationshipOnShove: -3,
    // what each personality does after being hit: run, square up, or shout and move on
    styleByPersonality: { friendly: 'flee', grumpy: 'confront', nervous: 'flee', chatty: 'yell', posh: 'flee', laidback: 'yell' },
  },

  hurtFx: {
    // red impact dots (one pooled instanced mesh) and ground stains (one pooled instanced mesh)
    particlePool: 192, // dots that can be in the air at once; never grows (a full pool reuses slots)
    particlesBase: 3, // dots in the smallest burst
    particlesPerStrength: 1.6, // extra dots per unit of impact strength (1 strength = 1 m/s of car impact)
    maxParticlesPerHit: 36, // most dots one hit can make
    strengthPerDamage: 0.35, // hp of damage -> strength, for throws, melee and player injuries (a brick ≈ 12)
    minStrength: 0.5, // weaker hits (a gently lobbed rubbish bag) draw no dots
    spreadBase: 1.4, // m/s the dots fly out at in the smallest burst
    spreadPerStrength: 0.22, // extra m/s of spread per unit of strength
    maxSpread: 6, // m/s cap on the spread
    impactCarry: 0.4, // fraction of the spread added along the blow's direction (dots spray away from it)
    inheritVelocity: 0.8, // fraction of the victim's own fling velocity the dots keep (they travel with them)
    gravity: 14, // m/s² on the dots (heavier than real so bursts stay compact)
    particleLife: 0.6, // seconds a dot lives while it shrinks away (±25% per dot)
    particleSize: [0.03, 0.065], // radius range of one dot (m)
    stainPool: 32, // ground stains kept at once; the oldest is reused when full
    stainsPerStrength: 0.15, // stains per unit of strength, rounded down (a car at 10 m/s leaves 1, at 20 m/s 3)
    maxStainsPerHit: 3,
    stainSize: [0.07, 0.17], // radius range of one stain (m)
    stainLifetime: 60, // seconds a stain takes to fade away completely
    stainOpacity: 0.85, // opacity of a fresh stain
    stainFadeHz: 4, // stain fading is updated this many times a second (it is slow; per frame is wasted work)
    stainLift: 0.065, // metres above the ground a stain is drawn (clears the road markings)
    dropMaxAge: 3, // seconds: a stain-making drop that never lands (fell off the map) is dropped
  },

  dogs: {
    hitCooldown: 0.35, // seconds after a hit before the same dog can be hit again (one bump or swing = one hit)
    carRehitTime: 1.5, // seconds before your car can hit the same dog again (one pass of the car = one hit)
    carSideFling: 0.6, // sideways part of a car hit, × car speed: the dog is flung out of the car's path
    tumbleTimeMax: 0.6, // seconds a dog rolls over after the hardest hits (scaled down for light ones)
    tumbleFullAt: 10, // strength at which the tumble lasts the full time
    knockbackPerStrength: 0.45, // m/s a dog is thrown per unit of strength (a car at 10 m/s throws it at 4.5 m/s)
    maxKnockback: 8, // m/s cap
    hopBase: 1.2, // m/s upward when hit
    hopPerStrength: 0.12, // extra m/s upward per unit of strength
    maxHop: 4, // m/s cap
    gravity: 18, // m/s² while tumbling
    groundFriction: 6, // how fast a tumbling dog slides to a stop on the ground (per second)
    limpTime: 9, // seconds a hurt dog limps, runs back to its owner and stays at their legs
    maxLimpTime: 20, // repeated hits stack the limp up to this
    runToOwnerSpeed: 4.5, // m/s a hurt dog runs back to its owner
    limpRoll: 0.18, // radians a limping dog lurches from side to side
    hitRadius: 0.38, // metres: how close a thrown item must pass a dog's centre (× dog size)
    hitHeight: 0.75, // metres: thrown items higher than this pass over a dog (× dog size)
    meleeReachExtra: 0.3, // metres added to a weapon's reach against a dog
    ownerScreamTime: 1.3, // seconds the owner screams before getting the phone out
    yelpHearRadius: 14, // metres: people this close react to the yelp even without line of sight
    relationshipOwner: -85, // the owner's relationship with you after you hurt their dog
    ownerMoodDrop: 0.8, // how much the owner's mood drops (mood runs -1..1)
    relationshipWitness: -25, // everyone nearby who saw it
    bystanderFleeRadius: 18, // metres: walkers this close run from the scene
    bystanderFleeTime: 4, // seconds they run
  },

  witness: {
    // heat a completed 999 call adds for each kind of crime (40 heat = 1 star). Hurting a dog is taken very
    // personally: 60 heat (2 stars) from one call, more than knocking a person down.
    heat: { pedHit: 40, assault: 32, harassment: 20, vandalism: 14, menace: 12, ramming: 16, ramPolice: 34, dogAttack: 60, carTheft: 30 },
    // metres within which people can witness each crime (they also need line of sight).
    // carTheftAlarm: while a car alarm sounds everyone this close turns to look, so they can witness the theft
    radius: { pedHit: 45, assault: 35, harassment: 22, vandalism: 26, menace: 14, ramming: 32, ramPolice: 40, dogAttack: 45, carTheft: 24, carTheftAlarm: 55 },
    // bystander reaction weights are multiplied by these when the crime is hurting a dog: far more call or square up
    dogAttackReaction: { call: 2, film: 1, flee: 0.5, confront: 2.5 },
    maxWitnesses: 8, // nearest people considered per crime
    callTimeMin: 2.0, // seconds the phone is visibly at their ear before the call goes through
    callTimeMax: 3.0,
    filmTime: 6, // seconds someone films before moving on
    extraCallerHeat: 5, // a second caller about the same crime adds a little more
    searchTime: 20, // seconds police head for the reported spot with the escape timer paused
    menaceCooldown: 8, // seconds between "waving a weapon" reports
    // chance the victim calls 999 themselves (after flinching), by personality
    victimCall: { friendly: 0.95, posh: 1, nervous: 0.9, chatty: 0.8, laidback: 0.5, grumpy: 0.35 },
    // bystander reactions by archetype (relative weights)
    byArchetype: {
      adult: { call: 4, film: 1, flee: 4, confront: 1 },
      jogger: { call: 1, film: 0.2, flee: 6, confront: 0.5 },
      delivery: { call: 2, film: 1, flee: 2, confront: 3 },
      tourist: { call: 1, film: 6, flee: 2, confront: 0.2 },
      elderly: { call: 7, film: 0, flee: 2, confront: 0.5 },
      parent: { call: 5, film: 0, flee: 5, confront: 1 },
      dogwalker: { call: 3, film: 1, flee: 3, confront: 2 },
    },
    // personality multipliers on those weights
    personality: {
      friendly: { call: 1.3, film: 1, flee: 1, confront: 0.5 },
      grumpy: { call: 0.8, film: 0.5, flee: 0.5, confront: 3 },
      nervous: { call: 1, film: 0.3, flee: 2, confront: 0 },
      chatty: { call: 1, film: 2, flee: 1, confront: 0.7 },
      posh: { call: 2, film: 0.5, flee: 1, confront: 0.3 },
      laidback: { call: 0.5, film: 1.5, flee: 1, confront: 0.7 },
    },
  },

  // Georgetown world generator v2 (src/systems/map/): the physical shape of streets, decks and water that cars,
  // people and the road graph depend on. Pure looks (colours, window sizes, LOD distances) live in the art files.
  geo: {
    laneWidth: 3.3, // m per lane; the map data's carriageway width is lanes x laneWidth
    minTwoWayWidth: 5.6, // m: a two-way street tagged with 1 lane is widened to this (two narrow lanes)
    sidewalkWidth: 3, // m from the kerb to the back of the sidewalk (the data's sidewalk lines run 1.5 m from the kerb)
    kerbHeight: 0.15, // m step from road to sidewalk; car wheels feel it, people step up it
    cornerRadius: 6, // m kerb radius at street corners
    maxGrade: 0.075, // steepest grade (rise/run) the generator gives ramps and bridge approaches
    roadClearance: 5, // m of headroom under a deck that crosses a road
    pathClearance: 2.6, // m of headroom under a deck that crosses a towpath or trail
    waterClearance: 2.4, // m from canal / creek water to the underside of a deck
    freewayClearance: 7, // m: the elevated freeway deck stays this far above the street below it
    deckThickness: 1.1, // m from deck surface to its underside
    stairWallFrom: 0.2, // m: a stair's side walls start once it has risen this far above its foot (the flat run-in stays open)
    columnRoadClear: 1.6, // m: a bridge / freeway column (and its sample points) keeps this far from a carriageway below, so it never stands in a lane
    parapetHeight: 1.05, // m: bridge and freeway parapets (solid, cars bounce off)
    riverLevel: 0, // m: the Potomac surface (map heights are metres above the river)
    canalLevels: [5.2, 4.4, 3.6, 2.8, 2.0], // m: canal water west of lock 4, then after locks 4, 3, 2, 1 (east)
    canalDepth: 1.6, // m of water in the canal
    creekDepth: 1.2, // m of water in Rock Creek
    treeColliderRoadDist: 9, // m: trees closer than this to a carriageway get a trunk collider
    stallWidth: 2.6, // m: painted parking bay width in car parks
    stallLength: 5.2, // m: parking bay length
    lotAisle: 6.6, // m: aisle between bay rows
  },

  quality: {
    default: 'medium', // preset used until the player picks one in the pause menu
    // resolutionScale multiplies the (capped) device pixel ratio; pedBudget = pedestrians active near the player
    // textureRes = px per side of every baked surface map (procedural PBR, render/texBake.ts); anisotropy = texture
    // filtering samples; textureDetail 1 = normal maps and baked occlusion on, 0 = off (cheaper pixels)
    // shadowMapSize = px per side of each of the sun's two shadow cascades (near and far); shadowDistance = metres the
    // cascades reach from the camera (beyond it, no sun shadows); treeNear = metres within which trees are drawn in full
    // detail (bark trunk, branches, leaf cards; render/trees.ts), 0 = never
    low: { resolutionScale: 0.7, maxDevicePixelRatio: 1, shadows: false, shadowMapSize: 512, shadowDistance: 0, pedBudget: 30, textureRes: 256, anisotropy: 2, textureDetail: 0, treeNear: 0, lampLights: 0 },
    medium: { resolutionScale: 1, maxDevicePixelRatio: 1.25, shadows: true, shadowMapSize: 1536, shadowDistance: 320, pedBudget: 45, textureRes: 512, anisotropy: 8, textureDetail: 1, treeNear: 110, lampLights: 6 },
    high: { resolutionScale: 1, maxDevicePixelRatio: 2, shadows: true, shadowMapSize: 2048, shadowDistance: 650, pedBudget: 60, textureRes: 1024, anisotropy: 16, textureDetail: 1, treeNear: 200, lampLights: 10 },
  },

  look: {
    // sky (three's Preetham sky, render/sky.ts) and image-based lighting from it
    skyBoxSize: 1200, // m: the sky box around the camera (drawn at the far plane)
    skyTurbidity: 3.2, // haze in clear weather (2 = very clear, 10 = hazy); clouds raise it
    skyRayleigh: 0.85, // blue scattering strength
    skyMie: 0.004, // aerosol scattering
    skyMieG: 0.82, // forward glow round the sun
    skyCloudClear: 0.18, // cloud cover drawn in clear weather (the weather's cloud value raises it)
    envCubeSize: 128, // px per face of the sky capture that lights everything (PMREM)
    envRefreshDegrees: 1.5, // recapture the sky when the sun has moved this far...
    envRefreshMinSeconds: 1.5, // ...but at most this often (real seconds)
    envIntensityDay: 1.0, // scene.environmentIntensity by day (sky light on PBR materials)
    envIntensityNight: 0.35, // at night (the night sky is dark anyway; this keeps a little moonlit fill)
    skyDiffuseDay: 0.42, // share of the sky light that reaches diffuse surfaces by day (reflections keep it all): sets how
    // bright the shade is next to sunlight (about 1:4 on a clear day)
    skyDiffuseNight: 1.0,
    skyDiffuseSaturation: 0.55, // colour saturation of that sky fill (1 = the sky's own blue; lower stands in for the warm
    // light bounced off sunlit streets and walls, which the sky capture does not hold)
    nightSkyZenith: [0.006, 0.008, 0.018], // linear radiance of the night sky overhead...
    nightSkyHorizon: [0.035, 0.028, 0.026], // ...and near the horizon (city glow)
    overcastDim: 0.62, // how much darker the sky (and so its light) gets under full cloud
    groundBounce: 0.45, // brightness of the ground below the horizon in the sky capture by day (bounce light from below)
    sunIntensity: 6.5, // sunlight at noon (the day/night keys scale it toward dawn and dusk)
    moonIntensity: 0.25, // night key light
    exposureDay: 0.86, // tone mapping exposure by day (ACES filmic)
    exposureNight: 1.1, // at night (eyes adapt)
    hemiDay: 0.12, // hemisphere fill by day (the sky environment does most of it)
    hemiNight: 0.32, // at night (city glow and moonlight)
    shadowRadius: 2.2, // soft shadow filter radius (shadow map texels) on Medium/High
    shadowBias: -0.0004,
    shadowNormalBias: 0.035,
    interiorDay: 0.35,
    lampLightRange: 24, // m: reach of the real lights at the street lamps nearest the camera (render/nightLights.ts)
    lampLightIntensity: 55, // candela-like intensity of one lamp at full night
    lampLightsMax: 10, // the most lamp lights any preset uses (TUNING.quality.*.lampLights) // daylight reaching window interiors, relative (window glass, render/facadeMaterial.ts)
  },

  debug: {
    spikeMs: 33, // a frame longer than this counts as a spike in the F3 overlay
    spikeWindow: 10, // seconds of history for the spike counter and worst frame
  },

  hud: {
    minimapRange: 220, // metres shown across the minimap radius
    minimapSize: 190, // pixels
    minimapBaseScale: 1.2, // pixels per metre of the pre-rendered map image behind the minimap
    minimapLabelPx: 10, // street-name font size on the minimap (pixels)
    minimapLabelSpacing: 260, // metres between repeated street-name labels along a long street
    minimapLabelMinLength: 60, // metres: shorter named streets get no label
    minimapLabelGapPx: 3, // pixels kept between two street-name labels (a label that would overlap one is left out)
    minimapLabelRepeatPx: 110, // pixels: the same street name is not shown twice closer than this
    minimapDealerBadgePx: 8, // radius of the car dealership badge ($) on the minimap
    minimapRankBadgePx: 6, // radius of the taxi rank badge (T) on the minimap
  },
} as const;

/** Numbers widen to `number` (so code can compute with them); strings stay literal. */
type Widen<T> = T extends number ? number : T extends boolean ? boolean : T extends string ? T : T extends readonly (infer U)[] ? readonly Widen<U>[] : { readonly [K in keyof T]: Widen<T[K]> };
export const TUNING: Widen<typeof RAW> = RAW;

export type CarTypeName = keyof typeof TUNING.vehicles.types;
export type CarSpec = (typeof TUNING.vehicles.types)[CarTypeName];
