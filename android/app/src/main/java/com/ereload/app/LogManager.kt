package com.ereload.app

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Simple on-device log so you can see what happened without a USB-connected
 * computer / Logcat. Stores the last MAX_ENTRIES lines in SharedPreferences.
 */
object LogManager {
    private const val PREFS_NAME = "ussd_logs"
    private const val KEY_LOG = "log_entries"
    private const val MAX_ENTRIES = 200

    private val timeFormat = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())

    fun append(context: Context, message: String, jobId: String? = null) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val timestamp = timeFormat.format(System.currentTimeMillis())
        val line = "[$timestamp] $message"

        val existing = prefs.getString(KEY_LOG, "") ?: ""
        val lines = existing.split("\n").filter { it.isNotBlank() }.toMutableList()
        lines.add(line)

        // Keep only the most recent MAX_ENTRIES lines so this doesn't grow forever.
        val trimmed = if (lines.size > MAX_ENTRIES) lines.takeLast(MAX_ENTRIES) else lines

        prefs.edit().putString(KEY_LOG, trimmed.joinToString("\n")).apply()

        // Also send to the server so this is visible in Firestore without
        // needing the phone in hand. Best-effort — failures here are silent.
        ApiClient.postLog(message, jobId)
    }

    fun getAll(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_LOG, "") ?: ""
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_LOG)
            .apply()
    }
}
