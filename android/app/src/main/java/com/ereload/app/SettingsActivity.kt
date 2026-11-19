package com.ereload.app

import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.messaging.FirebaseMessaging

class SettingsActivity : AppCompatActivity() {

    // Small built-in fallback in case the server can't be reached the very
    // first time this screen opens (e.g. no network yet). Replaced with the
    // real, current list from the server as soon as that call succeeds —
    // this is not a hardcoded telco list going forward, just a safety net.
    private val fallbackTelcos = listOf("UMOBILE", "MAXIS", "DIGI", "CELCOM")

    private lateinit var spinnerTelco: Spinner
    private var telcoList: List<String> = fallbackTelcos

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        val edtPin = findViewById<EditText>(R.id.edtPin)
        val btnSavePin = findViewById<Button>(R.id.btnSavePin)
        val txtSaveConfirm = findViewById<TextView>(R.id.txtSaveConfirm)
        spinnerTelco = findViewById(R.id.spinnerTelco)

        // Pre-fill with the currently saved PIN, if any, so it's easy to update.
        PrefsManager.getPin(this)?.let { edtPin.setText(it) }

        // Show the fallback list immediately so the screen isn't empty while
        // waiting on the network, then swap in the real server list (which
        // may include telcos added after this app was built) once it arrives.
        populateSpinner(fallbackTelcos)
        ApiClient.fetchTelcos { serverList ->
            if (serverList != null && serverList.isNotEmpty()) {
                runOnUiThread { populateSpinner(serverList) }
            }
        }

        btnSavePin.setOnClickListener {
            val pin = edtPin.text.toString().trim()
            if (pin.isEmpty()) {
                Toast.makeText(this, "Please enter a PIN", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val selectedTelco = spinnerTelco.selectedItem as? String
            if (selectedTelco.isNullOrEmpty()) {
                Toast.makeText(this, "Please select a telco", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            PrefsManager.savePin(this, pin)
            PrefsManager.saveTelco(this, selectedTelco)
            LogManager.append(this, "Settings updated: telco=$selectedTelco, PIN changed")

            // Re-register this device's FCM token under the (possibly new) telco
            // so the server routes future jobs for that telco to this phone.
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    task.result?.let { token ->
                        val installationId = PrefsManager.getOrCreateInstallationId(this)
                        ApiClient.registerDevice(this, installationId, token, selectedTelco) { status ->
                            if (status == "pending_approval") {
                                LogManager.append(this, "Registration pending admin approval for $selectedTelco")
                                runOnUiThread {
                                    txtSaveConfirm.text = "Saved. Waiting for admin approval for $selectedTelco."
                                }
                            }
                        }
                    }
                }
            }

            txtSaveConfirm.text = "Saved: $selectedTelco, PIN updated."
            txtSaveConfirm.visibility = View.VISIBLE
        }
    }

    private fun populateSpinner(list: List<String>) {
        telcoList = list
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, list)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinnerTelco.adapter = adapter

        // Preserve the currently-saved selection if it's present in the
        // (possibly newly-fetched) list.
        val currentTelco = PrefsManager.getTelco(this)
        val index = list.indexOf(currentTelco)
        if (index >= 0) spinnerTelco.setSelection(index)
    }
}
