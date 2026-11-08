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

// Keep the original six sites first: their entry IDs, room levels and saved item registry prefix are stable.
export const EXTRA_INTERIOR_SITES: readonly { kind: InteriorKind; title: string; matches: readonly string[]; upstairs: boolean }[] = [
  { kind: 'apartment', title: 'Canal Loft', matches: ['residential', 'home', 'hotel'], upstairs: true },
  { kind: 'apartment', title: 'Georgetown Studio', matches: ['residential', 'home', 'hotel'], upstairs: false },
  { kind: 'apartment', title: 'Riverside Maisonette', matches: ['residential', 'home', 'hotel'], upstairs: true },
  { kind: 'shop', title: 'Paper & Pantry', matches: ['shop', 'convenience'], upstairs: false },
  { kind: 'office', title: 'Neighbourhood Design Office', matches: ['office', 'bank'], upstairs: true },
  { kind: 'workshop', title: 'Canal Repair Shop', matches: ['garage', 'hardware', 'repair'], upstairs: false },
  { kind: 'cafe', title: 'Harbour Coffee', matches: ['cafe', 'restaurant'], upstairs: false },
  { kind: 'warehouse', title: 'Northside Stores', matches: ['warehouse', 'industrial', 'shop'], upstairs: false },
];

// Published v1 property keys refer to these Georgetown POI ids. Do not reassign them after geometry repairs.
export const LEGACY_GEORGETOWN_INTERIOR_POIS = [1569, 133, 1075, 5, 446, 749] as const;
