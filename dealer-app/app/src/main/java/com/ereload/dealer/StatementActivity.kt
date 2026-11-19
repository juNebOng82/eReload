package com.ereload.dealer

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.ereload.dealer.databinding.ActivityStatementBinding
import com.ereload.dealer.databinding.ItemRowBinding
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/** Credit in and out — the same statement as the portal's Credit Usage tab. */
class StatementActivity : AppCompatActivity() {

    private lateinit var binding: ActivityStatementBinding
    private val adapter = LedgerAdapter()
    private val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityStatementBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.list.layoutManager = LinearLayoutManager(this)
        binding.list.adapter = adapter
        binding.swipe.setOnRefreshListener { load() }
        binding.chipsRange.setOnCheckedStateChangeListener { _, _ -> load() }
        load()
    }

    private fun daysBack(): Int = when (binding.chipsRange.checkedChipId) {
        R.id.chipToday -> 0
        R.id.chip30 -> 29
        else -> 6
    }

    private fun load() {
        val token = Session.requireToken(this) ?: return
        val cal = Calendar.getInstance()
        val to = day.format(cal.time)
        cal.add(Calendar.DAY_OF_YEAR, -daysBack())
        val from = day.format(cal.time)
        binding.swipe.isRefreshing = true
        lifecycleScope.launch {
            try {
                val s = Api.statement(token, from, to)
                binding.txtBf.text = rm(s.balanceBf)
                binding.txtCf.text = rm(s.balanceCf)
                binding.txtBalance.text = rm(s.currentBalance)
                adapter.submit(s.entries)
                binding.txtEmpty.visibility = if (s.entries.isEmpty()) View.VISIBLE else View.GONE
            } catch (e: Exception) {
                handleError(e)
            } finally {
                binding.swipe.isRefreshing = false
            }
        }
    }
}

class LedgerAdapter : RecyclerView.Adapter<LedgerAdapter.VH>() {
    private var items: List<LedgerEntry> = emptyList()

    fun submit(list: List<LedgerEntry>) {
        items = list
        notifyDataSetChanged()
    }

    class VH(val b: ItemRowBinding) : RecyclerView.ViewHolder(b.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(ItemRowBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val e = items[position]
        // Usage is stored as a positive amount; adjustments are signed.
        val signed = if (e.type == "usage") -e.amount else e.amount
        val title = when (e.type) {
            "usage" -> "Reload ${e.phone ?: ""}${e.telco?.let { " · $it" } ?: ""}"
            "reload" -> "Credit top up${e.documentNumber?.let { " · $it" } ?: ""}"
            "adjustment" -> "Adjustment${e.documentNumber?.let { " · $it" } ?: ""}"
            else -> e.type
        }
        holder.b.txtTitle.text = title
        holder.b.txtSubtitle.text = listOfNotNull(displayTime(e.createdAt), e.remarks).joinToString(" · ")
        holder.b.txtAmount.text = (if (signed >= 0) "+" else "−") + rm(Math.abs(signed))
        holder.b.txtAmount.setTextColor(if (signed >= 0) Color.parseColor("#2E7D32") else Color.parseColor("#C62828"))
        holder.b.txtTag.text = "Bal " + rm(e.balanceAfter)
        holder.b.txtTag.setTextColor(Color.GRAY)
    }
}
