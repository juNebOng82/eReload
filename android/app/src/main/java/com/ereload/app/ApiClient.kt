package com.ereload.app

import android.content.Context
import android.os.PowerManager
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/**
 * Talks to the ussd-server Cloud Run deployment.
 *
 * IMPORTANT: Replace BASE_URL, API_KEY and APP_SECRET below with your real
 * deployed values before building. These three must match exactly what you
 * used in `gcloud run deploy --set-env-vars API_KEY=...,APP_SECRET=...`.
 */
object ApiClient {

    private const val BASE_URL = "https://ussd-topup-server-596609955900.asia-southeast1.run.app"
    private const val APP_SECRET = "REPLACE_WITH_YOUR_APP_SECRET"

    private val client = OkHttpClient()
    private val JSON = "application/json".toMediaType()

    /**
     * Called on app startup and whenever the telco selection changes.
     * Also reports this build's versionName so the admin panel can flag
     * devices running an outdated app build. onResult receives the raw
     * "status" field from the server response (e.g. "registered" or
     * "pending_approval") so callers can log it with their own Context.
     */
    fun registerDevice(context: Context, installationId: String, token: String, telco: String, onResult: ((String) -> Unit)? = null) {
        val appVersion = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"
        } catch (_: Exception) {
            "unknown"
        }

        val body = JSONObject().apply {
            put("installation_id", installationId)
            put("token", token)
            put("telco", telco)
            put("app_version", appVersion)
        }.toString().toRequestBody(JSON)

        val request = Request.Builder()
            .url("$BASE_URL/api/register-device")
            .addHeader("x-app-secret", APP_SECRET)
            .post(body)
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // Network hiccups here aren't critical — token will be resent
                // next time onNewToken() fires or the app restarts.
            }
            override fun onResponse(call: Call, response: okhttp3.Response) {
                val bodyText = response.body?.string()
                response.close()
                try {
                    val json = bodyText?.let { JSONObject(it) }
                    json?.optString("status")?.let { onResult?.invoke(it) }
                } catch (_: Exception) {
                    // Ignore parse failures — non-critical logging path.
                }
            }
        })
    }

    /**
     * Fetches the current list of supported telco codes from the server
     * (e.g. ["UMOBILE", "MAXIS", "DIGI", "CELCOM"]) — so adding a new telco
     * server-side shows up in the app's Settings dropdown automatically,
     * no app update needed. Calls back with null on failure so the caller
     * can fall back to a cached/default list.
     */
    fun fetchTelcos(onResult: (List<String>?) -> Unit) {
        val request = Request.Builder()
            .url("$BASE_URL/api/telcos")
            .addHeader("x-app-secret", APP_SECRET)
            .get()
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onResult(null)
            }
            override fun onResponse(call: Call, response: okhttp3.Response) {
                try {
                    val bodyText = response.body?.string()
                    response.close()
                    val json = bodyText?.let { JSONObject(it) }
                    val arr = json?.optJSONArray("telcos")
                    if (arr == null) {
                        onResult(null)
                        return
                    }
                    val list = mutableListOf<String>()
                    for (i in 0 until arr.length()) list.add(arr.getString(i))
                    onResult(list)
                } catch (_: Exception) {
                    onResult(null)
                }
            }
        })
    }

    /**
     * Records a manually-sent USSD (from the app's Send button, not a
     * remote FCM-triggered job) so it appears in the admin panel's USSD Log
     * section alongside REST-API-triggered sends.
     */
    fun postUssdLog(phone: String, amount: String, telco: String, status: String, rawResponse: String?) {
        val body = JSONObject().apply {
            put("phone", phone)
            put("amount", amount)
            put("telco", telco)
            put("status", status)
            put("raw_response", rawResponse ?: JSONObject.NULL)
        }.toString().toRequestBody(JSON)

        val request = Request.Builder()
            .url("$BASE_URL/api/ussd-log")
            .addHeader("x-app-secret", APP_SECRET)
            .post(body)
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // Best-effort — doesn't affect the actual USSD flow.
            }
            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.close()
            }
        })
    }

    private var resultWakeLock: PowerManager.WakeLock? = null

    /**
     * Called after a USSD response/failure to report the job result back to
     * the server. This is the single most important call in the app to get
     * through reliably — if it's lost, the server never learns the outcome:
     * the job stays "pending" forever (even though the phone already has
     * the real result), and the device stays marked "busy", blocking every
     * subsequent job for it until a timeout eventually clears it. Retries
     * with backoff before giving up, instead of firing once and hoping.
     *
     * IMPORTANT: by the time this fires, MyFirebaseMessagingService's
     * onMessageReceived() has already returned — meaning we're no longer
     * inside FCM's guaranteed execution window, and the CPU can go back to
     * sleep between retry attempts, silently preventing a scheduled retry
     * from ever running. A short partial wake lock (auto-releases after 30s
     * as a safety net even if something goes wrong) keeps the device awake
     * for the whole retry sequence so a delayed retry can't be lost to Doze.
     */
    fun postUssdResult(context: Context, jobId: String, status: String, rawResponse: String?, attempt: Int = 1) {
        val maxAttempts = 4

        if (attempt == 1) {
            try {
                val pm = context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
                resultWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "eReload:PostUssdResult").apply {
                    acquire(30_000L) // safety-net auto-release even if we somehow never release explicitly
                }
            } catch (_: Exception) {
                // Best-effort — if this fails for any reason, we still try the network call.
            }
        }

        val body = JSONObject().apply {
            put("job_id", jobId)
            put("status", status)
            put("raw_response", rawResponse ?: JSONObject.NULL)
        }.toString().toRequestBody(JSON)

        val request = Request.Builder()
            .url("$BASE_URL/api/fcm/callback")
            .addHeader("x-app-secret", APP_SECRET)
            .post(body)
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (attempt < maxAttempts) {
                    val delayMs = 2000L * attempt // 2s, 4s, 6s
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        postUssdResult(context, jobId, status, rawResponse, attempt + 1)
                    }, delayMs)
                } else {
                    // After the last attempt, this result is lost — the server's
                    // own per-device timeout will eventually clear the job as
                    // "timeout" instead of leaving it "pending" indefinitely.
                    releaseResultWakeLock()
                }
            }
            override fun onResponse(call: Call, response: okhttp3.Response) {
                val success = response.isSuccessful
                response.close()
                if (!success && attempt < maxAttempts) {
                    val delayMs = 2000L * attempt
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        postUssdResult(context, jobId, status, rawResponse, attempt + 1)
                    }, delayMs)
                } else {
                    releaseResultWakeLock()
                }
            }
        })
    }

    private fun releaseResultWakeLock() {
        try {
            resultWakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
            // Ignore — worst case the 30s timeout releases it for us.
        }
        resultWakeLock = null
    }

    /**
     * Sends a single log line to the server's `logs` collection so the full
     * trail (FCM received, USSD dialed, response, errors) is visible from
     * Firebase Console without needing to touch the phone.
     */
    fun postLog(message: String, jobId: String? = null) {
        val body = JSONObject().apply {
            put("message", message)
            put("job_id", jobId ?: JSONObject.NULL)
        }.toString().toRequestBody(JSON)

        val request = Request.Builder()
            .url("$BASE_URL/api/logs")
            .addHeader("x-app-secret", APP_SECRET)
            .post(body)
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // Remote logging is best-effort — don't let a failed log call
                // affect the actual USSD flow.
            }
            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.close()
            }
        })
    }
}
