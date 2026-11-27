# Member pricing component

## Purpose and facilities
Some customers (members, partners, staff) pay their own prices. A plan says how: a percentage off all items, some items or some categories (discount); fixed prices for a list of items at one length each and nothing else (custom); or, per item, a fixed price or a percentage off, with every other item at its catalogue price (mixed). Staff open a sign-up session for a plan and share its link; the person gives a name and email on that page; staff approve, and the member gets a voucher whose code gives the plan's prices until it expires or is revoked. The price rules (`resolveItemPrice` and the functions it uses) are pure and run the same on the reserve page and on the server, so the price a member sees is the price the server charges. Plans, sessions and vouchers live in the records store the application passes; codes come from the voucher-codes slot's component.

Facilities: `member-pricing` (Member plans, sign-up sessions approved by staff, member vouchers and the shared member price resolver, kept in a records store).

## User inputs
Fixed prices are multiples of `fixedPriceStep` from `minimumFixedPrice` to `maximumFixedPrice`, in minor units (5 to 500 euros in steps of 5 by default); their lengths are multiples of `minutesStep` from `minimumMinutes` to `maximumMinutes` (5 to 180 minutes in steps of 5). `sessionMinutes` is how long a sign-up link works after staff open it (15 minutes).

- `minimumFixedPrice` (integer; optional; default `500`)
- `maximumFixedPrice` (integer; optional; default `50000`)
- `fixedPriceStep` (integer; optional; default `500`)
- `minimumMinutes` (integer; optional; default `5`)
- `maximumMinutes` (integer; optional; default `180`)
- `minutesStep` (integer; optional; default `5`)
- `sessionMinutes` (integer; optional; default `15`)

## Artefacts and dependencies
`component.json` maps every `implementation/` source into `components/member-pricing/`:

- `implementation/server/index.ts` -> `components/member-pricing/server/index.ts`
- `implementation/server/service.ts` -> `components/member-pricing/server/service.ts`
- `implementation/web/index.ts` -> `components/member-pricing/web/index.ts`
- `implementation/web/pricing.ts` -> `components/member-pricing/web/pricing.ts`
- `implementation/web/settings.ts` -> `components/member-pricing/web/settings.ts`

Dependencies: none.
`tools.lock.json` pins verification tools: node 26.5. Licence: `Apache-2.0` (`LICENCE`, `NOTICE`).

## Provided interfaces
- `member-pricing` version 1.0.0: `interfaces/member-pricing.json` (OpenRPC). The web entry module `web/index.ts` has the pure price rules, the plan form's checks and `expiryFrom`; the server entry module `server/index.ts` adds `createMemberPricing`. The stored documents are described by `interfaces/member-plan.schema.json`, `member-voucher.schema.json` and `member-session.schema.json`.

## Required interfaces
- `records` version 1.0.0 (`interfaces/required-records.json`): the records slot's store, passed to `createMemberPricing` as `records`.
- `voucher-codes` version 1.0.0 (`interfaces/required-voucher-codes.json`): what the voucher-codes slot's `createVoucherCodes` returns, passed as `codes`; `normalise` reads typed codes and `withRetry` draws a new code when one is taken.

The web entry module needs neither.

## Integration
The application creates the service once per process with `createMemberPricing({ records, codes })`, where `codes` is the voucher-codes slot's `createVoucherCodes({ source })`, and calls `ensureIndexes()` at start. The owner's routes (behind staff-access) call `listPlans`, `createPlan`, `updatePlan`, `setPlanActive`, `removePlan`, `openSession` (then show the address of its own sign-up page for that session id, and a QR code of it), `session` (to watch for the person's details), `approve`, `lookup`, `revoke`, `remove`, `changeEmail` and `vouchersOf`; the customer's wallet (an app installed after the sign-up) asks `vouchersByEmail(email)` once email verification has confirmed the address; after `approve`, `changeEmail` (resend) and `remove` (when `notify` is true) the application emails the member. The sign-up page calls `session` and `submitSession`. The reserve page calls `validate(code)` and prices each line with `resolveItemPrice(rule, slug, categorySlug, item.options, minutes)` from `web/index.ts`; reservations prices the booking with the rule `activeRule(code)` gives and the same function, which the service also carries as `resolveItemPrice` because reservations receives only the service, and refuses the booking with `MEMBER_CODE_INVALID` when `activeRule` gives null.

## Visual definition and connected examples
`visual/definition.json` maps its ports to the provided and required interfaces. `visual/examples/connected.json` connects the component to an illustrative application consumer. Both image formats and a text description are retained under `visual/output/`.

## Infrastructure
No service or account. Plans, vouchers and sign-up sessions are documents in the records collections `memberPlans`, `memberVouchers` and `memberSessions` (`PLANS_COLLECTION`, `VOUCHERS_COLLECTION`, `SESSIONS_COLLECTION`); the store removes sessions `sessionMinutes` after they are opened, and the code reads their age by its own clock as well.

## Verification
`tests/web.test.ts` checks the settings template and its defaults; eligibility, fixed prices, discounts and the shared price resolver in the three modes, with the source's cases; rounding in minor units; the plan form's checks with their codes; validity in weeks, calendar months and years; the service over the records fixture with a voucher codes double that follows the voucher codes class's document (plans, sign-up sessions and their lifetime, approval once, a taken code drawn again, a failed approval returning the session to staff, validation reasons, lookups, revocation, removal, email changes, the vouchers of an address, expiry, indexes); the records export carried to another store; and the example. The member pricing class suite (`classes/member-pricing-class/check.mjs`) checks the same contract against any implementation.

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5)

## Scenarios and presentation
Example Studio's "Friends of the studio" plan gives 15% off massages for six months. At the desk, staff open a sign-up and show its QR code; Ana enters her name and email on her phone, staff approve, and the application emails her the code. On the reserve page she enters it, sees the 60-minute Relaxing Massage at 63.75 euros instead of 75, and the server charges the same. Staff later revoke a partner's code and her next booking is refused.

## Updates and removal
Patch updates replace the files only; plans, vouchers and sessions stay in the records store in the forms their schemas describe (`interfaces/member-plan.schema.json`, `member-voucher.schema.json`, `member-session.schema.json`). Removing the component leaves the three collections in the store; vouchers then give no prices.
