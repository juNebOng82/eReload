# eReload — Multi-Tenant USSD Top-Up Gateway (Project Knowledge Base)

**Owner:** Jun (Kuching, Malaysia — custom business software)
**Last synced with code:** server `index.js` (~3,080 lines) + Android `com.ereload.app` v1.16

## What this system is
A gateway that lets many **companies** (tenants) top up / pay telco services through a REST API. The actual USSD dial is performed by **real Android phones** (one eReload app install per telco SIM), triggered via Firebase Cloud Messaging (FCM). The server handles routing, queueing, billing (credit + margin), logging, an admin panel and a company portal.

```
Company system ──REST (x-api-key)──▶ Server (Cloud Run) ──FCM──▶ Android eReload app ──USSD──▶ Telco
                                          ▲                            │
                                          └──── POST /api/fcm/callback ┘
Sub-dealer app (com.ereload.dealer) ──JWT──▶ Server (/api/portal/topup)
Admin  ──▶ /admin.html     Company ──▶ /portal.html     Billplz ──webhook──▶ /api/billplz/callback
```

## Document map (read in this order)
| File | Purpose |
|---|---|
| `01_ARCHITECTURE.md` | Components, request lifecycle, queue and routing design |
| `02_DATA_MODEL.md` | Every Firestore collection and field |
| `03_BUSINESS_RULES.md` | Margin, billing, Trial company, service types, templates, custom fields, groups, Billplz |
| `04_API_REFERENCE.md` | All REST endpoints (caller, app, portal, admin) |
| `05_ADMIN_GUIDE.md` | Admin panel menu-by-menu |
| `06_PORTAL_GUIDE.md` | Company portal |
| `07_ANDROID_APP.md` | Android app design and behaviour |
| `08_DEPLOYMENT.md` | Cloud Run, Firebase, Scheduler, env vars, app build |
| `09_SECURITY.md` | Auth, secrets, hardening checklist |
| `10_DECISION_LOG.md` | Why things are the way they are (user-confirmed decisions) |
| `11_KNOWN_LIMITATIONS_AND_ROADMAP.md` | Open issues and next ideas |
| `12_CHANGELOG.md` | Feature history |
| `13_DEALER_APP.md` | Sub-dealer app (`com.ereload.dealer`): reload on behalf of customers |
| `../source/*.md` | Every source file embedded in code fences (secrets redacted) |

## Working rules for Claude when using this project
1. **Never** output or request real secrets (API_KEY, APP_SECRET, ADMIN_KEY, JWT_SECRET, CRON_SECRET, Billplz keys). Use placeholders.
2. Confirm requirements with Jun **before coding** when a change touches billing, routing or data model (he explicitly asks for this).
3. Bump Android `versionCode` / `versionName` on every app build, and tell Jun to update **Settings → Latest App Version** on the server.
4. Server is a single `index.js` + two HTML files; deliver changes as a full updated zip and verify by unzipping.
5. Margin (not markup): top-up 10 at 5% margin bills **9.50**; the phone always receives the full 10.
6. Jun's style: concise, screenshot-driven bug reports; wants discussion first for design changes.
