// All sandbox activity prices, timings and ranges use metres, seconds and game days.
export const SANDBOX = {
  boardRange: 4,
  objectiveRange: 1.8,
  stationHoldSeconds: 2,
  trespassGraceSeconds: 10,
  apartmentBuyPrice: 1800,
  apartmentLeasePrice: 90,
  apartmentLeaseDays: 7,
  storageSlots: 18,
  shopDrinkPrice: 5,
  jobs: {
    delivery: { name: 'Neighbourhood delivery', pay: 55, count: 1, startKind: 'warehouse', description: 'Collect the labelled parcel inside the warehouse. Carry that same parcel to the café counter.' },
    cleaning: { name: 'Shop cleaning shift', pay: 40, count: 3, startKind: 'shop', description: 'Pick up the three shift rubbish bags inside the shop. Bring each bag to the disposal point.' },
    repair: { name: 'Office maintenance', pay: 65, count: 3, startKind: 'office', description: 'Collect the supplied wrench. Hold E at each of three maintenance panels for two seconds.' },
    warehouse: { name: 'Warehouse shift', pay: 50, count: 3, startKind: 'warehouse', description: 'Carry the three shift boxes, one by one, to the loading point inside the warehouse.' },
  },
} as const;
export type SandboxJobId = keyof typeof SANDBOX.jobs;
