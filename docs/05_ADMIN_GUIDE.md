# 05 — Admin Panel (`/admin.html`)

Left sidebar (expand/collapse; blue theme; manual dark-mode toggle at the bottom). State keys in localStorage: `ussd_admin_theme`, `ussd_admin_sidebar_collapsed`.

| Section | Items | What it does |
|---|---|---|
| Home | Statistics | Per-telco and **per-company** success rates; period selector |
| Accounts | Account books (Company User) | Create/edit companies; Trial flag (auto-saves); default/alternative device group; company default margin; **Telco × Service Type margin grid**; reload, adjustment, API access |
| Transaction | Credit Top Up Transaction · Adjustment Transactions · Reload Mockup | Reload ledger (+CSV); signed adjustments with attachment; Reload Mockup = test top-up as a chosen company |
| Inquiry | Credit Inquiry | Balances/ledger across companies (+CSV) |
| Maintenance | User Maintenance · Device Approval · Device Groups | Admin users; approve/reject/revoke devices, set Account, Registered Phone, custom fields, timeout with **one Save button**, app version + Outdated badge; group CRUD |
| Settings | General · Payment Gateway · Telcos · Service Types · Telco Configuration | API/app secrets, doc prefixes, legacy key, min/max amount, latest app version; Billplz keys/sandbox/limits; telco list; service types; per-telco USSD templates |
| Log | USSD Log · Misc Log · Audit Log | Date-range filters (default today); device account shown |

## Common tasks
- **Onboard a phone:** install eReload → choose telco, set PIN → app registers → Device Approval → approve (pick group) → fill Account, Registered Phone, custom fields → Save.
- **Move device to another group:** revoke, re-register, approve into new group (no in-place move yet).
- **New telco:** Telcos → add; Telco Configuration → enable services + templates; devices pick it from the app dropdown.
- **New service (e.g. Bill Payment):** Service Types → add; Telco Configuration → enable + template per telco (extras like `{UNIQUE}` auto-detected).
- **Per-product margin:** Company → margin grid; blank = fall back to company default.
- **Trial company:** tick Trial; send top-up to the device's Registered Phone → simulated success; any other number dials for real.
