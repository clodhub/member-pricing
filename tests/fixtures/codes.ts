// A stand-in for createVoucherCodes, written to the voucher codes class's document (voucher-codes.json), for checks and
// tests that cannot import the voucher-codes component. No imports: the member-pricing component's tests carry a byte copy.
export type RandomSource = { int(bound: number): number };
export type VoucherCodeSettings = { groups: number; groupLength: number; alphabet: string };

export const DEFAULT_SETTINGS: VoucherCodeSettings = { groups: 3, groupLength: 4, alphabet: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" };

const whole = (value: unknown, name: string, low: number, high: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) throw new RangeError(`${name} is a whole number from ${low} to ${high}`);
  return value;
};

export function createVoucherCodes(options: { source: RandomSource } & Partial<VoucherCodeSettings>) {
  const source = options?.source;
  if (!source || typeof source.int !== "function") throw new TypeError("createVoucherCodes needs a random source with an int function");
  const groups = whole(options.groups ?? DEFAULT_SETTINGS.groups, "groups", 1, 8);
  const groupLength = whole(options.groupLength ?? DEFAULT_SETTINGS.groupLength, "groupLength", 2, 16);
  const alphabet = options.alphabet ?? DEFAULT_SETTINGS.alphabet;
  if (typeof alphabet !== "string" || !/^[A-Z][A-Z0-9]{1,63}$/.test(alphabet) || new Set(alphabet).size !== alphabet.length) {
    throw new RangeError("alphabet is upper-case letters and digits, each once");
  }
  if (groups * groupLength * Math.log2(alphabet.length) < 40) throw new RangeError("a code carries at least 40 random bits");
  const draw = (count: number) => {
    let text = "";
    for (let i = 0; i < count; i++) {
      const index = source.int(alphabet.length);
      if (!Number.isInteger(index) || index < 0 || index >= alphabet.length) throw new RangeError(`the random source returned ${String(index)}`);
      text += alphabet[index];
    }
    return text;
  };
  const grouped = (compact: string) => {
    const parts: string[] = [];
    for (let i = 0; i < compact.length; i += groupLength) parts.push(compact.slice(i, i + groupLength));
    return parts.join("-");
  };
  const generate = () => grouped(draw(groups * groupLength));
  const normalise = (text: unknown): string | null => {
    if (typeof text !== "string") return null;
    const compact = text.normalize("NFKC").toUpperCase().replace(/[\s\u2010-\u2015\u2212-]+/gu, "");
    if (compact.length !== groups * groupLength || [...compact].some((character) => !alphabet.includes(character))) return null;
    return grouped(compact);
  };
  return {
    settings: { groups, groupLength, alphabet },
    generate,
    generateShort(length: number) {
      return draw(whole(length, "length", 1, 64));
    },
    normalise,
    isCode: (text: unknown) => normalise(text) !== null,
    async withRetry<T>(attempt: (code: string) => Promise<T>, isCollision: (error: unknown) => boolean, attempts = 3): Promise<T> {
      whole(attempts, "attempts", 1, Number.MAX_SAFE_INTEGER);
      for (let tried = 1; ; tried++) {
        try {
          return await attempt(generate());
        } catch (error) {
          if (tried >= attempts || !isCollision(error)) throw error;
        }
      }
    },
  };
}

// A source whose codes count up: with the default shape, AAAA-AAAA-AAAA, then AAAA-AAAA-AAAB and so on. reset() starts
// the count again, so the next code repeats one already given.
export function countingSource(characters = DEFAULT_SETTINGS.groups * DEFAULT_SETTINGS.groupLength): RandomSource & { reset(): void } {
  let count = 0;
  let drawn = 0;
  return {
    int(bound: number) {
      drawn++;
      if (drawn % characters !== 0) return 0;
      return count++ % bound;
    },
    reset() {
      count = 0;
      drawn = 0;
    },
  };
}
