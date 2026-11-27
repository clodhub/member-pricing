# Member pricing instructions

## For the agent
Select this component for the member-pricing slot when the shop gives some customers their own prices (the recipe's member pricing feature). Leave the settings at their defaults unless the owner prices in other steps or bounds. Connect `records` to the records slot's component and `voucher-codes` to the voucher-codes slot's component. Connect the provided `member-pricing` to the application and to reservations' optional `member-pricing` requirement.

- Select package `pkg:clod/com.clodhub/member-pricing` version `0.1.0`.
- Settings to configure:
  - `minimumFixedPrice` (integer; optional; default `500`)
  - `maximumFixedPrice` (integer; optional; default `50000`)
  - `fixedPriceStep` (integer; optional; default `500`)
  - `minimumMinutes` (integer; optional; default `5`)
  - `maximumMinutes` (integer; optional; default `180`)
  - `minutesStep` (integer; optional; default `5`)
  - `sessionMinutes` (integer; optional; default `15`)
- Connect the provided `member-pricing` (1.0.0) to the application (the owner's page, the sign-up page, the reserve page) and to reservations.
- Supply `records` (1.0.0) from the records slot's component.
- Supply `voucher-codes` (1.0.0) from the voucher-codes slot's component.
- No accounts or keys are needed.

## For the developer
Nothing to supply. Call `ensureIndexes()` once at start, keep the owner's routes behind staff-access, and send the member emails after `approve`, `changeEmail` and `remove` (when `notify` is true): describe the voucher's own `rule`, which plan edits do not change. Price with `resolveItemPrice` on both the page and the server; never take a price from the page. Show prices with money's `formatMoney`.

## How to check
From the component directory:

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5)
- `python3 -m clod review <digest> --store STORE --policy POLICY --trusted --allow-network` runs the packaged checks.
