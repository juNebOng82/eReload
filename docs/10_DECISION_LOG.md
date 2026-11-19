# 10 — Decision Log (user-confirmed)

| # | Decision | Detail |
|---|---|---|
| 1 | Margin, not markup | 10 top-up → bills 9.50 |
| 2 | Group routing | Company: default + alternative group; no fallback to shared pool when groups assigned |
| 3 | Billplz limited to FPX + DuitNow Transfer | Webhook-only crediting |
| 4 | Sidebar UI | Collapsible, blue theme, manual dark toggle |
| 5 | Service types fully custom | Rename/add anytime; one phone-number field suffices |
| 6 | Templates server-side | Only `{PIN}` resolved on device |
| 7 | Unique code per device | Stored on server as device custom field, visible; PIN on phone only |
| 8 | Telco list from server | App dropdown; admin-managed telcos |
| 9 | One Save per device | Plus app-version/outdated display |
| 10 | App renamed eReload / `com.ereload.app` | Test mode removed; version shown on first screen |
| 11 | Trial company | Phone == device Registered Phone → simulated success; else normal; credit deducts; no enforcement (reversed from earlier) |
| 12 | Renames | "Credit Top Up Transaction", "Reload Mockup" |
| 13 | Log date filters | Range, default today |
| 14 | Margin per Telco + Service Type per company | Company default as fallback |
| 15 | Revoke by installation_id | Fixes wrong device being revoked |
