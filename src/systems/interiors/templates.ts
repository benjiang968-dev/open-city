// Interior templates: lay out a building's floors in its frame (u along the front wall from the door's end, v
// inward) with the PlanBuilder helpers (plan.ts). Stage C: the rowhouse (side-hall plan) and the shop. Each template
// reads its sizes from TUNING.interiors and works inside any footprint (everything is clipped to the inner polygon);
// validatePlan() then drops furniture that does not fit and rejects plans whose doors or stairs do not.
//
// To add a template (Stage D: cafe, garage, office lobby, apartment...): write `(B: PlanBuilder) => void`, add it to
// TEMPLATES with its TemplateId, and teach records.ts chooseTemplate when to pick it.
import { TUNING } from '../../tuning';
import { PlanBuilder, validatePlan, type FinishId, type Plan } from './plan';
import type { BuildingRecord, TemplateId } from './records';
import { hash32 } from './geom';

const I = TUNING.interiors;
const INF = 1e4;

export type Template = (B: PlanBuilder) => void;

/**
 * Rowhouse, side-hall plan (Georgetown's commonest building): the door at one end of the front, a hall along the
 * party wall on that side with the stair rising toward the back, a double parlour beside the hall, the kitchen and
 * dining room across the back. Upstairs (every floor the same): a bedroom across the front, the landing and a corridor
 * beside the stairwell, a bathroom and a small bedroom beside the corridor, a bedroom across the back. All flights
 * stand in the hall band, one above the other; you walk back along the corridor from the head of one to the foot of
 * the next.
 */
export const planHouse: Template = (B) => {
  const P = B.plan, n = P.levels.length;
  const hb = I.hallWidth, cw = I.corridorWidth, L = I.stairLanding, dw = I.innerDoorWidth, dh = I.innerDoorHeight;
  const u0 = B.uf0, u1 = B.uf1, W = u1 - u0;
  const [v0, vb] = B.along(u1 - 0.5);
  const Dm = vb - v0;
  const multi = n > 1;
  let runMax = 0;
  for (let k = 0; k + 1 < n; k++) runMax = Math.max(runMax, B.runOf(k));
  if (W < hb + 0.1 + I.minRoom) { P.errors.push(`house: ${W.toFixed(2)} m inside is too narrow for a hall and a room`); return; }
  if (multi && W < hb + cw + I.minRoom) { P.errors.push(`house: ${W.toFixed(2)} m inside is too narrow for a corridor beside the stairwell`); return; }
  const F = multi ? Math.min(4.5, Math.max(2.2, (Dm - runMax - 2 * L) * 0.5)) : 0;
  const vS = v0 + F + L; // foot of every flight
  const run0 = multi ? B.runOf(0) : 0;
  const vP = multi ? vS + run0 : v0 + Dm * 0.55; // parlour | kitchen
  if (vb - vP < 2.4) { P.errors.push(`house: ${(vb - vP).toFixed(2)} m left behind the stair for the kitchen`); return; }
  const uH = u0 + hb, uC = uH + cw;
  const rnd = hash32(P.id);
  const walls: FinishId[] = ['cream', 'sage', 'blue', 'rose', 'white', 'grey'];
  const wallOf = (k: number) => walls[(rnd >>> (k * 3)) % walls.length];
  B.frontDoor();
  // ------------------------------------------------------------------------------------------- ground floor
  const hall = B.room(0, 'hall', 'hall', -INF, uH, -INF, multi ? vS : vP, 'oak', 'cream');
  if (multi) B.room(0, 'stair', 'stair', -INF, uH, vS, vP, 'oak', 'cream');
  const parlour = B.room(0, 'parlour', 'living', uH, INF, -INF, vP, 'oak', wallOf(0));
  const kitchen = B.room(0, 'kitchen', 'kitchen', -INF, INF, vP, INF, 'tile', 'white');
  const dHall = v0 + 0.95 + dw / 2;
  B.partition(0, uH, v0 - 1, uH, vP, [[dHall - (v0 - 1), dw, dh, null]]);
  B.partition(0, uH, vP, u1 + 1, vP, [[0.35 + dw / 2, dw, dh, null]]);
  if (!multi) B.partition(0, u0 - 1, vP, uH, vP, [[1 + hb / 2, dw, dh, null]]);
  if (multi) B.stair(0, u0 + hb / 2, vS, 0, 1, hb - 0.04, run0, []);
  const vM = (v0 + vP) / 2 + 0.5;
  B.side('sofa', 0, parlour, 1, vM);
  B.furn('coffeeTable', 0, parlour, B.wallU(1, vM - 1, vM + 1) - 1.55, vM, -1, 0);
  B.furn('rug', 0, parlour, (uH + u1) / 2 + 0.25, vM, -1, 0);
  B.against('tvUnit', 0, parlour, uH + I.partition / 2, vM, 1, 0);
  B.side('armchair', 0, parlour, 1, v0 + 0.6);
  B.against('bookshelf', 0, parlour, B.wallU(1, vP - 0.4, vP) - 0.75, vP - I.partition / 2, 0, -1);
  B.furn('floorLamp', 0, parlour, uH + 0.35, vP - 0.4, 1, 0);
  B.side('fridge', 0, kitchen, 1, vP + I.partition / 2 + 0.38);
  B.side('kitchenRun', 0, kitchen, 1, vP + I.partition / 2 + 0.75 + 1.08);
  B.furn('diningTable', 0, kitchen, u0 + 1.45, vP + 1.75, 0, 1);
  B.furn('chair', 0, kitchen, u0 + 1.05, vP + 2.45, 0, -1);
  B.furn('chair', 0, kitchen, u0 + 1.85, vP + 2.45, 0, -1);
  B.furn('chair', 0, kitchen, u0 + 1.05, vP + 1.05, 0, 1);
  B.furn('chair', 0, kitchen, u0 + 1.85, vP + 1.05, 0, 1);
  for (const r of [hall, parlour, kitchen]) B.light(0, r);
  if (multi) B.light(0, 'L0/stair');
  // ------------------------------------------------------------------------------------------- upper floors
  const vF = vS - L, vK = vS + runMax + L;
  const bathD = Math.min(2.4, (vK - vF) * 0.45);
  for (let k = 1; k < n; k++) {
    const top = k === n - 1;
    const front = B.room(k, 'front', 'bedroom', -INF, INF, -INF, vF, 'oak', wallOf(k * 2));
    const core = B.room(k, 'landing', 'landing', -INF, uC, vF, vK, 'oak', 'cream');
    const bath = B.room(k, 'bath', 'bathroom', uC, INF, vF, vF + bathD, 'tile', 'white');
    const study = B.room(k, 'study', 'bedroom', uC, INF, vF + bathD, vK, 'pine', wallOf(k * 2 + 1));
    const back = B.room(k, 'back', 'bedroom', -INF, INF, vK, INF, 'oak', wallOf(k * 2 + 5));
    B.partition(k, u0 - 1, vF, u1 + 1, vF, [[uH + dw / 2 - (u0 - 1), dw, dh, null]]);
    const bathDoor = `L${k}/bathdoor`;
    B.partition(k, uC, vF, uC, vK, [[0.3 + dw / 2, dw, dh, bathDoor], [bathD + 0.25 + dw / 2, dw, dh, null]]);
    B.innerDoor(k, bathDoor, uC, vF + 0.3 + dw / 2, 0, 1, -1);
    B.partition(k, uC, vF + bathD, u1 + 1, vF + bathD);
    B.partition(k, u0 - 1, vK, u1 + 1, vK, [[1 + 0.15 + dw / 2, dw, dh, null]]);
    // the stairwell of the flight below, its railings, and the flight up from here
    const hs = B.holeStart(k - 1), rb = B.runOf(k - 1);
    B.hole(k, u0 - 0.01, uH, vS + hs, vS + rb);
    B.rail(k, uH, vS + hs, uH, vS + rb);
    if (top) B.rail(k, u0, vS + hs, uH, vS + hs);
    if (!top) B.stair(k, u0 + hb / 2, vS, 0, 1, hb - 0.04, hs, [[1, 0]]);
    // furniture
    B.against('bedDouble', k, front, B.wallU(1, v0, vF) - 0.95, v0, 0, 1);
    B.side('wardrobe', k, front, -1, v0 + 1.0);
    B.side('bath', k, bath, 1, vF + 0.12 + 0.85);
    B.against('toilet', k, bath, uC + 0.45, vF + bathD - I.partition / 2, 0, -1);
    B.against('basin', k, bath, uC + 1.15, vF + bathD - I.partition / 2, 0, -1);
    B.side('desk', k, study, 1, vK - 0.8);
    B.against('bookshelf', k, study, uC + 0.75, vK - I.partition / 2, 0, -1);
    B.furn('chair', k, study, B.wallU(1, vK - 1.2, vK - 0.4) - 0.75, vK - 0.8, 1, 0);
    B.side('nightstand', k, back, 1, vK + 0.28);
    B.side('bedDouble', k, back, 1, vK + 1.3);
    B.against('wardrobe', k, back, u0 + 1.0, B.wallV(1, u0 + 0.4, u0 + 1.6), 0, -1);
    for (const r of [front, core, bath, study, back]) B.light(k, r);
  }
};

/**
 * Shop with a flat or office above (M St's shopfronts): the sales floor behind the shopfront with the counter and
 * till by the door, double-sided shelving runs with aisles and wall shelves, a drinks fridge on the back wall; a back
 * room (stock) behind a door; the stair up from the back room; upstairs an office at the front and a stockroom at the
 * back. Floors above the first upper floor are left sealed in Stage C (reported in the plan's notes).
 */
export const planShop: Template = (B) => {
  const P = B.plan, n = P.levels.length;
  const L = I.stairLanding, dw = I.innerDoorWidth, dh = I.innerDoorHeight, sw = I.stairWidthWide;
  const u0 = B.uf0, u1 = B.uf1, W = u1 - u0;
  const [v0, vb] = B.along((u0 + u1) / 2);
  const D = vb - v0;
  if (W < 4) { P.errors.push(`shop: ${W.toFixed(2)} m inside is too narrow`); return; }
  const run0 = n > 1 ? B.runOf(0) : 0;
  const backD = n > 1 ? Math.max(4, L + run0 + L) : Math.max(3, D * (1 - I.shopSalesDepth));
  const vB = n > 1 ? vb - backD : v0 + Math.min(D * I.shopSalesDepth, I.shopSalesMax);
  if (vB - v0 < 5) { P.errors.push(`shop: ${(vB - v0).toFixed(2)} m of sales floor is too shallow`); return; }
  B.frontDoor();
  const sales = B.room(0, 'sales', 'shop', -INF, INF, -INF, vB, 'lino', 'white');
  const back = B.room(0, 'back', 'storage', -INF, INF, vB, INF, 'concrete', 'grey');
  const backDoor = 'L0/backdoor', uD = u1 - 0.35 - dw / 2;
  B.partition(0, u0 - 1, vB, u1 + 1, vB, [[uD - (u0 - 1), dw, dh, backDoor]]);
  B.innerDoor(0, backDoor, uD, vB, 1, 0, 1);
  if (n > 1) B.stair(0, u0 + sw / 2, vB + L, 0, 1, sw - 0.04, run0, []);
  // sales floor: counter and till by the door, shelving runs, wall shelves, the drinks fridge
  B.furn('counter', 0, sales, u0 + 1.55, v0 + 2.75, 1, 0);
  const runs = [u1 - 2.15, u1 - 4.3];
  const vRun0 = v0 + 3.6;
  for (const uR of runs) {
    if (uR - 0.45 < u0 + 2.6) continue;
    for (let vR = vRun0; vR + 1.5 <= vB - 1.25; vR += 3.05) B.furn('gondola', 0, sales, uR, vR, 1, 0);
  }
  for (let vR = v0 + 3.4; vR + 1.2 <= vB - 1.3; vR += 2.5) B.side('wallShelf', 0, sales, 1, vR);
  for (let vR = v0 + 5.0; vR + 1.2 <= vB - 1.3; vR += 2.5) B.side('wallShelf', 0, sales, -1, vR);
  B.against('drinksFridge', 0, sales, u0 + 2.9, vB - I.partition / 2, 0, -1);
  B.side('stockBoxes', 0, back, 1, vB + 1.9);
  B.side('stockBoxes', 0, back, 1, vB + 3.3);
  B.light(0, sales); B.light(0, back);
  // an extra light over the shelving runs (the sales floor is deep)
  const [lx, lz] = B.W((u0 + u1) / 2, (v0 + vB) / 2 + 2.5);
  P.lights.push({ level: 0, room: sales!, x: lx, y: P.levels[0].ceil - 0.12, z: lz });
  // upstairs: office at the front, stockroom at the back, the stairwell with railings
  if (n > 1) {
    const office = B.room(1, 'office', 'office', -INF, INF, -INF, vB, 'oak', 'white');
    const stock = B.room(1, 'stock', 'storage', -INF, INF, vB, INF, 'concrete', 'grey');
    B.partition(1, u0 - 1, vB, u1 + 1, vB, [[uD - (u0 - 1), dw, dh, null]]);
    const hs = B.holeStart(0);
    B.hole(1, u0 - 0.01, u0 + sw, vB + L + hs, vB + L + run0);
    B.rail(1, u0 + sw, vB + L + hs, u0 + sw, vB + L + run0);
    B.rail(1, u0, vB + L + hs, u0 + sw, vB + L + hs);
    B.against('officeDesk', 1, office, (u0 + u1) / 2, vB - I.partition / 2, 0, -1);
    B.side('filing', 1, office, -1, v0 + 1.4);
    B.side('bookshelf', 1, office, -1, v0 + 2.6);
    B.furn('chair', 1, office, (u0 + u1) / 2, vB - 1.3, 0, 1);
    B.side('stockBoxes', 1, stock, 1, vB + 1.9);
    B.side('stockBoxes', 1, stock, 1, vB + 3.3);
    B.light(1, office); B.light(1, stock);
    if (n > 2) P.notes.push(`floors L2-L${n - 1} sealed (no stair above the first floor in the shop template yet)`);
  }
};

export const TEMPLATES: Record<TemplateId, Template> = { house: planHouse, shop: planShop };

/** Plan a building's interior (pure, deterministic from the record) and validate it. */
export function planInterior(rec: BuildingRecord): Plan | null {
  if (!rec.template || !rec.door) return null;
  const B = new PlanBuilder(rec, rec.template);
  try {
    TEMPLATES[rec.template](B);
  } catch (e) {
    B.plan.errors.push(`template threw: ${String(e)}`);
  }
  if (!B.plan.errors.length) validatePlan(B.plan);
  return B.plan;
}
