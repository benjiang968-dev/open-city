// Full sandbox regression. Called by the main browser smoke test; browser setup is intentionally shared.
// Requires production __ocSandbox bridge. Teleportation is test setup; pickups, objectives and payouts use game input.
export async function runSandboxFlow(page) {
  return page.evaluate(() => {
    const w = window.__oc, api = window.__ocSandbox, run = window.__ocRun;
    if (!api) throw new Error('Missing __ocSandbox bridge');
    const fail = m => { throw new Error(m); };
    const assert = (x, m) => { if (!x) fail(m); };
    const e = kind => w.interiors.entries.find(x => x.kind === kind);
    const go = (x, y, z) => {
      w.input.keys.clear(); w.input.pressed.clear();
      w.player.body.setTranslation({ x, y: y + 1, z }, true);
      w.player.vy = 0;
      run(0.15, 60);
    };
    const use = () => { w.input.pressed.add('KeyE'); run(1 / 60, 60); };
    const enter = kind => {
      const entry = e(kind);
      assert(entry, `No ${kind} interior`);
      if (w.interiors.active) api.exitInterior();
      run(0.6, 60);
      go(entry.exterior.x, entry.exterior.y, entry.exterior.z);
      use();
      assert(w.interiors.active === entry.id, `E failed to enter ${kind}`);
      return entry;
    };
    const pick = id => {
      const it = w.itemsState.items[id];
      assert(it?.inWorld, `Missing world item ${id}`);
      const p = it.body.translation();
      go(p.x, p.y - w.itemsState.art[it.type].restY, p.z + 0.5);
      w.player.facing = Math.PI;
      run(0.05, 60); use();
      const slot = w.inventory.slots.findIndex(x => x?.id === id);
      assert(slot >= 0, `E failed to pick item ${id}`);
      w.inventory.selected = slot;
    };
    const objectives = {};
    for (const kind of ['warehouse', 'cleaning', 'repair', 'delivery']) {
      const startKind = kind === 'cleaning' ? 'shop' : kind === 'repair' ? 'office' : 'warehouse';
      const start = enter(startKind);
      assert(api.startJob(kind), `Could not start ${kind}`);
      const active = w.sandbox.save.active;
      const cash = w.cash;
      for (const id of active.items) {
        pick(id);
        if (kind === 'repair') {
          for (let k = 0; k < 3; k++) {
            go(start.origin.x - 1 + k, start.origin.y, start.origin.z - 3.6);
            w.input.keys.add('KeyE'); run(2.1, 60); w.input.keys.delete('KeyE');
          }
        } else {
          const dest = kind === 'delivery' ? enter('cafe') : start;
          go(dest.origin.x + (kind === 'delivery' ? 0 : 2), dest.origin.y, dest.origin.z + (kind === 'delivery' ? -2 : 2));
          use(); use();
        }
      }
      assert(w.sandbox.save.active === null, `${kind} did not complete`);
      const expected = { warehouse: 50, cleaning: 40, repair: 65, delivery: 55 }[kind];
      assert(w.cash === cash + expected, `${kind} paid ${w.cash - cash}, expected ${expected}`);
      use(); assert(w.cash === cash + expected, `${kind} paid twice`);
      objectives[kind] = { pay: expected, completed: true };
    }
    const apartment = enter('apartment');
    const money = w.cash;
    assert(api.rent(apartment.id), 'Apartment rent failed');
    assert(!api.rent(apartment.id), 'Lease duplicate was accepted');
    assert(w.cash === money - 90, 'Lease charged incorrectly');
    // Store a regular, unowned collectible (a shift prop is deliberately ineligible).
    const normal = w.itemsState.items.find(it => it.inWorld && !it.owner && !Object.values(w.sandbox.save.pool).flat().includes(it.id));
    assert(normal, 'No ordinary item available for storage');
    if (w.interiors.active) api.exitInterior();
    pick(normal.id);
    enter('apartment');
    const slot = w.inventory.slots.findIndex(it => it?.id === normal.id); w.inventory.selected = slot;
    assert(api.store(apartment.id), 'Storage deposit failed');
    assert(!api.store(apartment.id), 'Storage accepted duplicate deposit');
    assert(normal.location === 'storage', 'Item not in storage');
    assert(api.retrieve(normal.id), 'Storage retrieval failed');
    assert(!api.retrieve(normal.id), 'Storage returned the same item twice');
    assert(w.inventory.slots.filter(it => it?.id === normal.id).length === 1, 'Storage duplicated instance');
    return { jobs: objectives, apartment: { rented: true, duplicatePaymentRejected: true, storageSameInstance: true } };
  });
}
