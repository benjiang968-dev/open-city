// How people react when the player hits them (thrown items, melee) or shoves them: damage, flinch,
// then flee / confront / yell depending on personality. Raises crime events for witnesses (M2.8).
// Dogs can be hurt too (M3): the dog yelps and limps back to its owner, the owner screams and calls 999.
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import type { Ped } from './pedestrians';
import { startFlee, tumbleDog } from './pedestrians';
import { adjustRelationship, remember } from '../npc/npc';
import { LINES, pick } from '../npc/reactionLines';
import { say } from './bubbles';
import { closeChat } from './chat';
import { victimMaybeCalls } from './witness';
import { hurtBurst } from './hurtFx';

const RX = TUNING.reactions;
const DG = TUNING.dogs;

export type HitCause = 'thrown' | 'melee';

/** The player hit `ped` with something. */
export function hitPed(w: World, ped: Ped, cause: HitCause, damage: number, heavy: boolean, fromX: number, fromZ: number, what: string): void {
  if (ped.state === 'down' || ped.pos.y < -10) return;
  const repeat = w.time - ped.lastHitByPlayer < RX.repeatWindow;
  ped.hitCount = repeat ? ped.hitCount + 1 : 1;
  ped.lastHitByPlayer = w.time;
  ped.health -= damage;
  hurtBurst(w, ped.pos.x, ped.pos.y + 1.2 * ped.scale, ped.pos.z, damage * TUNING.hurtFx.strengthPerDamage, ped.pos.x - fromX, ped.pos.z - fromZ, w.city.heightAt(ped.pos.x, ped.pos.z));
  const assault = heavy || cause === 'melee' || ped.hitCount >= 2;
  const hour = w.dayNight.hour, day = w.dayNight.day;
  remember(ped.npc, 'assaulted', cause === 'melee' ? `hit me with a ${what.toLowerCase()}` : `threw a ${what.toLowerCase()} at me`, hour, day);
  adjustRelationship(ped.npc, assault ? RX.relationshipOnAssault : RX.relationshipOnHarass);
  ped.npc.mood = Math.max(-1, ped.npc.mood - 0.4);
  emit(w, { type: assault ? 'assault' : 'harassment', pedId: ped.id, x: ped.pos.x, z: ped.pos.z, weapon: what });
  if (w.chat.ped === ped) closeChat(w); // nobody keeps chatting after being hit
  if (ped.health <= 0) {
    // knocked out cold
    ped.state = 'down';
    ped.timer = RX.knockoutTime;
    const dx = ped.pos.x - fromX, dz = ped.pos.z - fromZ, l = Math.hypot(dx, dz) || 1;
    ped.vel.set((dx / l) * 2.5, 2.5, (dz / l) * 2.5);
    ped.pos.y = w.city.heightAt(ped.pos.x, ped.pos.z) + 0.1;
    say(w, ped, pick(LINES.hitHeavy), 1.6, `ped${ped.id}`);
    return;
  }
  // flinch first, then react
  ped.state = 'flinch';
  ped.timer = RX.flinchTime;
  ped.fleeDir.set(fromX, fromZ); // remember where it came from
  say(w, ped, pick(cause === 'melee' ? LINES.melee : heavy ? LINES.hitHeavy : LINES.hitLight), 2.2, `ped${ped.id}`);
}

/** After the flinch: what this person does next, by personality (and archetype later). */
export function reactAfterFlinch(w: World, ped: Ped): void {
  if (victimMaybeCalls(w, ped)) return;
  const pp = w.player.mesh.position;
  const style = ped.hitCount >= 2 || ped.health < RX.fleeBelowHealth ? 'flee' : RX.styleByPersonality[ped.npc.personality];
  if (style === 'confront') {
    ped.state = 'confront';
    ped.timer = RX.confrontTime;
    say(w, ped, pick(LINES.confront), 2.4, `ped${ped.id}`);
  } else if (style === 'yell') {
    ped.state = 'yell';
    ped.timer = RX.yellTime;
    say(w, ped, pick(LINES.yell), 2.2, `ped${ped.id}`);
  } else {
    startFlee(ped, pp.x, pp.z);
  }
}

/** Shoved by the player walking into them. */
export function shovePed(w: World, ped: Ped, pushX: number, pushZ: number): void {
  if (!ped.active || ped.hidden || ped.state === 'down' || ped.state === 'flinch' || ped.state === 'phone') return;
  ped.pos.x += pushX;
  ped.pos.z += pushZ;
  if (w.time - ped.lastShoved < RX.shoveCooldown) return;
  const again = w.time - ped.lastShoved < RX.repeatWindow * 0.5;
  ped.lastShoved = w.time;
  ped.shoveCount = again ? ped.shoveCount + 1 : 1;
  ped.state = 'stumble';
  ped.timer = RX.stumbleTime;
  adjustRelationship(ped.npc, RX.relationshipOnShove);
  remember(ped.npc, 'insulted', 'shoved past me', w.dayNight.hour, w.dayNight.day);
  say(w, ped, pick(ped.shoveCount >= 2 ? LINES.pushedAgain : LINES.pushed), 2, `ped${ped.id}`);
  if (ped.shoveCount >= RX.shovesToHarass) emit(w, { type: 'harassment', pedId: ped.id, x: ped.pos.x, z: ped.pos.z, weapon: 'shoving' });
}

/**
 * The player hurt `owner`'s dog (car, thrown item or melee). `strength` is in hurtFx units (m/s, or
 * hp × strengthPerDamage); (dirX, dirZ) is the direction of the blow. Returns false if the dog can't be hit
 * right now (just hit, or not out in the world).
 */
export function hurtDog(w: World, owner: Ped, cause: 'car' | 'thrown' | 'melee', strength: number, dirX: number, dirZ: number, what: string): boolean {
  const d = owner.dog;
  if (!d || !owner.active || owner.hidden || w.time - d.lastHit < DG.hitCooldown) return false;
  d.lastHit = w.time;
  tumbleDog(d, strength, dirX, dirZ);
  w.audio.yelp?.(d.pos.x, d.pos.z);
  say(w, d, pick(LINES.yelp), 1.6, `dog${owner.id}`);
  hurtBurst(w, d.pos.x, d.pos.y + 0.42 * d.scale, d.pos.z, strength, dirX, dirZ, w.city.heightAt(d.pos.x, d.pos.z), true, d.vel.x, d.vel.z);
  ownerScreams(w, owner);
  emit(w, { type: 'dogHurt', pedId: owner.id, x: d.pos.x, z: d.pos.z, cause, weapon: what });
  return true;
}

/** The owner's reaction: scream at you, then (via the witness system) call 999. Not if they're knocked down. */
function ownerScreams(w: World, owner: Ped) {
  if (owner.state === 'down' || owner.pos.y < -10) return;
  if (owner.state === 'phone' && owner.phoneMode === 'call') return; // already on the phone: they report this instead
  if (w.chat.ped === owner) closeChat(w);
  say(w, owner, pick(LINES.dogOwner), DG.ownerScreamTime + 0.8, `ped${owner.id}`);
  if (owner.state === 'flinch') return; // hit as well: they call once the flinch is over
  owner.state = 'yell';
  owner.timer = DG.ownerScreamTime;
  owner.tilt = 0;
}
