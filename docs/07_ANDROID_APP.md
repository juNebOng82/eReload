# 07 — Android App (eReload, `com.ereload.app`)

Kotlin, ViewBinding, OkHttp, Firebase Messaging. One install per telco SIM. **Fully background-operated** — no manual send, no test mode.

## Files (package `com.ereload.app`)
| File | Role |
|---|---|
| `ApiClient.kt` | `BASE_URL`, `APP_SECRET` (hardcoded — see security), `registerDevice` (sends `app_version`), `fetchTelcos`, `postUssdLog`, `postUssdResult` (4 retries, partial wake lock `eReload:PostUssdResult`, 30 s auto-release) |
| `MyFirebaseMessagingService.kt` | Receives FCM `{job_id, phone, amount, ussd_template}`; needs saved PIN and template else reports failure; dials `template.replace("{PIN}", pin)`; reports result |
| `SettingsActivity.kt` | Telco Spinner (fallback list then server list), PIN, re-registers FCM token on save |
| `MainActivity.kt` | Status screen; shows `v<versionName>` |
| `LogActivity.kt`, `LogManager.kt` | Local log viewer |
| `PrefsManager.kt` | telco (String, default UMOBILE), PIN, installationId |
| `AndroidManifest.xml` | `INTERNET`, `CALL_PHONE`, `WAKE_LOCK`; label `eReload` |

## Build
- `applicationId`/`namespace`: `com.ereload.app`; currently versionCode 16 / versionName 1.16 (bump both every build).
- Add `google-services.json` for the **`com.ereload.app`** Firebase Android app to `app/`. Not included in the zip.
- After the package rename, all devices must be re-registered and re-approved; old registry records stay until revoked.

## Behaviour notes
- Missing PIN or missing `ussd_template` → immediate failed callback (no dial).
- Real Digi dial once produced "USSD error code: -1" — carrier/device-side, not syntax; undiagnosed.
- Grant phone-call permission and disable battery optimisation for reliability.
