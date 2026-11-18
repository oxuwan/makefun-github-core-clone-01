// Deterministic scenario derivation (ported from the suite's wire.ts).
// The suite seeds every name from one fixed seed; the token owner (viewer) is
// users[0] of that scenario. Recomputing it here lets the forge answer
// `viewer { login }` and GET /api/v3/user with the login the checks expect.
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
const FIRST_NAMES = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST_NAMES = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
function scenarioSeedFor(label: string): bigint { return mix64(SCENARIO_SEED ^ fnv1a64(label)); }

class Rng {
  #state: bigint;
  constructor(seed: bigint) { const m = seed & U64_MASK; this.#state = m === 0n ? SCENARIO_SEED : m; }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296; const limit = range - (range % maxExclusive);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % maxExclusive; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)] as T; }
}

export interface ScenarioUser { id: number; login: string; name: string; email: string; }
export function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>(); const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES); const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base; let suffix = 2;
    while (used.has(login)) { login = `${base}-${suffix}`; suffix += 1; }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}
const USERS = scenarioUsers();
export const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
export const VIEWER_LOGIN: string = VIEWER.login;
