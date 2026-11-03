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
  filming: ['📹 Getting this on camera…', '📹 This is going online', '📹 Smile for the internet'],
  bark: ['Woof!', 'Woof woof!', 'Grrr…'],
  carHorn: ['Get out of the road!'],
} as const;

export function pick<T>(a: readonly T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}
