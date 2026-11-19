package com.ereload.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives the FCM data message sent by the server's POST /api/topup endpoint,
 * then dials the USSD directly (no UI needed) and reports the result back.
 *
 * Requires CALL_PHONE permission to already be granted — this happens the
 * first time the user sends a USSD manually from MainActivity. Since this is
 * a single-device app, that's a reasonable one-time setup step.
 */
class MyFirebaseMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        LogManager.append(applicationContext, "New FCM token received, registering with server")
        // Token can change (e.g. app reinstall, data cleared) — always re-register.
        val installationId = PrefsManager.getOrCreateInstallationId(applicationContext)
        val telco = PrefsManager.getTelco(applicationContext)
        ApiClient.registerDevice(applicationContext, installationId, token, telco) { status ->
            if (status == "pending_approval") {
                LogManager.append(applicationContext, "Registration pending admin approval for $telco")
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)

        val jobId = message.data["job_id"]
        val phone = message.data["phone"]
        val amount = message.data["amount"]
        val ussdTemplate = message.data["ussd_template"]

        LogManager.append(
            applicationContext,
            "FCM received: job_id=$jobId, phone=$phone, amount=$amount",
            jobId
        )

        if (jobId == null || phone == null || amount == null) {
            LogManager.append(applicationContext, "FCM payload missing required fields, ignoring")
            return
        }

        val pin = PrefsManager.getPin(applicationContext)

        if (pin.isNullOrEmpty()) {
            LogManager.append(applicationContext, "No PIN saved on device, reporting failure to server", jobId)
            // No PIN saved yet — can't build the USSD string. Report failure so
            // the job doesn't sit stuck as "pending" forever.
            ApiClient.postUssdResult(applicationContext, jobId, "failed", "No PIN configured on device")
            return
        }

        // The server resolves the USSD template (with amount/phone/any extra
        // fields already substituted) — fully editable from the admin panel,
        // no app update needed. {PIN} is deliberately left for the app to
        // fill in locally, since it never leaves the device. There's no
        // local fallback template anymore — telcos are now a dynamic,
        // server-managed list, so a device-side fallback could easily be
        // stale or simply not exist for a telco added after this app build.
        if (ussdTemplate.isNullOrEmpty()) {
            LogManager.append(applicationContext, "No ussd_template in FCM payload, cannot dial", jobId)
            ApiClient.postUssdResult(applicationContext, jobId, "failed", "Server did not provide a USSD template for this job")
            return
        }
        val ussd = ussdTemplate.replace("{PIN}", pin)

        LogManager.append(applicationContext, "Dialing USSD: $ussd", jobId)
        sendUssd(jobId, ussd)
    }

    private fun sendUssd(jobId: String, ussd: String) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            LogManager.append(applicationContext, "CALL_PHONE permission not granted, cannot dial", jobId)
            ApiClient.postUssdResult(applicationContext, jobId, "failed", "CALL_PHONE permission not granted on device")
            return
        }

        val telephonyManager = getSystemService(TELEPHONY_SERVICE) as TelephonyManager
        val handler = Handler(Looper.getMainLooper())

        try {
            telephonyManager.sendUssdRequest(ussd, object : TelephonyManager.UssdResponseCallback() {
                override fun onReceiveUssdResponse(
                    telephonyManager: TelephonyManager?,
                    request: String?,
                    response: CharSequence?
                ) {
                    super.onReceiveUssdResponse(telephonyManager, request, response)
                    val result = response?.toString() ?: "Empty response"
                    val isSuccess = result.lowercase().contains("success")
                    LogManager.append(applicationContext, "USSD response: $result", jobId)
                    ApiClient.postUssdResult(applicationContext, jobId, if (isSuccess) "success" else "failed", result)
                }

                override fun onReceiveUssdResponseFailed(
                    telephonyManager: TelephonyManager?,
                    request: String?,
                    failureCode: Int
                ) {
                    super.onReceiveUssdResponseFailed(telephonyManager, request, failureCode)
                    LogManager.append(applicationContext, "USSD failed, error code: $failureCode", jobId)
                    ApiClient.postUssdResult(applicationContext, jobId, "failed", "USSD error code: $failureCode")
                }
            }, handler)
        } catch (e: Exception) {
            LogManager.append(applicationContext, "Exception sending USSD: ${e.message}", jobId)
            ApiClient.postUssdResult(applicationContext, jobId, "failed", "Exception: ${e.message}")
        }
    }
}
