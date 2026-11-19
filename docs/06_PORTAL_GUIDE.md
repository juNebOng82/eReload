# 06 — Company Portal (`/portal.html`)

Companies are created by admin only (no self-signup). Tabs:
- **API Keys** — create named keys; full value shown once; revoke.
- **Reload Credit** — pay via Billplz (FPX / DuitNow Transfer); amount within configured min/max; on return, `verify-redirect` shows status; credit is applied only by webhook.
- **Credit Usage** — balance and ledger with date range and CSV; shows reload (+), adjustment (signed), usage (−); attachment links where available.
- The same login works in the sub-dealer app (`13_DEALER_APP.md`), which adds reloading for customers and a list of every reload with its status.
- **Company Settings** — company details, password; **Margin Applied** shown read-only.
