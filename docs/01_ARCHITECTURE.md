# 01 — Architecture

## Components
| Component | Tech | Notes |
|---|---|---|
| Server | Node 20, Express, `firebase-admin`, `bcryptjs`, `jsonwebtoken`, `multer`, `node-fetch` | Single file `index.js`; static `public/admin.html` and `public/portal.html` |
| Hosting | Google Cloud Run, region `asia-southeast1` | Firebase project `ussd-3d846` |
| Database | Firestore (Native) | See `02_DATA_MODEL.md` |
| Files | Firebase Storage | Reload/adjustment attachments, served via signed URLs |
| Push | Firebase Cloud Messaging | `sendFcmWithRetry`: 3 attempts, 500/1000/2000 ms backoff |
| Scheduler | Cloud Scheduler → `POST /api/internal/check-timeouts` every minute with `x-cron-secret` | Marks stuck jobs as `timeout` and advances queues |
| Payments | Billplz (FPX + DuitNow Transfer only) | Webhook is the only thing that credits |
| Android | Kotlin, ViewBinding, OkHttp, FCM | Package `com.ereload.app` |

## Request lifecycle (real dial)
1. Company calls `POST /api/topup` or `/api/service-request` with `x-api-key`.
2. `performTopup` validates phone/amount/telco, resolves service type + telco template, checks idempotency.
3. `resolveRoutingDevice(company, telco)` picks the device slot (see routing).
4. Credit pre-check: `billedAmount = amount × (1 − margin%/100)`; if balance < billedAmount → job `rejected`, HTTP 402.
5. Job created `queued` (with `groupId`, `serviceTypeId`, resolved `ussdTemplate`).
6. `tryDispatchNext` — if the device slot is free, job → `pending`, FCM sent with `{job_id, phone, amount, ussd_template}`.
7. App substitutes only `{PIN}`, dials USSD, reads response, `POST /api/fcm/callback {job_id, status, raw_response}` (retries up to 4×).
8. Server: guard (`already_processed` if already success) → update job → on success `deductCreditForJob` (Firestore transaction) → company webhook → `completeJobAndAdvanceQueue` (dispatch next queued job).
9. Cron: pending jobs older than the device timeout (default 60 s) → `timeout`, queue advances.

## Job statuses
`queued → pending → success | failed | timeout | rejected` (rejected = refused at request time, e.g. insufficient credit).

## Queue model
- One FIFO queue **per device slot**, keyed by `(groupId, telco)`.
- Slot doc id: `deviceDocId(groupId, telco)` = `groupId ? "<groupId>__<telco>" : telco` in collection `devices`.
- One job in flight per slot. `runTimeoutCheck` iterates the `devices` collection.

## Routing (`resolveRoutingDevice`)
- Company with **no groups assigned** → shared **ungrouped** pool (`devices/{telco}`).
- Company with groups → **default group** device first; if unavailable → **alternative group**. **No silent fallback** to the shared pool.
- No device → HTTP 503.

## Trial shortcut (inside `performTopup`)
If company `isTrial` and requested phone equals routed device's `registeredPhoneNumber` → job created as `success` with simulated response, **no FCM**, billing/margin still applied. Otherwise normal flow. See `03_BUSINESS_RULES.md`.

## Auth surfaces
| Surface | Header | Middleware |
|---|---|---|
| Company API | `x-api-key` (company key) or legacy global key | `resolveApiKey` / `requireApiKey` |
| Android app | `x-app-secret` | `requireAppSecret` |
| Admin panel | `Authorization: Bearer <JWT>` | `requireAdminSession` |
| Portal | `Authorization: Bearer <JWT>` | `requireCompanySession` |
| Cron | `x-cron-secret` | inline check |
| Bootstrap | `x-admin-key` | inline check (first admin only) |
| Billplz webhook | X-Signature (HMAC-SHA256) | verified in handler |
