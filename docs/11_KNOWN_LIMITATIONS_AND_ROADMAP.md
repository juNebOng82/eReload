# 11 — Known Limitations & Roadmap

## Open items for Jun
- Confirm Billplz keys regenerated; "Load Payment Methods" failure was never confirmed fixed (check key pair, sandbox/production match, Collection ID).
- Enter real per-telco USSD templates (seeded placeholder only).
- Set Latest App Version to the deployed build; re-approve devices after package change; regenerate `google-services.json`.
- Diagnose Digi "USSD error code: -1".

## Limitations
- Login rate limit per username, not IP.
- Ledger/credit-inquiry load full history (no pagination).
- Old reload records without `attachmentPath` show no attachment.
- Small race between credit pre-check and deduction under parallel requests.
- `/api/ussd-log` and `channel:"manual"` are unused leftovers.
- Old pre-rename devices linger in registry until revoked.
- App `BASE_URL`/`APP_SECRET` hardcoded.

## Ideas
In-place device group move; credit reservation; pagination; per-device app tokens; bill-payment service live testing for Digi; dashboards for success rate trends.
