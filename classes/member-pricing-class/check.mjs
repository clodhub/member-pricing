import { readFileSync } from 'node:fs';
import { assert, load } from './runtime.mjs';
import { createStore } from './records.ts';
import { countingSource, createVoucherCodes } from './codes.ts';

const web = await load('web/index.ts');
const server = await load('server/index.ts');
let clock = Date.parse('2026-03-02T10:00:00.000Z');
const now = () => new Date(clock);
const minutes = (count) => { clock += count * 60_000; };
const schema = (name) => JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8'));

// Both entry modules give the pure rules; settings default as the class declares.
for (const name of ['isEligible', 'isFixedPrice', 'discountPercentFor', 'applyDiscount', 'resolveItemPrice', 'validatePlanInput', 'expiryFrom',
  'normaliseEmail', 'isLanguage', 'settingsFrom', 'installedSettings']) {
  assert.equal(typeof web[name], 'function', name);
  assert.equal(typeof server[name], 'function', name);
}
assert.equal(typeof server.createMemberPricing, 'function');
const defaults = { minimumFixedPrice: 500, maximumFixedPrice: 50000, fixedPriceStep: 500, minimumMinutes: 5, maximumMinutes: 180, minutesStep: 5, sessionMinutes: 15 };
assert.deepEqual(web.settingsFrom({}), defaults);
assert.deepEqual(web.settingsFrom({ sessionMinutes: '30', minutesStep: '{{minutesStep}}' }), { ...defaults, sessionMinutes: 30 });
assert.throws(() => web.settingsFrom({ sessionMinutes: '0' }), RangeError);
assert.throws(() => web.settingsFrom({ minimumMinutes: 200 }), RangeError);

// The three modes, priced the same way wherever the resolver runs.
const discount = { mode: 'discount', discountPercent: 15, itemSlugs: ['deep-facial'], categorySlugs: ['massage'], allItems: false };
const custom = { mode: 'custom', discountPercent: 0, itemSlugs: ['relaxing-massage'], categorySlugs: [], allItems: false,
  itemPricing: { 'relaxing-massage': { type: 'fixed', minutes: 60, price: 5000 } } };
const mixed = { mode: 'mixed', discountPercent: 0, itemSlugs: ['relaxing-massage', 'deep-facial'], categorySlugs: [], allItems: false,
  itemPricing: { 'relaxing-massage': { type: 'fixed', minutes: 45, price: 4000 }, 'deep-facial': { type: 'discount', discountPercent: 20, minutes: 0, price: 0 } } };
const options = [{ minutes: 45, price: 6000 }, { minutes: 60, price: 7000 }];
assert.equal(web.isEligible(null, 'any', 'thing'), true);
assert.equal(web.isEligible(discount, 'aromatherapy-massage', 'massage'), true);
assert.equal(web.isEligible(discount, 'hydrating-facial', 'facials'), false);
assert.equal(web.isEligible(custom, 'aromatherapy-massage', 'massage'), false);
assert.equal(web.isEligible(mixed, 'constructor', 'massage'), false);
assert.equal(web.isFixedPrice(custom, 'anything'), true);
assert.equal(web.isFixedPrice(mixed, 'deep-facial'), false);
assert.equal(web.discountPercentFor(discount, 'deep-facial', 'facials'), 15);
assert.equal(web.discountPercentFor(mixed, 'deep-facial', 'facials'), 20);
assert.equal(web.discountPercentFor(mixed, 'relaxing-massage', 'massage'), null);
assert.equal(web.applyDiscount(4550, 15), 3868);
assert.throws(() => web.applyDiscount(10.5, 15), RangeError);
assert.deepEqual(web.resolveItemPrice(null, 'relaxing-massage', 'massage', options, 60), { price: 7000, minutes: 60 });
assert.deepEqual(web.resolveItemPrice(discount, 'relaxing-massage', 'massage', options, 60), { price: 5950, minutes: 60 });
assert.deepEqual(web.resolveItemPrice(custom, 'relaxing-massage', 'massage', options, 60), { price: 5000, minutes: 60 });
assert.equal(web.resolveItemPrice(custom, 'relaxing-massage', 'massage', options, 45), null);
assert.equal(web.resolveItemPrice(custom, 'deep-facial', 'facials', options, 60), null);
assert.deepEqual(web.resolveItemPrice(mixed, 'deep-facial', 'facials', options, 45), { price: 4800, minutes: 45 });
assert.deepEqual(web.resolveItemPrice(mixed, 'aromatherapy-massage', 'massage', options, 45), { price: 6000, minutes: 45 });
assert.equal(web.resolveItemPrice(discount, 'relaxing-massage', 'massage', options, 90), null);

// Plan input: discount plans need a percentage and a scope; custom and mixed plans price items within the settings' bounds.
const friends = { title: { en: 'Friends', es: 'Amigos' }, mode: 'discount', discountPercent: 15, categorySlugs: ['massage'], validity: { amount: 3, unit: 'months' } };
assert.deepEqual(web.validatePlanInput(friends, defaults), { ok: true, plan: { title: { en: 'Friends', es: 'Amigos' }, conditions: {},
  validity: { amount: 3, unit: 'months' }, rule: { mode: 'discount', discountPercent: 15, itemSlugs: [], categorySlugs: ['massage'], allItems: false } } });
const refused = (input) => {
  const result = web.validatePlanInput(input, defaults);
  assert.equal(result.ok, false, JSON.stringify(input));
  assert.equal(typeof result.error, 'string');
  return result.code;
};
assert.equal(refused({ ...friends, title: {} }), 'INVALID_TITLE');
assert.equal(refused({ ...friends, validity: { amount: 2, unit: 'days' } }), 'INVALID_VALIDITY');
assert.equal(refused({ ...friends, discountPercent: 100 }), 'INVALID_DISCOUNT');
assert.equal(refused({ ...friends, categorySlugs: [] }), 'INVALID_SCOPE');
assert.equal(refused({ ...friends, mode: 'custom' }), 'MISSING_ITEMS');
assert.equal(refused({ ...friends, mode: 'mixed', itemPricing: { 'deep-facial': { minutes: 60, price: 5000 } } }), 'INVALID_ITEM_TYPE');
assert.equal(refused({ ...friends, mode: 'custom', itemPricing: { 'deep-facial': { minutes: 62, price: 5000 } } }), 'INVALID_MINUTES');
assert.equal(refused({ ...friends, mode: 'custom', itemPricing: { 'deep-facial': { minutes: 60, price: 5050 } } }), 'INVALID_PRICE');
assert.equal(refused({ ...friends, mode: 'custom', itemPricing: { 'a.b': { minutes: 60, price: 5000 } } }), 'INVALID_SCOPE');
const staffPlan = web.validatePlanInput({ title: { en: 'Staff' }, mode: 'custom', validity: { amount: 1, unit: 'year' },
  itemPricing: { 'relaxing-massage': { minutes: 60, price: 5000 } } }, defaults);
assert.ok(staffPlan.ok);
assert.deepEqual(staffPlan.plan.rule, custom);

// Validity: weeks, calendar months (the last day of a shorter month) and years.
const issued = new Date('2026-01-31T09:00:00.000Z');
assert.deepEqual(web.expiryFrom({ amount: 2, unit: 'weeks' }, issued), new Date('2026-02-14T09:00:00.000Z'));
assert.deepEqual(web.expiryFrom({ amount: 1, unit: 'months' }, issued), new Date('2026-02-28T09:00:00.000Z'));
assert.deepEqual(web.expiryFrom({ amount: 2, unit: 'year' }, issued), new Date('2028-01-31T09:00:00.000Z'));
assert.throws(() => web.expiryFrom({ amount: 0, unit: 'weeks' }, issued), RangeError);
assert.equal(web.normaliseEmail(' Ana@Example.COM '), 'ana@example.com');
assert.equal(web.normaliseEmail('ana'), null);

// The service over a records store, with codes from a voucher codes double whose codes count up.
const records = createStore({ now });
const source = countingSource();
const codes = createVoucherCodes({ source });
const members = server.createMemberPricing({ records, codes, now });
assert.throws(() => server.createMemberPricing({ records }), TypeError);
await members.ensureIndexes();
const created = await members.createPlan(friends);
assert.ok(created.ok);
const plan = created.plan;
assert.equal(plan.active, false);
assert.deepEqual(await members.openSession(plan._id), { ok: false, code: 'INACTIVE' });
assert.deepEqual(await members.openSession('missing'), { ok: false, code: 'NOT_FOUND' });
const on = await members.setPlanActive(plan._id, true);
assert.ok(on.ok && on.plan.active);
assert.deepEqual(await members.setPlanActive(plan._id, 'yes'), { ok: false, code: 'MISSING_FIELDS' });

// Sign-up: staff open a session, the person gives a name and email, staff approve once.
const opened = await members.openSession(plan._id);
assert.ok(opened.ok);
assert.equal(typeof opened.sessionId, 'string');
assert.deepEqual(opened.expiresAt, new Date(clock + 15 * 60_000));
assert.equal((await members.session(opened.sessionId)).state, 'pending_email');
assert.deepEqual(await members.approve(opened.sessionId), { ok: false, code: 'WRONG_STATE' });
assert.deepEqual(await members.submitSession(opened.sessionId, { name: ' ', email: 'ana@example.com' }), { ok: false, code: 'INVALID_NAME' });
assert.deepEqual(await members.submitSession(opened.sessionId, { name: 'Ana', email: 'ana' }), { ok: false, code: 'INVALID_EMAIL' });
assert.deepEqual(await members.submitSession('missing', { name: 'Ana', email: 'ana@example.com' }), { ok: false, code: 'NOT_FOUND' });
assert.deepEqual(await members.submitSession(opened.sessionId, { name: ' Ana Example ', email: 'Ana@Example.com', language: 'es' }), { ok: true });
assert.deepEqual(await members.submitSession(opened.sessionId, { name: 'Ana', email: 'ana@example.com' }), { ok: false, code: 'WRONG_STATE' });
const waiting = await members.session(opened.sessionId);
assert.deepEqual([waiting.state, waiting.name, waiting.email, waiting.language, waiting.plan._id], ['pending_approval', 'Ana Example', 'ana@example.com', 'es', plan._id]);
const approved = await members.approve(opened.sessionId);
assert.ok(approved.ok);
const voucher = approved.voucher;
assert.equal(voucher.code, 'AAAA-AAAA-AAAA');
assert.deepEqual([voucher.planId, voucher.name, voucher.email, voucher.status, voucher.language], [plan._id, 'Ana Example', 'ana@example.com', 'active', 'es']);
assert.deepEqual(voucher.rule, plan.rule);
assert.deepEqual(voucher.issuedAt, now());
assert.deepEqual(voucher.expiresAt, new Date('2026-06-02T10:00:00.000Z'));
assert.deepEqual(await members.approve(opened.sessionId), { ok: false, code: 'WRONG_STATE' });

// Stored documents follow the class's schemas: every required field present, dates as dates.
const [storedPlan] = await records.collection(server.PLANS_COLLECTION).find({});
const [storedVoucher] = await records.collection(server.VOUCHERS_COLLECTION).find({});
const [storedSession] = await records.collection(server.SESSIONS_COLLECTION).find({ sessionId: opened.sessionId });
for (const [doc, name] of [[storedPlan, 'member-plan'], [storedVoucher, 'member-voucher'], [storedSession, 'member-session']]) {
  assert.deepEqual(Object.keys(doc).sort(), [...schema(name).required].sort(), name);
}
assert.ok(storedVoucher.expiresAt instanceof Date && storedSession.createdAt instanceof Date && storedPlan.updatedAt instanceof Date);

// A code already taken is drawn again.
source.reset();
const second = await members.openSession(plan._id);
await members.submitSession(second.sessionId, { name: 'Ben', email: 'ben@example.com' });
const other = await members.approve(second.sessionId);
assert.ok(other.ok);
assert.equal(other.voucher.code, 'AAAA-AAAA-AAAB');

// Sessions last sessionMinutes from opening.
const late = await members.openSession(plan._id);
minutes(15);
assert.equal(await members.session(late.sessionId), null);
assert.deepEqual(await members.submitSession(late.sessionId, { name: 'Cleo', email: 'cleo@example.com' }), { ok: false, code: 'NOT_FOUND' });

// Validation for the reserve page and the rule the server prices with; codes are read as typed.
assert.deepEqual(await members.validate(''), { valid: false, reason: 'missing_code' });
assert.deepEqual(await members.validate('ZZZZ-ZZZZ-ZZZZ'), { valid: false, reason: 'not_found' });
const valid = await members.validate(' aaaa aaaa aaaa ');
assert.deepEqual(valid, { valid: true, code: voucher.code, rule: plan.rule, name: 'Ana Example', email: 'ana@example.com', expiresAt: voucher.expiresAt });
assert.deepEqual((await members.activeRule('aaaaaaaaaaaa')).rule, plan.rule);
assert.deepEqual(members.resolveItemPrice((await members.activeRule(voucher.code)).rule, 'relaxing-massage', 'massage', options, 60), { price: 5950, minutes: 60 });
assert.deepEqual((await members.lookup('AAAA-AAAA-AAAA')).code, voucher.code);

// Plan edits leave issued vouchers their rule; member counts leave revoked vouchers out.
const edited = await members.updatePlan(plan._id, { discountPercent: 25 });
assert.ok(edited.ok);
assert.equal(edited.plan.rule.discountPercent, 25);
assert.equal((await members.activeRule(voucher.code)).rule.discountPercent, 15);
const revoked = await members.revoke(other.voucher.code);
assert.ok(revoked.ok && revoked.voucher.status === 'revoked');
assert.deepEqual(await members.validate(other.voucher.code), { valid: false, reason: 'revoked' });
assert.equal(await members.activeRule(other.voucher.code), null);
assert.deepEqual((await members.listPlans()).map((item) => [item._id, item.memberCount]), [[plan._id, 1]]);

// The vouchers of an address, read as normaliseEmail reads it, newest first and with their status.
assert.deepEqual((await members.vouchersByEmail(' ANA@example.com ')).map((item) => [item.code, item.status]), [[voucher.code, 'active']]);
assert.deepEqual((await members.vouchersByEmail('ben@example.com')).map((item) => [item.code, item.status]), [[other.voucher.code, 'revoked']]);
assert.deepEqual(await members.vouchersByEmail('cleo@example.com'), []);
assert.deepEqual(await members.vouchersByEmail('not an address'), []);
assert.deepEqual(await members.vouchersByEmail(null), []);

// Staff change where a code is sent, and remove vouchers.
const moved = await members.changeEmail(voucher.code, 'Ana@Example.org');
assert.ok(moved.ok && moved.voucher.email === 'ana@example.org' && moved.plan._id === plan._id);
assert.deepEqual(await members.changeEmail(voucher.code, 'ana'), { ok: false, code: 'INVALID_EMAIL' });
const removed = await members.remove(other.voucher.code);
assert.ok(removed.ok);
assert.deepEqual([removed.notify, removed.expired], [false, false]);
assert.deepEqual(await members.remove(other.voucher.code), { ok: false, code: 'NOT_FOUND' });

// Expiry: lapsed vouchers no longer price bookings and are marked expired when read.
minutes(93 * 24 * 60);
assert.equal(await members.activeRule(voucher.code), null);
assert.deepEqual(await members.validate(voucher.code), { valid: false, reason: 'expired' });
assert.deepEqual((await members.vouchersOf(plan._id)).map((item) => [item.code, item.status]), [[voucher.code, 'expired']]);
assert.equal((await members.lookup(voucher.code)).status, 'expired');
assert.deepEqual((await members.vouchersByEmail('ana@example.org')).map((item) => [item.code, item.status]), [[voucher.code, 'expired']]);

await assert.rejects(records.collection(server.VOUCHERS_COLLECTION).insertOne({ code: voucher.code }), (error) => error.code === 'duplicate-key');
assert.deepEqual(await members.removePlan(plan._id), { ok: true });
assert.deepEqual(await members.removePlan(plan._id), { ok: false, code: 'NOT_FOUND' });
console.log('member pricing class: all checks passed');
