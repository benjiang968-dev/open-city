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
    extraDrivableCars: 9, // more drivable cars scattered around the district
  },

  traffic: {
    count: 26, // AI cars on the road graph
    cruiseSpeed: 11, // m/s (~40 km/h)
    accel: 4, // m/s²
    brake: 9, // m/s²
    followGap: 9, // metres kept to the car ahead
    intersectionWait: 0.9, // seconds stopped at each junction
    laneOffset: 3.1, // metres right of centreline
    honkDistance: 10, // player within this in front of a stopped AI car = honk
    honkCooldown: 3, // seconds between honks per car
    swerveDistance: 16, // player car approaching faster than swerveSpeed within this triggers a swerve
    swerveSpeed: 14, // m/s
    swerveOffset: 2.4, // metres sideways when swerving
    spawnMinDistFromPlayer: 25,
  },

  peds: {
    maxPopulation: 60, // people created at load (the quality preset activates 30 / 45 / 60 of them)
    recycleDistance: 230, // metres: walkers further than this (and out of view) are moved closer to you
    respawnMin: 70, // metres from you where they reappear (always out of view)
    respawnMax: 170,
    kidScale: 0.62, // size of children next to adults
    capsuleRange: 35, // metres: people's collision capsules are only active this close to you
    dogBarkDistance: 7, // metres: dogs bark at you when you're this close
    dogBarkCooldown: 7, // seconds between barks
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
      timeBonusMax: 25, // $ extra for beating the time allowance by a lot
      tipFraction: 0.25, // tip = this fraction of the fare when no crash happened
      crashTipLossDamage: 3, // health lost during a fare that voids the tip
      pickupRadius: 7, // m from marker to count as arrived
      stopSpeed: 2.5, // m/s: must be this slow to load/unload
      nextFareDelay: 2, // s before a new fare appears
      lateAfterFactor: 2.2, // fare is "late" after this multiple of the time allowance (pay reduced)
      lateFareFactor: 0.6, // pay multiplier when late
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
    chaseSpeed: [0, 14, 17, 20, 23, 26], // m/s by star level
    accel: 7, // m/s²
    directChaseRange: 45, // metres: drive straight at the player when visible this close
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
    heat: { pedHit: 40, assault: 32, harassment: 20, vandalism: 14, menace: 12, ramming: 16, ramPolice: 34, dogAttack: 60 },
    // metres within which people can witness each crime (they also need line of sight)
    radius: { pedHit: 45, assault: 35, harassment: 22, vandalism: 26, menace: 14, ramming: 32, ramPolice: 40, dogAttack: 45 },
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

  quality: {
    default: 'medium', // preset used until the player picks one in the pause menu
    // resolutionScale multiplies the (capped) device pixel ratio; pedBudget = pedestrians active near the player
    low: { resolutionScale: 0.7, maxDevicePixelRatio: 1, shadows: false, shadowMapSize: 512, pedBudget: 30 },
    medium: { resolutionScale: 1, maxDevicePixelRatio: 1.25, shadows: true, shadowMapSize: 1024, pedBudget: 45 },
    high: { resolutionScale: 1, maxDevicePixelRatio: 2, shadows: true, shadowMapSize: 2048, pedBudget: 60 },
  },

  debug: {
    spikeMs: 33, // a frame longer than this counts as a spike in the F3 overlay
    spikeWindow: 10, // seconds of history for the spike counter and worst frame
  },

  hud: {
    minimapRange: 220, // metres shown across the minimap radius
    minimapSize: 190, // pixels
  },
} as const;

/** Numbers widen to `number` (so code can compute with them); strings stay literal. */
type Widen<T> = T extends number ? number : T extends boolean ? boolean : T extends string ? T : T extends readonly (infer U)[] ? readonly Widen<U>[] : { readonly [K in keyof T]: Widen<T[K]> };
export const TUNING: Widen<typeof RAW> = RAW;

export type CarTypeName = keyof typeof TUNING.vehicles.types;
export type CarSpec = (typeof TUNING.vehicles.types)[CarTypeName];
