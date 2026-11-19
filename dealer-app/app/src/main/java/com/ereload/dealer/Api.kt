package com.ereload.dealer

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Thrown for any failed call; [sessionExpired] means the user must log in again. */
class ApiException(message: String, val httpCode: Int = 0) : Exception(message) {
    val sessionExpired get() = httpCode == 401
}

data class TelcoOption(val code: String, val marginPercent: Double)

data class ReloadOptions(
    val companyName: String,
    val balance: Double,
    val minAmount: Double,
    val maxAmount: Double,
    val telcos: List<TelcoOption>,
)

data class Job(
    val id: String,
    val phone: String,
    val amount: Double,
    val billedAmount: Double?,
    val telco: String,
    val serviceType: String,
    val status: String,
    val rawResponse: String?,
    val createdAt: String?,
) {
    val isFinal get() = status in setOf("success", "failed", "timeout", "rejected")
}

data class LedgerEntry(
    val type: String,
    val amount: Double,
    val balanceAfter: Double,
    val createdAt: String?,
    val documentNumber: String?,
    val remarks: String?,
    val phone: String?,
    val telco: String?,
)

data class Statement(val balanceBf: Double, val balanceCf: Double, val currentBalance: Double, val entries: List<LedgerEntry>)

/**
 * Sub-dealer API client. Uses the same company login as the web portal
 * (/api/portal/...), authenticated with the session token from [Session].
 *
 * IMPORTANT: set BASE_URL to the deployed server (same one the gateway app uses).
 */
object Api {

    const val BASE_URL = "https://ussd-topup-server-596609955900.asia-southeast1.run.app"

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val JSON = "application/json".toMediaType()

    private suspend fun call(path: String, token: String?, body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url("$BASE_URL$path")
            if (token != null) builder.addHeader("Authorization", "Bearer $token")
            if (body != null) builder.post(body.toString().toRequestBody(JSON))
            try {
                client.newCall(builder.build()).execute().use { resp ->
                    val text = resp.body?.string().orEmpty()
                    val json = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
                    if (!resp.isSuccessful) {
                        val msg = json.optString("error").ifEmpty { "Server error (${resp.code})" }
                        throw ApiException(msg, resp.code)
                    }
                    json
                }
            } catch (e: IOException) {
                throw ApiException("No connection to server. Check your internet and try again.")
            }
        }

    /** Returns token and company name. */
    suspend fun login(username: String, password: String): Pair<String, String> {
        val json = call("/api/portal/login", null, JSONObject().put("username", username).put("password", password))
        val name = json.optString("company_name").ifEmpty { json.optString("username") }
        return json.getString("token") to name
    }

    suspend fun reloadOptions(token: String): ReloadOptions {
        val j = call("/api/portal/reload-options", token)
        val arr = j.optJSONArray("telcos") ?: JSONArray()
        val telcos = (0 until arr.length()).map {
            val t = arr.getJSONObject(it)
            TelcoOption(t.getString("code"), t.optDouble("margin_percent", 0.0))
        }
        return ReloadOptions(
            companyName = j.optString("company_name"),
            balance = j.optDouble("credit_balance", 0.0),
            minAmount = j.optDouble("min_amount", 1.0),
            maxAmount = j.optDouble("max_amount", 1000.0),
            telcos = telcos,
        )
    }

    /** Returns the new job id. [idempotencyKey] makes a retried submit safe (no double reload). */
    suspend fun topup(token: String, telco: String, phone: String, amount: Double, idempotencyKey: String): String {
        val body = JSONObject()
            .put("telco", telco)
            .put("phone", phone)
            .put("amount", amount)
            .put("idempotency_key", idempotencyKey)
        return call("/api/portal/topup", token, body).getString("job_id")
    }

    suspend fun job(token: String, jobId: String): Job = parseJob(call("/api/portal/jobs/$jobId", token))

    suspend fun jobs(token: String, status: String?): List<Job> {
        val q = if (status != null) "?status=$status" else ""
        val arr = call("/api/portal/jobs$q", token).optJSONArray("jobs") ?: JSONArray()
        return (0 until arr.length()).map { parseJob(arr.getJSONObject(it)) }
    }

    suspend fun statement(token: String, from: String?, to: String?): Statement {
        val params = listOfNotNull(from?.let { "from=$it" }, to?.let { "to=$it" }).joinToString("&")
        val j = call("/api/portal/ledger" + if (params.isEmpty()) "" else "?$params", token)
        val arr = j.optJSONArray("entries") ?: JSONArray()
        val entries = (0 until arr.length()).map {
            val e = arr.getJSONObject(it)
            LedgerEntry(
                type = e.optString("type"),
                amount = e.optDouble("amount", 0.0),
                balanceAfter = e.optDouble("balance_after", 0.0),
                createdAt = e.optStringOrNull("created_at"),
                documentNumber = e.optStringOrNull("document_number"),
                remarks = e.optStringOrNull("remarks"),
                phone = e.optStringOrNull("phone"),
                telco = e.optStringOrNull("telco"),
            )
        }
        return Statement(
            balanceBf = j.optDouble("balance_bf", 0.0),
            balanceCf = j.optDouble("balance_cf", 0.0),
            currentBalance = j.optDouble("current_balance", 0.0),
            entries = entries,
        )
    }

    private fun parseJob(j: JSONObject) = Job(
        id = j.getString("job_id"),
        phone = j.optString("phone"),
        amount = j.optDouble("amount", 0.0),
        billedAmount = if (j.isNull("billed_amount")) null else j.optDouble("billed_amount"),
        telco = j.optString("telco"),
        serviceType = j.optString("service_type", "Reload"),
        status = j.optString("status"),
        rawResponse = j.optStringOrNull("raw_response"),
        createdAt = j.optStringOrNull("created_at"),
    )

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key)
}
