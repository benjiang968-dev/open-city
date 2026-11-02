// Deterministic seeded random numbers (mulberry32). Same seed = same city.
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Fork a child generator so systems don't disturb each other's sequences. */
  fork(salt: number): Rng {
    return new Rng((this.next() * 4294967296) ^ salt);
  }
}

export function seedFromUrl(defaultSeed: number): number {
  const p = new URLSearchParams(location.search).get('seed');
  const n = p === null ? NaN : parseInt(p, 10);
  return Number.isFinite(n) ? n : defaultSeed;
}
