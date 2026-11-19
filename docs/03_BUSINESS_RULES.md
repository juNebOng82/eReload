# 03 — Business Rules

## Billing and margin
- `billedAmount = amount × (1 − marginPercent/100)`. Example: top-up 10 at 5% → bills **9.50**; phone receives full 10.
- **Margin resolution order** (`resolveMarginPercent`):
  1. `productMargins["<TELCO>__<serviceTypeId>"]` (per company, per product)
  2. company `marginPercent`
  3. legacy `markupPercent`
  4. 0
- Credit **pre-check** at request time (no reservation) → 402 + `rejected` job if insufficient.
- Credit **deducted only on success callback**, inside a Firestore transaction (`deductCreditForJob`). Failed/timeout = no charge.
- Low-balance alert fires once per cycle; re-arms on reload or positive adjustment.
- Legacy global API key: bypasses billing; can be disabled in Settings.

## Ledger and document numbers
- Types: `reload` (+), `adjustment` (signed ±), `usage` (−).
- Numbering `<prefix><yyMM><NNN>` with separate counters: `RC` (admin reload), `AJ` (adjustment), `OL` (Billplz online). Prefixes configurable in Settings.
- Reload and adjustment each record **created by** and write an **audit log** entry; both accept an optional image/PDF attachment (Firebase Storage).

## Service types and USSD templates
- Service types are admin-defined (add/rename anytime). **Reload** is protected (cannot be deleted).
- Templates live in `telco_configs/{TELCO}.services[serviceTypeId] = {enabled, template}`.
- Placeholders: `{PIN}` (device only — never leaves the phone side), `{AMOUNT}`, `{PHONE}`, and any custom `{FIELD}` (e.g. `{UNIQUE}`).
- `extractExtraPlaceholders(template)` auto-detects required extras per telco (anything except PIN/AMOUNT/PHONE).
- Server resolves everything except `{PIN}` (`resolveUssdTemplate`) and sends the result as `ussd_template` in FCM. The app only does `replace("{PIN}", pin)`.
- Seeded Reload default: `*303*{PIN}*1*{AMOUNT}*{PHONE}#` — **placeholder; set the real per-telco syntax in Telco Configuration.**
- Known telco capabilities: UMobile = reload only; Digi = reload + postpaid bill payment (needs a unique code + PIN); others TBD.

## Per-device custom fields
- Values that are per device and stable (e.g. Digi "unique code") are stored on the device (`customFields`, edited in Device Approval) and fill template extras silently.
- Caller `extra_fields` fill the remainder; non-empty caller values override device values.
- Missing required extras → HTTP 400.
- PIN stays on the phone only (user-changeable); unique code is visible/admin-managed.

## Device groups
- Each device belongs to at most one group (assigned on approval). Each company can have a **default** and an **alternative** group. See routing in `01_ARCHITECTURE.md`.

## Trial company
- Flag `isTrial` on a company. If the requested phone == routed device's `registeredPhoneNumber`: simulated success (`rawResponse: "Simulated success (Trial self-test — no real dial performed)"`), no FCM, credit/margin still applied normally.
- Any other phone → completely normal flow (real USSD).
- (Earlier "enforce matching phone" idea was **removed** by the user.)

## Billplz online reload
- Portal "Reload Credit" → `create-bill`; payment methods limited to **FPX** and **DuitNow Transfer**; min/max amounts configurable; sandbox toggle.
- Signature: HMAC-SHA256 over case-insensitively sorted `key+value` pairs joined by `|` (callback form-urlencoded; redirect uses nested `billplz[...]` flattened as `billplzid`, …).
- **Webhook is the only thing that credits**; redirect is cosmetic. Idempotent via `billplz_bills`.
- Billplz secrets are write-only in the UI (GET returns `*_set` booleans; audit log redacts).

## Idempotency and reliability
- `/api/topup` accepts `idempotency_key`; same key returns the original job.
- Callback guard returns `already_processed` once a job is success (prevents double deduction on app retries).
- App retries result posting up to 4× (2 s/4 s/6 s) under a partial wake lock.

## App version tracking
- App sends `app_version` at registration; admin sets **Latest App Version** in Settings; devices below it show **Outdated**.

## Log date filters
USSD Log, Misc Log, Audit Log filter by date range (default today) via `applyDateRangeFilter` (`from`, `to` inclusive, or `before` exclusive).
