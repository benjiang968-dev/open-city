// Rapier collision groups. A pair collides when each one's membership is in the other's filter.
export const G = {
  STATIC: 1, // buildings, ground, poles, trees
  PLAYER: 2, // the on-foot player capsule
  VEHICLE: 4, // drivable cars
  AI: 8, // traffic and police cars
  PED: 16, // pedestrian capsules (only the player and thrown items touch them)
  ITEM: 32, // loose world items
  ALL: 0xffff,
} as const;

/** Pack membership and filter into Rapier's 32-bit interaction groups. */
export function groups(member: number, filter: number): number {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

export const GROUPS = {
  static: groups(G.STATIC, G.ALL),
  player: groups(G.PLAYER, G.ALL),
  vehicle: groups(G.VEHICLE, G.ALL & ~G.PED),
  ai: groups(G.AI, G.ALL & ~G.PED),
  ped: groups(G.PED, G.PLAYER | G.ITEM),
  item: groups(G.ITEM, G.ALL),
  /** Wheel raycasts only see the ground, buildings and other cars (not litter or people). */
  wheelRays: groups(G.VEHICLE, G.STATIC | G.VEHICLE | G.AI),
};
