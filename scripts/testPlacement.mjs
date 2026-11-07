// Exact geometry regression and full shipped-map audit (no GPU or running game required).
// Usage: node scripts/testPlacement.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { validateBuildingPlacement, roadPlacementObstacles, overlapArea, footprintArea, makeEntranceValidator } = await server.ssrLoadModule('/src/systems/map/placement.ts');
  const { footprintTriangles, footprintConvexPieces } = await server.ssrLoadModule('/src/systems/map/facades.ts');
  const { buildRoadNet } = await server.ssrLoadModule('/src/systems/map/roadNet.ts');
  const { GeoRaster } = await server.ssrLoadModule('/src/systems/map/terrain.ts');
  const rect = (x0, z0, x1, z1) => [[x0,z0],[x1,z0],[x1,z1],[x0,z1]];
  const b = (id, pts, extra = {}) => ({ id, pts, h: 6.4, levels: 2, type: 'house', ...extra });
  const emptyNet = { nodes: [], edges: [], profAt: () => 0 };
  const docOf = buildings => ({ meta: {}, buildings });
  const netOf = (pts, extra = {}) => {
    const L = Math.hypot(pts[1][0]-pts[0][0], pts[1][1]-pts[0][1]);
    return { nodes: [], edges: [{ pts, cum: new Float32Array([0,L]), L, hw: 1, swL: false, swR: false, noSw: [], deck: false, cls: 'service', road: { service:'driveway' }, ...extra }], profAt: () => extra.height ?? 0 };
  };
  // A narrow road enters and exits a long wall between the old corner/midpoint sample positions.
  {
    const doc = docOf([b('long', rect(-20,-10,20,10))]);
    const net = netOf([[-15,-30],[-15,30]]);
    const report = validateBuildingPlacement(doc, net, () => 0);
    assert.equal(report.clipped.length, 1);
    assert.equal(report.drop.length, 0);
    for (const o of roadPlacementObstacles(net).query(doc.buildings[0].pts)) assert.ok(overlapArea([doc.buildings[0].pts], o.polygon) < 1e-6);
  }
  // Nested duplicate sources and crossing rotated shapes are detected even with no contained corner.
  {
    const doc = docOf([b('parent', rect(-5,-5,5,5)), b('contained', rect(-1,-1,1,1)), b('rotated', [[0,-9],[9,0],[0,9],[-9,0]])]);
    const r = validateBuildingPlacement(doc, emptyNet, () => 0);
    assert.equal(r.drop.includes('contained'), true);
    const standing = doc.buildings.filter(x => !r.drop.includes(x.id));
    for (let i=0;i<standing.length;i++) for(let j=i+1;j<standing.length;j++) assert.ok(overlapArea([standing[i].pts], [standing[j].pts]) < 1e-6);
  }
  // AABBs overlap, actual rotated footprints do not: do not move valid buildings.
  {
    const doc = docOf([b('a', [[0,0],[8,8],[7,9],[-1,1]]), b('b', [[2,0],[10,8],[9,9],[1,1]])]);
    const r = validateBuildingPlacement(doc, emptyNet, () => 0);
    assert.equal(r.clipped.length + r.drop.length, 0);
  }
  // Bridge height matters: preserve a low building beneath a sufficiently high deck, clip a tall one.
  for(const height of [30,4]) {
    const doc = docOf([b('below',rect(-5,-5,5,5))]);
    const r = validateBuildingPlacement(doc, netOf([[-10,0],[10,0]], { deck:true, height }), () => 0);
    assert.equal(r.clipped.length+r.drop.length > 0, height === 4);
  }
  // Roof triangulation preserves the L notch and an enclosed courtyard (old fans and hulls filled them).
  {
    const outer = rect(0,0,20,20), hole = rect(5,5,15,15);
    const triangles = footprintTriangles(outer, [hole]);
    assert.ok(Math.abs(triangles.reduce((s,t) => s+footprintArea([t]),0)-300)<1e-6);
    for(const t of triangles) assert.ok(overlapArea([t],[hole])<1e-6);
    const L = [[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]];
    assert.ok(Math.abs(footprintTriangles(L).reduce((s,t)=>s+footprintArea([t]),0)-51)<1e-6);
  }
  // Entrance validation includes the full rotated stair footprint and reserves an uninterrupted pavement corridor.
  {
    const doc = docOf([b('home',rect(0,5,8,12)),b('neighbour',rect(8,5,16,12))]);
    const can = makeEntranceValidator(doc, netOf([[-20,0],[20,0]]), new Set());
    assert.equal(can('home',rect(3,3,5,5)),true);
    assert.equal(can('home',rect(3,1,5,5)),false);
    assert.equal(can('home',rect(7,5.1,9,7)),false);
  }
  const doc = JSON.parse(await readFile('src/data/georgetown.json','utf8'));
  if(doc.meta.companions) doc.buildings.push(...JSON.parse(await readFile('src/data/georgetown-buildings-ccby.json','utf8')).buildings);
  const ras = new GeoRaster(doc.meta.bounds.x0,doc.meta.bounds.z0,doc.meta.bounds.x1,doc.meta.bounds.z1);
  ras.fillBase(doc);
  const baseAt=(x,z)=>ras.baseAt(x,z), net=buildRoadNet(doc,baseAt);
  const start=performance.now();
  const report=validateBuildingPlacement(doc,net,baseAt);
  const standing=doc.buildings.filter(b=>!report.drop.includes(b.id));
  const roads=roadPlacementObstacles(net,true,doc);
  let roadOverlaps=0, neighbourOverlaps=0, roofErrors=0, colliderErrors=0, checkedPairs=0;
  for(let i=0;i<standing.length;i++) {
    const a=standing[i], A=[a.pts,...(a.holes??[])];
    for(const o of roads.query(a.pts)) {
      const roof=Math.max(...a.pts.map(p=>baseAt(...p)))+Math.max(a.h,a.levels*3.2)+2;
      if((!o.deck || roof>o.underside) && overlapArea(A,o.polygon)>1e-4) { roadOverlaps++; console.log("road-overlap", a.id, overlapArea(A,o.polygon), {deck:o.deck, underside:o.underside,roof}); }
    }
    const triangles=footprintTriangles(a.pts,a.holes);
    if(Math.abs(triangles.reduce((s,t)=>s+footprintArea([t]),0)-footprintArea(A))>0.01) roofErrors++;
    const pieces = a.holes?.length ? triangles : footprintConvexPieces(a.pts);
    if(Math.abs(pieces.reduce((s,t)=>s+footprintArea([t]),0)-footprintArea(A))>0.01) colliderErrors++;
    for(const piece of pieces) {
      if(footprintArea([piece])-overlapArea([piece],A)>0.001) colliderErrors++;
      let sign=0;
      for(let k=0;k<piece.length;k++) {
        const p=piece[k],q=piece[(k+1)%piece.length],r=piece[(k+2)%piece.length];
        const cross=(q[0]-p[0])*(r[1]-q[1])-(q[1]-p[1])*(r[0]-q[0]);
        if(Math.abs(cross)<1e-7)continue;
        if(sign&&Math.sign(cross)!==sign)colliderErrors++;
        sign=Math.sign(cross);
      }
    }
    // Independent all-pairs broad phase; this catches errors in the placement spatial index itself.
    const bb=pts=>[Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1]))];
    const ab=bb(a.pts);
    for(let j=0;j<i;j++) {
      const c=standing[j], cb=bb(c.pts);
      if(ab[0]>cb[2] || ab[2]<cb[0] || ab[1]>cb[3] || ab[3]<cb[1]) continue;
      checkedPairs++;
      if(overlapArea(A,[c.pts,...(c.holes??[])])>1e-4) neighbourOverlaps++;
    }
  }
  const result={total:doc.buildings.length,standing:standing.length,clipped:report.clipped.length,dropped:report.drop.length,roadConflicts:report.roadConflicts,neighbourConflicts:report.neighbourConflicts,roadOverlaps,neighbourOverlaps,roofErrors,colliderErrors,checkedPairs,elapsedMs:Math.round(performance.now()-start)};
  console.log(JSON.stringify(result,null,2));
  assert.equal(roadOverlaps,0); assert.equal(neighbourOverlaps,0); assert.equal(roofErrors,0); assert.equal(colliderErrors,0);
  console.log('placement regressions and full shipped-map audit passed');
} finally { await server.close(); }
