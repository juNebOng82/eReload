package com.ereload.dealer

import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import com.ereload.dealer.databinding.ActivityReloadBinding
import com.google.android.material.chip.Chip
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Reload a customer's phone: pick telco, enter phone + amount, confirm
 * (shows the amount deducted after margin), then follow the status until
 * the gateway phone reports success or failure.
 */
class ReloadActivity : AppCompatActivity() {

    private lateinit var binding: ActivityReloadBinding
    private var options: ReloadOptions? = null
    private var pollJob: CoroutineJob? = null

    // Reused if the same reload is re-submitted after a network error, so the
    // server returns the original job instead of reloading the customer twice.
    private var pendingKey: String? = null
    private var pendingSignature: String? = null

    private val quickAmounts = listOf(5, 10, 20, 30, 50, 100)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityReloadBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.toolbar.setNavigationOnClickListener { finish() }

        for (amt in quickAmounts) {
            val chip = Chip(this).apply {
                text = "RM $amt"
                setOnClickListener { binding.inputAmount.setText(amt.toString()) }
            }
            binding.chipsAmount.addView(chip)
        }

        binding.inputAmount.doAfterTextChanged { updateDeduction() }
        binding.chipsTelco.setOnCheckedStateChangeListener { _, _ -> updateDeduction() }
        binding.btnSubmit.setOnClickListener { confirm() }
        binding.btnNew.setOnClickListener { showForm(clear = true) }
        binding.btnDone.setOnClickListener { finish() }

        loadOptions()
    }

    override fun onDestroy() {
        pollJob?.cancel()
        super.onDestroy()
    }

    private fun loadOptions() {
        val token = Session.requireToken(this) ?: return
        binding.progressForm.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val opts = Api.reloadOptions(token)
                options = opts
                binding.txtBalance.text = "Balance: " + rm(opts.balance)
                binding.layoutAmount.helperText = "Between ${rm(opts.minAmount)} and ${rm(opts.maxAmount)}"
                binding.chipsTelco.removeAllViews()
                opts.telcos.forEachIndexed { i, t ->
                    val chip = Chip(this@ReloadActivity).apply {
                        id = View.generateViewId()
                        text = t.code
                        tag = t
                        isCheckable = true
                        isChecked = opts.telcos.size == 1 && i == 0
                    }
                    binding.chipsTelco.addView(chip)
                }
                binding.txtNoTelco.visibility = if (opts.telcos.isEmpty()) View.VISIBLE else View.GONE
                binding.btnSubmit.isEnabled = opts.telcos.isNotEmpty()
                updateDeduction()
            } catch (e: Exception) {
                handleError(e)
            } finally {
                binding.progressForm.visibility = View.GONE
            }
        }
    }

    private fun selectedTelco(): TelcoOption? {
        val id = binding.chipsTelco.checkedChipId
        if (id == View.NO_ID) return null
        return findViewById<Chip>(id)?.tag as? TelcoOption
    }

    private fun updateDeduction() {
        val telco = selectedTelco()
        val amount = binding.inputAmount.text.toString().toDoubleOrNull()
        binding.txtDeduct.text = if (telco != null && amount != null && amount > 0) {
            "Deducted from your credit: ${rm(billedFor(amount, telco.marginPercent))}"
        } else ""
    }

    private fun confirm() {
        val opts = options ?: return
        val telco = selectedTelco()
        val phone = binding.inputPhone.text.toString().replace(" ", "").replace("-", "")
        val amount = binding.inputAmount.text.toString().toDoubleOrNull()

        binding.layoutPhone.error = null
        binding.layoutAmount.error = null
        if (telco == null) {
            binding.txtDeduct.text = "Choose a telco"
            return
        }
        if (!Regex("^\\+?\\d{8,15}$").matches(phone)) {
            binding.layoutPhone.error = "Enter a valid phone number"
            return
        }
        if (amount == null || amount < opts.minAmount || amount > opts.maxAmount) {
            binding.layoutAmount.error = "Amount must be between ${rm(opts.minAmount)} and ${rm(opts.maxAmount)}"
            return
        }
        val billed = billedFor(amount, telco.marginPercent)

        MaterialAlertDialogBuilder(this)
            .setTitle("Confirm reload")
            .setMessage(
                "Telco: ${telco.code}\n" +
                "Customer phone: $phone\n" +
                "Reload amount: ${rm(amount)}\n\n" +
                "Deducted from your credit: ${rm(billed)}"
            )
            .setPositiveButton("Reload now") { _, _ -> submit(telco.code, phone, amount) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun submit(telco: String, phone: String, amount: Double) {
        val token = Session.requireToken(this) ?: return
        val signature = "$telco|$phone|$amount"
        if (pendingSignature != signature || pendingKey == null) {
            pendingKey = UUID.randomUUID().toString()
            pendingSignature = signature
        }
        val key = pendingKey!!

        binding.btnSubmit.isEnabled = false
        binding.progressForm.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                val jobId = Api.topup(token, telco, phone, amount, key)
                pendingKey = null
                pendingSignature = null
                showResult(telco, phone, amount)
                followJob(token, jobId)
            } catch (e: Exception) {
                // A server answer (e.g. insufficient credit) is final — the next
                // attempt is a new reload. Only a lost connection keeps the key.
                if (e is ApiException && e.httpCode != 0) {
                    pendingKey = null
                    pendingSignature = null
                }
                if (e is ApiException && e.sessionExpired) handleError(e)
                else MaterialAlertDialogBuilder(this@ReloadActivity)
                    .setTitle("Reload not sent")
                    .setMessage(e.message)
                    .setPositiveButton("OK", null)
                    .show()
            } finally {
                binding.btnSubmit.isEnabled = true
                binding.progressForm.visibility = View.GONE
            }
        }
    }

    private fun showResult(telco: String, phone: String, amount: Double) {
        binding.form.visibility = View.GONE
        binding.result.visibility = View.VISIBLE
        binding.txtResultSummary.text = "$telco · $phone · ${rm(amount)}"
        setStatus("pending", null, null)
    }

    private fun setStatus(status: String, response: String?, billed: Double?) {
        val processing = status == "queued" || status == "pending"
        binding.progressResult.visibility = if (processing) View.VISIBLE else View.GONE
        binding.txtStatus.text = statusLabel(status)
        binding.txtStatus.setTextColor(statusColor(status))
        binding.txtResponse.text = when {
            processing -> "Sending to the telco… this usually takes under a minute."
            status == "success" && billed != null -> "Deducted ${rm(billed)} from your credit." + (response?.let { "\n\n$it" } ?: "")
            status == "success" -> response ?: ""
            else -> "No credit was deducted." + (response?.let { "\n\n$it" } ?: "")
        }
        binding.btnNew.isEnabled = !processing
    }

    private fun followJob(token: String, jobId: String) {
        pollJob?.cancel()
        pollJob = lifecycleScope.launch {
            val started = System.currentTimeMillis()
            while (true) {
                try {
                    val job = Api.job(token, jobId)
                    setStatus(job.status, job.rawResponse, job.billedAmount)
                    if (job.isFinal) return@launch
                } catch (e: Exception) {
                    if (e is ApiException && e.sessionExpired) { handleError(e); return@launch }
                }
                if (System.currentTimeMillis() - started > 3 * 60 * 1000) {
                    binding.progressResult.visibility = View.GONE
                    binding.txtResponse.text = "Still processing. Check My Reloads for the final result."
                    binding.btnNew.isEnabled = true
                    return@launch
                }
                delay(2000)
            }
        }
    }

    private fun showForm(clear: Boolean) {
        pollJob?.cancel()
        binding.result.visibility = View.GONE
        binding.form.visibility = View.VISIBLE
        if (clear) {
            binding.inputPhone.setText("")
            binding.inputAmount.setText("")
            binding.inputPhone.requestFocus()
        }
        loadOptions()
    }
}
