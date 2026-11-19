package com.ereload.dealer

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.ereload.dealer.databinding.ActivityLoginBinding
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_MESSAGE = "message"
    }

    private lateinit var binding: ActivityLoginBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Session.token(this) != null) {
            openHome()
            return
        }
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.inputUsername.setText(Session.lastUsername(this))
        intent.getStringExtra(EXTRA_MESSAGE)?.let { showError(it) }
        try {
            binding.txtVersion.text = "v" + packageManager.getPackageInfo(packageName, 0).versionName
        } catch (_: Exception) { }

        binding.btnLogin.setOnClickListener { login() }
    }

    private fun login() {
        val username = binding.inputUsername.text.toString().trim()
        val password = binding.inputPassword.text.toString()
        if (username.isEmpty() || password.isEmpty()) {
            showError("Enter your username and password")
            return
        }
        binding.btnLogin.isEnabled = false
        binding.progress.visibility = View.VISIBLE
        binding.txtError.visibility = View.GONE
        lifecycleScope.launch {
            try {
                val (token, company) = Api.login(username, password)
                Session.save(this@LoginActivity, token, company, username)
                openHome()
            } catch (e: Exception) {
                showError(e.message ?: "Login failed")
            } finally {
                binding.btnLogin.isEnabled = true
                binding.progress.visibility = View.GONE
            }
        }
    }

    private fun showError(msg: String) {
        binding.txtError.text = msg
        binding.txtError.visibility = View.VISIBLE
    }

    private fun openHome() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
