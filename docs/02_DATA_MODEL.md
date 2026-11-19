# 02 — Firestore Data Model

| Collection | Doc id | Key fields |
|---|---|---|
| `settings` | `config` | `apiKey, appSecret, documentPrefix, adjustmentPrefix, legacyKeyEnabled, minTopupAmount, maxTopupAmount, billplzSecretKey, billplzXSignatureKey, billplzCollectionId, billplzSandbox, billplzMinReload, billplzMaxReload, billplzOnlinePrefix, latestAppVersion` |
| `admin_users` | username | `passwordHash, createdAt` |
| `company_users` | auto | `username, passwordHash, companyName, regNo, address, phone, email, contactPerson, creditBalance, marginPercent, markupPercent(legacy), productMargins{ "TELCO__serviceTypeId": pct }, isTrial, defaultGroupId, alternativeGroupId, lowBalanceThreshold, lowBalanceAlerted, webhookUrl` |
| `api_keys` | auto | `userId, name, keyHash/prefix, createdAt, active` (full key shown once) |
| `credit_ledger` | auto | `userId, type: reload\|adjustment\|usage, amount (signed for adjustment), balanceAfter, docNo, docDate, remarks, attachmentPath, createdBy, jobId, billedAmount, marginPercent, createdAt` |
| `counters` | per prefix + yyMM | sequential doc numbers: `RC` reload, `AJ` adjustment, `OL` Billplz online → `<prefix><yyMM><NNN>` |
| `jobs` | job id | `userId, phone, amount, billedAmount, marginPercent, telco, groupId, serviceTypeId, ussdTemplate, status, installationId, rawResponse, idempotencyKey, webhookUrl, channel, createdAt, updatedAt` |
| `devices` | `deviceDocId` | active slot: `installationId, token, telco, groupId, timeoutSeconds, currentJobId, appVersion, customFields, account, registeredPhoneNumber` |
| `devices_registry` | installationId | `telco, token, status: pending\|approved\|rejected\|revoked, approvedTelco, approvedGroupId, appVersion, account, registeredPhoneNumber, customFields, createdAt` |
| `device_groups` | auto | `name, description` (delete blocked if in use) |
| `telcos` | code | `code, name` (seeded UMOBILE, MAXIS, DIGI, CELCOM; 30 s cache; delete blocked if an approved device uses it) |
| `service_types` | id | `name, isDefault` ("reload" is protected) |
| `telco_configs` | TELCO | `services[serviceTypeId] = { enabled, template }` |
| `billplz_bills` | bill id | idempotency + status of online reloads |
| `logs` | auto | app / server log lines with device account |
| `audit_log` | auto | `actor, action, target, details (secrets redacted), createdAt` |
| `rate_limits` | username | login attempt counters (5 per 15 min) |

## Notes
- Ungrouped device slot: `devices/UMOBILE`. Grouped: `devices/GRP1__UMOBILE`.
- Registry is per physical install; `approvedTelco/approvedGroupId` point to the slot it occupies. Revoke deletes the slot only if its `installationId` matches (bug fix).
- Money is stored as numbers (MYR) with 2-dp rounding at billing time.
