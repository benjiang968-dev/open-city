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
    fov: 62, // base field of view (degrees)
    fovSpeedBoost: 12, // extra FOV degrees at top speed
  },

  player: {
    walkSpeed: 4.2, // m/s
    runSpeed: 8.5, // m/s with Shift
    jumpVelocity: 6.2, // m/s upward on Space
    gravity: 22, // m/s² for the on-foot controller (snappier than real 9.8)
    turnLerp: 12, // how fast the body rotates to face movement
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

  audio: {
    masterVolume: 0.55,
    engineIdleHz: 38,
    engineMaxHz: 165,
    screechSlipThreshold: 0.25, // lateral slip (m/s ÷ speed) before tyres squeal
    hornVolume: 0.25,
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
