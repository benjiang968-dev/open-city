// Things people shout when something happens to them. Original lines, picked at random.
export const LINES = {
  hitLight: ['Ow! What was that for?', 'Hey! Watch it!', 'Did you just throw that at me?!', 'Oi! That hit me!'],
  hitHeavy: ['Aagh! Somebody help!', 'Are you out of your mind?!', 'Get away from me!', 'That really hurt!'],
  melee: ['Put that down! Help!', 'Stop! Somebody stop them!', 'No no no — back off!'],
  confront: ['You want a problem? Come on then!', 'Throw one more thing. I dare you.', "I've got your face memorised, pal.", 'Say sorry. Right now.'],
  yell: ['Unbelievable. Grow up!', 'Seriously?! In broad daylight?', 'Some people…', 'Real mature!'],
  pushed: ['Hey, watch it!', 'Excuse YOU.', 'Ever heard of "excuse me"?', 'Mind where you walk!', 'Oof — personal space!'],
  pushedAgain: ['Stop shoving me!', 'Do that again and I call the cops.', "What is your problem?!"],
  calling: ['📞 999… police, please', '📞 Yes, police — hurry!', '📞 There\'s someone attacking people'],
  callingDog: ['📞 Police! Someone just hurt a dog!', '📞 Yes, police, they attacked a dog. Hurry!'],
  callingMyDog: ['📞 Police? Someone attacked my dog!', '📞 Please hurry, they hurt my dog!'],
  filming: ['📹 Getting this on camera…', '📹 This is going online', '📹 Smile for the internet'],
  bark: ['Woof!', 'Woof woof!', 'Grrr…'],
  yelp: ['Yelp!', 'Ki-yi-yi!', 'Awoo…', 'Yip! Yip!'],
  dogOwner: ['NO! Not my dog!', 'You MONSTER! Leave him alone!', 'What is wrong with you?!', 'Somebody help, they hurt my dog!'],
  dogWitness: ['Did they just hurt that dog?!', 'Leave the dog alone!', 'Oh no, the poor thing!', 'Hey! What kind of person does that?!'],
  callingTheft: ['📞 999… someone\'s stealing a car!', '📞 Police? A car\'s being broken into!', '📞 They just drove off in a stolen car!'],
  // a car owner chasing the thief (the first line is always the opener)
  carOwner: ["Hey! That's my car!", 'Stop! Thief!', 'Get out of my car!', 'Somebody stop them, that\'s MY car!', 'I know your face!'],
  carOwnerGaveUp: ['My car… unbelievable.', 'Great. Just great.', "Who steals a car in broad daylight?!"],
  carHorn: ['Get out of the road!'],
} as const;

export function pick<T>(a: readonly T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}
