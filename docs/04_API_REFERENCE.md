# 04 — API Reference

Base URL: `https://<service>.asia-southeast1.run.app`. JSON unless stated. Errors: `{ "error": "..." }`.

## A. Company / caller API (`x-api-key: <company key>`)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/topup` | `{phone, amount, telco, webhook_url?, idempotency_key?}` | Reload service. Returns `{job_id, status, telco}` (`status` `queued/pending`, or `success` for Trial self-test). 402 insufficient credit; 400 invalid; 503 no device |
| POST | `/api/service-request` | `{service_type, phone, amount, telco, extra_fields?, webhook_url?, idempotency_key?}` | Any enabled service type |
| GET | `/api/topup/:jobId` | — | Job status (own jobs only for company keys) |

Webhook (if `webhook_url`) is POSTed the job result on completion.

## B. Android app (`x-app-secret`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/telcos` | Telco list for the dropdown |
| POST | `/api/register-device` | `{installation_id, token, telco, app_version}` |
| POST | `/api/fcm/callback` | `{job_id, status: success\|failed, raw_response}` |
| POST | `/api/logs` | App log line(s) |
| POST | `/api/ussd-log` | Legacy/unused manual path |

## C. Cron / bootstrap / public
| POST | `/api/internal/check-timeouts` | header `x-cron-secret` |
| POST | `/api/admin/bootstrap` | header `x-admin-key`; creates first admin |
| POST | `/api/billplz/callback` | Billplz webhook, signature-verified, always 200 |
| GET | `/` | Redirect/health |

## D. Portal (`Authorization: Bearer <company JWT>`)
`POST /api/portal/login` · `GET|POST /api/portal/profile` · `PUT /api/portal/password` · `GET|POST /api/portal/api-keys` · `DELETE /api/portal/api-keys/:keyId` · `GET /api/portal/ledger` (+ `/export` CSV) · `GET /api/portal/reload-attachment/:ledgerId` · `GET /api/portal/adjustment-attachment/:ledgerId` · `POST /api/portal/billplz/create-bill` · `GET /api/portal/billplz/verify-redirect`

## E. Admin (`Authorization: Bearer <admin JWT>`)
**Session/users:** `POST /api/admin/login` · `GET|POST /api/admin/users` · `PUT /api/admin/users/:username/password` · `DELETE /api/admin/users/:username`

**Settings:** `GET|POST /api/admin/settings` · `GET|POST /api/admin/billplz/payment-methods`

**Companies:** `GET|POST /api/admin/company-users` · `POST /api/admin/company-users/:userId/{margin|product-margin|groups|trial|reload|adjustment}`
- `margin {margin_percent 0–100}` · `product-margin {telco, service_type_id, margin_percent|null}` · `groups {default_group_id, alternative_group_id}` · `trial {is_trial}` · `reload`/`adjustment` are multipart (amount, docDate, remarks, attachment).

**Transactions:** `GET /api/admin/reload-transactions[/export]` · `GET /api/admin/adjustment-transactions[/export]` · `GET /api/admin/credit-inquiry[/export]` · attachments `GET /api/admin/{reload|adjustment}-attachment/:ledgerId`

**Stats/logs:** `GET /api/admin/stats?days=N` → `{stats, company_stats}` · `GET /api/admin/ussd-logs` · `GET /api/admin/other-logs` · `GET /api/admin/audit-log` (all accept `from`, `to`, `before`) · `GET /api/logs`

**Catalog:** `service-types` (GET/POST/PUT :id/DELETE :id) · `telco-configs` (GET, POST /:telco) · `telcos` (GET/POST/DELETE :code) · `device-groups` (GET/POST/DELETE :groupId)

**Devices:** `GET /api/admin/pending-devices` · `GET /api/admin/devices` (returns `app_version, is_outdated, custom_fields, group_name, account, registered_phone_number, latest_app_version`) · `POST /api/admin/approve-device {installation_id, telco, group_id}` · `reject-device` · `revoke-device {installation_id}` · `devices-registry/:installationId/info {account, registered_phone_number, custom_fields}` · `devices/:telco/timeout` and `.../force-release` (both take `group_id`) · `POST /api/admin/check-timeouts` · `POST /api/admin/test-topup {user_id, phone, amount, telco, service_type, extra_fields}`
