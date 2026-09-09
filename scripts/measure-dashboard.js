/**
 * Local dashboard performance baseline. Does not change formulas or SQL.
 *
 *   npm run measure:dashboard -- --user_id=2 --year=2026 --month=8
 *   npm run measure:dashboard -- --users=2,4 --year=2026 --month=8 --runs=6 --explain
 */
require("dotenv").config();
const db = require("../src/db");
const {
  installQueryProfile,
  resetQueryProfile,
  getQueryProfile,
} = require("../src/utils/queryProfile");
const {
  buildDashboard,
  buildMonthOverview,
  buildMonthOverviewFromSource,
  buildMonthOverviewFromSummary,
} = require("../src/routes/overview.routes");

function argValue(name) {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.slice(name.length + 3);
}

function roundMs(value) {
  return Number(Number(value).toFixed(2));
}

function pct(part, whole) {
  if (!whole) return "0%";
  return `${roundMs((part / whole) * 100)}%`;
}

function printTable(rows, columns) {
  const widths = columns.map((col) =>
    Math.max(
      col.label.length,
      ...rows.map((row) => String(row[col.key] ?? "").length)
    )
  );
  const line = (cells) =>
    `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(" | ")} |`;
  console.log(line(columns.map((col) => col.label)));
  console.log(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
  rows.forEach((row) => {
    console.log(line(columns.map((col) => row[col.key] ?? "")));
  });
}

async function measureOnce(label, work) {
  resetQueryProfile();
  const started = process.hrtime.bigint();
  const result = await work();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const profile = getQueryProfile();
  return {
    label,
    elapsedMs,
    result,
    profile,
  };
}

function summarizeRun(run) {
  return {
    label: run.label,
    requestMs: roundMs(run.elapsedMs),
    sqlMs: roundMs(run.profile.totalSqlMs),
    queries: run.profile.queryCount,
    sourceFactQueries: run.profile.sourceFactQueries,
  };
}

function average(runs) {
  if (!runs.length) return null;
  const n = runs.length;
  return {
    requestMs: roundMs(runs.reduce((sum, run) => sum + run.elapsedMs, 0) / n),
    sqlMs: roundMs(
      runs.reduce((sum, run) => sum + run.profile.totalSqlMs, 0) / n
    ),
    queries: roundMs(
      runs.reduce((sum, run) => sum + run.profile.queryCount, 0) / n
    ),
  };
}

function aggregateComponents(warmRuns) {
  const byName = {};
  const avgTotalSql =
    warmRuns.reduce((sum, run) => sum + run.profile.totalSqlMs, 0) /
    warmRuns.length;

  warmRuns.forEach((run) => {
    run.profile.events.forEach((event) => {
      if (!byName[event.name]) {
        byName[event.name] = {
          name: event.name,
          durations: [],
          rowCounts: [],
        };
      }
      byName[event.name].durations.push(event.durationMs);
      if (event.rowCount != null) {
        byName[event.name].rowCounts.push(event.rowCount);
      }
    });
  });

  return Object.values(byName)
    .map((item) => {
      const execCount = item.durations.length;
      const execPerReq = execCount / warmRuns.length;
      const totalPerReq =
        item.durations.reduce((sum, value) => sum + value, 0) / warmRuns.length;
      const avgExec =
        item.durations.reduce((sum, value) => sum + value, 0) / execCount;
      const slowest = Math.max(...item.durations);
      const avgRows = item.rowCounts.length
        ? item.rowCounts.reduce((sum, value) => sum + value, 0) /
          item.rowCounts.length
        : null;
      return {
        name: item.name,
        exec_per_req: roundMs(execPerReq),
        total_sql_ms: roundMs(totalPerReq),
        avg_exec_ms: roundMs(avgExec),
        slowest_ms: roundMs(slowest),
        rows: avgRows == null ? "" : roundMs(avgRows),
        pct: pct(totalPerReq, avgTotalSql),
      };
    })
    .sort((a, b) => b.total_sql_ms - a.total_sql_ms);
}

function pickSlowestExplainTargets(allRuns) {
  const candidates = [];
  ["dashboard-month", "dashboard-year", "overview-month"].forEach((label) => {
    const series = allRuns[label] || [];
    const warm = series.slice(1);
    const sample = (warm.length ? warm : series).slice(-1)[0];
    if (!sample) return;
    sample.profile.events.forEach((event) => {
      candidates.push({
        scenario: label,
        name: event.name,
        durationMs: event.durationMs,
        rowCount: event.rowCount,
        sql: event.sql,
        values: event.values,
        preview: event.preview,
      });
    });
  });

  candidates.sort((a, b) => b.durationMs - a.durationMs);
  const picked = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = `${item.scenario}:${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
    if (picked.length >= 3) break;
  }
  return picked;
}

async function loadUserHistory() {
  const summary = await db.query(
    `SELECT user_id,
            MIN(year) AS min_year,
            MAX(year) AS max_year,
            COUNT(*)::int AS months
     FROM monthly_financial_summary
     GROUP BY user_id
     ORDER BY user_id`
  );
  return { summary: summary.rows };
}

async function loadUserVolume(userId) {
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM expenses WHERE user_id = $1) AS expenses,
       (SELECT COUNT(*)::int
          FROM expense_category_splits s
          JOIN expenses e ON e.id = s.expense_id
         WHERE e.user_id = $1) AS splits,
       (SELECT COUNT(*)::int
          FROM expense_returns r
          JOIN expenses e ON e.id = r.expense_id
         WHERE e.user_id = $1) AS expense_returns,
       (SELECT COUNT(*)::int FROM payments WHERE user_id = $1) AS payments,
       (SELECT COUNT(*)::int FROM debts WHERE user_id = $1) AS debts,
       (SELECT COUNT(*)::int FROM monthly_financial_summary WHERE user_id = $1) AS summary_months,
       (SELECT COUNT(*)::int FROM monthly_balances WHERE user_id = $1) AS balance_overrides`,
    [userId]
  );
  return result.rows[0];
}

async function explainIfPresent(sql, values, title) {
  if (!sql) return;
  console.log(`\nEXPLAIN ANALYZE — ${title}`);
  console.log(`SQL preview: ${String(sql).replace(/\s+/g, " ").trim().slice(0, 180)}`);
  const result = await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, values);
  result.rows.forEach((row) => console.log(row["QUERY PLAN"]));
}

function compareDashboardToSource(dashboard, source) {
  const fields = [
    ["earned", dashboard.earned, source.earned],
    ["not_earned", dashboard.not_earned, source.not_earned],
    ["incoming", dashboard.income, source.incoming],
    ["previous", dashboard.previous_balance, source.previous_month_balance],
    ["available", dashboard.available, source.available],
    ["spent", dashboard.spent, source.spent],
    ["remaining", dashboard.balance, source.remaining],
    ["savings", dashboard.from_savings, source.from_savings],
    ["debt", dashboard.debt, source.debt],
  ];
  return fields.map(([field, dash, src]) => ({
    field,
    match: Number(dash) === Number(src),
  }));
}

function printTiming(label, series) {
  const cold = summarizeRun(series[0]);
  const warm = series.slice(1).map(summarizeRun);
  const warmAvg = average(series.slice(1).length ? series.slice(1) : series);
  console.log(`\n${label}`);
  console.log(
    `  cold:  ${cold.requestMs} ms  sql ${cold.sqlMs} ms  queries ${cold.queries}  source-fact ${cold.sourceFactQueries}`
  );
  if (warm.length) {
    console.log(
      `  warm avg (${warm.length}): ${warmAvg.requestMs} ms  sql ${warmAvg.sqlMs} ms  queries ${warmAvg.queries}`
    );
    warm.forEach((item, index) => {
      console.log(
        `    warm ${index + 1}: ${item.requestMs} ms  sql ${item.sqlMs} ms  queries ${item.queries}`
      );
    });
  }
  return { cold, warmAvg };
}

function printComponentBreakdown(label, warmRuns) {
  const rows = aggregateComponents(warmRuns);
  const avgTotal = warmRuns.reduce((sum, run) => sum + run.profile.totalSqlMs, 0) /
    warmRuns.length;
  console.log(
    `\n${label} — warm avg ${warmRuns.length} runs, ${warmRuns[0].profile.queryCount} queries/request, sql ${roundMs(avgTotal)} ms`
  );
  printTable(rows, [
    { key: "name", label: "component" },
    { key: "exec_per_req", label: "exec/req" },
    { key: "total_sql_ms", label: "sql_ms" },
    { key: "avg_exec_ms", label: "avg_ms" },
    { key: "slowest_ms", label: "slowest_ms" },
    { key: "rows", label: "rows" },
    { key: "pct", label: "sql_%" },
  ]);
  return rows;
}

function productionPathNotes(monthSample, yearSample) {
  const monthNames = monthSample.profile.byName.map((row) => row.name);
  const yearNames = yearSample.profile.byName.map((row) => row.name);
  return {
    monthSourceFacts: monthSample.profile.sourceFactQueries,
    yearSourceFacts: yearSample.profile.sourceFactQueries,
    monthSummary: monthNames.includes("monthly_financial_summary"),
    yearSummary: yearNames.includes("monthly_financial_summary"),
    monthTypeNets: monthNames.filter((name) => name === "expense_type_nets").length,
    yearTypeNetsMonth: yearNames.filter((name) => name === "expense_type_nets").length,
    yearTypeNetsYear: yearNames.filter((name) => name === "expense_type_nets_year")
      .length,
  };
}

async function measureUser(userId, year, month, runs) {
  const volume = await loadUserVolume(userId);
  console.log(`\n========== user_id=${userId} year=${year} month=${month} ==========`);
  console.log(
    `summary_months=${volume.summary_months} expenses=${volume.expenses} splits=${volume.splits} expense_returns=${volume.expense_returns} payments=${volume.payments} debts=${volume.debts} balance_overrides=${volume.balance_overrides}`
  );
  console.log(
    `HTTP equivalents:\n  GET /api/dashboard?user_id=${userId}&year=${year}&month=${month}\n  GET /api/dashboard?user_id=${userId}&year=${year}\n  GET /api/overview?user_id=${userId}&year=${year}&month=${month}`
  );

  const scenarios = [
    {
      label: "overview-month",
      work: () => buildMonthOverview(userId, year, month),
    },
    {
      label: "dashboard-month",
      work: () => buildDashboard(userId, year, month, "month"),
    },
    {
      label: "dashboard-year",
      work: () => buildDashboard(userId, year, null, "year"),
    },
  ];

  const allRuns = {};
  for (const scenario of scenarios) {
    allRuns[scenario.label] = [];
    for (let i = 0; i < runs; i++) {
      const run = await measureOnce(`${scenario.label}#${i + 1}`, scenario.work);
      allRuns[scenario.label].push(run);
    }
  }

  console.log("\n=== Request timing (local) ===");
  const timing = {};
  Object.keys(allRuns).forEach((label) => {
    timing[label] = printTiming(label, allRuns[label]);
  });

  console.log("\n=== Query/component breakdown (warm runs, no financial values) ===");
  const breakdowns = {};
  Object.keys(allRuns).forEach((label) => {
    const series = allRuns[label];
    const warm = series.slice(1).length ? series.slice(1) : series;
    breakdowns[label] = printComponentBreakdown(label, warm);
  });

  const monthSample = allRuns["dashboard-month"][allRuns["dashboard-month"].length - 1];
  const yearSample = allRuns["dashboard-year"][allRuns["dashboard-year"].length - 1];
  const overviewSample = allRuns["overview-month"][allRuns["overview-month"].length - 1];
  const path = productionPathNotes(monthSample, yearSample);

  console.log("\n=== Production-path verification ===");
  console.log(`dashboard-month source-fact SQL: ${path.monthSourceFacts}`);
  console.log(`dashboard-year source-fact SQL: ${path.yearSourceFacts}`);
  console.log(`dashboard-month monthly_financial_summary: ${path.monthSummary ? "yes" : "NO"}`);
  console.log(`dashboard-year monthly_financial_summary: ${path.yearSummary ? "yes" : "NO"}`);
  console.log(`dashboard-month expense_type_nets: ${path.monthTypeNets}`);
  console.log(`dashboard-year expense_type_nets (monthly helper): ${path.yearTypeNetsMonth}`);
  console.log(`dashboard-year expense_type_nets_year: ${path.yearTypeNetsYear}`);
  console.log(
    `polar slices month/year: ${monthSample.result?.charts?.polar_area?.slices?.length || 0}/${yearSample.result?.charts?.polar_area?.slices?.length || 0}`
  );
  console.log(
    `trend points month/year: ${monthSample.result?.charts?.monthly_trend?.points?.length || 0}/${yearSample.result?.charts?.monthly_trend?.points?.length || 0}`
  );
  console.log(
    `payment group keys month/year: ${monthSample.result?.charts?.spending_breakdown?.groups?.length || monthSample.result?.charts?.spending_breakdown?.slices?.length || 0}/${yearSample.result?.charts?.spending_breakdown?.groups?.length || yearSample.result?.charts?.spending_breakdown?.slices?.length || 0}`
  );

  let regression = null;
  try {
    const sourceOverview = await buildMonthOverviewFromSource(userId, year, month);
    const summaryOverview = await buildMonthOverviewFromSummary(userId, year, month);
    const dashboard = monthSample.result;
    const compared = compareDashboardToSource(dashboard, sourceOverview);
    console.log("\n=== Functional regression (match only; amounts not logged) ===");
    printTable(
      compared.map((row) => ({
        field: row.field,
        match: row.match ? "yes" : "NO",
      })),
      [
        { key: "field", label: "field" },
        { key: "match", label: "match" },
      ]
    );
    console.log(
      `summary vs source remaining match: ${Number(summaryOverview.remaining) === Number(sourceOverview.remaining) ? "yes" : "NO"}`
    );
    console.log(
      `expense-type present month/year: ${dashboard.necessary != null && dashboard.unnecessary != null ? "yes" : "NO"}/${yearSample.result?.necessary != null ? "yes" : "NO"}`
    );
    regression = compared;
  } catch (err) {
    console.log(`\nFunctional regression skipped: ${err.message}`);
  }

  return {
    userId,
    year,
    month,
    volume,
    timing,
    breakdowns,
    path,
    allRuns,
    overviewQueries: overviewSample.profile.queryCount,
    regression,
  };
}

async function main() {
  const primaryUserId = Number(argValue("user_id") || 2);
  const year = Number(argValue("year") || 2026);
  const month = Number(argValue("month") || 8);
  const runs = Math.max(2, Number(argValue("runs") || 6));
  const explain = process.argv.includes("--explain");
  const usersArg = argValue("users");
  const users = usersArg
    ? usersArg.split(",").map((value) => Number(value.trim())).filter(Boolean)
    : [primaryUserId];

  console.log("Dashboard performance measurement (local, read-only)");
  console.log(`users=${users.join(",")} year=${year} month=${month} runs=${runs} (first=cold, rest=warm)`);
  console.log(
    "Routes: GET /api/dashboard  GET /api/overview/dashboard  GET /api/overview"
  );
  console.log("Params: ?user_id=&month=&year=  (year-only → year mode)");

  const history = await loadUserHistory();
  console.log("\nmonthly_financial_summary coverage:");
  if (!history.summary.length) {
    console.log("(no summary rows)");
  } else {
    printTable(history.summary, [
      { key: "user_id", label: "user_id" },
      { key: "min_year", label: "min_year" },
      { key: "max_year", label: "max_year" },
      { key: "months", label: "months" },
    ]);
  }

  const stop = installQueryProfile(db);
  const measured = [];

  try {
    for (const userId of users) {
      measured.push(await measureUser(userId, year, month, runs));
    }

    console.log("\n=== History-length comparison ===");
    printTable(
      measured.map((item) => ({
        user_id: item.userId,
        months: item.volume.summary_months,
        expenses: item.volume.expenses,
        payments: item.volume.payments,
        overview_q: item.timing["overview-month"].warmAvg.queries,
        overview_sql: item.timing["overview-month"].warmAvg.sqlMs,
        overview_req: item.timing["overview-month"].warmAvg.requestMs,
        month_q: item.timing["dashboard-month"].warmAvg.queries,
        month_sql: item.timing["dashboard-month"].warmAvg.sqlMs,
        month_req: item.timing["dashboard-month"].warmAvg.requestMs,
        year_q: item.timing["dashboard-year"].warmAvg.queries,
        year_sql: item.timing["dashboard-year"].warmAvg.sqlMs,
        year_req: item.timing["dashboard-year"].warmAvg.requestMs,
      })),
      [
        { key: "user_id", label: "user_id" },
        { key: "months", label: "summary_mo" },
        { key: "expenses", label: "expenses" },
        { key: "payments", label: "payments" },
        { key: "overview_q", label: "ov_q" },
        { key: "overview_sql", label: "ov_sql" },
        { key: "overview_req", label: "ov_req" },
        { key: "month_q", label: "mo_q" },
        { key: "month_sql", label: "mo_sql" },
        { key: "month_req", label: "mo_req" },
        { key: "year_q", label: "yr_q" },
        { key: "year_sql", label: "yr_sql" },
        { key: "year_req", label: "yr_req" },
      ]
    );
    console.log(
      "Query counts above are for each user's actual stored history. No synthetic 24-month dataset was created."
    );

    if (explain) {
      const primary = measured.find((item) => item.userId === primaryUserId) || measured[0];
      const targets = pickSlowestExplainTargets(primary.allRuns);
      console.log(
        `\n=== EXPLAIN ANALYZE for top ${targets.length} slowest remaining queries (user ${primary.userId}) ===`
      );
      console.log("Bind values are not printed.");
      for (const target of targets) {
        await explainIfPresent(
          target.sql,
          target.values,
          `${target.name} / ${target.scenario} (${roundMs(target.durationMs)} ms, rows=${target.rowCount})`
        );
      }
    }
  } finally {
    stop();
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
