# USSD Top Up Server

REST API + FCM trigger + admin panel that sits between whoever requests a
top-up and your Android device(s) (each representing one telco).

## Company Portal

Visit `https://YOUR_URL/portal.html`. Company accounts are created by admin
only (Admin Panel → Company Users tab) — there's no public self-signup.

**What a company can do:**
- **API Keys** — create named keys (e.g. "Production server"), each tied to
  their account. The full key value is shown only once, at creation time.
- **Credit Usage** — see current balance, full transaction history with
  date-range filtering. Reloads show as `+`, USSD usage shows as `-`.
- **Company Settings** — edit company name, registration number, address,
  phone, email, contact person, and change their own password.

**What only admin can do:** reload a company's credit (Admin Panel → Company
Users → Reload Credit). Each reload requires an amount and generates a
sequential document number, plus optional remarks and an image/PDF
attachment (e.g. a bank transfer receipt).

## Credit system

- Each `/api/topup` call must use a **company-specific API key** (from
  Company Portal) to be billed. The legacy global `API_KEY` (Settings tab)
  still works but isn't tied to any company — no credit is checked or
  deducted for it, useful for your own testing.
- **Credit is checked at request time**: if the company's balance is less
  than the requested amount, the call is rejected immediately with
  `402 Insufficient credit balance` — no job is created.
- **Credit is deducted only on success** — if the USSD ultimately fails or
  times out, nothing is deducted, even though the balance check passed
  earlier.
- **Known limitation:** balance is checked, not reserved, at request time.
  If a company fires many requests in parallel that each individually pass
  the balance check, but collectively exceed it, and all succeed, the
  balance can go slightly negative. This is a reasonable simplification
  given there's no real payment gateway yet — flag it if you want proper
  reservation-based holds later.
- Document numbers follow `<prefix><yyMM><000>` (e.g. `RC2608001` for
  reloads, `AJ2608001` for adjustments), each with its own prefix
  (configurable in Admin → Settings) and independent monthly sequence.
- **Legacy key safeguard**: the global `API_KEY` (no credit tracking, no
  company attribution) can be turned off entirely from Admin → Settings once
  every real caller has migrated to their own company API key. While
  disabled, any call using that key gets `403 Legacy API key is disabled`.
  Keep it on only for your own internal testing.
- **Margin**: each company can have a margin % (Company Users tab) that
  *reduces* what they're billed relative to the topup amount sent to the
  phone — e.g. a 5% margin on a 10 topup bills the company only 9.5. The
  phone always dials the full, unmodified amount.

## Online reload via Billplz (FPX / DuitNow Transfer)

Companies can reload their own credit through Billplz instead of waiting for
an admin-created reload. Set up:

1. **Get your credentials** from Billplz Dashboard → Settings → Keys &
   Integration: Secret Key, X Signature Key. Create a Collection (via the
   dashboard or Billplz's API) and note its Collection ID.
2. **Admin Panel → Payment Gateway tab**: enter the Secret Key, X Signature
   Key, and Collection ID. Leave "Sandbox mode" checked while testing
   (uses `billplz-sandbox.com`); uncheck it to go live.
3. **Restrict payment methods**: click "Load Payment Methods" — this pulls
   the actual list of payment methods available on your Billplz account
   (avoids guessing at exact code names). Check only the ones you want
   customers to see (e.g. the FPX entry and the DuitNow Transfer entry),
   leave everything else unchecked, click "Save Payment Methods". This
   updates your Billplz Collection directly — every future Bill created
   under it will only offer the methods you selected.

**How it works:**
- Company Portal → Reload Credit tab → enter an amount → redirected to
  Billplz's hosted payment page.
- After payment, Billplz calls `/api/billplz/callback` (server-to-server) —
  this is verified via HMAC-SHA256 **X Signature** and is the only thing
  that actually credits the account. The browser redirect back to
  `/portal.html` is purely for immediate UI feedback and is never trusted
  to apply credit on its own, since Billplz's own docs note redirects
  "do not guarantee execution" (closed browser, network issue, etc.) —
  only the callback is reliable.
- Each online reload gets its own document number series (e.g.
  `OL2608001`, prefix configurable), recorded in `credit_ledger` exactly
  like a manual reload, with `createdByAdmin: "SYSTEM (Billplz online
  reload)"` and its own Audit Log entry.
- Idempotent: a `billplz_bills/{billId}` tracking doc prevents a retried
  callback delivery from crediting the same payment twice.
- If the X Signature verification ever fails on a callback (misconfigured
  key, or a spoofed request), nothing is credited and it's logged loudly
  in Other Logs so you notice — but the endpoint still responds `200` so
  Billplz doesn't hammer retries for something that will never pass.

**Security note:** the Secret Key and X Signature Key are write-only —
once saved, they're never sent back to the browser, only a "configured ✓"
indicator. You can update other Billplz settings (sandbox toggle, min/max
reload) without needing to re-paste them.

## Adjustment transactions

For increasing or decreasing a company's credit **without** an actual
topup — correcting a mistake, a goodwill credit, clawing back an error, etc.

- Same shape as a reload: its own document number series (`AJ2608001`,
  prefix configurable), document date, remarks, and an optional
  image/PDF attachment, with a signed short-lived URL when viewed later
  (same access control as reload attachments — admin sees any, a company
  sees only their own).
- **Unlike reload, the amount can be positive or negative** — a positive
  adjustment adds credit, a negative one removes it. There's no floor
  check, so an admin can intentionally push a balance negative if needed.
- Recorded in `credit_ledger` as `type: "adjustment"`, shown in both the
  admin's Credit Inquiry and the company's own Credit Usage view with its
  actual sign (not assumed positive/negative like reload/usage are).
- A positive adjustment re-arms the low-balance alert (same behavior as a
  reload crossing back above the threshold); a negative one does not.
- Every reload and adjustment records **who created it** (`createdByAdmin`)
  and is written to the Audit Log (`reload` / `adjustment` actions).

## One-time setup: Firebase Storage (for reload attachments)

1. Firebase Console → Build → Storage → Get Started (enable it if not already).
2. Note the bucket name shown (e.g. `your-project-id.appspot.com` or
   `your-project-id.firebasestorage.app`).
3. Grant your Cloud Run service account the **Storage Admin** role (or
   Storage Object Admin, more restrictive) via IAM & Admin → IAM.
4. Set `FIREBASE_STORAGE_BUCKET` to that bucket name when deploying.

Reload attachments are currently made publicly readable via their URL (no
authentication needed to view a receipt image if you have the link) — fine
for an internal tool, but worth knowing if this ever needs stricter access
control.

## Reliability, security & business features

- **FCM retry** — a push is retried up to 3 times with backoff before a job
  is marked failed, covering transient network blips.
- **Idempotency keys** — pass `idempotency_key` in `/api/topup` to make
  client-side retries safe; a repeat with the same key returns the original
  job instead of creating (and billing) a duplicate.
- **Rate limiting** — 5 login attempts per 15 minutes on both admin and
  portal login, tracked in Firestore (correct even across Cloud Run's
  multiple instances, unlike an in-memory counter would be).
- **Low-balance alerts** — each company can set their own threshold and an
  optional webhook URL (Company Settings tab) that fires once when their
  balance first drops below it; resets on the next reload.
- **Device last-seen tracking** — "Last Seen" column in Device Approval
  shows when each device last responded, color-coded if it's gone quiet.
- **Signed-URL attachments** — reload receipts are no longer permanently
  public; viewing one generates a 15-minute signed link, access-controlled
  (admin sees any, a company only sees their own).
- **Audit log** — every admin login, device approval/rejection/revocation,
  company creation, reload, markup change, and settings change is recorded
  with who did it and when (Audit Log tab).
- **Per-company markup** — set a markup % per company (Company Users tab);
  the phone still dials the raw topup amount, but the company is billed
  `amount × (1 + markup%)`.
- **Min/max topup limits** — global guard rails (Settings tab) reject
  obviously-wrong amounts (e.g. a stray extra zero) before they reach a job.
- **CSV export** — available on the admin's Credit Inquiry tab and the
  company portal's Credit Usage tab.
- **Success-rate stats** — `/api/admin/stats?days=N` (Stats tab) shows
  success/failed/timeout/rejected counts and success rate per telco.
- **Pagination** — USSD Log and Other Logs support a "Load More" button
  (cursor-based, via a `before=` timestamp) instead of a hard cap.

## Device Groups (multi-telco routing)

For deployments with more than one physical device per telco (e.g. separate
device pools for different clients), Device Groups let you control exactly
which device handles which company's requests.

**How it works:**
- A device can belong to at most one group, or none (the shared "General
  Pool" — this is exactly how every device worked before groups existed, so
  nothing breaks for companies you haven't touched).
- A company can be assigned a **default** and/or **alternative** group
  (Company Users tab). When they call `/api/topup`:
  - No group assigned → routed to the shared General Pool, same as always.
  - Default group assigned → tries that group's device for the requested
    telco first.
  - If the default group has no device for that telco, tries the
    alternative group.
  - If neither group has a matching device, the request fails with
    `503 No device registered for telco X in your assigned device group(s)`
    — there's **no silent fallback** to the shared pool, since group
    assignment is treated as a deliberate isolation choice.
- **Group assignment happens at device approval time.** To move an
  already-approved device to a different group, revoke it and re-approve
  with the new group selected — there's no in-place "move" action yet.
- Each device group's queue, timeout, and current-job tracking are
  completely independent, even for the same telco across different groups.

**Device Account & Registered Phone Number** (Device Approval tab, "All
devices" table): free-text fields you fill in yourself — e.g. "Account" for
an internal label like which staff member or SIM contract this device
belongs to, and "Registered Phone Number" for the SIM's own MSISDN. These
aren't auto-detected (modern Android restricts apps from reliably reading
their own phone number), but once set, they show up as **Device Account**
on every USSD Log and Other Log entry that device handled — useful for
tracing an issue back to a specific physical phone.

## Admin Panel

Visit `https://YOUR_URL/admin.html` in a browser.

**First time setup:**
1. Click "Create the first admin account" on the login screen.
2. Enter your `ADMIN_KEY` (the bootstrap secret, set as an env var on deploy — never put this in the Android app), plus a username/password for your admin account.
3. This only works once — after the first account exists, the bootstrap option is disabled and you log in normally.

**Panel sections:**
- **Device Approval** — approve/reject pending device registrations (now with a Group selector), revoke live devices, edit each device's Account label and Registered Phone Number
- **Device Groups** — create/delete named device pools for multi-telco/multi-client routing (see above)
- **Test Top-up** ("Reload Mockup" in the sidebar) — trigger a real `/api/topup` call from the browser instead of `curl`. Pick "General Testing" (no billing, same as the legacy key) or any specific company (real credit check + deduction, exactly as if that company used their own API key) — useful for diagnosing a company's issue without ever needing their actual key.
- **Company Users** — create company accounts; view their credit balances; assign default/alternative device groups
- **Credit Top Up Transaction** (formerly "Reload Transactions") — create a reload (pick company from dropdown, amount, date picker, remarks, optional attachment) and view every reload ever made, across all companies
- **Adjustment Transactions** — same as Reload, but the amount can be positive or negative and uses its own document number series; for correcting balances without an actual topup
- **Credit Inquiry** — pick any company + date range to see Balance B/F, Balance C/F, and the full transaction list for that window
- **USSD Log, Other Logs, Audit Log** — every top-up attempt, the step-by-step trail, and admin actions, each with a From/To date filter defaulting to today on first load. "Load More" pages backwards within whatever range is currently selected.
- **User Maintenance** — create/delete admin accounts, change passwords
- **Settings** — view/update `API_KEY`, `APP_SECRET`, the document number prefix, and an on/off toggle for the legacy key
- **Payment Gateway** — configure Billplz (Secret Key, X Signature Key, Collection ID, sandbox toggle, min/max reload) and restrict which payment methods are shown to customers (e.g. FPX + DuitNow Transfer only)

## Trial companies (free self-test, no restriction otherwise)

Mark any company as "Trial" (Company Users tab — checkbox, auto-saves on
toggle). This replaces the old device-side Test Mode entirely, and is
**not a restriction** — a Trial company behaves exactly like any other
company, with one added shortcut:

- If the target phone number **matches the assigned device's own
  Registered Phone Number** (set in Device Approval), the result is
  **simulated immediately** — `success`, with no FCM push and no real
  USSD dial. Credit still deducts normally through the same billing
  path as a real job, so the whole company/credit/billing flow is
  genuinely exercised, just without touching the telco network. Useful
  for free, repeatable end-to-end testing.
- Any **other** phone number proceeds through the completely normal
  flow — real dial, real result, real billing — identical to a
  non-trial company. Trial status never blocks or restricts a request.
- The Android app has no test-mode concept at all anymore — every real
  job it receives always does a real dial.

## Per-product margin (per Telco + Service Type, per company)

A company's margin can be overridden for a specific Telco + Service
Type combination — e.g. 5% on UMobile Reload but 3% on Digi Bill
Payment — instead of one flat rate for everything.

- Company Users tab → "Margin %" column still sets that company's
  **default** margin, used whenever no more specific override exists.
- Company Users tab → **Product Margins** section: pick a company, get
  a grid (Telco rows × Service Type columns) — leave a cell blank to
  use the default, or type a specific percentage to override it just
  for that combination.
- Resolution order at transaction time: product-specific override (if
  set) → company default → `0`.

## App version tracking

Every device reports its installed app version (`versionName` from
`app/build.gradle`) on every registration call. Set "Latest App Version"
in Settings → General to whatever you most recently distributed, and any
device reporting something different — or nothing at all (very old
builds, before this feature existed) — is flagged **Outdated** in
Device Approval → All Devices.

- Bump `versionCode`/`versionName` in `app/build.gradle` before building a
  new APK, then update "Latest App Version" in Settings to match once
  it's been distributed.
- Leave "Latest App Version" blank to disable outdated-detection entirely
  (no devices get flagged either way).
- This is informational only — an outdated device keeps working normally;
  it's just a visibility aid for knowing which phones still need updating.

## Managing telcos

Telcos are no longer hardcoded — they're a real Firestore collection,
fully manageable from Settings → Telcos, no code change or redeploy needed.

- **Existing deployments are auto-seeded** with U Mobile, Maxis, Digi, and
  Celcom on first read, so nothing changes until you deliberately add or
  remove one.
- **To add a telco**: Settings → Telcos → enter a code (e.g. `REDONE`) and
  an optional display name → Create. It immediately appears in every
  telco dropdown across the panel (Device Approval, Test Top-up, Telco
  Configuration) and in the Android app's Settings screen (fetched via
  `GET /api/telcos`) — no app rebuild needed.
- **To remove one**: blocked if any device is still approved for it —
  revoke that device first, then delete.
- After adding a telco, go to **Telco Configuration** to set up which
  service types it supports and their USSD templates (see below).

## Service types & telco configuration

Different telcos support different services (e.g. U Mobile: reload only;
Digi: reload and postpaid bill payment), each potentially needing its own
USSD syntax. This is fully admin-configurable, no app updates required.

**How it works:**
- **Service Types** (Settings → Service Types) are fully custom — create,
  rename, or delete any you need (e.g. "Reload", "Bill Payment", or
  anything you discover later). They're just named categories — no field
  schema to define upfront.
- **"Reload" always exists and can't be deleted** — it's the implicit
  default for `/api/topup`, so every existing integration keeps working
  unchanged.
- **Telco Configuration** (Settings → Telco Configuration): for each of
  the 4 telcos, tick which service types it supports and set the USSD
  template for each. Templates use `{PIN}`, `{AMOUNT}`, `{PHONE}`, and any
  other `{FIELD_NAME}` that specific telco's syntax needs.
- **Two kinds of extra fields, resolved differently:**
  - **Per-device fields** (Device Approval → All Devices → "Custom Fields"
    column, format `key=value, key2=value2`) — for data that's fixed per
    physical device and not sensitive, e.g. a code Digi issues per-SIM
    that never changes and doesn't need to stay secret (unlike PIN, which
    genuinely must never leave the device). Set once per device; every job
    routed to that device automatically has it filled in — the API caller
    never needs to know about it.
  - **Per-transaction fields** (`extra_fields` in the API call) — for data
    that genuinely varies per request, e.g. a bill account number for Bill
    Payment.
  - Both use the same `{FIELD_NAME}` placeholder syntax in a template —
    the system doesn't need you to declare which is which. It just checks:
    is this field already satisfied by the device's stored custom fields?
    If yes, done. If not, the caller must supply it via `extra_fields`, or
    the call is rejected with a clear "missing field" error.
- **Templates are resolved server-side.** The server fills in everything
  except `{PIN}` — which never leaves the device — and sends the
  partially-resolved template to the phone via FCM. The app's only job is
  substituting `{PIN}` and dialing. This means **editing a template takes
  effect on the very next job, no app update needed.**
- **On first use, every telco is auto-seeded** with a "Reload" entry
  using the exact syntax that's always worked (`*303*{PIN}*1*{AMOUNT}*{PHONE}#`)
  — the transition to server-side templates doesn't change behavior until
  you deliberately edit something.

**REST API:**
- `/api/topup` — unchanged, always uses the default "Reload" service type.
- `POST /api/service-request` — the generalized version for any service
  type:
  ```json
  { "telco": "DIGI", "service_type": "bill_payment", "phone": "0123456789", "amount": 50, "extra_fields": { "account_number": "123456" } }
  ```
  Returns `400` with a clear message if that telco doesn't support the
  service type, or if a field its specific template requires is missing
  and isn't already set as a per-device custom field.
- The admin panel's **Test Top-up** tool detects and shows the right extra
  field boxes automatically based on the telco + service type you pick —
  leave one blank to use the device's stored value, if it has one.
- USSD Log now shows a **Service Type** column so you can distinguish
  reload vs. bill payment (vs. anything else) at a glance.

## Per-device queue

Each physical phone can only process one USSD session at a time. To handle
that:

- Every job created via `/api/topup` starts as `"queued"`.
- `devices/{telco}` tracks `currentJobId` + `currentJobStartedAt` while a job
  is in flight to that device.
- A new job is promoted to `"pending"` (and the FCM push actually sent) only
  when the device is free. Otherwise it waits in the queue.
- Each telco has its own configurable timeout (default 60s, editable in the
  admin panel's Device Approval tab). If a device doesn't respond within its
  timeout, that job is marked `"timeout"`, the device is freed, and the next
  queued job is automatically dispatched.
- Queue order is FIFO based on creation time.

**Important — timeout checking needs an active trigger.** There is no
background process ticking on its own inside the server. A stale/stuck job
only gets noticed and cleared when something calls the check. Three ways
that happens:
1. **Cloud Scheduler (recommended — see setup below)** — hits
   `/api/internal/check-timeouts` on a timer, fully automatic, no human
   involved.
2. **Admin panel auto-check** — opening/refreshing the Device Approval tab
   calls `/api/admin/check-timeouts` as a fallback.
3. **Manual "Release Now" button** — force-frees a specific device
   immediately, regardless of elapsed time.

### Setting up Cloud Scheduler for genuinely hands-off enforcement

```bash
# One-time: enable the API
gcloud services enable cloudscheduler.googleapis.com

# Create the recurring job (runs every minute)
gcloud scheduler jobs create http ussd-check-timeouts \
  --schedule="* * * * *" \
  --uri="https://YOUR_URL/api/internal/check-timeouts" \
  --http-method=POST \
  --headers="x-cron-secret=YOUR_CRON_SECRET" \
  --location=asia-southeast1 \
  --time-zone="Asia/Kuala_Lumpur"
```

- Replace `YOUR_URL` with your Cloud Run service URL, and `YOUR_CRON_SECRET`
  with the same value you set for `CRON_SECRET` on deploy.
- Every-minute is the finest granularity cron syntax allows. With the
  default 60s per-device timeout, a stuck job might sit for up to ~2 minutes
  worst-case before being cleared — still fully automatic, just not
  millisecond-precise.
- This comfortably fits Cloud Scheduler's free tier (3 free jobs/month).
- To update the schedule or URL later:
  `gcloud scheduler jobs update http ussd-check-timeouts --location=asia-southeast1 ...`

**Known limitation:** manual sends (from the app's own Send button) are not
currently tracked in this device-busy state. If a manual send and a
REST-API-triggered job land on the same device at the same time, they could
both try to use the phone's USSD session simultaneously. This hasn't been an
issue at small scale but is worth knowing about — ask if you want the manual
flow folded into the same lock.

## Endpoints

| Method | Path                          | Auth              | Purpose                                    |
|--------|-------------------------------|-------------------|---------------------------------------------|
| POST   | /api/admin/bootstrap          | x-admin-key       | Create the first admin account (one-time)  |
| POST   | /api/admin/login              | none              | Log in, returns a session token            |
| GET    | /api/admin/users              | Bearer session    | List admin accounts                        |
| POST   | /api/admin/users              | Bearer session    | Create an admin account                    |
| PUT    | /api/admin/users/:u/password  | Bearer session    | Change a user's password                   |
| DELETE | /api/admin/users/:u           | Bearer session    | Delete an admin account                    |
| GET    | /api/admin/settings           | Bearer session    | View current API_KEY / APP_SECRET          |
| POST   | /api/admin/settings           | Bearer session    | Update API_KEY / APP_SECRET live           |
| GET    | /api/admin/pending-devices    | Bearer session    | List devices awaiting approval             |
| GET    | /api/admin/devices            | Bearer session    | List all known devices (any status)        |
| POST   | /api/admin/approve-device     | Bearer session    | Approve a pending device for a telco       |
| POST   | /api/admin/reject-device      | Bearer session    | Reject a pending device request            |
| POST   | /api/admin/revoke-device      | Bearer session    | Revoke a specific device by installation_id (safe even if a newer device has since taken over its telco/group slot) |
| POST   | /api/admin/devices/:telco/timeout | Bearer session | Set that device slot's USSD timeout (pass group_id if grouped) |
| POST   | /api/admin/check-timeouts     | Bearer session    | Check all device slots for stale jobs and advance queues |
| POST   | /api/internal/check-timeouts  | x-cron-secret     | Same check, for Cloud Scheduler (automated)|
| POST   | /api/admin/devices/:telco/force-release | Bearer session | Immediately free a device slot's current job (pass group_id if grouped) |
| POST   | /api/admin/devices-registry/:id/info | Bearer session | Set a device's Account label and Registered Phone Number |
| GET    | /api/admin/telcos             | Bearer session    | List all telcos                            |
| POST   | /api/admin/telcos             | Bearer session    | Create a telco                             |
| DELETE | /api/admin/telcos/:code       | Bearer session    | Delete a telco (blocked if a device is still approved for it) |
| GET    | /api/admin/device-groups      | Bearer session    | List device groups                         |
| POST   | /api/admin/device-groups      | Bearer session    | Create a device group                      |
| DELETE | /api/admin/device-groups/:id  | Bearer session    | Delete a device group (blocked if still in use) |
| POST   | /api/admin/company-users/:id/groups | Bearer session | Set a company's default/alternative device group |
| POST   | /api/admin/company-users/:id/trial | Bearer session | Mark/unmark a company as Trial |
| POST   | /api/admin/company-users/:id/product-margin | Bearer session | Set/clear a margin override for one Telco+Service Type combo |
| GET    | /api/admin/stats              | Bearer session    | Success-rate stats per telco AND per company |
| GET    | /api/admin/company-users      | Bearer session    | List all company accounts                  |
| POST   | /api/admin/company-users      | Bearer session    | Create a company account                   |
| POST   | /api/admin/company-users/:id/reload | Bearer session | Reload a company's credit (multipart, with optional attachment) |
| GET    | /api/admin/reload-transactions | Bearer session | List every reload across all companies      |
| GET    | /api/admin/reload-transactions/export | Bearer session | CSV export of all reload transactions      |
| GET    | /api/admin/reload-attachment/:ledgerId | Bearer session | Signed URL for a reload's attachment       |
| POST   | /api/admin/company-users/:id/adjustment | Bearer session | Adjust a company's credit +/- (multipart, with optional attachment) |
| GET    | /api/admin/adjustment-transactions | Bearer session | List every adjustment across all companies |
| GET    | /api/admin/adjustment-transactions/export | Bearer session | CSV export of all adjustment transactions  |
| GET    | /api/admin/billplz/payment-methods | Bearer session | List live payment methods from your Billplz account |
| GET    | /api/admin/service-types      | Bearer session    | List service types (auto-seeds "Reload" if none exist) |
| POST   | /api/admin/service-types      | Bearer session    | Create a service type                      |
| PUT    | /api/admin/service-types/:id  | Bearer session    | Rename or edit a service type's extra fields |
| DELETE | /api/admin/service-types/:id  | Bearer session    | Delete a service type (blocked for the default, or if still enabled somewhere) |
| GET    | /api/admin/telco-configs      | Bearer session    | Get every telco's enabled services + templates |
| POST   | /api/admin/telco-configs/:telco | Bearer session  | Update one telco's service configuration   |
| POST   | /api/service-request          | x-api-key         | Generalized top-up for any service type    |
| POST   | /api/admin/billplz/payment-methods | Bearer session | Enable exactly the given method codes, disable the rest |
| POST   | /api/portal/billplz/create-bill | Bearer session (company) | Create a Billplz Bill for a reload amount |
| GET    | /api/portal/billplz/verify-redirect | Bearer session (company) | Verify a Billplz redirect's signature (UI feedback only) |
| POST   | /api/billplz/callback         | X Signature (Billplz)| Webhook — the only thing that actually credits an online reload |
| GET    | /api/admin/adjustment-attachment/:ledgerId | Bearer session | Signed URL for an adjustment's attachment  |
| GET    | /api/portal/adjustment-attachment/:ledgerId | Bearer session | Same, scoped to the logged-in company's own adjustment |
| GET    | /api/admin/credit-inquiry     | Bearer session    | Statement (entries + B/F + C/F) for any company |
| POST   | /api/portal/login             | none              | Company logs in, returns a session token   |
| GET/POST | /api/portal/profile         | Bearer session    | View/update company profile                |
| PUT    | /api/portal/password          | Bearer session    | Company changes their own password         |
| GET    | /api/portal/api-keys          | Bearer session    | List this company's API keys (masked)      |
| POST   | /api/portal/api-keys          | Bearer session    | Create a new named API key (shown once)    |
| DELETE | /api/portal/api-keys/:id      | Bearer session    | Revoke an API key                          |
| GET    | /api/portal/ledger            | Bearer session    | Credit ledger with optional ?from=&to= date filter |
| GET    | /api/admin/ussd-logs          | Bearer session    | USSD Log section (manual + REST API sends) |
| GET    | /api/admin/other-logs         | Bearer session    | Other Logs section (device/system trail)   |
| POST   | /api/register-device          | x-app-secret      | Device requests registration for a telco   |
| POST   | /api/topup                    | x-api-key         | Create a top-up job (REST API channel)     |
| POST   | /api/ussd-log                 | x-app-secret       | App logs a manual send (Manual channel)    |
| POST   | /api/fcm/callback             | x-app-secret       | App posts the USSD result back             |
| GET    | /api/topup/:jobId             | x-api-key         | Check job status                           |
| POST   | /api/logs                     | x-app-secret       | App posts a detailed trail log line        |
| GET    | /api/logs                     | x-api-key         | (dev/curl use) view recent trail logs      |

## Environment variables

- `API_KEY` / `APP_SECRET` — default/fallback values only. Once set via the Settings tab, the Firestore-stored value takes priority. Still useful as the initial value on first deploy.
- `ADMIN_KEY` — bootstrap secret, only used once to create the first admin account. Never put this in the Android app.
- `JWT_SECRET` — signs admin login sessions. Set a real random value (e.g. `openssl rand -hex 32`) — anyone with this could forge admin sessions.
- `PUBLIC_BASE_URL` — optional. If not set, Billplz callback/redirect URLs are built from the incoming request's host (works fine on Cloud Run). Set this explicitly only if you're behind another proxy/CDN that changes the visible host.

## Data model (Firestore)

- `jobs/{jobId}`: `{ phone, amount, billedAmount, telco, groupId, serviceTypeId, ussdTemplate, channel, status, rawResponse, webhookUrl, userId, installationId, idempotencyKey, createdAt, updatedAt }`
  - `ussdTemplate`: the server-resolved template for this job, with everything except `{PIN}` already filled in
  - `serviceTypeId`: which service type this job used (defaults to the "Reload" type's ID if not specified)
  - `channel`: `"manual"` (sent from the app's Send button) | `"rest_api"` (triggered via `/api/topup`)
  - `status`: `queued` → `pending` → `success` | `failed` | `timeout` | `rejected`
  - `userId`: set only when triggered by a company API key (for credit deduction)
  - `groupId`: which device group this job was routed to (`null` = shared pool)
  - `installationId`: which physical device actually handled it, set at dispatch time
- `devices/{telco}` (ungrouped) or `devices/{groupId}__{telco}` (grouped): `{ fcmToken, telco, groupId, installationId, timeoutSeconds, currentJobId, currentJobStartedAt, lastCallbackAt, lastSuccessAt, updatedAt }`
- `devices_registry/{installationId}`: `{ installationId, requestedTelco, approvedTelco, approvedGroupId, fcmToken, status, account, registeredPhoneNumber, customFields, appVersion, requestedAt, approvedAt, updatedAt }`
  - `customFields`: `{ [fieldName]: value }` — per-device values (e.g. a telco-issued code) auto-merged into that device's USSD templates
  - `appVersion`: reported on every registration call, compared against `settings.latestAppVersion` to flag outdated devices
  - `status`: `pending` | `approved` | `rejected` | `revoked`
- `telcos/{code}`: `{ code, name, createdAt }` — `code` is the doc ID (e.g. `UMOBILE`), fully admin-manageable
- `device_groups/{autoId}`: `{ name, createdAt }`
- `logs/{autoId}`: `{ message, jobId, createdAt }` — step-by-step trail from the app (Other Logs section)
- `admin_users/{username}`: `{ username, passwordHash, createdAt }`
- `company_users/{autoId}`: `{ username, passwordHash, companyName, registrationNumber, address, phone, email, contactPerson, creditBalance, marginPercent, productMargins, defaultGroupId, alternativeGroupId, lowBalanceThreshold, lowBalanceWebhookUrl, lowBalanceAlerted, isTrial, createdAt }`
  - `productMargins`: `{ [telco__serviceTypeId]: marginPercent }` — overrides `marginPercent` for that specific combination only
- `api_keys/{keyValue}`: `{ key, userId, name, revoked, createdAt }` — doc ID is the actual key value for fast lookup
- `credit_ledger/{autoId}`: `{ userId, type, amount, balanceAfter, createdAt, ... }`
  - `type: "reload"` also has: `documentNumber, documentDate, createdByAdmin, remarks, attachmentPath` — `amount` always positive
  - `type: "adjustment"` also has: `documentNumber, documentDate, createdByAdmin, remarks, attachmentPath` — `amount` can be positive or negative
  - `type: "usage"` also has: `jobId, phone, telco`
- `counters/{prefix+yyMM}`: `{ seq }` — powers sequential document numbering (separate counters per prefix, so reload and adjustment never collide)
- `settings/config`: `{ apiKey, appSecret, documentPrefix, adjustmentPrefix, legacyKeyEnabled, minTopupAmount, maxTopupAmount, billplzSecretKey, billplzXSignatureKey, billplzCollectionId, billplzSandbox, billplzMinReload, billplzMaxReload, billplzOnlinePrefix }` — live-editable via the Settings / Payment Gateway tabs
- `audit_log/{autoId}`: `{ actor, action, details, createdAt }`
- `billplz_bills/{billId}`: `{ userId, amount, status, createdAt }` — tracks each Billplz Bill for idempotency; `status`: `pending` | `completed` | `failed`
- `service_types/{id}`: `{ name, extraFields, isDefault, createdAt }` — `id` is a slug of the name (or `reload` for the protected default)
- `telco_configs/{TELCO}`: `{ services: { [serviceTypeId]: { enabled, template } }, updatedAt }`
- `rate_limits/{bucket:key}`: `{ count, windowStart }` — internal, powers login rate limiting

## Local setup

```bash
npm install
cp .env.example .env   # fill in real secrets
```

For local testing you also need a Firebase service account key:
1. Firebase Console → Project Settings → Service Accounts → Generate new private key
2. Save as `service-account.json` in this folder (already gitignored — do NOT commit it)
3. Before running locally: `export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json`

```bash
npm start
```

## Deploy to Cloud Run

```bash
gcloud run deploy ussd-topup-server \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars API_KEY=your-real-api-key,APP_SECRET=your-real-app-secret,ADMIN_KEY=your-bootstrap-key,JWT_SECRET=your-random-jwt-secret,FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com,CRON_SECRET=your-random-cron-secret
```

Generate a strong `JWT_SECRET` with: `openssl rand -hex 32`

## Example calls

```bash
# Create a top-up job for a specific telco
curl -X POST https://YOUR_URL/api/topup \
  -H "x-api-key: your-real-api-key" \
  -H "Content-Type: application/json" \
  -d '{"phone": "0123456789", "amount": 10, "telco": "MAXIS"}'

# Check status
curl https://YOUR_URL/api/topup/JOB_ID \
  -H "x-api-key: your-real-api-key"
```

## Notes

- `--allow-unauthenticated` makes the Cloud Run URL publicly reachable —
  the various keys/tokens are what actually protect each endpoint.
- Jobs left `pending` for more than 5 minutes are auto-marked `timeout`
  when polled.
- This assumes exactly one live device per telco. If a telco's approved
  phone is offline or broken, jobs for that telco will fail with "No
  device registered" until you approve a replacement.
