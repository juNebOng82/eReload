package com.ereload.dealer

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.ereload.dealer.databinding.ActivityMainBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/** Home: company name, current balance and the main actions. */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.txtCompany.text = Session.companyName(this)
        binding.btnReload.setOnClickListener { startActivity(Intent(this, ReloadActivity::class.java)) }
        binding.btnHistory.setOnClickListener { startActivity(Intent(this, JobsActivity::class.java)) }
        binding.btnStatement.setOnClickListener { startActivity(Intent(this, StatementActivity::class.java)) }
        binding.swipe.setOnRefreshListener { refresh() }
        binding.btnLogout.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setMessage("Log out of eReload Dealer?")
                .setPositiveButton("Log out") { _, _ -> Session.logout(this, null) }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val token = Session.requireToken(this) ?: return
        binding.swipe.isRefreshing = true
        lifecycleScope.launch {
            try {
                val opts = Api.reloadOptions(token)
                binding.txtCompany.text = opts.companyName
                binding.txtBalance.text = rm(opts.balance)
            } catch (e: Exception) {
                handleError(e)
            } finally {
                binding.swipe.isRefreshing = false
            }
        }
    }
}
