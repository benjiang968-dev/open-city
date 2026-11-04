// ScriptedProvider: zero-cost dialogue from personality templates + keyword intent matching.
// Uses the NPC's memory, relationship and mood so replies stay in character and consistent.
import type { DialogueProvider, DialogueReply, DialogueRequest, NpcAction } from './provider';
import { TEMPLATES, SHARED, TICS, TRADE_ITEMS, type Intent } from '../personalities';
import { TUNING } from '../../tuning';

const INTENTS: [Intent, RegExp][] = [
  ['threat', /\b(kill|stab|shoot|beat you|hurt you|give me (your|ur) (money|wallet|cash)|rob)\b/i],
  ['insult', /\b(idiot|stupid|dumb|moron|shut up|ugly|loser|hate you|f+u+c*k|fck|stfu|jerk|clown|trash|useless)\b/i],
  ['apology', /\b(sorry|apolog\w*|my bad|forgive)\b/i],
  ['offerRide', /\b(need|want|like) (a )?(ride|lift|taxi|cab)\b|\b(give|offer) (you )?(a )?(ride|lift)\b|\bget in\b|\bhop in\b|\bdrive you\b|\b(ride|lift)\?/i],
  ['name', /\b(your name|who are you|what'?s your name|call you)\b/i],
  ['job', /\b(what do you do|your job|work as|do for a living|occupation)\b/i],
  ['askWork', /\b(work|job|money|cash|earn|gig|hire|hiring|fares?|passengers?|customers?)\b/i],
  ['whereIs', /\bwhere('s| is| are| can i find)\b|\bhow (do i|to) get to\b|\bdirections?\b/i],
  ['remember', /\b(remember me|know me|seen me|recogni[sz]e)\b/i],
  ['gossip', /\b(gossip|news|rumou?r|what'?s (going on|happening|new)|heard anything|anything interesting)\b/i],
  ['police', /\b(cops?|police|sheriff|precinct|wanted)\b/i],
  ['trade', /\b(buy|sell|selling|trade|got anything|for sale|deal)\b/i],
  ['weather', /\b(weather|rain|raining|sunny|sun|cold|hot|warm|snow|fog|foggy|storm|thunder)\b/i],
  ['time', /\b(time is it|what time|the time|clock)\b/i],
  ['howAreYou', /\b(how are (you|u)|how'?s it going|how you doing|how'?s life|you ok|you alright|what'?s up|sup)\b/i],
  ['compliment', /\b(nice|love|great|cool|beautiful|awesome|amazing|pretty|handsome|kind|lovely|like your)\b/i],
  ['thanks', /\b(thanks|thank you|thx|cheers|ta)\b/i],
  ['bye', /\b(bye|goodbye|see ya|see you|later|cya|farewell)\b/i],
  ['greet', /\b(hi|hello|hey|yo|hiya|good (morning|afternoon|evening)|howdy|greetings)\b/i],
];

function detectIntent(text: string): Intent {
  for (const [intent, re] of INTENTS) if (re.test(text)) return intent;
  return 'fallback';
}

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export class ScriptedProvider implements DialogueProvider {
  readonly id = 'scripted';

  async reply(req: DialogueRequest): Promise<DialogueReply> {
    return this.replySync(req);
  }

  replySync(req: DialogueRequest): DialogueReply {
    const { npc, world } = req;
    const text = req.playerText.trim();
    const intent = detectIntent(text);
    const P = TEMPLATES[npc.personality];
    const tics = TICS[npc.personality];
    // grudges: you hurt me, or you stole my car (the latest one decides what they throw at you)
    let grudge: 'hit' | 'car' | null = null;
    for (const m of npc.memory) {
      if (m.kind === 'hitMe' || m.kind === 'assaulted') grudge = 'hit';
      else if (m.kind === 'stoleMyCar') grudge = 'car';
    }
    const hitMe = grudge !== null;
    const rel = npc.relationship;
    const firstTime = npc.timesTalked === 0;

    // place/rank substitutions
    const rank = world.taxiRanks[0];
    const fill = (s: string, extra: Record<string, string> = {}) =>
      s.replace(/\{(\w+)\}/g, (_, k: string) => {
        const map: Record<string, string> = {
          first: npc.name.split(' ')[0], name: npc.name, job: npc.job, work: world.npcWorkplace, home: world.npcHome,
          place: world.nearestPlace, rank: rank?.name ?? 'the taxi rank', street: rank?.street ?? 'the main street',
          clock: world.clock, car: world.playerCarLabel ?? 'car', ...extra,
        };
        return map[k] ?? k;
      });
    // Personality lines are already in voice; shared lines get a personality tic so everyone sounds different.
    const say = (lines: string[] | undefined, extra?: Record<string, string>, flavour = false) => {
      const base = fill(pick(lines && lines.length ? lines : SHARED.thanks!), extra);
      if (!flavour) return base;
      const pre = pick(tics.pre);
      const lower = pre && !/^I\b|^I'/.test(base) ? base[0].toLowerCase() + base.slice(1) : base;
      return `${pre}${lower}${pick(tics.post)}`;
    };
    const sayShared = (lines: string[] | undefined, extra?: Record<string, string>) => say(lines, extra, true);
    const reply = (t: string, action?: NpcAction, relationshipDelta = 0, moodDelta = 0): DialogueReply => ({ text: t, action, relationshipDelta, moodDelta });

    // ---- grudges first: people you hit don't want to talk ----
    if (hitMe && rel < -30) {
      const car = grudge === 'car';
      if (intent === 'apology') return reply(say(car ? SHARED.apologyStolen : SHARED.apologyHit, undefined, false), undefined, 6);
      if (rel <= TUNING.npc.callPoliceBelow && (intent === 'insult' || intent === 'threat' || npc.timesTalked >= 1))
        return reply(say(car ? SHARED.callPoliceStolen : SHARED.callPolice, undefined, false), { type: 'callPolice' }, -5);
      return reply(say(car ? SHARED.refuseStolen : SHARED.refuseHit, undefined, false), { type: 'refuse' }, -2);
    }
    if (rel < -60 && intent !== 'apology') {
      if (intent === 'insult' || intent === 'threat') return reply(say(SHARED.callPolice, undefined, false), { type: 'callPolice' }, -5);
      return reply(say(SHARED.refuseHated, undefined, false), { type: 'refuse' }, -1);
    }
    if (world.wantedStars >= 2 && npc.personality !== 'laidback' && intent !== 'police')
      return reply(say(SHARED.policeWanted, undefined, false), { type: 'refuse' }, -1);

    switch (intent) {
      case 'threat':
        return reply(say(SHARED.threat, undefined, false), { type: 'callPolice' }, -40, -0.5);
      case 'insult':
        return reply(say(P.insult, undefined, false), npc.personality === 'grumpy' && rel < -20 ? { type: 'refuse' } : undefined, TUNING.npc.relationshipOnInsult, -0.2);
      case 'apology':
        return reply(sayShared(SHARED.apology), undefined, 4);
      case 'compliment':
        return reply(say(P.compliment), undefined, TUNING.npc.relationshipOnCompliment, 0.1);
      case 'thanks':
        return reply(sayShared(SHARED.thanks), undefined, 1);
      case 'greet': {
        const known = !firstTime && P.greetKnown;
        let t = say(known ? P.greetKnown : P.greet);
        const notable = memoryRemark(npc.memory);
        if (notable) t += ' ' + notable;
        return reply(t, undefined, TUNING.npc.relationshipOnChat);
      }
      case 'howAreYou':
        return reply(say(npc.mood < -0.2 ? P.howAreYouBad : P.howAreYou), undefined, TUNING.npc.relationshipOnChat);
      case 'name':
        return reply(say(P.name), undefined, 1);
      case 'job':
        return reply(say(P.job), undefined, 1);
      case 'askWork': {
        // point at the rank with a waiting fare; friendly folk sometimes need a ride themselves
        if (rel >= 10 && Math.random() < 0.35 && P.offerJob) return reply(say(P.offerJob), { type: 'offerJob', job: 'taxi', detail: world.nearestPlace }, 2);
        const r = world.taxiRanks.find((x) => x.hasFare) ?? rank;
        return reply(say(P.askWork, { rank: r.name, street: r.street }), { type: 'giveTip', poiId: r.poiId }, 2);
      }
      case 'offerRide': {
        const willing = rel > -15 && (npc.personality !== 'posh' || world.playerCarLabel !== 'Pickup');
        if (!willing || (npc.personality === 'nervous' && npc.memory.some((m) => m.kind === 'speeding' || m.kind === 'crashed')))
          return reply(say(P.declineRide), { type: 'refuse' });
        return reply(say(P.acceptRide), { type: 'acceptRide' }, 3);
      }
      case 'whereIs': {
        const q = text.toLowerCase();
        const place = world.places.find((p) => q.includes(p.name.toLowerCase()) || q.includes(p.kind)) ??
          world.places.find((p) => p.name.toLowerCase().split(/\W+/).some((wd) => wd.length > 3 && q.includes(wd)));
        if (place) return reply(say(SHARED.whereIs, { place: place.name, street: place.street }), { type: 'giveTip', poiId: place.poiId }, 1);
        if (/taxi|cab|rank/.test(q)) return reply(say(P.askWork, { rank: rank.name, street: rank.street }), { type: 'giveTip', poiId: rank.poiId }, 1);
        return reply(sayShared(SHARED.whereIsUnknown));
      }
      case 'remember': {
        const m = npc.memory[npc.memory.length - 1];
        return reply(m ? say(SHARED.remember, { mem: m.note }) : sayShared(SHARED.rememberNone));
      }
      case 'gossip': {
        const g = world.gossip.length ? pick(world.gossip) : null;
        return reply(g ? say(SHARED.gossip, { gossip: g }) : sayShared(SHARED.gossipNone), undefined, 1);
      }
      case 'police':
        return reply(say(world.wantedStars > 0 ? SHARED.policeWanted : SHARED.police));
      case 'weather':
        {
          const byKind: Record<string, string[] | undefined> = { rain: SHARED.weatherRain, storm: SHARED.weatherStorm, fog: SHARED.weatherFog, snow: SHARED.weatherSnow, cloudy: SHARED.weatherCloudy };
          return reply(sayShared(byKind[world.weather] ?? (world.isNight ? SHARED.weatherNight : SHARED.weather)));
        }
      case 'time':
        return reply(sayShared(SHARED.time));
      case 'trade': {
        const t = TRADE_ITEMS[npc.job];
        if (!t) return reply(say(['I\'m not selling anything, sorry. Try the market by the docks.']));
        if (world.cash < t.price) return reply(say(SHARED.tradeBroke, { item: t.item, price: String(t.price) }));
        return reply(say(SHARED.trade, { item: t.item, price: String(t.price) }), { type: 'trade', item: t.item, price: t.price }, 4);
      }
      case 'bye':
        return reply(say(P.bye), undefined, 1);
      default: {
        let t = say(P.fallback);
        if (firstTime) t = `${say(P.greet)} ${t}`;
        return reply(t, undefined, 1);
      }
    }
  }
}

function memoryRemark(mem: DialogueRequest['npc']['memory']): string {
  const last = [...mem].reverse().find((m) => m.kind !== 'chatted');
  if (!last) return '';
  switch (last.kind) {
    case 'speeding': return pick(SHARED.memSpeeding!);
    case 'fareDone': return pick(SHARED.memFare!);
    case 'hitSomeone': return pick(SHARED.memHitSomeone!);
    case 'sawCarTheft': return pick(SHARED.memCarTheft!);
    default: return '';
  }
}
