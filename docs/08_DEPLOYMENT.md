# 08 — Deployment

## Environment variables (set on Cloud Run; **never commit values**)
| Var | Purpose |
|---|---|
| `API_KEY` | Fallback legacy global API key (Settings overrides) |
| `APP_SECRET` | Shared secret the Android app sends (`x-app-secret`) |
| `ADMIN_KEY` | One-time bootstrap of first admin |
| `JWT_SECRET` | Signs admin/portal sessions (`openssl rand -hex 32`) |
| `CRON_SECRET` | Authorises Cloud Scheduler |
| `FIREBASE_STORAGE_BUCKET` | Attachment bucket (e.g. `<project>.appspot.com`) |
| `PUBLIC_BASE_URL` | Optional; used for Billplz callback/redirect URLs |

## Steps
1. Firebase project `ussd-3d846`: enable Firestore (Native), Storage, Cloud Messaging; service account via Cloud Run default credentials.
2. Deploy from `ussd-server/`:
   ```bash
   gcloud run deploy ussd-topup-server --source . --region asia-southeast1 --allow-unauthenticated \
     --set-env-vars API_KEY=<...>,APP_SECRET=<...>,ADMIN_KEY=<...>,JWT_SECRET=<...>,CRON_SECRET=<...>,FIREBASE_STORAGE_BUCKET=<...>
   ```
3. Bootstrap first admin: open `/admin.html`, use the bootstrap form with `ADMIN_KEY`.
4. Cloud Scheduler job (every minute): `POST https://<service>/api/internal/check-timeouts` with header `x-cron-secret: <CRON_SECRET>`.
5. Admin → Settings: set document prefixes, min/max, Latest App Version; Payment Gateway: Billplz keys, collection id, sandbox toggle; Billplz dashboard webhook → `https://<service>/api/billplz/callback`.
6. Telco Configuration: enter real USSD templates for each telco/service.
7. Android: add `google-services.json`, set `BASE_URL`/`APP_SECRET`, build, install, register, approve.

## Docker
`node:20-slim`, `npm install --omit=dev`, `PORT=8080`, `CMD node index.js`.
