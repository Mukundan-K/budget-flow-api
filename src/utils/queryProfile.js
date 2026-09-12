/**
 * Opt-in SQL profiler for local dashboard measurement.
 * Does not log bind values (amounts, dates, user data).
 *
 * Usage:
 *   const stop = installQueryProfile(db);
 *   ...
 *   const snapshot = getQueryProfile();
 *   stop();
 */
function classifyQuery(sql) {
  const text = String(sql || "").replace(/\s+/g, " ").trim();

  if (/AS earliest/i.test(text) || /AS latest/i.test(text)) {
    return "activity_range";
  }
  if (/FROM monthly_financial_summary/i.test(text)) {
    return "monthly_financial_summary";
  }
  if (/FROM monthly_balances/i.test(text)) {
    return "monthly_balances";
  }
  if (/LOWER\(\s*TRIM\(\s*pt\.name\s*\)\s*\)\s*=\s*'emi'/i.test(text)) {
    return "emi_stats";
  }
  if (/LOWER\(\s*pt\.name\s*\)\s*=\s*'salary'/i.test(text)) {
    return "latest_salary";
  }
  if (/FROM emi_products/i.test(text)) {
    return "emi_products";
  }
  // Spending-breakdown grouping embeds the paid-months join subquery
  // (COUNT DISTINCT DATE_TRUNC ... FROM payments). Classify it before
  // emi_paid_months so the dashboard chart query is not miscounted.
  if (
    /pt\.flow = 'outgoing'/i.test(text) &&
    /GROUP BY/i.test(text) &&
    /payment_type/i.test(text)
  ) {
    return "outgoing_payment_groups";
  }
  if (
    /COUNT\(DISTINCT DATE_TRUNC\('month'/i.test(text) &&
    /FROM payments/i.test(text)
  ) {
    return "emi_paid_months";
  }
  if (
    /emi_product_id IS NOT NULL/i.test(text) &&
    /AS paid_amount/i.test(text)
  ) {
    return "emi_period_payments";
  }
  if (
    /FROM debts/i.test(text) &&
    /EXTRACT\(MONTH FROM \(debt_date/i.test(text)
  ) {
    return "monthly_debt_trend";
  }
  // Strict `< $n` — do not match `debt_date <=` from month-range activity.
  if (/FROM debts/i.test(text) && /debt_date < \$/i.test(text)) {
    return "monthly_debt_trend_opening";
  }
  if (/\bAS section\b/i.test(text) && /'polar'/i.test(text)) {
    return "expense_charts";
  }
  if (/GROUP BY t\.category/i.test(text)) {
    return "category_polar";
  }
  if (/AS necessary/i.test(text) && /AS unnecessary/i.test(text)) {
    if (/GROUP BY t\.month/i.test(text)) return "expense_type_nets_year";
    return "expense_type_nets";
  }
  if (/pt\.flow = 'incoming'/i.test(text) && /pt\.is_income/i.test(text)) {
    return "source_incoming_facts";
  }
  if (/pt\.flow = 'outgoing'/i.test(text) && /FROM payments p/i.test(text)) {
    return "source_outgoing_facts";
  }
  if (
    /FROM expenses e/i.test(text) &&
    /COALESCE\(SUM\(e\.amount/i.test(text)
  ) {
    return "source_expense_facts";
  }
  if (/FROM savings_transactions/i.test(text)) {
    return "source_savings_facts";
  }
  if (/FROM debts/i.test(text) && /given_total/i.test(text)) {
    return "debt_originated";
  }
  return "other";
}

function sqlPreview(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function extractText(args) {
  if (!args.length) return "";
  if (typeof args[0] === "string") return args[0];
  if (args[0] && typeof args[0] === "object") {
    return args[0].text || args[0].query || "";
  }
  return "";
}

let active = null;

function installQueryProfile(pool) {
  if (active) {
    throw new Error("query profile already installed");
  }

  const originalQuery = pool.query.bind(pool);
  const events = [];

  pool.query = (...args) => {
    const started = process.hrtime.bigint();
    const sql = extractText(args);
    const name = classifyQuery(sql);
    const result = originalQuery(...args);

    const record = (ok, rowCount, err) => {
      const ended = process.hrtime.bigint();
      events.push({
        name,
        durationMs: Number(ended - started) / 1e6,
        rowCount: rowCount == null ? null : Number(rowCount),
        preview: sqlPreview(sql),
        ok,
        error: err ? String(err.message || err) : null,
        sql,
        values: args[1] || (args[0] && args[0].values) || null,
      });
    };

    if (result && typeof result.then === "function") {
      return result.then(
        (res) => {
          record(
            true,
            res && (res.rowCount != null ? res.rowCount : res.rows && res.rows.length),
            null
          );
          return res;
        },
        (err) => {
          record(false, null, err);
          throw err;
        }
      );
    }

    record(true, null, null);
    return result;
  };

  active = { pool, originalQuery, events };

  return function stop() {
    if (!active) return;
    pool.query = originalQuery;
    active = null;
  };
}

function resetQueryProfile() {
  if (active) active.events.length = 0;
}

function getQueryProfile() {
  const events = active ? [...active.events] : [];
  const byName = {};
  events.forEach((event) => {
    if (!byName[event.name]) {
      byName[event.name] = { name: event.name, count: 0, durationMs: 0 };
    }
    byName[event.name].count += 1;
    byName[event.name].durationMs += event.durationMs;
  });

  const totalSqlMs = events.reduce((sum, event) => sum + event.durationMs, 0);
  const slowest = [...events]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 8)
    .map((event) => ({
      name: event.name,
      durationMs: Number(event.durationMs.toFixed(2)),
      rowCount: event.rowCount,
      preview: event.preview,
    }));

  return {
    queryCount: events.length,
    totalSqlMs,
    byName: Object.values(byName).sort((a, b) => b.durationMs - a.durationMs),
    slowest,
    events,
    sourceFactQueries: events.filter((event) =>
      event.name.startsWith("source_")
    ).length,
  };
}

module.exports = {
  classifyQuery,
  installQueryProfile,
  resetQueryProfile,
  getQueryProfile,
};
