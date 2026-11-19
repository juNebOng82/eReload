# 13 — Sub-dealer App (eReload Dealer, `com.ereload.dealer`)

The app sub-dealers use to reload airtime **on behalf of their customers**. It is a separate app from the gateway app (`com.ereload.app`, see `07_ANDROID_APP.md`), which sits on the dealer's own phones and dials USSD.

```
Sub-dealer phone (eReload Dealer) ──JWT──▶ Server ──FCM──▶ Gateway phone (eReload) ──USSD──▶ Telco
```

Source: `dealer-app/` (separate Gradle project, Kotlin, ViewBinding, OkHttp, coroutines). No Firebase / `google-services.json` needed.

## Login
Same username and password as the company portal (`POST /api/portal/login`). The 12-hour session token is kept on the phone; when it expires the app returns to the login screen.

## Screens
| Screen | What it does | Endpoint |
|---|---|---|
| Login | Portal username + password | `POST /api/portal/login` |
| Home | Company name, current balance; buttons below | `GET /api/portal/reload-options` |
| New reload | Telco (only telcos with Reload enabled), customer phone, amount (+ quick amounts). Shows the amount that will be deducted after margin. Confirm dialog, then live status until success / failed / timeout | `GET /api/portal/reload-options`, `POST /api/portal/topup`, `GET /api/portal/jobs/:id` (polled every 2 s, up to 3 min) |
| My reloads | Every reload with status (All / Success / Failed / Processing). Tap for details and the telco reply | `GET /api/portal/jobs` |
| Credit statement | Credit in and out (Today / 7 days / 30 days) with B/F, C/F and current balance | `GET /api/portal/ledger` |

## Billing and routing
Unchanged. `POST /api/portal/topup` calls the same `performTopup` as `/api/topup`: same margin resolution, credit pre-check (402 if short), deduction **only on success**, group routing, Trial self-test and min/max amount. Jobs are tagged `channel: "dealer_app"` (API jobs stay `rest_api`) and the USSD Log shows that channel.

Each confirmed reload carries an `idempotency_key`. If the connection drops after the reload was sent, tapping Reload again for the same phone/amount/telco reuses the key, so the server returns the original job instead of reloading the customer twice.

## Build
- Set `Api.BASE_URL` in `dealer-app/app/src/main/java/com/ereload/dealer/Api.kt` to the server URL (currently the same as the gateway app).
- `cd dealer-app && ./gradlew assembleRelease` (sign with your own keystore), or `assembleDebug` for testing.
- Bump `versionCode` / `versionName` in `dealer-app/app/build.gradle` on every build. (Latest App Version in Settings applies to the gateway app only.)
