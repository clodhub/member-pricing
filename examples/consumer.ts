import { createMemberPricing, resolveItemPrice, type RecordsStore, type VoucherCodes } from "../implementation/server/index.ts";

// Example Studio's Relaxing Massage as shop-catalogue gives it.
const relaxingMassage = { slug: "relaxing-massage", categorySlug: "massage", options: [{ minutes: 45, price: 6000 }, { minutes: 60, price: 7000 }] };

// Staff open a sign-up for the "Friends of the studio" plan, the person gives their name and email on the shared link,
// staff approve, and the reserve page and the server price the member's 60-minute massage with the voucher's rule.
export async function friendsOfTheStudio(records: RecordsStore, codes: VoucherCodes, now: () => Date) {
  const members = createMemberPricing({ records, codes, now });
  await members.ensureIndexes();
  const created = await members.createPlan({
    title: { en: "Friends of the studio", es: "Amigos del estudio" },
    conditions: { en: "For regular clients; one booking at a time." },
    mode: "discount",
    discountPercent: 15,
    categorySlugs: ["massage"],
    validity: { amount: 6, unit: "months" },
  });
  if (!created.ok) throw new Error(created.error);
  await members.setPlanActive(created.plan._id, true);
  const opened = await members.openSession(created.plan._id);
  if (!opened.ok) throw new Error(opened.code);
  await members.submitSession(opened.sessionId, { name: "Ana Example", email: "Ana@Example.com", language: "es" });
  const approved = await members.approve(opened.sessionId);
  if (!approved.ok) throw new Error(approved.code);
  const checked = await members.validate(approved.voucher.code.toLowerCase());
  const active = await members.activeRule(approved.voucher.code);
  return {
    email: approved.voucher.email,
    page: checked.valid ? resolveItemPrice(checked.rule, relaxingMassage.slug, relaxingMassage.categorySlug, relaxingMassage.options, 60) : null,
    server: active ? resolveItemPrice(active.rule, relaxingMassage.slug, relaxingMassage.categorySlug, relaxingMassage.options, 60) : null,
  };
}
