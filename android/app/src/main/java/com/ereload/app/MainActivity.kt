package com.ereload.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import com.ereload.app.databinding.ActivityMainBinding
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    companion object {
        private const val REQUEST_CALL_PHONE = 100
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnMenu.setOnClickListener {
            binding.drawerLayout.openDrawer(GravityCompat.START)
        }

        binding.menuSettings.setOnClickListener {
            binding.drawerLayout.closeDrawer(GravityCompat.START)
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        binding.menuViewLogs.setOnClickListener {
            binding.drawerLayout.closeDrawer(GravityCompat.START)
            startActivity(Intent(this, LogActivity::class.java))
        }

        // Shows the installed build's version right on the first screen —
        // makes it easy to confirm at a glance whether a device is up to
        // date without needing to check the admin panel.
        try {
            val versionName = packageManager.getPackageInfo(packageName, 0).versionName
            binding.txtAppVersion.text = "v$versionName"
        } catch (_: Exception) {
            binding.txtAppVersion.text = ""
        }

        // This device only ever dials USSD in response to a remote push —
        // there's no manual "Send" button anymore — so request the
        // permission proactively on first launch instead of waiting for an
        // interactive trigger that no longer exists.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.CALL_PHONE),
                REQUEST_CALL_PHONE
            )
        }

        // Fetch this device's FCM token and register it with the server so
        // it knows this phone represents the currently selected telco.
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                task.result?.let { token ->
                    val installationId = PrefsManager.getOrCreateInstallationId(this)
                    val telco = PrefsManager.getTelco(this)
                    ApiClient.registerDevice(this, installationId, token, telco) { status ->
                        if (status == "pending_approval") {
                            LogManager.append(this, "Registration pending admin approval for $telco")
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        showLastLog()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_CALL_PHONE) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            LogManager.append(
                this,
                if (granted) "CALL_PHONE permission granted" else "CALL_PHONE permission denied — remote top-ups will fail until granted"
            )
        }
    }

    private fun showLastLog() {
        val logs = LogManager.getAll(this)
        val lastLine = logs.split("\n").lastOrNull { it.isNotBlank() }
        binding.txtLastLog.text = lastLine ?: "No activity yet."
    }
}
