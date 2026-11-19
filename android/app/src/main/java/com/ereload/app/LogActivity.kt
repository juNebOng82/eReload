package com.ereload.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import java.io.File

class LogActivity : AppCompatActivity() {

    private lateinit var txtLogs: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_log)

        txtLogs = findViewById(R.id.txtLogs)
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { loadLogs() }
        findViewById<Button>(R.id.btnClear).setOnClickListener {
            LogManager.clear(this)
            loadLogs()
        }
        findViewById<Button>(R.id.btnShare).setOnClickListener { shareLogsToWhatsApp() }

        loadLogs()
    }

    override fun onResume() {
        super.onResume()
        loadLogs()
    }

    /**
     * Writes the current log to a .txt file and shares it directly to WhatsApp
     * as an attachment (avoids WhatsApp's inline text length limits). Falls
     * back to the general share sheet if WhatsApp isn't installed.
     */
    private fun shareLogsToWhatsApp() {
        val logs = LogManager.getAll(this)
        if (logs.isBlank()) {
            Toast.makeText(this, "No logs to share yet", Toast.LENGTH_SHORT).show()
            return
        }

        val logsDir = File(cacheDir, "logs").apply { mkdirs() }
        val logFile = File(logsDir, "ussd_logs.txt")
        logFile.writeText(logs)

        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", logFile)

        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            setPackage("com.whatsapp")
        }

        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "WhatsApp not installed, showing other share options", Toast.LENGTH_SHORT).show()
            val fallback = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(fallback, "Share logs via"))
        }
    }

    private fun loadLogs() {
        val logs = LogManager.getAll(this)
        // Show most recent entries at the top for easier reading.
        txtLogs.text = if (logs.isBlank()) {
            "No logs yet."
        } else {
            logs.split("\n").reversed().joinToString("\n")
        }
    }
}
