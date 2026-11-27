// The entry module of member-pricing's web code: everything code outside the component may use in the browser.
export {
  DEFAULT_SETTINGS, MAXIMUM_VALIDITY, applyDiscount, discountPercentFor, expiryFrom, installedSettings, isEligible, isFixedPrice, isLanguage,
  normaliseEmail, resolveItemPrice, settingsFrom, validatePlanInput,
} from "./pricing.ts";
export type {
  ItemPrice, LocalText, MemberPricingSettings, Money, PlanInput, PlanInputCode, PlanInputResult, PriceOption, PricingMode, PricingRule,
  Validity,
} from "./pricing.ts";
