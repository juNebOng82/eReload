package com.ereload.dealer

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.ereload.dealer.databinding.ActivityJobsBinding
import com.ereload.dealer.databinding.ItemRowBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/** Every reload this sub-dealer has sent, with its status — including failed ones. */
class JobsActivity : AppCompatActivity() {

    private lateinit var binding: ActivityJobsBinding
    private val adapter = JobAdapter { showDetail(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityJobsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.list.layoutManager = LinearLayoutManager(this)
        binding.list.adapter = adapter
        binding.swipe.setOnRefreshListener { load() }
        binding.chipsFilter.setOnCheckedStateChangeListener { _, _ -> load() }
        load()
    }

    private fun currentFilter(): String? = when (binding.chipsFilter.checkedChipId) {
        R.id.chipSuccess -> "success"
        R.id.chipFailed -> "failed"
        R.id.chipProcessing -> "pending"
        else -> null
    }

    private fun load() {
        val token = Session.requireToken(this) ?: return
        binding.swipe.isRefreshing = true
        lifecycleScope.launch {
            try {
                val jobs = Api.jobs(token, currentFilter())
                adapter.submit(jobs)
                binding.txtEmpty.visibility = if (jobs.isEmpty()) View.VISIBLE else View.GONE
            } catch (e: Exception) {
                handleError(e)
            } finally {
                binding.swipe.isRefreshing = false
            }
        }
    }

    private fun showDetail(job: Job) {
        val lines = mutableListOf(
            "Status: ${statusLabel(job.status)}",
            "Telco: ${job.telco}",
            "Phone: ${job.phone}",
            "Amount: ${rm(job.amount)}",
        )
        if (job.status == "success" && job.billedAmount != null) lines += "Deducted: ${rm(job.billedAmount)}"
        lines += "Time: ${displayTime(job.createdAt)}"
        lines += "Reference: ${job.id}"
        if (!job.rawResponse.isNullOrEmpty()) lines += "\nTelco reply:\n${job.rawResponse}"
        MaterialAlertDialogBuilder(this)
            .setTitle(job.serviceType)
            .setMessage(lines.joinToString("\n"))
            .setPositiveButton("Close", null)
            .show()
    }
}

class JobAdapter(private val onClick: (Job) -> Unit) : RecyclerView.Adapter<JobAdapter.VH>() {
    private var items: List<Job> = emptyList()

    fun submit(list: List<Job>) {
        items = list
        notifyDataSetChanged()
    }

    class VH(val b: ItemRowBinding) : RecyclerView.ViewHolder(b.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(ItemRowBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val job = items[position]
        holder.b.txtTitle.text = "${job.phone} · ${job.telco}"
        holder.b.txtSubtitle.text = displayTime(job.createdAt)
        holder.b.txtAmount.text = rm(job.amount)
        holder.b.txtTag.text = statusLabel(job.status)
        holder.b.txtTag.setTextColor(statusColor(job.status))
        holder.b.root.setOnClickListener { onClick(job) }
    }
}
