// Talk to anyone: free-text chat box. Builds a DialogueRequest, asks the provider, shows the reply and
// applies the structured action (tips, rides, refusals, police calls, trades) to the game.
import { TUNING } from '../tuning';
import type { World } from '../world';
import { emit } from '../world';
import type { Ped } from './pedestrians';
import type { DialogueRequest, DialogueReply } from '../npc/providers/provider';
import { adjustRelationship, remember } from '../npc/npc';
import { formatClock } from './dayNight';
import type { TaxiJob } from './economy/taxi';
import { toast } from './hud';

export interface ChatState {
  open: boolean;
  ped: Ped | null;
  root: HTMLElement;
  head: HTMLElement;
  log: HTMLElement;
  input: HTMLInputElement;
  busy: boolean;
  /** Count of conversations started, for tests and the debug overlay. */
  conversations: number;
}

export function createChat(w: World): ChatState {
  const root = document.createElement('div');
  root.id = 'chat';
  root.innerHTML = '<button class="close" aria-label="Leave conversation">✕</button><div class="head"></div><div class="log"></div><div class="quick"></div><input type="text" maxlength="200" placeholder="Say something…" /><div class="hint">Enter to send · Esc to leave · or tap a reply</div>';
  document.getElementById('ui')!.appendChild(root);
  const s: ChatState = {
    open: false, ped: null, root, head: root.querySelector('.head')!, log: root.querySelector('.log')!,
    input: root.querySelector('input')!, busy: false, conversations: 0,
  };
  // tap-friendly quick replies (iPad / touch); each just sends its text like typing would
  const quick = root.querySelector('.quick') as HTMLElement;
  for (const [label, text] of QUICK_REPLIES) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      void send(w, text);
    });
    quick.appendChild(btn);
  }
  (root.querySelector('.close') as HTMLElement).addEventListener('click', () => closeChat(w));
  s.input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeChat(w);
    else if (e.key === 'Enter') {
      const text = s.input.value.trim();
      if (text) {
        s.input.value = '';
        void send(w, text);
      }
    }
  });
  return s;
}

/** Quick-reply buttons: label shown, text sent to the NPC. */
export const QUICK_REPLIES: [string, string][] = [
  ['👋 Hi', 'Hi there!'],
  ['How are you?', 'How are you?'],
  ['Any work?', 'Any work around here?'],
  ['Need a ride?', 'Need a ride?'],
  ['Got any cash?', 'Can you spare some money?'],
  ['Trade?', 'Got anything to trade?'],
  ['Gossip?', 'Heard any gossip?'],
  ['Sorry', 'Sorry about that.'],
  ['Bye', 'Bye!'],
];

export function openChat(w: World, ped: Ped): void {
  const s = w.chat;
  s.open = true;
  s.ped = ped;
  s.conversations++;
  w.input.blocked = true;
  w.input.keys.clear();
  if (document.pointerLockElement) {
    w.input.expectUnlock = true;
    document.exitPointerLock();
  }
  ped.state = 'talk';
  const rel = ped.npc.relationship;
  const relTxt = rel > 30 ? 'likes you' : rel < -30 ? 'dislikes you' : 'neutral';
  s.head.innerHTML = `${ped.npc.name} <span>· ${ped.npc.job} · ${relTxt}</span>`;
  s.log.innerHTML = '';
  // show the last couple of lines if you've talked before
  for (const h of ped.npc.history.slice(-4)) line(s, h.who === 'player' ? 'me' : 'npc', h.text, ped);
  s.root.style.display = 'block';
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => s.input.focus(), 0);
}

export function closeChat(w: World): void {
  const s = w.chat;
  if (!s.open) return;
  s.open = false;
  s.root.style.display = 'none';
  s.input.blur();
  w.input.blocked = false;
  if (s.ped && s.ped.state === 'talk') {
    s.ped.state = 'idle';
    s.ped.timer = 1.5;
  }
  s.ped = null;
}

function line(s: ChatState, cls: 'me' | 'npc' | 'act', text: string, ped: Ped) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = cls === 'me' ? `You: ${text}` : cls === 'npc' ? `${ped.npc.name.split(' ')[0]}: ${text}` : text;
  s.log.appendChild(d);
  s.log.scrollTop = s.log.scrollHeight;
}

export function buildRequest(w: World, ped: Ped, text: string): DialogueRequest {
  const city = w.city;
  const taxi = w.jobs.get<TaxiJob>('taxi');
  const fareAt = taxi?.waitingAt(w);
  const ranks = city.taxiRanks.map((r) => ({ poiId: r.id, name: r.name, street: r.street, hasFare: fareAt?.id === r.id }));
  ranks.sort((a, b) => Number(b.hasFare) - Number(a.hasFare) || Math.hypot(city.pois[a.poiId].x - ped.pos.x, city.pois[a.poiId].z - ped.pos.z) - Math.hypot(city.pois[b.poiId].x - ped.pos.x, city.pois[b.poiId].z - ped.pos.z));
  let nearest = city.pois[0], nd = Infinity;
  for (const p of city.pois) {
    if (p.kind === 'taxiRank') continue;
    const d = Math.hypot(p.x - ped.pos.x, p.z - ped.pos.z);
    if (d < nd && d > 15) { nd = d; nearest = p; }
  }
  // gossip: what other people nearby remember about the player
  const gossip: string[] = [];
  for (const o of w.peds) {
    if (o === ped) continue;
    for (const m of o.npc.memory) {
      if (['hitMe', 'hitSomeone', 'rammedCar', 'speeding', 'busted', 'sawAssault', 'vandalism', 'sawCarTheft', 'sawDogHurt'].includes(m.kind)) gossip.push(m.kind === 'hitMe' ? `ran over ${o.npc.name.split(' ')[0]}` : m.note);
      else if (m.kind === 'stoleMyCar') gossip.push(`stole ${o.npc.name.split(' ')[0]}'s car`);
    }
  }
  const v = w.player.vehicle;
  return {
    npc: ped.npc,
    playerText: text,
    world: {
      hour: w.dayNight.hour,
      clock: formatClock(w.dayNight.hour),
      isNight: w.dayNight.night > 0.5,
      weather: w.weather.kind,
      playerInCar: !!v,
      playerCarLabel: v ? v.spec.label : null,
      wantedStars: w.police.stars,
      cash: w.cash,
      npcWorkplace: city.pois[ped.npc.workPoi].name,
      npcHome: city.pois[ped.npc.homePoi].name,
      nearestPlace: nearest.name,
      taxiRanks: ranks,
      gossip: gossip.slice(-6),
      places: city.pois.filter((p) => p.kind !== 'taxiRank').map((p) => ({ poiId: p.id, name: p.name, kind: p.kind, street: p.street })),
    },
  };
}

async function send(w: World, text: string): Promise<void> {
  const s = w.chat;
  const ped = s.ped;
  if (!ped || s.busy) return;
  s.busy = true;
  line(s, 'me', text, ped);
  ped.npc.history.push({ who: 'player', text });
  let reply: DialogueReply;
  try {
    reply = await w.dialogue.reply(buildRequest(w, ped, text));
  } catch {
    reply = { text: '…' };
  }
  s.busy = false;
  if (s.ped !== ped) return; // chat closed while waiting
  line(s, 'npc', reply.text, ped);
  ped.npc.history.push({ who: 'npc', text: reply.text });
  while (ped.npc.history.length > 12) ped.npc.history.shift();
  ped.npc.timesTalked++;
  if (reply.relationshipDelta) adjustRelationship(ped.npc, reply.relationshipDelta);
  if (reply.moodDelta) ped.npc.mood = Math.max(-1, Math.min(1, ped.npc.mood + reply.moodDelta));
  if (ped.npc.timesTalked === 1) remember(ped.npc, 'chatted', 'stopped to chat with me', w.dayNight.hour, w.dayNight.day);
  applyAction(w, ped, reply);
}

function applyAction(w: World, ped: Ped, reply: DialogueReply): void {
  const a = reply.action;
  if (!a) return;
  const s = w.chat;
  const taxi = w.jobs.get<TaxiJob>('taxi');
  switch (a.type) {
    case 'giveTip': {
      const poi = w.city.pois[a.poiId];
      if (!poi) break;
      if (poi.kind === 'taxiRank' && taxi) taxi.tipAbout(w, poi);
      else if (taxi) taxi.tipMarker = { x: poi.curbX, z: poi.curbZ, until: w.time + 60 };
      line(s, 'act', `📍 ${poi.name} marked on your map`, ped);
      break;
    }
    case 'acceptRide':
    case 'offerJob': {
      if (taxi && taxi.startFromPed(w, ped)) {
        line(s, 'act', `🚕 ${ped.npc.name.split(' ')[0]} will wait here for a ride`, ped);
        setTimeout(() => closeChat(w), 1200);
      } else line(s, 'act', 'You already have a passenger.', ped);
      break;
    }
    case 'refuse':
      line(s, 'act', `${ped.npc.name.split(' ')[0]} won't talk to you.`, ped);
      setTimeout(() => { if (s.ped === ped) closeChat(w); }, 1800);
      break;
    case 'callPolice':
      line(s, 'act', '📞 They are calling the police!', ped);
      emit(w, { type: 'policeCalled', x: ped.pos.x, z: ped.pos.z, byPed: ped.id });
      adjustRelationship(ped.npc, -10);
      setTimeout(() => { if (s.ped === ped) closeChat(w); }, 1500);
      break;
    case 'trade':
      if (w.cash >= a.price) {
        w.cash -= a.price;
        line(s, 'act', `You bought a ${a.item} for $${a.price}.`, ped);
        toast(w, `-$${a.price} · ${a.item}`, 1.5);
      }
      break;
  }
}

export function updateChat(w: World): void {
  const s = w.chat;
  if (!s.open || !s.ped) return;
  // walked/driven away or the NPC got hurt
  const d = Math.hypot(s.ped.pos.x - w.player.mesh.position.x, s.ped.pos.z - w.player.mesh.position.z);
  if (d > TUNING.player.talkRange * 3 || s.ped.state === 'down') closeChat(w);
}
