import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS, PLANS_COLLECTION, SESSIONS_COLLECTION, VOUCHERS_COLLECTION, applyDiscount, createMemberPricing, discountPercentFor,
  expiryFrom, installedSettings, isEligible, isFixedPrice, normaliseEmail, resolveItemPrice, settingsFrom, validatePlanInput, type PricingRule,
} from "../implementation/server/index.ts";
import * as web from "../implementation/web/index.ts";
import { createStore } from "./fixtures/records.ts";
import { countingSource, createVoucherCodes } from "./fixtures/codes.ts";
import { importRendered, placeholders } from "./render.ts";
import { friendsOfTheStudio } from "../examples/consumer.ts";

const template = new URL("../implementation/web/settings.ts", import.meta.url);
const MINUTE = 60_000;

function clock(start: string) {
  let time = Date.parse(start);
  return { now: () => new Date(time), advance: (minutes: number) => { time += minutes * MINUTE; } };
}

const options = [{ minutes: 45, price: 6000 }, { minutes: 60, price: 7000 }, { minutes: null, price: 9000 }];
const discount: PricingRule = { mode: "discount", discountPercent: 15, itemSlugs: ["deep-facial"], categorySlugs: ["massage"], allItems: false };
const custom: PricingRule = {
  mode: "custom", discountPercent: 0, itemSlugs: ["relaxing-massage"], categorySlugs: [], allItems: false,
  itemPricing: { "relaxing-massage": { type: "fixed", minutes: 60, price: 5000 } },
};
const mixed: PricingRule = {
  mode: "mixed", discountPercent: 0, itemSlugs: ["relaxing-massage", "deep-facial"], categorySlugs: [], allItems: false,
  itemPricing: { "relaxing-massage": { type: "fixed", minutes: 45, price: 4000 }, "deep-facial": { type: "discount", discountPercent: 20, minutes: 0, price: 0 } },
};
const friends = {
  title: { en: "Friends of the studio", es: "Amigos del estudio" }, mode: "discount", discountPercent: 15, categorySlugs: ["massage"],
  validity: { amount: 3, unit: "months" },
};

function setup(start = "2026-03-02T10:00:00Z", settings?: Record<string, unknown>) {
  const time = clock(start);
  const records = createStore({ now: time.now });
  const source = countingSource();
  const codes = createVoucherCodes({ source });
  const members = createMemberPricing({ records, codes, now: time.now, settings });
  return { time, records, source, codes, members };
}

async function activePlan(members: ReturnType<typeof setup>["members"], input: object = friends) {
  const created = await members.createPlan(input);
  assert.ok(created.ok, JSON.stringify(created));
  const switched = await members.setPlanActive(created.plan._id, true);
  assert.ok(switched.ok);
  return switched.plan;
}

async function member(members: ReturnType<typeof setup>["members"], planId: string, name = "Ana Example", email = "ana@example.com") {
  const opened = await members.openSession(planId);
  assert.ok(opened.ok);
  assert.deepEqual(await members.submitSession(opened.sessionId, { name, email, language: "es" }), { ok: true });
  const approved = await members.approve(opened.sessionId);
  assert.ok(approved.ok, JSON.stringify(approved));
  return approved.voucher;
}

test("the settings template names only declared plain settings and renders to the defaults", async () => {
  assert.deepEqual(placeholders(template).sort(), ["fixedPriceStep", "maximumFixedPrice", "maximumMinutes", "minimumFixedPrice", "minimumMinutes", "minutesStep", "sessionMinutes"]);
  // The defaults declared in authoring/spec.json collect.
  const rendered = await importRendered<{ rawSettings: Record<string, string> }>(template, {
    minimumFixedPrice: 500, maximumFixedPrice: 50000, fixedPriceStep: 500, minimumMinutes: 5, maximumMinutes: 180, minutesStep: 5, sessionMinutes: 15,
  });
  assert.deepEqual(settingsFrom(rendered.rawSettings), DEFAULT_SETTINGS);
  assert.deepEqual(installedSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFrom({ sessionMinutes: "30", fixedPriceStep: 100 }), { ...DEFAULT_SETTINGS, sessionMinutes: 30, fixedPriceStep: 100 });
  for (const bad of [{ sessionMinutes: "0" }, { minutesStep: "five" }, { maximumMinutes: 2000 }, { minimumFixedPrice: 1.5 },
    { minimumFixedPrice: 60000 }, { minimumMinutes: 200 }]) {
    assert.throws(() => settingsFrom(bad), RangeError, JSON.stringify(bad));
  }
});

test("eligibility follows the plan's mode: custom and mixed plans cover the items they price", () => {
  assert.equal(isEligible(null, "anything", "any"), true);
  assert.equal(isEligible(discount, "aromatherapy-massage", "massage"), true);
  assert.equal(isEligible(discount, "deep-facial", "facials"), true);
  assert.equal(isEligible(discount, "hydrating-facial", "facials"), false);
  assert.equal(isEligible({ ...discount, itemSlugs: [], categorySlugs: [], allItems: true }, "x", "y"), true);
  assert.equal(isEligible(custom, "relaxing-massage", "massage"), true);
  assert.equal(isEligible(custom, "aromatherapy-massage", "massage"), false);
  assert.equal(isEligible(mixed, "deep-facial", "facials"), true);
  assert.equal(isEligible(mixed, "constructor", "massage"), false);
  assert.equal(isEligible(custom, "toString", "massage"), false);
});

test("fixed prices: every item of a custom plan, the fixed items of a mixed plan", () => {
  assert.equal(isFixedPrice(null, "relaxing-massage"), false);
  assert.equal(isFixedPrice(custom, "relaxing-massage"), true);
  assert.equal(isFixedPrice(custom, "aromatherapy-massage"), true);
  assert.equal(isFixedPrice(mixed, "relaxing-massage"), true);
  assert.equal(isFixedPrice(mixed, "deep-facial"), false);
  assert.equal(isFixedPrice(discount, "deep-facial"), false);
});

test("the discount of an item: the plan's for covered items, a mixed plan's per item", () => {
  assert.equal(discountPercentFor(null, "deep-facial", "facials"), null);
  assert.equal(discountPercentFor(discount, "deep-facial", "facials"), 15);
  assert.equal(discountPercentFor(discount, "hydrating-facial", "facials"), null);
  assert.equal(discountPercentFor({ ...discount, discountPercent: 0 }, "deep-facial", "facials"), null);
  assert.equal(discountPercentFor(mixed, "deep-facial", "facials"), 20);
  assert.equal(discountPercentFor(mixed, "relaxing-massage", "massage"), null);
  assert.equal(discountPercentFor(mixed, "aromatherapy-massage", "massage"), null);
  assert.equal(discountPercentFor(custom, "relaxing-massage", "massage"), null);
});

test("a discount is taken in minor units and rounded half up", () => {
  assert.equal(applyDiscount(7500, 15), 6375);
  assert.equal(applyDiscount(8000, 33), 5360);
  // 45.50 euros at 15% is 38.675, which rounds half up to 38.68.
  assert.equal(applyDiscount(4550, 15), 3868);
  assert.equal(applyDiscount(999, 0), 999);
  assert.equal(applyDiscount(999, 100), 0);
  for (const [price, percent] of [[-1, 10], [10.5, 10], [100, -1], [100, 101], [100, Number.NaN]]) {
    assert.throws(() => applyDiscount(price, percent), RangeError, JSON.stringify([price, percent]));
  }
});

test("one price resolver for the reserve page and the server", () => {
  assert.deepEqual(resolveItemPrice(null, "relaxing-massage", "massage", options, 60), { price: 7000, minutes: 60 });
  assert.equal(resolveItemPrice(null, "relaxing-massage", "massage", options, 90), null);
  assert.deepEqual(resolveItemPrice(discount, "relaxing-massage", "massage", options, 45), { price: 5100, minutes: 45 });
  assert.deepEqual(resolveItemPrice(discount, "hydrating-facial", "facials", options, 60), { price: 7000, minutes: 60 });
  // A fixed price sells only its own length; a custom plan sells nothing else.
  assert.deepEqual(resolveItemPrice(custom, "relaxing-massage", "massage", options, 60), { price: 5000, minutes: 60 });
  assert.equal(resolveItemPrice(custom, "relaxing-massage", "massage", options, 45), null);
  assert.equal(resolveItemPrice(custom, "aromatherapy-massage", "massage", options, 60), null);
  assert.deepEqual(resolveItemPrice(mixed, "relaxing-massage", "massage", options, 45), { price: 4000, minutes: 45 });
  assert.equal(resolveItemPrice(mixed, "relaxing-massage", "massage", options, 60), null);
  assert.deepEqual(resolveItemPrice(mixed, "deep-facial", "facials", options, 60), { price: 5600, minutes: 60 });
  assert.deepEqual(resolveItemPrice(mixed, "aromatherapy-massage", "massage", options, 60), { price: 7000, minutes: 60 });
  assert.equal(resolveItemPrice(null, "x", "y", [{ minutes: null, price: 100 }], 0), null);
});

test("a discount plan's input is checked as the source checked it", () => {
  const checked = validatePlanInput({ ...friends, title: { en: " Friends ", fr: "Amis" }, conditions: { en: "Regulars only.", es: "" }, itemSlugs: ["deep-facial", "deep-facial"] });
  assert.deepEqual(checked, { ok: true, plan: {
    title: { en: "Friends", fr: "Amis" }, conditions: { en: "Regulars only." }, validity: { amount: 3, unit: "months" },
    rule: { mode: "discount", discountPercent: 15, itemSlugs: ["deep-facial"], categorySlugs: ["massage"], allItems: false },
  } });
  const code = (input: unknown) => {
    const result = validatePlanInput(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    return result.ok ? null : result.code;
  };
  assert.equal(code("plan"), "INVALID_INPUT");
  assert.equal(code({ ...friends, title: {} }), "INVALID_TITLE");
  assert.equal(code({ ...friends, title: { English: "x" } }), "INVALID_TITLE");
  assert.equal(code({ ...friends, conditions: "none" }), "INVALID_CONDITIONS");
  for (const validity of [undefined, { amount: 0, unit: "months" }, { amount: 1.5, unit: "weeks" }, { amount: 2, unit: "days" }, { amount: 1001, unit: "weeks" }]) {
    assert.equal(code({ ...friends, validity }), "INVALID_VALIDITY", JSON.stringify(validity));
  }
  assert.equal(code({ ...friends, mode: "free" }), "INVALID_MODE");
  for (const discountPercent of [undefined, 0, 100, 12.5, "15"]) assert.equal(code({ ...friends, discountPercent }), "INVALID_DISCOUNT");
  assert.equal(code({ ...friends, categorySlugs: [] }), "INVALID_SCOPE");
  assert.equal(code({ ...friends, itemSlugs: "deep-facial" }), "INVALID_SCOPE");
  assert.equal(code({ ...friends, allItems: "yes" }), "INVALID_SCOPE");
  const all = validatePlanInput({ ...friends, categorySlugs: [], allItems: true, mode: undefined });
  assert.equal(all.ok && all.plan.rule.allItems, true);
  const failed = validatePlanInput({ ...friends, discountPercent: 0 });
  assert.equal(!failed.ok && failed.error, "discountPercent is a whole number from 1 to 99");
});

test("custom and mixed plans price each item within the settings' bounds and cover only those items", () => {
  const plan = { title: { en: "Staff" }, validity: { amount: 1, unit: "year" }, discountPercent: 30, categorySlugs: ["massage"], allItems: true };
  const customPlan = validatePlanInput({ ...plan, mode: "custom", itemPricing: { "relaxing-massage": { minutes: 60, price: 5000, type: "discount" } } });
  assert.deepEqual(customPlan.ok && customPlan.plan.rule, custom);
  const mixedPlan = validatePlanInput({ ...plan, mode: "mixed", itemPricing: {
    "relaxing-massage": { type: "fixed", minutes: 45, price: 4000 }, "deep-facial": { type: "discount", discountPercent: 20, minutes: 60, price: 9500 } } });
  assert.deepEqual(mixedPlan.ok && mixedPlan.plan.rule, mixed);
  const code = (mode: string, itemPricing: unknown, settings = DEFAULT_SETTINGS) => {
    const result = validatePlanInput({ ...plan, mode, itemPricing }, settings);
    return result.ok ? "ok" : `${result.code}: ${result.error}`;
  };
  assert.equal(code("custom", undefined), "MISSING_ITEMS: a custom plan prices at least one item");
  assert.equal(code("mixed", {}), "MISSING_ITEMS: a mixed plan prices at least one item");
  assert.equal(code("mixed", { "deep-facial": { minutes: 60, price: 5000 } }), 'INVALID_ITEM_TYPE: item "deep-facial": type is "discount" or "fixed"');
  assert.equal(code("custom", { "deep-facial": "cheap" }), 'INVALID_ITEM_TYPE: item "deep-facial": type is "discount" or "fixed"');
  assert.equal(code("mixed", { "deep-facial": { type: "discount", discountPercent: 0 } }), 'INVALID_DISCOUNT: item "deep-facial": discountPercent is a whole number from 1 to 99');
  assert.equal(code("custom", { "deep-facial": { minutes: 62, price: 5000 } }), 'INVALID_MINUTES: item "deep-facial": minutes is a multiple of 5 from 5 to 180');
  assert.equal(code("custom", { "deep-facial": { minutes: 185, price: 5000 } }).split(":")[0], "INVALID_MINUTES");
  assert.equal(code("custom", { "deep-facial": { minutes: 60, price: 5050 } }), 'INVALID_PRICE: item "deep-facial": price is a multiple of 500 from 500 to 50000 minor units');
  assert.equal(code("custom", { "deep-facial": { minutes: 60, price: 0 } }).split(":")[0], "INVALID_PRICE");
  assert.equal(code("custom", { "deep-facial": { minutes: 60, price: 50500 } }).split(":")[0], "INVALID_PRICE");
  assert.equal(code("custom", { "deep.facial": { minutes: 60, price: 5000 } }), 'INVALID_SCOPE: "deep.facial" is not an item slug');
  assert.equal(code("custom", { __proto__: null, $where: { minutes: 60, price: 5000 } }).split(":")[0], "INVALID_SCOPE");
  const fine = { ...DEFAULT_SETTINGS, minimumMinutes: 10, minutesStep: 10, fixedPriceStep: 50, minimumFixedPrice: 50 };
  assert.equal(code("custom", { "deep-facial": { minutes: 70, price: 4550 } }, fine), "ok");
  assert.equal(code("custom", { "deep-facial": { minutes: 75, price: 4550 } }, fine).split(":")[0], "INVALID_MINUTES");
});

test("a voucher runs for its plan's weeks, calendar months or years", () => {
  const from = new Date("2026-01-31T09:30:00.000Z");
  assert.deepEqual(expiryFrom({ amount: 2, unit: "weeks" }, from), new Date("2026-02-14T09:30:00.000Z"));
  assert.deepEqual(expiryFrom({ amount: 1, unit: "months" }, from), new Date("2026-02-28T09:30:00.000Z"));
  assert.deepEqual(expiryFrom({ amount: 3, unit: "months" }, from), new Date("2026-04-30T09:30:00.000Z"));
  assert.deepEqual(expiryFrom({ amount: 13, unit: "months" }, from), new Date("2027-02-28T09:30:00.000Z"));
  assert.deepEqual(expiryFrom({ amount: 1, unit: "months" }, new Date("2028-01-31T00:00:00Z")), new Date("2028-02-29T00:00:00Z"));
  assert.deepEqual(expiryFrom({ amount: 1, unit: "year" }, new Date("2028-02-29T12:00:00Z")), new Date("2029-02-28T12:00:00Z"));
  // A validity of several years counts every one of them.
  assert.deepEqual(expiryFrom({ amount: 2, unit: "year" }, from), new Date("2028-01-31T09:30:00.000Z"));
  assert.throws(() => expiryFrom({ amount: 0, unit: "weeks" }, from), RangeError);
  assert.throws(() => expiryFrom({ amount: 1, unit: "days" } as never, from), RangeError);
  assert.throws(() => expiryFrom({ amount: 1, unit: "weeks" }, new Date(Number.NaN)), RangeError);
});

test("email addresses are trimmed and lower case", () => {
  assert.equal(normaliseEmail("  Ana@Example.COM "), "ana@example.com");
  for (const bad of ["ana", "ana@example", "a b@example.com", "", 42, null, `${"a".repeat(250)}@example.com`]) assert.equal(normaliseEmail(bad), null, String(bad));
});

test("plans: created switched off, listed newest first with their member counts, switched on, edited and removed", async () => {
  const { time, members } = setup();
  const created = await members.createPlan(friends);
  assert.ok(created.ok);
  const plan = created.plan;
  assert.match(plan._id, /^[0-9a-f]{24}$/);
  assert.equal(plan.active, false);
  assert.deepEqual([plan.createdAt, plan.updatedAt], [time.now(), time.now()]);
  assert.deepEqual(await members.plan(plan._id), plan);
  assert.deepEqual(await members.createPlan({ ...friends, discountPercent: 0 }), { ok: false, code: "INVALID_DISCOUNT", error: "discountPercent is a whole number from 1 to 99" });
  time.advance(1);
  const staff = await members.createPlan({ title: { en: "Staff" }, mode: "custom", itemPricing: { "relaxing-massage": { minutes: 60, price: 5000 } }, validity: { amount: 1, unit: "year" } });
  assert.ok(staff.ok);
  assert.deepEqual((await members.listPlans()).map((item) => [item.title.en, item.memberCount]), [["Staff", 0], ["Friends of the studio", 0]]);

  assert.deepEqual(await members.openSession(plan._id), { ok: false, code: "INACTIVE" });
  const on = await members.setPlanActive(plan._id, true);
  assert.ok(on.ok && on.plan.active);
  assert.deepEqual(await members.setPlanActive(plan._id, "yes"), { ok: false, code: "MISSING_FIELDS" });
  assert.deepEqual(await members.setPlanActive("missing", true), { ok: false, code: "NOT_FOUND" });
  const first = await member(members, plan._id);
  await member(members, plan._id, "Ben Example", "ben@example.com");
  await members.revoke(first.code);
  assert.deepEqual((await members.listPlans()).map((item) => item.memberCount), [0, 1]);

  // Edits replace the fields given and check the whole plan again; issued vouchers keep their rule.
  time.advance(1);
  const edited = await members.updatePlan(plan._id, { discountPercent: 20, title: { en: "Friends" } });
  assert.ok(edited.ok);
  assert.deepEqual([edited.plan.title, edited.plan.rule.discountPercent, edited.plan.rule.categorySlugs, edited.plan.active], [{ en: "Friends" }, 20, ["massage"], true]);
  assert.deepEqual(edited.plan.updatedAt, time.now());
  assert.equal((await members.lookup(first.code))?.rule.discountPercent, 15);
  const switched = await members.updatePlan(plan._id, { mode: "mixed", itemPricing: { "deep-facial": { type: "discount", discountPercent: 25 } } });
  assert.ok(switched.ok);
  assert.deepEqual(switched.plan.rule, { mode: "mixed", discountPercent: 0, itemSlugs: ["deep-facial"], categorySlugs: [], allItems: false,
    itemPricing: { "deep-facial": { type: "discount", discountPercent: 25, minutes: 0, price: 0 } } });
  const back = await members.updatePlan(plan._id, { mode: "discount", discountPercent: 10 });
  assert.ok(back.ok);
  assert.deepEqual(back.plan.rule, { mode: "discount", discountPercent: 10, itemSlugs: ["deep-facial"], categorySlugs: [], allItems: false });
  assert.deepEqual(await members.updatePlan(plan._id, { validity: { amount: 0, unit: "weeks" } }), {
    ok: false, code: "INVALID_VALIDITY", error: "validity is a whole amount from 1 to 1000 of weeks, months or year" });
  assert.deepEqual(await members.updatePlan(plan._id, "x"), { ok: false, code: "INVALID_INPUT", error: "a plan is an object" });
  assert.deepEqual(await members.updatePlan("missing", { discountPercent: 5 }), { ok: false, code: "NOT_FOUND" });

  assert.deepEqual(await members.removePlan(plan._id), { ok: true });
  assert.deepEqual(await members.removePlan(plan._id), { ok: false, code: "NOT_FOUND" });
  assert.deepEqual(await members.removePlan(7), { ok: false, code: "NOT_FOUND" });
  assert.equal(await members.plan(plan._id), null);
  assert.equal((await members.validate(first.code.replace(/-/g, ""))).valid, false);
});

test("a sign-up session: opened by staff for an active plan, filled in by the person, shown to both", async () => {
  const { time, members } = setup();
  const plan = await activePlan(members);
  assert.deepEqual(await members.openSession("missing"), { ok: false, code: "NOT_FOUND" });
  const opened = await members.openSession(plan._id);
  assert.ok(opened.ok);
  assert.match(opened.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(opened.expiresAt, new Date(time.now().getTime() + 15 * MINUTE));
  const view = await members.session(opened.sessionId);
  assert.deepEqual(view, { sessionId: opened.sessionId, state: "pending_email", name: null, email: null, language: null, expiresAt: opened.expiresAt,
    plan: { _id: plan._id, title: plan.title, conditions: plan.conditions, rule: plan.rule, validity: plan.validity } });

  for (const [details, code] of [[{ name: " ", email: "ana@example.com" }, "INVALID_NAME"], [{ name: "x".repeat(101), email: "ana@example.com" }, "INVALID_NAME"],
    [{ name: "Ana", email: "ana" }, "INVALID_EMAIL"], [null, "INVALID_NAME"]] as const) {
    assert.deepEqual(await members.submitSession(opened.sessionId, details), { ok: false, code }, JSON.stringify(details));
  }
  assert.deepEqual(await members.submitSession("missing", { name: "Ana", email: "ana@example.com" }), { ok: false, code: "NOT_FOUND" });
  assert.deepEqual(await members.submitSession(opened.sessionId, { name: " Ana Example ", email: " Ana@Example.com", language: "Spanish" }), { ok: true });
  const filled = await members.session(opened.sessionId);
  assert.deepEqual([filled?.state, filled?.name, filled?.email, filled?.language], ["pending_approval", "Ana Example", "ana@example.com", "en"]);
  assert.deepEqual(await members.submitSession(opened.sessionId, { name: "Ana", email: "ana@example.com" }), { ok: false, code: "WRONG_STATE" });
  assert.equal(await members.session(undefined), null);
  assert.equal(await members.session("missing"), null);
});

test("a session lasts sessionMinutes from opening, read by the clock even before the store removes it", async () => {
  const { time, members } = setup("2026-03-02T10:00:00Z", { sessionMinutes: 10 });
  const plan = await activePlan(members);
  const opened = await members.openSession(plan._id);
  assert.ok(opened.ok);
  assert.deepEqual(opened.expiresAt, new Date(Date.parse("2026-03-02T10:10:00Z")));
  time.advance(9);
  assert.deepEqual(await members.submitSession(opened.sessionId, { name: "Ana", email: "ana@example.com" }), { ok: true });
  time.advance(1);
  assert.equal(await members.session(opened.sessionId), null);
  assert.deepEqual(await members.approve(opened.sessionId), { ok: false, code: "NOT_FOUND" });
});

test("approval issues a voucher with the plan's rule and validity, once", async () => {
  const { time, records, members } = setup();
  const plan = await activePlan(members);
  await members.ensureIndexes();
  const opened = await members.openSession(plan._id);
  assert.ok(opened.ok);
  assert.deepEqual(await members.approve(opened.sessionId), { ok: false, code: "WRONG_STATE" });
  assert.deepEqual(await members.approve("missing"), { ok: false, code: "NOT_FOUND" });
  await members.submitSession(opened.sessionId, { name: "Ana Example", email: "ana@example.com", language: "es" });
  time.advance(2);
  const approved = await members.approve(opened.sessionId);
  assert.ok(approved.ok);
  const { voucher } = approved;
  assert.deepEqual(approved.plan, plan);
  assert.equal(voucher.code, "AAAA-AAAA-AAAA");
  assert.deepEqual({ ...voucher, _id: "" }, {
    _id: "", code: "AAAA-AAAA-AAAA", planId: plan._id, name: "Ana Example", email: "ana@example.com", rule: plan.rule, status: "active", language: "es",
    issuedAt: time.now(), expiresAt: new Date("2026-06-02T10:02:00.000Z"),
  });
  assert.deepEqual(await records.collection(VOUCHERS_COLLECTION).findOne({ code: voucher.code }), voucher);
  assert.equal((await members.session(opened.sessionId))?.state, "approved");
  assert.deepEqual(await members.approve(opened.sessionId), { ok: false, code: "WRONG_STATE" });
  assert.equal(await records.collection(VOUCHERS_COLLECTION).countDocuments({}), 1);
});

test("a code already taken is drawn again; a failed approval returns the session to staff", async () => {
  const { time, records, source, members, codes } = setup();
  const plan = await activePlan(members);
  await members.ensureIndexes();
  const first = await member(members, plan._id);
  source.reset();
  const second = await member(members, plan._id, "Ben Example", "ben@example.com");
  assert.deepEqual([first.code, second.code], ["AAAA-AAAA-AAAA", "AAAA-AAAA-AAAB"]);

  const opened = await members.openSession(plan._id);
  assert.ok(opened.ok);
  await members.submitSession(opened.sessionId, { name: "Cleo", email: "cleo@example.com" });
  const failing = createMemberPricing({ records, now: time.now, codes: { normalise: codes.normalise, withRetry: async () => { throw new Error("store down"); } } });
  await assert.rejects(failing.approve(opened.sessionId), /store down/);
  assert.equal((await members.session(opened.sessionId))?.state, "pending_approval");
  assert.throws(() => createMemberPricing({ records, codes: undefined as never }), TypeError);
});

test("approval needs the plan to still exist", async () => {
  const { members } = setup();
  const plan = await activePlan(members);
  const opened = await members.openSession(plan._id);
  assert.ok(opened.ok);
  await members.submitSession(opened.sessionId, { name: "Ana", email: "ana@example.com" });
  await members.removePlan(plan._id);
  assert.deepEqual(await members.approve(opened.sessionId), { ok: false, code: "PLAN_NOT_FOUND" });
  assert.equal((await members.session(opened.sessionId))?.plan, null);
});

test("validating a code for the reserve page: missing, unknown, revoked, expired, valid", async () => {
  const { time, records, members } = setup();
  const plan = await activePlan(members);
  const voucher = await member(members, plan._id);
  assert.deepEqual(await members.validate(""), { valid: false, reason: "missing_code" });
  assert.deepEqual(await members.validate(undefined), { valid: false, reason: "missing_code" });
  assert.deepEqual(await members.validate("ZZZZ-ZZZZ-ZZZZ"), { valid: false, reason: "not_found" });
  assert.deepEqual(await members.validate("not a code"), { valid: false, reason: "not_found" });
  assert.deepEqual(await members.validate(" aaaa aaaa aaaa "), {
    valid: true, code: voucher.code, rule: plan.rule, name: "Ana Example", email: "ana@example.com", expiresAt: voucher.expiresAt });
  assert.deepEqual(await members.activeRule("AAAAAAAAAAAA"), { rule: plan.rule, voucher });
  assert.equal(members.resolveItemPrice, resolveItemPrice);
  assert.deepEqual(members.resolveItemPrice(plan.rule, "relaxing-massage", "massage", options, 60), { price: 5950, minutes: 60 });
  time.advance(92 * 24 * 60 + 1);
  assert.deepEqual(await members.activeRule(voucher.code), null);
  assert.deepEqual(await members.validate(voucher.code), { valid: false, reason: "expired" });
  assert.equal((await records.collection(VOUCHERS_COLLECTION).findOne({ code: voucher.code }))?.status, "expired");
  assert.deepEqual(await members.validate(voucher.code), { valid: false, reason: "expired" });
  await members.revoke(voucher.code);
  assert.deepEqual(await members.validate(voucher.code), { valid: false, reason: "revoked" });
});

test("staff look vouchers up, revoke, remove and resend them", async () => {
  const { time, members } = setup();
  const plan = await activePlan(members);
  const voucher = await member(members, plan._id);
  assert.deepEqual(await members.lookup("aaaa-aaaa-aaaa"), voucher);
  assert.equal(await members.lookup("BBBB-BBBB-BBBB"), null);
  assert.equal(await members.lookup(5), null);

  assert.deepEqual(await members.changeEmail(voucher.code, "ana"), { ok: false, code: "INVALID_EMAIL" });
  assert.deepEqual(await members.changeEmail("BBBB-BBBB-BBBB", "ana@example.org"), { ok: false, code: "NOT_FOUND" });
  const moved = await members.changeEmail(voucher.code, " Ana@Example.ORG ");
  assert.ok(moved.ok);
  assert.equal(moved.voucher.email, "ana@example.org");
  assert.equal(moved.plan?._id, plan._id);

  const revoked = await members.revoke(voucher.code);
  assert.ok(revoked.ok);
  assert.equal(revoked.voucher.status, "revoked");
  assert.deepEqual(await members.revoke("BBBB-BBBB-BBBB"), { ok: false, code: "NOT_FOUND" });
  assert.equal(await members.activeRule(voucher.code), null);
  const removed = await members.remove(voucher.code);
  assert.deepEqual(removed, { ok: true, voucher: { ...revoked.voucher }, notify: false, expired: false });
  assert.deepEqual(await members.remove(voucher.code), { ok: false, code: "NOT_FOUND" });

  const other = await member(members, plan._id, "Ben Example", "ben@example.com");
  time.advance(100 * 24 * 60);
  const gone = await members.remove(other.code);
  assert.ok(gone.ok);
  assert.deepEqual([gone.notify, gone.expired], [true, true]);
});

test("a plan's vouchers, newest first, with lapsed ones marked expired", async () => {
  const { time, members } = setup();
  const plan = await activePlan(members, { ...friends, validity: { amount: 1, unit: "weeks" } });
  const first = await member(members, plan._id);
  time.advance(3 * 24 * 60);
  const second = await member(members, plan._id, "Ben Example", "ben@example.com");
  time.advance(5 * 24 * 60);
  const list = await members.vouchersOf(plan._id);
  assert.deepEqual(list.map((item) => [item.code, item.status]), [[second.code, "active"], [first.code, "expired"]]);
  assert.deepEqual(await members.vouchersOf("missing"), []);
  assert.deepEqual(await members.vouchersOf(null), []);
});

test("the vouchers of an address, for the customer's wallet: newest first, lapsed ones marked expired, revoked ones kept", async () => {
  const { time, members } = setup();
  const plan = await activePlan(members, { ...friends, validity: { amount: 1, unit: "weeks" } });
  const first = await member(members, plan._id, "Ana Example", "Ana@Example.com");
  time.advance(3 * 24 * 60);
  const second = await member(members, plan._id, "Ana Example", "ana@example.com");
  time.advance(1);
  const third = await member(members, plan._id, "Ana Example", "ana@example.com");
  await member(members, plan._id, "Ben Example", "ben@example.com");
  assert.ok((await members.revoke(third.code)).ok);
  time.advance(5 * 24 * 60);
  const list = await members.vouchersByEmail("  ANA@example.COM ");
  assert.deepEqual(list.map((item) => [item.code, item.status]), [[third.code, "revoked"], [second.code, "active"], [first.code, "expired"]]);
  assert.deepEqual(await members.vouchersByEmail("cleo@example.com"), []);
  assert.deepEqual(await members.vouchersByEmail("ana"), []);
  assert.deepEqual(await members.vouchersByEmail(undefined), []);
});

test("ensureIndexes creates the unique code and session indexes and the session expiry", async () => {
  const { records, members } = setup("2026-03-02T10:00:00Z", { sessionMinutes: 20 });
  await members.ensureIndexes();
  assert.deepEqual(await records.collection(VOUCHERS_COLLECTION).listIndexes(), [
    { key: { code: 1 }, unique: true }, { key: { email: 1 } }, { key: { planId: 1 } }, { key: { expiresAt: 1 } }, { key: { status: 1 } }]);
  assert.deepEqual(await records.collection(SESSIONS_COLLECTION).listIndexes(), [{ key: { sessionId: 1 }, unique: true }, { key: { createdAt: 1 }, expireAfterSeconds: 1200 }]);
  assert.deepEqual(await records.collection(PLANS_COLLECTION).listIndexes(), [{ key: { createdAt: -1 } }]);
});

test("the records export carries plans, vouchers and sessions to another store with their dates (migration.json)", async () => {
  const { time, records, members } = setup();
  await members.ensureIndexes();
  const plan = await activePlan(members);
  const voucher = await member(members, plan._id);
  const exported = records.exportAll();
  const lines = exported.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([...new Set(lines.map((line) => line.collection))], [PLANS_COLLECTION, SESSIONS_COLLECTION, VOUCHERS_COLLECTION]);
  const target = createStore({ now: time.now });
  assert.deepEqual(target.importAll(exported), { collections: 3, records: 3 });
  const moved = createMemberPricing({ records: target, codes: createVoucherCodes({ source: countingSource() }), now: time.now });
  assert.deepEqual(await moved.lookup(voucher.code), voucher);
  assert.deepEqual((await moved.listPlans()).map((item) => item.memberCount), [1]);
  await assert.rejects(target.collection(VOUCHERS_COLLECTION).insertOne({ code: voucher.code }), (error: unknown) => (error as { code?: string }).code === "duplicate-key");
});

test("the web entry holds the pure rules and the server entry adds the service", () => {
  assert.equal("createMemberPricing" in web, false);
  for (const name of ["isEligible", "isFixedPrice", "discountPercentFor", "applyDiscount", "resolveItemPrice", "validatePlanInput", "expiryFrom", "normaliseEmail",
    "isLanguage", "settingsFrom", "installedSettings"]) {
    assert.equal(typeof (web as Record<string, unknown>)[name], "function", name);
  }
  assert.deepEqual([PLANS_COLLECTION, VOUCHERS_COLLECTION, SESSIONS_COLLECTION], ["memberPlans", "memberVouchers", "memberSessions"]);
});

test("the example signs a member up and prices Example Studio's massage the same on the page and the server", async () => {
  const time = clock("2026-03-02T10:00:00Z");
  const result = await friendsOfTheStudio(createStore({ now: time.now }), createVoucherCodes({ source: countingSource() }), time.now);
  assert.deepEqual(result, { email: "ana@example.com", page: { price: 5950, minutes: 60 }, server: { price: 5950, minutes: 60 } });
});
