package com.ereload.dealer

import android.app.Activity
import android.graphics.Color
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

fun rm(value: Double): String = "RM " + String.format(Locale.US, "%,.2f", value)

fun billedFor(amount: Double, marginPercent: Double): Double =
    Math.round(amount * (1 - marginPercent / 100) * 100) / 100.0

private val isoParser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
private val display = SimpleDateFormat("d MMM yyyy, h:mm a", Locale.getDefault())

fun displayTime(iso: String?): String {
    if (iso.isNullOrEmpty()) return ""
    return try { display.format(isoParser.parse(iso.take(19))!!) } catch (_: Exception) { iso }
}

fun statusLabel(status: String): String = when (status) {
    "queued", "pending" -> "Processing"
    "success" -> "Success"
    "failed" -> "Failed"
    "timeout" -> "Timed out"
    "rejected" -> "Rejected"
    else -> status.replaceFirstChar { it.uppercase() }
}

fun statusColor(status: String): Int = when (status) {
    "success" -> Color.parseColor("#2E7D32")
    "queued", "pending" -> Color.parseColor("#EF6C00")
    else -> Color.parseColor("#C62828")
}

/** Shows the error, or logs out if the session has expired. */
fun Activity.handleError(e: Exception) {
    if (e is ApiException && e.sessionExpired) {
        Session.logout(this, "Your session has expired. Please log in again.")
    } else {
        Toast.makeText(this, e.message ?: "Something went wrong", Toast.LENGTH_LONG).show()
    }
}
