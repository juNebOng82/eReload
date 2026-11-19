package com.ereload.dealer

import android.app.Activity
import android.content.Context
import android.content.Intent

/** Keeps the portal session token on the device. */
object Session {
    private const val PREFS = "dealer_session"

    fun token(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("token", null)

    fun companyName(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("company", "") ?: ""

    fun lastUsername(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("username", "") ?: ""

    fun save(context: Context, token: String, company: String, username: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("token", token).putString("company", company).putString("username", username).apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("token").remove("company").apply()
    }

    /** Token or, if missing, sends the user back to the login screen and returns null. */
    fun requireToken(activity: Activity): String? {
        val t = token(activity)
        if (t == null) logout(activity, null)
        return t
    }

    fun logout(activity: Activity, message: String?) {
        clear(activity)
        val intent = Intent(activity, LoginActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        if (message != null) intent.putExtra(LoginActivity.EXTRA_MESSAGE, message)
        activity.startActivity(intent)
        activity.finish()
    }
}
