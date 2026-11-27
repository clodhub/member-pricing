// Member plans, their sign-up sessions and member vouchers, kept in a records store. A person signs up through a
// link the shop shares, staff approve, and the voucher's code gives the member the plan's prices when booking.
import {
  expiryFrom, installedSettings, isLanguage, normaliseEmail, resolveItemPrice, settingsFrom, validatePlanInput, type LocalText,
  type MemberPricingSettings, type PlanInputCode, type PricingRule, type Validity,
} from "../web/pricing.ts";

export const PLANS_COLLECTION = "memberPlans";
export const VOUCHERS_COLLECTION = "memberVouchers";
export const SESSIONS_COLLECTION = "memberSessions";

export type Plan = {
  _id: string;
  title: LocalText;
  conditions: LocalText;
  rule: PricingRule;
  validity: Validity;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};
export type PlanListing = Plan & { memberCount: number };
export type VoucherStatus = "active" | "expired" | "revoked";
// A voucher keeps the rule its plan had when it was approved.
export type Voucher = {
  _id: string;
  code: string;
  planId: string;
  name: string;
  email: string;
  rule: PricingRule;
  status: VoucherStatus;
  language: string;
  issuedAt: Date;
  expiresAt: Date;
};
export type SessionState = "pending_email" | "pending_approval" | "approved";
export type SignUpSession = {
  _id: string;
  sessionId: string;
  planId: string;
  state: SessionState;
  name: string | null;
  email: string | null;
  language: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type PlanSummary = Pick<Plan, "_id" | "title" | "conditions" | "rule" | "validity">;
export type SessionView = {
  sessionId: string;
  state: SessionState;
  name: string | null;
  email: string | null;
  language: string | null;
  expiresAt: Date;
  plan: PlanSummary | null;
};
export type Validation =
  | { valid: true; code: string; rule: PricingRule; name: string; email: string; expiresAt: Date }
  | { valid: false; reason: "missing_code" | "not_found" | "revoked" | "expired" };

// The part of the records class's interface used here; the application passes its records store.
type Filter = Record<string, unknown>;
type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; $inc?: Record<string, number> };
type FindOptions = { sort?: Record<string, 1 | -1>; skip?: number; limit?: number; projection?: Record<string, 0 | 1> };
type IndexSpec = { key: Record<string, 1 | -1>; unique?: boolean; sparse?: boolean; expireAfterSeconds?: number };
export type MemberCollection = {
  insertOne(doc: Record<string, unknown>): Promise<{ insertedId: string }>;
  findOne(filter?: Filter, options?: FindOptions): Promise<Record<string, unknown> | null>;
  find(filter?: Filter, options?: FindOptions): Promise<Record<string, unknown>[]>;
  countDocuments(filter?: Filter): Promise<number>;
  updateOne(filter: Filter, update: Update): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(filter: Filter, update: Update): Promise<{ matchedCount: number; modifiedCount: number }>;
  findOneAndUpdate(filter: Filter, update: Update, options?: { returnDocument?: "before" | "after" }): Promise<Record<string, unknown> | null>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  createIndexes(indexes: IndexSpec[]): Promise<void>;
};
export type RecordsStore = { collection(name: string): MemberCollection };
// The part of the voucher codes class's interface (createVoucherCodes) used here.
export type VoucherCodes = {
  normalise(text: unknown): string | null;
  withRetry<T>(attempt: (code: string) => Promise<T>, isCollision: (error: unknown) => boolean, attempts?: number): Promise<T>;
};

export type MemberPricingOptions = {
  records: RecordsStore;
  codes: VoucherCodes;
  now?: () => Date;
  settings?: Partial<Record<keyof MemberPricingSettings, unknown>>;
};

type NotFound = { ok: false; code: "NOT_FOUND" };
type PlanResult = { ok: true; plan: Plan } | { ok: false; code: PlanInputCode; error: string };
const NOT_FOUND: NotFound = { ok: false, code: "NOT_FOUND" };
const NAME_LIMIT = 100;

// A records store reports a taken unique key (here a voucher code) as a RecordsError with code duplicate-key.
const isDuplicateKey = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "duplicate-key";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMemberPricing(options: MemberPricingOptions) {
  const settings = settingsFrom({ ...installedSettings(), ...options.settings });
  const now = options.now ?? (() => new Date());
  const codes = options.codes;
  if (!codes || typeof codes.normalise !== "function" || typeof codes.withRetry !== "function") {
    throw new TypeError("createMemberPricing needs codes, the object createVoucherCodes returns");
  }
  const plans = options.records.collection(PLANS_COLLECTION);
  const vouchers = options.records.collection(VOUCHERS_COLLECTION);
  const sessions = options.records.collection(SESSIONS_COLLECTION);
  const sessionLife = settings.sessionMinutes * 60_000;

  const idOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  async function findPlan(planId: unknown): Promise<Plan | null> {
    const key = idOf(planId);
    return key === null ? null : ((await plans.findOne({ _id: key })) as Plan | null);
  }
  // A session lasts sessionMinutes from when it was opened, whatever its state; the store's expiry index removes it later.
  async function findSession(sessionId: unknown): Promise<SignUpSession | null> {
    const key = idOf(sessionId);
    const session = key === null ? null : ((await sessions.findOne({ sessionId: key })) as SignUpSession | null);
    return session && session.createdAt.getTime() + sessionLife > now().getTime() ? session : null;
  }
  async function findVoucher(text: unknown): Promise<Voucher | null> {
    const code = codes.normalise(text);
    return code === null ? null : ((await vouchers.findOne({ code })) as Voucher | null);
  }
  const lapsed = (voucher: Voucher) => voucher.expiresAt.getTime() < now().getTime();
  // An active voucher past its expiry is marked expired when read, as the source did.
  async function current(voucher: Voucher): Promise<Voucher> {
    if (voucher.status !== "active" || !lapsed(voucher)) return voucher;
    await vouchers.updateOne({ _id: voucher._id, status: "active" }, { $set: { status: "expired" } });
    return { ...voucher, status: "expired" };
  }
  const formOf = (plan: Plan) => ({
    title: plan.title, conditions: plan.conditions, validity: plan.validity, mode: plan.rule.mode, discountPercent: plan.rule.discountPercent,
    itemSlugs: plan.rule.itemSlugs, categorySlugs: plan.rule.categorySlugs, allItems: plan.rule.allItems, itemPricing: plan.rule.itemPricing,
  });

  return {
    settings,
    // The web module's resolver, for callers that receive only this object (reservations).
    resolveItemPrice,
    async ensureIndexes(): Promise<void> {
      await plans.createIndexes([{ key: { createdAt: -1 } }]);
      await vouchers.createIndexes([
        { key: { code: 1 }, unique: true }, { key: { email: 1 } }, { key: { planId: 1 } }, { key: { expiresAt: 1 } }, { key: { status: 1 } },
      ]);
      await sessions.createIndexes([{ key: { sessionId: 1 }, unique: true }, { key: { createdAt: 1 }, expireAfterSeconds: settings.sessionMinutes * 60 }]);
    },

    // Newest first, each with how many vouchers it has that are not revoked.
    async listPlans(): Promise<PlanListing[]> {
      const list = (await plans.find({}, { sort: { createdAt: -1 } })) as Plan[];
      return Promise.all(list.map(async (plan) => ({
        ...plan, memberCount: await vouchers.countDocuments({ planId: plan._id, status: { $ne: "revoked" } }),
      })));
    },
    plan: findPlan,
    // A new plan starts switched off.
    async createPlan(input: unknown): Promise<PlanResult> {
      const checked = validatePlanInput(input, settings);
      if (!checked.ok) return checked;
      const at = now();
      const doc = { ...checked.plan, active: false, createdAt: at, updatedAt: at };
      const { insertedId } = await plans.insertOne(doc);
      return { ok: true, plan: { _id: insertedId, ...doc } };
    },
    // The fields given replace the plan's and the whole plan is checked again. Vouchers already issued keep their rule.
    async updatePlan(planId: unknown, input: unknown): Promise<PlanResult | NotFound> {
      const plan = await findPlan(planId);
      if (!plan) return NOT_FOUND;
      if (!isObject(input)) return { ok: false, code: "INVALID_INPUT", error: "a plan is an object" };
      const checked = validatePlanInput({ ...formOf(plan), ...input }, settings);
      if (!checked.ok) return checked;
      const updated = (await plans.findOneAndUpdate({ _id: plan._id }, { $set: { ...checked.plan, updatedAt: now() } }, { returnDocument: "after" })) as Plan | null;
      return updated ? { ok: true, plan: updated } : NOT_FOUND;
    },
    // Its vouchers keep working until they expire or are revoked.
    async removePlan(planId: unknown): Promise<{ ok: true } | NotFound> {
      const key = idOf(planId);
      if (key === null) return NOT_FOUND;
      const { deletedCount } = await plans.deleteOne({ _id: key });
      return deletedCount === 1 ? { ok: true } : NOT_FOUND;
    },
    async setPlanActive(planId: unknown, active: unknown): Promise<{ ok: true; plan: Plan } | { ok: false; code: "NOT_FOUND" | "MISSING_FIELDS" }> {
      if (typeof active !== "boolean") return { ok: false, code: "MISSING_FIELDS" };
      const key = idOf(planId);
      const plan = key === null ? null : ((await plans.findOneAndUpdate({ _id: key }, { $set: { active, updatedAt: now() } }, { returnDocument: "after" })) as Plan | null);
      return plan ? { ok: true, plan } : NOT_FOUND;
    },

    // Staff open a sign-up session for an active plan and share its link (or a QR code of it) with the person.
    async openSession(planId: unknown): Promise<{ ok: true; sessionId: string; expiresAt: Date } | { ok: false; code: "NOT_FOUND" | "INACTIVE" }> {
      const plan = await findPlan(planId);
      if (!plan) return NOT_FOUND;
      if (!plan.active) return { ok: false, code: "INACTIVE" };
      const sessionId = crypto.randomUUID();
      const at = now();
      await sessions.insertOne({ sessionId, planId: plan._id, state: "pending_email", name: null, email: null, language: null, createdAt: at, updatedAt: at });
      return { ok: true, sessionId, expiresAt: new Date(at.getTime() + sessionLife) };
    },
    // The person gives their name and email on the sign-up page; staff then approve.
    async submitSession(sessionId: unknown, details: unknown): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "WRONG_STATE" | "INVALID_NAME" | "INVALID_EMAIL" }> {
      const given = isObject(details) ? details : {};
      const name = typeof given.name === "string" ? given.name.trim() : "";
      if (name === "" || name.length > NAME_LIMIT) return { ok: false, code: "INVALID_NAME" };
      const email = normaliseEmail(given.email);
      if (email === null) return { ok: false, code: "INVALID_EMAIL" };
      const session = await findSession(sessionId);
      if (!session) return NOT_FOUND;
      if (session.state !== "pending_email") return { ok: false, code: "WRONG_STATE" };
      const language = isLanguage(given.language) ? given.language : "en";
      const claimed = await sessions.findOneAndUpdate(
        { sessionId: session.sessionId, state: "pending_email" },
        { $set: { state: "pending_approval", name, email, language, updatedAt: now() } },
      );
      return claimed ? { ok: true } : { ok: false, code: "WRONG_STATE" };
    },
    // What the sign-up page and the staff page show while they wait; null once the session has expired.
    async session(sessionId: unknown): Promise<SessionView | null> {
      const session = await findSession(sessionId);
      if (!session) return null;
      const plan = await findPlan(session.planId);
      return {
        sessionId: session.sessionId, state: session.state, name: session.name, email: session.email, language: session.language,
        expiresAt: new Date(session.createdAt.getTime() + sessionLife),
        plan: plan && { _id: plan._id, title: plan.title, conditions: plan.conditions, rule: plan.rule, validity: plan.validity },
      };
    },
    // Issues the member's voucher with the plan's rule and validity. The application sends the member the code.
    async approve(sessionId: unknown): Promise<{ ok: true; voucher: Voucher; plan: Plan } | { ok: false; code: "NOT_FOUND" | "WRONG_STATE" | "PLAN_NOT_FOUND" }> {
      const session = await findSession(sessionId);
      if (!session) return NOT_FOUND;
      if (session.state !== "pending_approval") return { ok: false, code: "WRONG_STATE" };
      const plan = await findPlan(session.planId);
      if (!plan) return { ok: false, code: "PLAN_NOT_FOUND" };
      const at = now();
      const claimed = await sessions.findOneAndUpdate({ sessionId: session.sessionId, state: "pending_approval" }, { $set: { state: "approved", updatedAt: at } });
      if (!claimed) return { ok: false, code: "WRONG_STATE" };
      try {
        const voucher = await codes.withRetry(async (code) => {
          const doc = {
            code, planId: plan._id, name: session.name ?? "", email: session.email ?? "", rule: plan.rule, status: "active" as const,
            language: session.language ?? "en", issuedAt: at, expiresAt: expiryFrom(plan.validity, at),
          };
          const { insertedId } = await vouchers.insertOne(doc);
          return { _id: insertedId, ...doc };
        }, isDuplicateKey);
        return { ok: true, voucher, plan };
      } catch (error) {
        await sessions.updateOne({ sessionId: session.sessionId, state: "approved" }, { $set: { state: "pending_approval", updatedAt: now() } });
        throw error;
      }
    },

    // What the reserve page asks before showing member prices.
    async validate(text: unknown): Promise<Validation> {
      if (typeof text !== "string" || text.trim() === "") return { valid: false, reason: "missing_code" };
      const found = await findVoucher(text);
      if (!found) return { valid: false, reason: "not_found" };
      if (found.status === "revoked") return { valid: false, reason: "revoked" };
      const voucher = await current(found);
      if (voucher.status !== "active") return { valid: false, reason: "expired" };
      return { valid: true, code: voucher.code, rule: voucher.rule, name: voucher.name, email: voucher.email, expiresAt: voucher.expiresAt };
    },
    // Staff look a voucher up by its code.
    async lookup(text: unknown): Promise<Voucher | null> {
      const found = await findVoucher(text);
      return found ? current(found) : null;
    },
    async revoke(text: unknown): Promise<{ ok: true; voucher: Voucher } | NotFound> {
      const code = codes.normalise(text);
      const voucher = code === null ? null : ((await vouchers.findOneAndUpdate({ code }, { $set: { status: "revoked" } }, { returnDocument: "after" })) as Voucher | null);
      return voucher ? { ok: true, voucher } : NOT_FOUND;
    },
    // Deletes a voucher. `notify` is true when it was not revoked, the case where the source emailed the member, and
    // `expired` says whether it had already expired.
    async remove(text: unknown): Promise<{ ok: true; voucher: Voucher; notify: boolean; expired: boolean } | NotFound> {
      const voucher = await findVoucher(text);
      if (!voucher) return NOT_FOUND;
      const { deletedCount } = await vouchers.deleteOne({ _id: voucher._id });
      if (deletedCount !== 1) return NOT_FOUND;
      return { ok: true, voucher, notify: voucher.status !== "revoked", expired: lapsed(voucher) };
    },
    // Changes where the code is sent; the application then sends it again.
    async changeEmail(text: unknown, address: unknown): Promise<{ ok: true; voucher: Voucher; plan: Plan | null } | { ok: false; code: "NOT_FOUND" | "INVALID_EMAIL" }> {
      const email = normaliseEmail(address);
      if (email === null) return { ok: false, code: "INVALID_EMAIL" };
      const code = codes.normalise(text);
      const voucher = code === null ? null : ((await vouchers.findOneAndUpdate({ code }, { $set: { email } }, { returnDocument: "after" })) as Voucher | null);
      if (!voucher) return NOT_FOUND;
      return { ok: true, voucher, plan: await findPlan(voucher.planId) };
    },
    // A plan's vouchers, newest first, with lapsed ones marked expired.
    async vouchersOf(planId: unknown): Promise<Voucher[]> {
      const key = idOf(planId);
      if (key === null) return [];
      await vouchers.updateMany({ planId: key, status: "active", expiresAt: { $lt: now() } }, { $set: { status: "expired" } });
      return (await vouchers.find({ planId: key }, { sort: { issuedAt: -1 } })) as Voucher[];
    },
    // The vouchers issued to an address (as normaliseEmail reads it), newest first, with lapsed ones marked expired; the
    // application has confirmed the address (email verification) before it asks.
    async vouchersByEmail(address: unknown): Promise<Voucher[]> {
      const email = normaliseEmail(address);
      if (email === null) return [];
      await vouchers.updateMany({ email, status: "active", expiresAt: { $lt: now() } }, { $set: { status: "expired" } });
      return (await vouchers.find({ email }, { sort: { issuedAt: -1, _id: -1 } })) as Voucher[];
    },
    // The rule the server prices a booking with: null unless the voucher is active and unexpired.
    async activeRule(text: unknown): Promise<{ rule: PricingRule; voucher: Voucher } | null> {
      const voucher = await findVoucher(text);
      if (!voucher || voucher.status !== "active" || lapsed(voucher)) return null;
      return { rule: voucher.rule, voucher };
    },
  };
}

export type MemberPricing = ReturnType<typeof createMemberPricing>;
