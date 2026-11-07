/** Authored interior dimensions and interaction tuning, in metres. No external assets. */
export const INTERIOR = {
  floorHeight: 300, levelSpacing: 18, halfWidth: 5, halfDepth: 6,
  ceiling: 3.2, upperCeiling: 6.7, upperFloor: 3.2,
  doorWidth: 1.6, doorHeight: 2.4, doorInset: 4.65,
  interactRange: 2.8, transitionCooldown: 0.8, returnClearance: 1.1,
  stair: { x: 3.5, z0: -4.3, z1: 1.9, width: 1.6, rise: 3.2, steps: 20 },
} as const;

export type InteriorKind = 'shop' | 'office' | 'warehouse' | 'workshop' | 'apartment' | 'cafe';
export const INTERIOR_SITES: readonly { kind: InteriorKind; title: string; matches: readonly string[]; upstairs: boolean }[] = [
  { kind: 'shop', title: 'Corner Market', matches: ['shop', 'convenience', 'supermarket'], upstairs: false },
  { kind: 'office', title: 'Canal Works Office', matches: ['office', 'bank'], upstairs: true },
  { kind: 'warehouse', title: 'Riverside Dispatch', matches: ['warehouse', 'industrial', 'shop'], upstairs: false },
  { kind: 'workshop', title: 'Community Workshop', matches: ['garage', 'hardware', 'repair'], upstairs: false },
  { kind: 'apartment', title: 'Waterfront Apartment', matches: ['residential', 'home', 'hotel'], upstairs: true },
  { kind: 'cafe', title: 'The Copper Kettle', matches: ['cafe', 'restaurant', 'bar'], upstairs: false },
];
