package com.ereload.app

import android.content.Context
import java.util.UUID

/** Stores the top-up PIN and selected telco locally so background-triggered USSD (via FCM) can use it. */
object PrefsManager {
    private const val PREFS_NAME = "ussd_prefs"
    private const val KEY_PIN = "pin"
    private const val KEY_TELCO = "telco"
    private const val KEY_INSTALLATION_ID = "installation_id"

    fun savePin(context: Context, pin: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PIN, pin)
            .apply()
    }

    fun getPin(context: Context): String? {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_PIN, null)
    }

    fun saveTelco(context: Context, telco: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TELCO, telco)
            .apply()
    }

    /**
     * The device's selected telco, as a plain code string (e.g. "UMOBILE").
     * The set of valid telcos now comes from the server (see
     * ApiClient.fetchTelcos) instead of a fixed list baked into the app —
     * this just returns whatever was last saved, defaulting to "UMOBILE"
     * if nothing has been chosen yet.
     */
    fun getTelco(context: Context): String {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_TELCO, null) ?: "UMOBILE"
    }

    /**
     * A permanent random ID generated once per install. This is what the
     * server's admin approval is tied to — reinstalling the app generates a
     * brand new ID, which would need re-approval.
     */
    fun getOrCreateInstallationId(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_INSTALLATION_ID, null)
        if (existing != null) return existing

        val newId = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_INSTALLATION_ID, newId).apply()
        return newId
    }
}
