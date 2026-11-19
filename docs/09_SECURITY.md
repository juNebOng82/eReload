# 09 — Security

## Action items (important)
1. **Billplz keys were pasted in chat earlier — treat as compromised; regenerate both the Secret Key and X Signature Key** and re-enter in Settings → Payment Gateway.
2. The Android `ApiClient.kt` hardcodes the app secret. It is redacted in this documentation; rotate it if the APK or source was shared.
3. Keep every env var out of source control; `.env.example` holds placeholders only.

## Controls in place
- Admin/company JWT sessions; bcrypt password hashes; Firestore-backed login rate limit (5 attempts / 15 min — per username).
- Audit log on admin mutations (secrets redacted).
- Billplz secrets write-only in UI; webhook signature verified (HMAC-SHA256).
- Attachments via signed URLs; company can only read own jobs/ledger.
- `trust proxy` enabled for correct client IP behind Cloud Run.

## Hardening backlog
Per-IP rate limiting; move app secret out of the APK (per-device token); pagination on ledger endpoints; atomic credit reservation; restrict Cloud Run ingress / add Cloud Armor if needed.
