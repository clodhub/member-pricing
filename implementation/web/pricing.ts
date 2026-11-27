// Member prices: plans that give their members a discount, fixed prices for some items, or both, and the one price
// resolver the reserve page and the server share. Pure and client-safe.
import { rawSettings } from "./settings.ts";

export type Money = number;
export type LocalText = Record<string, string>;
export type PricingMode = "discount" | "custom" | "mixed";
// One item's member price: a fixed price for one length (type fixed), or a percentage off the catalogue price (type
// discount, in mixed plans, whose minutes and price are 0).
export type ItemPrice = { minutes: number; price: Money; type?: "discount" | "fixed"; discountPercent?: number };
export type PricingRule = {
  mode: PricingMode;
  discountPercent: number;
  itemSlugs: string[];
  categorySlugs: string[];
  allItems: boolean;
  itemPricing?: Record<string, ItemPrice>;
};
export type Validity = { amount: number; unit: "weeks" | "months" | "year" };
export type PlanInput = { title: LocalText; conditions: LocalText; rule: PricingRule; validity: Validity };
export type PlanInputCode =
  | "INVALID_INPUT" | "INVALID_TITLE" | "INVALID_CONDITIONS" | "INVALID_VALIDITY" | "INVALID_MODE" | "INVALID_DISCOUNT" | "INVALID_SCOPE"
  | "MISSING_ITEMS" | "INVALID_ITEM_TYPE" | "INVALID_MINUTES" | "INVALID_PRICE";
export type PlanInputResult = { ok: true; plan: PlanInput } | { ok: false; code: PlanInputCode; error: string };
export type PriceOption = { minutes: number | null; price: Money };

export type MemberPricingSettings = {
  minimumFixedPrice: number;
  maximumFixedPrice: number;
  fixedPriceStep: number;
  minimumMinutes: number;
  maximumMinutes: number;
  minutesStep: number;
  sessionMinutes: number;
};

export const DEFAULT_SETTINGS: MemberPricingSettings = {
  minimumFixedPrice: 500,
  maximumFixedPrice: 50000,
  fixedPriceStep: 500,
  minimumMinutes: 5,
  maximumMinutes: 180,
  minutesStep: 5,
  sessionMinutes: 15,
};

export const MAXIMUM_VALIDITY = 1000;

// A value still in its {{name}} form (the source, before installation renders it) takes the default.
const unrendered = (value: unknown) => typeof value === "string" && /^\{\{[A-Za-z][A-Za-z0-9_.-]*\}\}$/.test(value);

function wholeSetting(raw: unknown, name: keyof MemberPricingSettings, minimum: number, maximum: number): number {
  const value = raw === undefined || unrendered(raw) ? DEFAULT_SETTINGS[name] : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

export function settingsFrom(raw: Partial<Record<keyof MemberPricingSettings, unknown>>): MemberPricingSettings {
  const settings = {
    minimumFixedPrice: wholeSetting(raw.minimumFixedPrice, "minimumFixedPrice", 1, 100_000_000),
    maximumFixedPrice: wholeSetting(raw.maximumFixedPrice, "maximumFixedPrice", 1, 100_000_000),
    fixedPriceStep: wholeSetting(raw.fixedPriceStep, "fixedPriceStep", 1, 100_000_000),
    minimumMinutes: wholeSetting(raw.minimumMinutes, "minimumMinutes", 1, 1440),
    maximumMinutes: wholeSetting(raw.maximumMinutes, "maximumMinutes", 1, 1440),
    minutesStep: wholeSetting(raw.minutesStep, "minutesStep", 1, 1440),
    sessionMinutes: wholeSetting(raw.sessionMinutes, "sessionMinutes", 1, 1440),
  };
  if (settings.maximumFixedPrice < settings.minimumFixedPrice) throw new RangeError("maximumFixedPrice is at least minimumFixedPrice");
  if (settings.maximumMinutes < settings.minimumMinutes) throw new RangeError("maximumMinutes is at least minimumMinutes");
  return settings;
}

export const installedSettings = (): MemberPricingSettings => settingsFrom(rawSettings);

// Own entries only, so a slug such as "constructor" never reads an object's built-in members.
function entryOf(rule: PricingRule, slug: string): ItemPrice | undefined {
  return rule.itemPricing && Object.hasOwn(rule.itemPricing, slug) ? rule.itemPricing[slug] : undefined;
}

// Whether a member with this rule may have the item at a member price; everyone may when there is no rule. Custom and
// mixed plans cover exactly the items they price.
export function isEligible(rule: PricingRule | null, slug: string, categorySlug: string): boolean {
  if (!rule) return true;
  if ((rule.mode === "custom" || rule.mode === "mixed") && rule.itemPricing) return entryOf(rule, slug) !== undefined;
  if (rule.allItems) return true;
  if (rule.itemSlugs.includes(slug)) return true;
  return rule.categorySlugs.includes(categorySlug);
}

// A custom plan fixes the price of every item it sells; a mixed plan of the items priced with type fixed.
export function isFixedPrice(rule: PricingRule | null, slug: string): boolean {
  if (!rule) return false;
  if (rule.mode === "custom") return true;
  return rule.mode === "mixed" && entryOf(rule, slug)?.type === "fixed";
}

export function discountPercentFor(rule: PricingRule | null, slug: string, categorySlug: string): number | null {
  if (!rule) return null;
  if (rule.mode === "mixed") {
    const entry = entryOf(rule, slug);
    return entry?.type === "discount" ? (entry.discountPercent ?? null) : null;
  }
  if (rule.mode === "discount" && rule.discountPercent && isEligible(rule, slug, categorySlug)) return rule.discountPercent;
  return null;
}

// The price less the percentage, rounded half up to the minor unit.
export function applyDiscount(price: Money, percent: number): Money {
  if (!Number.isInteger(price) || price < 0) throw new RangeError("price is a whole amount in minor units");
  if (typeof percent !== "number" || !(percent >= 0 && percent <= 100)) throw new RangeError("percent is from 0 to 100");
  return Math.round((price * (100 - percent)) / 100);
}

// The price charged for one item of the requested length, or null when it is not sold at that length: a fixed price
// sells only its own length; otherwise the catalogue option's price, less the member's discount where one applies.
export function resolveItemPrice(
  rule: PricingRule | null,
  slug: string,
  categorySlug: string,
  options: readonly PriceOption[],
  requestedMinutes: number,
): { price: Money; minutes: number } | null {
  if (isFixedPrice(rule, slug)) {
    const entry = rule ? entryOf(rule, slug) : undefined;
    if (!entry || entry.minutes !== requestedMinutes) return null;
    return { price: entry.price, minutes: entry.minutes };
  }
  const option = options.find((entry) => entry.minutes !== null && entry.minutes === requestedMinutes);
  if (!option) return null;
  const percent = discountPercentFor(rule, slug, categorySlug);
  return { price: percent ? applyDiscount(option.price, percent) : option.price, minutes: requestedMinutes };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
// Item slugs become field names of the stored rule, so they hold no dot or dollar sign.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLanguage(value: unknown): value is string {
  return typeof value === "string" && LANGUAGE.test(value);
}

// Trimmed and lower case; null when it is not an address.
export function normaliseEmail(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const email = text.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

// Text by language; blank texts are dropped. Null when the value is not text by language code.
function localText(value: unknown): LocalText | null {
  if (!isObject(value)) return null;
  const out: LocalText = {};
  for (const [language, text] of Object.entries(value)) {
    if (!LANGUAGE.test(language) || typeof text !== "string") return null;
    if (text.trim() !== "") out[language] = text.trim();
  }
  return out;
}

function slugList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((slug) => typeof slug === "string" && slug.trim() !== "")) return null;
  return [...new Set(value.map((slug: string) => slug.trim()))];
}

const whole = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

const stepped = (value: unknown, minimum: number, maximum: number, step: number): value is number =>
  whole(value, minimum, maximum) && value % step === 0;

function validityOf(value: unknown): Validity | null {
  if (!isObject(value) || !whole(value.amount, 1, MAXIMUM_VALIDITY)) return null;
  if (value.unit !== "weeks" && value.unit !== "months" && value.unit !== "year") return null;
  return { amount: value.amount, unit: value.unit };
}

const refuse = (code: PlanInputCode, error: string): PlanInputResult => ({ ok: false, code, error });

// Checks a plan as the owner's form sends it (title, conditions, mode, discountPercent, itemSlugs, categorySlugs, allItems,
// itemPricing, validity) and gives the plan to store. Custom and mixed plans cover exactly the items they price.
export function validatePlanInput(input: unknown, settings: MemberPricingSettings = installedSettings()): PlanInputResult {
  if (!isObject(input)) return refuse("INVALID_INPUT", "a plan is an object");
  const title = localText(input.title);
  if (title === null || Object.keys(title).length === 0) return refuse("INVALID_TITLE", "title needs a text in at least one language");
  const conditions = input.conditions === undefined ? {} : localText(input.conditions);
  if (conditions === null) return refuse("INVALID_CONDITIONS", "conditions are texts by language code");
  const validity = validityOf(input.validity);
  if (!validity) return refuse("INVALID_VALIDITY", `validity is a whole amount from 1 to ${MAXIMUM_VALIDITY} of weeks, months or year`);
  const mode = input.mode === undefined ? "discount" : input.mode;
  if (mode !== "discount" && mode !== "custom" && mode !== "mixed") return refuse("INVALID_MODE", "mode is discount, custom or mixed");

  if (mode === "discount") {
    if (!whole(input.discountPercent, 1, 99)) return refuse("INVALID_DISCOUNT", "discountPercent is a whole number from 1 to 99");
    const itemSlugs = slugList(input.itemSlugs);
    const categorySlugs = slugList(input.categorySlugs);
    if (itemSlugs === null || categorySlugs === null || (input.allItems !== undefined && typeof input.allItems !== "boolean")) {
      return refuse("INVALID_SCOPE", "itemSlugs and categorySlugs are lists of slugs and allItems is true or false");
    }
    const allItems = input.allItems === true;
    if (!allItems && itemSlugs.length === 0 && categorySlugs.length === 0) {
      return refuse("INVALID_SCOPE", "a discount plan covers all items, some items or some categories");
    }
    return { ok: true, plan: { title, conditions, validity, rule: { mode, discountPercent: input.discountPercent, itemSlugs, categorySlugs, allItems } } };
  }

  const pricing = input.itemPricing;
  if (!isObject(pricing) || Object.keys(pricing).length === 0) return refuse("MISSING_ITEMS", `a ${mode} plan prices at least one item`);
  const itemPricing: Record<string, ItemPrice> = {};
  const { minimumMinutes, maximumMinutes, minutesStep, minimumFixedPrice, maximumFixedPrice, fixedPriceStep } = settings;
  for (const [slug, entry] of Object.entries(pricing)) {
    if (!SLUG.test(slug)) return refuse("INVALID_SCOPE", `${JSON.stringify(slug)} is not an item slug`);
    const type = mode === "custom" ? "fixed" : isObject(entry) ? entry.type : undefined;
    if (!isObject(entry) || (type !== "fixed" && type !== "discount")) {
      return refuse("INVALID_ITEM_TYPE", `item "${slug}": type is "discount" or "fixed"`);
    }
    if (type === "discount") {
      if (!whole(entry.discountPercent, 1, 99)) return refuse("INVALID_DISCOUNT", `item "${slug}": discountPercent is a whole number from 1 to 99`);
      itemPricing[slug] = { type, discountPercent: entry.discountPercent, minutes: 0, price: 0 };
      continue;
    }
    if (!stepped(entry.minutes, minimumMinutes, maximumMinutes, minutesStep)) {
      return refuse("INVALID_MINUTES", `item "${slug}": minutes is a multiple of ${minutesStep} from ${minimumMinutes} to ${maximumMinutes}`);
    }
    if (!stepped(entry.price, minimumFixedPrice, maximumFixedPrice, fixedPriceStep)) {
      return refuse("INVALID_PRICE", `item "${slug}": price is a multiple of ${fixedPriceStep} from ${minimumFixedPrice} to ${maximumFixedPrice} minor units`);
    }
    itemPricing[slug] = { type, minutes: entry.minutes, price: entry.price };
  }
  return {
    ok: true,
    plan: { title, conditions, validity, rule: { mode, discountPercent: 0, itemSlugs: Object.keys(itemPricing), categorySlugs: [], allItems: false, itemPricing } },
  };
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

// Calendar months in UTC; a day the target month lacks becomes its last day (31 January and one month is 28 or 29 February).
function addMonths(from: Date, months: number): Date {
  const total = from.getUTCMonth() + months;
  const year = from.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const moved = new Date(from.getTime());
  moved.setUTCFullYear(year, month, Math.min(from.getUTCDate(), last));
  return moved;
}

// When a voucher issued at `from` stops: `amount` weeks, calendar months or years later.
export function expiryFrom(validity: Validity, from: Date): Date {
  const checked = validityOf(validity);
  if (!checked) throw new RangeError(`validity is a whole amount from 1 to ${MAXIMUM_VALIDITY} of weeks, months or year`);
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) throw new RangeError("from is a valid Date");
  if (checked.unit === "weeks") return new Date(from.getTime() + checked.amount * WEEK);
  return addMonths(from, checked.unit === "months" ? checked.amount : checked.amount * 12);
}
