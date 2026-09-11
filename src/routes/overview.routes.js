const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  badRequest,
  serverError,
} = require("../utils/response");
const { parseAmount, formatAmount, addAmounts } = require("../utils/money");
const {
  formatTimestamp,
  monthRangeTimestamps,
  APP_TIMEZONE,
} = require("../utils/datetime");
const { getMonths, isValidMonth } = require("../masters/month.master");
const { getYears, isValidYear } = require("../masters/year.master");
const {
  calculatePreviousBalance,
  calculateMonthlyBalance,
  buildDashboardFinancialBlock,
  enrichEmiProduct,
  paidCountFromRow,
  previouslyPaidFromRow,
  emiPaidMonthsJoinSql,
  pct: sharePct,
} = require("../services/financial");
const {
  getDebtMonthNetForMonth,
} = require("../services/financial/debtMonth.service");
const {
  getIncomingBreakdownForMonth,
  getOutgoingPaymentsTotalForMonth,
  getExpenseTotalForMonth,
  getSavingsMonthNetForMonth,
  findEarliestYearMonth,
} = require("../services/financial/monthFacts.query");
const {
  EMPTY_FACTS,
  yearMonthKey,
  loadMonthlyFinancialSummariesInRange,
  loadStoredPreviousBalancesInRange,
  monthInputsFromFacts,
} = require("../services/financial/monthlyFinancialSummary.service");

function toAmount(value) {
  const amount = parseAmount(value);
  return amount === null ? 0 : amount;
}

function roundMoney(value) {
  // Keep full decimal precision for money totals
  return formatAmount(value);
}

function monthRange(year, month) {
  return monthRangeTimestamps(year, month);
}

function nextMonth(year, month) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function compareYearMonth(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

function parseMonthYear(month, year) {
  const now = new Date();
  const selectedYear =
    year !== undefined && year !== null && year !== ""
      ? Number(year)
      : now.getFullYear();
  const selectedMonth =
    month !== undefined && month !== null && month !== ""
      ? Number(month)
      : now.getMonth() + 1;

  if (!isValidMonth(selectedMonth)) {
    return { error: "month must be an integer between 1 and 12" };
  }

  if (!isValidYear(selectedYear)) {
    return { error: "year must be a valid year from the years master" };
  }

  return { month: selectedMonth, year: selectedYear, mode: "month" };
}

/**
 * Dashboard period:
 * - month + year  → that month (year defaults to current)
 * - year only     → full year
 * - neither       → current month
 */
function parseDashboardPeriod(month, year) {
  const hasMonth = month !== undefined && month !== null && month !== "";
  const hasYear = year !== undefined && year !== null && year !== "";
  const now = new Date();

  if (hasYear && !hasMonth) {
    const selectedYear = Number(year);
    if (!isValidYear(selectedYear)) {
      return { error: "year must be a valid year from the years master" };
    }
    return { mode: "year", year: selectedYear, month: null };
  }

  const selectedYear = hasYear ? Number(year) : now.getFullYear();
  const selectedMonth = hasMonth ? Number(month) : now.getMonth() + 1;

  if (!isValidMonth(selectedMonth)) {
    return { error: "month must be an integer between 1 and 12" };
  }
  if (!isValidYear(selectedYear)) {
    return { error: "year must be a valid year from the years master" };
  }

  return { mode: "month", month: selectedMonth, year: selectedYear };
}

/** @deprecated use getIncomingBreakdownForMonth — kept as alias for salary/income total */
async function getIncomeTotalForMonth(userId, year, month) {
  const breakdown = await getIncomingBreakdownForMonth(userId, year, month);
  return breakdown.total;
}

/** EMI payments for the month — net amount + count (subset of outgoing). */
async function getEmiStatsForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT
       COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total,
       COUNT(p.id)::int AS count
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND LOWER(TRIM(pt.name)) = 'emi'
       AND p.payment_date >= $2
       AND p.payment_date <= $3`,
    [userId, start, end]
  );
  return {
    emis: toAmount(result.rows[0].total),
    emi_count: Number(result.rows[0].count) || 0,
  };
}

/**
 * Necessary / unnecessary nets (split-aware, after returns).
 *
 * Tables: expenses, expense_category_splits, expense_returns
 * Date filter: expenses.expense_date (parent month), not return_date
 * No splits → header amount minus all returns on that expense
 * With splits → split amount minus returns matched by LOWER(category)
 * Classification: COALESCE(split.expense_type, expense.expense_type, TRUE)
 *   TRUE = necessary / wanted, FALSE = unnecessary / unwanted
 */
const EXPENSE_TYPE_NETS_FROM = `
       FROM expenses e
       LEFT JOIN expense_category_splits s ON s.expense_id = e.id
       LEFT JOIN (
         SELECT expense_id, LOWER(category) AS category_key, SUM(amount) AS returned_amount
         FROM expense_returns
         GROUP BY expense_id, LOWER(category)
       ) r
         ON s.id IS NOT NULL
        AND r.expense_id = e.id
        AND r.category_key = LOWER(s.category)
       WHERE e.user_id = $1
         AND e.expense_date >= $2
         AND e.expense_date <= $3`;

const EXPENSE_TYPE_NETS_SELECT = `
         COALESCE(s.expense_type, e.expense_type, TRUE) AS is_necessary,
         CASE
           WHEN s.id IS NULL THEN
             e.amount - COALESCE((
               SELECT SUM(er.amount)
               FROM expense_returns er
               WHERE er.expense_id = e.id
             ), 0)
           ELSE
             s.amount - COALESCE(r.returned_amount, 0)
         END AS net_amount`;

const EXPENSE_CHART_BASE_SELECT = `
         COALESCE(s.category, e.category) AS category,
         ${EXPENSE_TYPE_NETS_SELECT}`;

function emptyExpenseTypeNets() {
  return { necessary: 0, unnecessary: 0 };
}

async function getExpenseTypeNetsForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS necessary,
       COALESCE(SUM(CASE WHEN NOT t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS unnecessary
     FROM (
       SELECT
         ${EXPENSE_TYPE_NETS_SELECT}
       ${EXPENSE_TYPE_NETS_FROM}
     ) t`,
    [userId, start, end]
  );

  return {
    necessary: toAmount(result.rows[0].necessary),
    unnecessary: toAmount(result.rows[0].unnecessary),
  };
}

/**
 * Same nets as 12 × getExpenseTypeNetsForMonth for a calendar year, one query.
 * Months with no expenses are { necessary: 0, unnecessary: 0 }.
 * Month buckets use APP_TIMEZONE, matching monthRangeTimestamps.
 */
async function getExpenseTypeNetsForYear(userId, year) {
  const y = Number(year);
  const { start, end } = periodRange(y, null, "year");
  const byMonth = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    year: y,
    ...emptyExpenseTypeNets(),
  }));

  const result = await db.query(
    `SELECT
       t.month,
       COALESCE(SUM(CASE WHEN t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS necessary,
       COALESCE(SUM(CASE WHEN NOT t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS unnecessary
     FROM (
       SELECT
         EXTRACT(MONTH FROM (e.expense_date AT TIME ZONE $4))::int AS month,
         ${EXPENSE_TYPE_NETS_SELECT}
       ${EXPENSE_TYPE_NETS_FROM}
     ) t
     GROUP BY t.month`,
    [userId, start, end, APP_TIMEZONE]
  );

  result.rows.forEach((row) => {
    const month = Number(row.month);
    if (month >= 1 && month <= 12) {
      byMonth[month - 1].necessary = toAmount(row.necessary);
      byMonth[month - 1].unnecessary = toAmount(row.unnecessary);
    }
  });

  return byMonth;
}

/**
 * Category breakdown for Polar Area Chart (split-aware, after returns).
 * Ready for ApexCharts / Chart.js: labels + series + colors, plus slices with %.
 * Unnecessary-dominant categories get red shades; others get a non-red palette.
 */
const POLAR_NECESSARY_COLORS = [
  // Green shades — darkest → lightest (highest expense → darker green)
  "#198754",
  "#20C997",
  "#2F9E44",
  "#40C057",
  "#51CF66",
  "#69DB7C",
  "#8CE99A",
  "#B2F2BB",
];

const POLAR_UNNECESSARY_RED_SHADES = [
  // Danger red — milder dark → light (highest expense → first)
  "#DC3545",
  "#E35D6A",
  "#EA868F",
  "#F1B0B7",
  "#F5C2C7",
  "#F8D7DA",
  "#FAE3E5",
];

function isUnnecessaryDominant(slice) {
  const unnecessary = Number(slice.unnecessary_total) || 0;
  const necessary = Number(slice.necessary_total) || 0;
  return unnecessary > 0 && unnecessary >= necessary;
}

function assignPolarAreaColors(slices) {
  const unnecessaryRanks = slices
    .map((slice, index) => ({
      index,
      total: Number(slice.total) || 0,
      is_unnecessary: isUnnecessaryDominant(slice),
    }))
    .filter((item) => item.is_unnecessary)
    .sort((a, b) => b.total - a.total);

  const necessaryRanks = slices
    .map((slice, index) => ({
      index,
      total: Number(slice.total) || 0,
      is_unnecessary: isUnnecessaryDominant(slice),
    }))
    .filter((item) => !item.is_unnecessary)
    .sort((a, b) => b.total - a.total);

  const colorByIndex = {};

  unnecessaryRanks.forEach((item, rank) => {
    colorByIndex[item.index] =
      POLAR_UNNECESSARY_RED_SHADES[
        Math.min(rank, POLAR_UNNECESSARY_RED_SHADES.length - 1)
      ];
  });

  necessaryRanks.forEach((item, rank) => {
    colorByIndex[item.index] =
      POLAR_NECESSARY_COLORS[
        Math.min(rank, POLAR_NECESSARY_COLORS.length - 1)
      ];
  });

  return slices.map((slice, index) => {
    const is_unnecessary = isUnnecessaryDominant(slice);
    return {
      ...slice,
      color: colorByIndex[index],
      is_unnecessary,
    };
  });
}

function buildPolarAreaFromCategoryRows(rows) {
  const slices = rows.map((row) => ({
    category: row.category,
    total: toAmount(row.total),
    necessary_total: toAmount(
      row.necessary_total != null ? row.necessary_total : row.necessary
    ),
    unnecessary_total: toAmount(
      row.unnecessary_total != null ? row.unnecessary_total : row.unnecessary
    ),
  }));

  slices.sort((a, b) => {
    const byTotal = b.total - a.total;
    if (byTotal !== 0) return byTotal;
    return String(a.category || "").localeCompare(String(b.category || ""));
  });

  // Chart shows top 10 categories by total only
  const topSlices = slices.slice(0, 10);

  const grand_total = roundMoney(
    topSlices.reduce((sum, s) => sum + s.total, 0)
  );

  const withPct = assignPolarAreaColors(
    topSlices.map((s) => ({
      ...s,
      percentage:
        grand_total > 0 ? roundMoney((s.total / grand_total) * 100) : 0,
    }))
  );

  return {
    grand_total,
    labels: withPct.map((s) => s.category),
    series: withPct.map((s) => s.total),
    colors: withPct.map((s) => s.color),
    slices: withPct,
  };
}

async function getCategoryPolarArea(userId, start, end) {
  const result = await db.query(
    `SELECT
       t.category,
       COALESCE(SUM(t.net_amount), 0) AS total,
       COALESCE(SUM(CASE WHEN t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS necessary_total,
       COALESCE(SUM(CASE WHEN NOT t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS unnecessary_total
     FROM (
       SELECT
         ${EXPENSE_CHART_BASE_SELECT}
       ${EXPENSE_TYPE_NETS_FROM}
     ) t
     GROUP BY t.category
     HAVING COALESCE(SUM(t.net_amount), 0) > 0
     ORDER BY total DESC`,
    [userId, start, end]
  );

  return buildPolarAreaFromCategoryRows(result.rows);
}

/**
 * One round trip: same split-aware base rows as polar + type-nets, then two
 * aggregates via UNION ALL (section = 'polar' | 'type').
 * Returns are pre-aggregated by (expense_id, LOWER(category)) before joining
 * splits, so multiple splits cannot double-count return rows.
 */
async function queryExpenseCharts(userId, start, end, { includeMonth } = {}) {
  const monthSelect = includeMonth
    ? `EXTRACT(MONTH FROM (e.expense_date AT TIME ZONE $4))::int AS month,`
    : `NULL::int AS month,`;

  const typeBranch = includeMonth
    ? `SELECT
        'type'::text AS section,
        NULL::text AS category,
        month,
        0::numeric AS total,
        COALESCE(SUM(CASE WHEN is_necessary THEN net_amount ELSE 0 END), 0) AS necessary,
        COALESCE(SUM(CASE WHEN NOT is_necessary THEN net_amount ELSE 0 END), 0) AS unnecessary
      FROM base
      GROUP BY month`
    : `SELECT
        'type'::text AS section,
        NULL::text AS category,
        NULL::int AS month,
        0::numeric AS total,
        COALESCE(SUM(CASE WHEN is_necessary THEN net_amount ELSE 0 END), 0) AS necessary,
        COALESCE(SUM(CASE WHEN NOT is_necessary THEN net_amount ELSE 0 END), 0) AS unnecessary
      FROM base`;

  const result = await db.query(
    `-- expense_charts_combined
     WITH base AS (
       SELECT
         ${monthSelect}
         ${EXPENSE_CHART_BASE_SELECT}
       ${EXPENSE_TYPE_NETS_FROM}
     )
     (
       SELECT
         'polar'::text AS section,
         category,
         NULL::int AS month,
         COALESCE(SUM(net_amount), 0) AS total,
         COALESCE(SUM(CASE WHEN is_necessary THEN net_amount ELSE 0 END), 0) AS necessary,
         COALESCE(SUM(CASE WHEN NOT is_necessary THEN net_amount ELSE 0 END), 0) AS unnecessary
       FROM base
       GROUP BY category
       HAVING COALESCE(SUM(net_amount), 0) > 0
       ORDER BY total DESC
     )
     UNION ALL
     (
       ${typeBranch}
     )`,
    includeMonth ? [userId, start, end, APP_TIMEZONE] : [userId, start, end]
  );

  return result.rows;
}

async function getExpenseChartsForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const rows = await queryExpenseCharts(userId, start, end, {
    includeMonth: false,
  });
  const typeRow = rows.find((row) => row.section === "type");
  return {
    polar_area: buildPolarAreaFromCategoryRows(
      rows.filter((row) => row.section === "polar")
    ),
    typeNets: {
      necessary: toAmount(typeRow && typeRow.necessary),
      unnecessary: toAmount(typeRow && typeRow.unnecessary),
    },
  };
}

async function getExpenseChartsForYear(userId, year) {
  const y = Number(year);
  const { start, end } = periodRange(y, null, "year");
  const rows = await queryExpenseCharts(userId, start, end, {
    includeMonth: true,
  });
  const typeNetsByMonth = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    year: y,
    ...emptyExpenseTypeNets(),
  }));
  rows.forEach((row) => {
    if (row.section !== "type") return;
    const month = Number(row.month);
    if (month >= 1 && month <= 12) {
      typeNetsByMonth[month - 1].necessary = toAmount(row.necessary);
      typeNetsByMonth[month - 1].unnecessary = toAmount(row.unnecessary);
    }
  });
  return {
    polar_area: buildPolarAreaFromCategoryRows(
      rows.filter((row) => row.section === "polar")
    ),
    typeNetsByMonth,
  };
}

function periodRange(year, month, mode) {
  if (mode === "year") {
    const jan = monthRange(year, 1);
    const dec = monthRange(year, 12);
    return { start: jan.start, end: dec.end };
  }
  return monthRange(year, month);
}

function pct(part, whole) {
  return sharePct(part, whole);
}

/** Donut / pie — necessary vs unnecessary expenses */
const EXPENSE_TYPE_COLORS = {
  necessary: "#198754", // green
  unnecessary: "#DC3545", // danger red
};

function buildExpenseTypeChart(necessary, unnecessary) {
  const slices = [
    {
      label: "Necessary",
      key: "necessary",
      total: necessary,
      color: EXPENSE_TYPE_COLORS.necessary,
      is_unnecessary: false,
    },
    {
      label: "Unnecessary",
      key: "unnecessary",
      total: unnecessary,
      color: EXPENSE_TYPE_COLORS.unnecessary,
      is_unnecessary: true,
    },
  ].filter((s) => s.total > 0);

  const grand_total = roundMoney(necessary + unnecessary);

  return {
    type: "donut",
    title: "Necessary vs Unnecessary",
    grand_total,
    labels: slices.map((s) => s.label),
    series: slices.map((s) => s.total),
    colors: slices.map((s) => s.color),
    slices: slices.map((s) => ({
      ...s,
      percentage: pct(s.total, grand_total),
    })),
  };
}

/** Bar — money flow snapshot for the period */
const CASHFLOW_GREEN = "#198754";
const CASHFLOW_RED = "#DC3545";

function cashflowPositiveColor(value) {
  return Number(value) > 0 ? CASHFLOW_GREEN : CASHFLOW_RED;
}

function cashflowNonNegativeColor(value) {
  return Number(value) >= 0 ? CASHFLOW_GREEN : CASHFLOW_RED;
}

function resolveCashflowColor(key, total, available) {
  const value = Number(total) || 0;
  const availableAmt = Number(available) || 0;

  switch (key) {
    case "income":
    case "available":
      return cashflowPositiveColor(value);
    case "previous_balance":
      // Carry-forward: green when positive, red when not
      return cashflowPositiveColor(value);
    case "spent":
      // Green when spending is under available, else red
      return value < availableAmt ? CASHFLOW_GREEN : CASHFLOW_RED;
    case "from_savings":
      // Red when negative (net pull hurts); green otherwise
      return cashflowNonNegativeColor(value);
    case "debt":
      // Positive debt burden → red; zero/negative → green
      return value > 0 ? CASHFLOW_RED : CASHFLOW_GREEN;
    case "balance":
      // Green when positive, red when zero/negative
      return cashflowPositiveColor(value);
    default:
      return cashflowPositiveColor(value);
  }
}

function buildCashflowChart({
  income,
  previous_balance,
  available,
  spent,
  from_savings,
  debt,
  balance,
}) {
  const items = [
    { label: "Income", key: "income", total: income },
    { label: "Prev. balance", key: "previous_balance", total: previous_balance },
    { label: "Available", key: "available", total: available },
    { label: "Spent", key: "spent", total: spent },
    { label: "From savings", key: "from_savings", total: from_savings },
    { label: "Debt", key: "debt", total: debt },
    { label: "Balance", key: "balance", total: balance },
  ].map((item) => ({
    ...item,
    color: resolveCashflowColor(item.key, item.total, available),
  }));

  return {
    type: "bar",
    title: "Cash flow",
    labels: items.map((i) => i.label),
    series: items.map((i) => i.total),
    colors: items.map((i) => i.color),
    items,
  };
}

/** Donut — spending by expenses + each outgoing payment type (EMI grouped by product) */
const SPENDING_BREAKDOWN_FIXED_COLORS = {
  expenses: "#4F46E5", // indigo
  from_savings: "#0D9488", // deep teal
  debt: "#E11D48", // crimson
  emi: "#EA580C", // vivid orange
};

const SPENDING_PAYMENT_TYPE_COLORS = [
  "#7C3AED", // violet
  "#059669", // emerald
  "#DB2777", // magenta
  "#0284C7", // blue
  "#CA8A04", // gold
  "#C026D3", // fuchsia
  "#16A34A", // green
  "#0891B2", // cyan
  "#D97706", // amber
  "#9333EA", // purple
];

/**
 * Outgoing (non-income) payments grouped by payment type.
 * EMI includes full product details in groups[] for the spending-breakdown chart.
 */
async function getOutgoingPaymentsGrouped(userId, start, end) {
  const result = await db.query(
    `SELECT
       pt.id AS payment_type_id,
       pt.name AS payment_type_name,
       ep.id AS emi_product_id,
       ep.product_name AS emi_product_name,
       ep.emi_start_from,
       ep.already_paid,
       COALESCE(emi_paid.paid_months, 0) AS paid_months,
       ep.number_of_emis,
       COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total,
       COUNT(p.id)::int AS count
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN emi_products ep ON ep.id = p.emi_product_id
     ${emiPaidMonthsJoinSql({ userParam: "$1", tzParam: "$4" })}
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.flow = 'outgoing'
       AND p.payment_date >= $2
       AND p.payment_date <= $3
     GROUP BY
       pt.id,
       pt.name,
       ep.id,
       ep.product_name,
       ep.emi_start_from,
       ep.already_paid,
       emi_paid.paid_months,
       ep.number_of_emis
     HAVING COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) > 0
     ORDER BY total DESC`,
    [userId, start, end, APP_TIMEZONE]
  );

  const byType = {};

  result.rows.forEach((row) => {
    const typeId = row.payment_type_id;
    const typeName = String(row.payment_type_name || "").trim();
    const isEmi = typeName.toLowerCase() === "emi";
    const total = toAmount(row.total);
    const count = Number(row.count) || 0;

    if (!byType[typeId]) {
      byType[typeId] = {
        payment_type_id: typeId,
        label: typeName || "Payment",
        key: isEmi ? "emi" : `payment_type_${typeId}`,
        total: 0,
        count: 0,
        groups: [],
      };
    }

    const group = byType[typeId];
    group.total = roundMoney(group.total + total);
    group.count += count;

    if (isEmi) {
      const number_of_emis =
        row.number_of_emis != null ? Number(row.number_of_emis) : null;
      const emiProgress = enrichEmiProduct({
        already_paid: previouslyPaidFromRow(row),
        paid_months: paidCountFromRow(row),
        number_of_emis,
      });

      group.groups.push({
        label: row.emi_product_name || "EMI",
        product_name: row.emi_product_name || "EMI",
        emi_product_id: row.emi_product_id || null,
        start_date: formatTimestamp(row.emi_start_from),
        already_paid: emiProgress.already_paid,
        previously_paid: emiProgress.previously_paid,
        tracked_paid_months: emiProgress.tracked_paid_months,
        number_of_emis: emiProgress.number_of_emis,
        paid: emiProgress.paid,
        total_paid: emiProgress.total_paid,
        remaining: emiProgress.remaining,
        emis_left: emiProgress.emis_left,
        progress_percentage: emiProgress.progress_percentage,
        total,
        amount: total,
        count,
        payments_this_period: count,
      });
    }
  });

  // EMI products: highest emis left first
  Object.values(byType).forEach((group) => {
    if (group.key === "emi" && group.groups.length) {
      group.groups.sort((a, b) => {
        const leftA = a.remaining ?? a.emis_left ?? -1;
        const leftB = b.remaining ?? b.emis_left ?? -1;
        if (leftB !== leftA) return leftB - leftA;
        return (b.total || 0) - (a.total || 0);
      });
    }
  });

  return Object.values(byType).sort((a, b) => b.total - a.total);
}

function buildSpendingBreakdownChart({
  expense_total,
  from_savings,
  debt,
  payment_groups = [],
}) {
  const slices = [];
  let paymentColorIndex = 0;

  if ((expense_total || 0) > 0) {
    slices.push({
      label: "Expenses",
      key: "expenses",
      total: expense_total,
      count: null,
      groups: [],
      color: SPENDING_BREAKDOWN_FIXED_COLORS.expenses,
    });
  }

  payment_groups.forEach((group) => {
    const isEmi = group.key === "emi";
    const color = isEmi
      ? SPENDING_BREAKDOWN_FIXED_COLORS.emi
      : SPENDING_PAYMENT_TYPE_COLORS[
          paymentColorIndex++ % SPENDING_PAYMENT_TYPE_COLORS.length
        ];

    const slice = {
      label: group.label,
      key: group.key,
      payment_type_id: group.payment_type_id,
      total: group.total,
      count: group.count,
      groups: group.groups || [],
      color,
    };

    if (isEmi) {
      slice.emi_count = group.count;
      slice.products_count = (group.groups || []).length;
      slice.emis = group.total;
    }

    slices.push(slice);
  });

  if ((from_savings || 0) > 0) {
    slices.push({
      label: "From savings",
      key: "from_savings",
      total: from_savings,
      count: null,
      groups: [],
      color: SPENDING_BREAKDOWN_FIXED_COLORS.from_savings,
    });
  }

  if ((debt || 0) > 0) {
    slices.push({
      label: "Debt",
      key: "debt",
      total: debt,
      count: null,
      groups: [],
      color: SPENDING_BREAKDOWN_FIXED_COLORS.debt,
    });
  }

  const filtered = slices.filter((s) => s.total > 0);
  const grand_total = roundMoney(
    filtered.reduce((sum, s) => sum + s.total, 0)
  );

  const emiSlice = filtered.find((s) => s.key === "emi") || null;

  return {
    type: "donut",
    title: "Spending breakdown",
    grand_total,
    labels: filtered.map((s) => s.label),
    series: filtered.map((s) => s.total),
    colors: filtered.map((s) => s.color),
    // EMI summary for chart details panel (replaces top-level dashboard emis fields)
    emi: emiSlice
      ? {
          total: emiSlice.total,
          emi_count: emiSlice.emi_count,
          products_count: emiSlice.products_count,
          color: emiSlice.color,
          products: emiSlice.groups,
        }
      : null,
    slices: filtered.map((s) => ({
      ...s,
      percentage: pct(s.total, grand_total),
    })),
  };
}

/** Line — month-by-month for a year */
const MONTHLY_TREND_COLORS = {
  income: "#198754", // green
  spent: "#DC3545", // danger red
  from_savings: "#8FE388", // light / parrot green
  debt: "#F97316", // orange
  balance: "#4F46E5", // indigo
};

function buildMonthlyTrendChart(points) {
  const months = getMonths();
  const labels = points.map(
    (p) => months.find((m) => m.id === p.month)?.short || String(p.month)
  );

  const series = [
    {
      name: "Earned",
      key: "earned",
      color: MONTHLY_TREND_COLORS.income,
      data: points.map((p) => p.earned ?? p.income),
    },
    {
      name: "Spent",
      key: "spent",
      color: MONTHLY_TREND_COLORS.spent,
      data: points.map((p) => p.spent),
    },
    {
      name: "From savings",
      key: "from_savings",
      color: MONTHLY_TREND_COLORS.from_savings,
      data: points.map((p) => p.from_savings),
    },
    {
      name: "Net debt",
      key: "debt",
      color: MONTHLY_TREND_COLORS.debt,
      data: points.map((p) => p.debt),
    },
    {
      name: "Balance",
      key: "balance",
      color: MONTHLY_TREND_COLORS.balance,
      data: points.map((p) => p.balance),
    },
  ];

  return {
    type: "line",
    title: "Monthly trend",
    labels,
    colors: series.map((s) => s.color),
    series,
    points,
  };
}

function attachPolarAreaMeta(polar_area) {
  return {
    type: "polarArea",
    title: "Expenses by category",
    ...polar_area,
  };
}

function buildChartsBundle({
  polar_area,
  necessary,
  unnecessary,
  income,
  previous_balance,
  available,
  spent,
  from_savings,
  debt,
  balance,
  expense_total,
  payment_groups,
  monthly_trend_points,
}) {
  const charts = {
    polar_area: attachPolarAreaMeta(polar_area),
    expense_type: buildExpenseTypeChart(necessary, unnecessary),
    cashflow: buildCashflowChart({
      income,
      previous_balance,
      available,
      spent,
      from_savings,
      debt,
      balance,
    }),
    spending_breakdown: buildSpendingBreakdownChart({
      expense_total,
      from_savings,
      debt,
      payment_groups,
    }),
  };

  if (monthly_trend_points && monthly_trend_points.length) {
    charts.monthly_trend = buildMonthlyTrendChart(monthly_trend_points);
  }

  return charts;
}

async function getLatestSalaryPayment(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT p.id, p.amount, p.payment_date
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     WHERE p.user_id = $1
       AND LOWER(pt.name) = 'salary'
       AND p.payment_date >= $2
       AND p.payment_date <= $3
     ORDER BY p.payment_date DESC, p.id DESC
     LIMIT 1`,
    [userId, start, end]
  );
  return result.rows[0] || null;
}

async function getStoredPreviousBalance(userId, year, month) {
  const result = await db.query(
    `SELECT previous_month_balance
     FROM monthly_balances
     WHERE user_id = $1 AND year = $2 AND month = $3`,
    [userId, year, month]
  );

  if (result.rows.length === 0) return null;
  return toAmount(result.rows[0].previous_month_balance);
}

function walkStartForTarget(earliest, target) {
  let cursor = earliest || target;
  if (earliest && compareYearMonth(target, earliest) < 0) {
    cursor = target;
  }
  return cursor;
}

async function loadSourceMonthFacts(userId, year, month) {
  const incomingBreakdown = await getIncomingBreakdownForMonth(
    userId,
    year,
    month
  );
  const outgoingPayments = await getOutgoingPaymentsTotalForMonth(
    userId,
    year,
    month
  );
  const expenseTotal = await getExpenseTotalForMonth(userId, year, month);
  const savings = await getSavingsMonthNetForMonth(userId, year, month);
  const debtInfo = await getDebtMonthNetForMonth(userId, year, month);
  return {
    salary: incomingBreakdown.total,
    earned: incomingBreakdown.earned,
    not_earned: incomingBreakdown.not_earned,
    outgoingPayments,
    expenseTotal,
    savings,
    fromSavings: savings.month_net,
    debtInfo,
    debt: debtInfo.debt,
  };
}

function loadSummaryMonthFacts(facts) {
  const inputs = monthInputsFromFacts(facts || EMPTY_FACTS);
  return {
    salary: inputs.incoming,
    earned: inputs.earned,
    not_earned: inputs.not_earned,
    outgoingPayments: inputs.outgoing,
    expenseTotal: inputs.expenses,
    savings: inputs.savings,
    fromSavings: inputs.savings.month_net,
    debtInfo: inputs.debtInfo,
    debt: inputs.debtInfo.debt,
  };
}

function assembleMonthOverview({
  userId,
  year,
  month,
  previous,
  monthly,
  salary,
  earned,
  not_earned,
  outgoingPayments,
  expenseTotal,
  savings,
  fromSavings,
  debt,
  debtInfo,
  latestSalary,
  emiStats,
}) {
  return {
    user_id: Number(userId),
    month,
    year,
    date: latestSalary ? formatTimestamp(latestSalary.payment_date) : null,
    salary,
    // Effective value used in balance math (manual override or calculated)
    previous_month_balance: previous.previous_month_balance,
    // Auto value = previous month Remaining (before any edit)
    previous_month_balance_calculated: previous.previous_month_balance_calculated,
    previous_month_balance_manual: previous.previous_month_balance_manual,
    // Canonical aliases
    previous_balance: previous.previous_balance,
    previous_balance_calculated: previous.previous_balance_calculated,
    previous_balance_manual: previous.previous_balance_manual,
    from_savings: fromSavings,
    savings_credited: fromSavings,
    savings_month_net: fromSavings,
    savings_amount_saved: savings.credited,
    savings_amount_debited: savings.debited,
    debt,
    debt_given_net: debtInfo.given_net,
    debt_received_net: debtInfo.received_net,
    debt_given_total: debtInfo.given_total,
    debt_given_returned: debtInfo.given_returned,
    debt_received_total: debtInfo.received_total,
    debt_received_returned: debtInfo.received_returned,
    debt_received_repaid_this_month: debtInfo.received_repaid_this_month,
    debt_received_repaid_past_months: debtInfo.received_repaid_past_months,
    total_amount_to_spend: monthly.total_amount_to_spend,
    total_spent: monthly.spent,
    total_deductions: monthly.total_deductions,
    total_expenses: monthly.spent,
    expense_total: expenseTotal,
    outgoing_payments_total: outgoingPayments,
    emis: emiStats.emis,
    emi_count: emiStats.emi_count,
    // Remaining — becomes next month's calculated previous balance
    current_balance: monthly.remaining,
    remaining: monthly.remaining,
    incoming: salary,
    earned,
    not_earned,
    // Available = earned + previous_month_balance
    available: monthly.available,
    available_split: monthly.available_split,
    spent: monthly.spent,
    savings: fromSavings,
  };
}

async function walkMonthOverviewRange(userId, from, to, options = {}) {
  const factsSource = options.factsSource || "summary";
  const extraMonths = options.extraMonths || [];
  const extraSet = new Set(
    extraMonths.map((period) => yearMonthKey(period.year, period.month))
  );

  let summaryMap = options.summaryMap;
  let previousMap = options.previousMap;
  if (factsSource === "summary") {
    if (!summaryMap) {
      summaryMap = await loadMonthlyFinancialSummariesInRange(userId, from, to);
    }
    if (!previousMap) {
      previousMap = await loadStoredPreviousBalancesInRange(userId, from, to);
    }
  }

  const results = new Map();
  let previousMonthBalance = 0;
  let cursor = { year: from.year, month: from.month };

  while (compareYearMonth(cursor, to) <= 0) {
    const key = yearMonthKey(cursor.year, cursor.month);
    // Default previous balance = previous month's Remaining (current_balance).
    // Manual edit in monthly_balances overrides that for this month only.
    // A stored value of 0 is a valid override (Map.has, not truthiness).
    const calculatedPreviousMonthBalance = previousMonthBalance;
    const storedPrevious =
      factsSource === "summary"
        ? previousMap.has(key)
          ? previousMap.get(key)
          : null
        : await getStoredPreviousBalance(userId, cursor.year, cursor.month);
    const previous = calculatePreviousBalance({
      manual: storedPrevious,
      calculated: calculatedPreviousMonthBalance,
    });
    previousMonthBalance = previous.previous_balance;

    const factsBundle =
      factsSource === "summary"
        ? loadSummaryMonthFacts(summaryMap.get(key) || EMPTY_FACTS)
        : await loadSourceMonthFacts(userId, cursor.year, cursor.month);

    const monthly = calculateMonthlyBalance({
      incoming: factsBundle.salary,
      earned: factsBundle.earned,
      not_earned: factsBundle.not_earned,
      previous: previousMonthBalance,
      expense_total: factsBundle.expenseTotal,
      outgoing_payments_total: factsBundle.outgoingPayments,
      savings: factsBundle.fromSavings,
      debt: factsBundle.debt,
    });

    const isExtra = extraSet.has(key);
    let latestSalary = null;
    let emiStats = { emis: 0, emi_count: 0 };
    let debtInfo = factsBundle.debtInfo;

    if (isExtra) {
      latestSalary = await getLatestSalaryPayment(
        userId,
        cursor.year,
        cursor.month
      );
      emiStats = await getEmiStatsForMonth(userId, cursor.year, cursor.month);
      if (factsSource === "summary") {
        const liveDebt = await getDebtMonthNetForMonth(
          userId,
          cursor.year,
          cursor.month
        );
        debtInfo = {
          ...debtInfo,
          received_repaid_this_month: liveDebt.received_repaid_this_month,
          received_repaid_past_months: liveDebt.received_repaid_past_months,
        };
      }
    }

    results.set(
      key,
      assembleMonthOverview({
        userId,
        year: cursor.year,
        month: cursor.month,
        previous,
        monthly,
        salary: factsBundle.salary,
        earned: factsBundle.earned,
        not_earned: factsBundle.not_earned,
        outgoingPayments: factsBundle.outgoingPayments,
        expenseTotal: factsBundle.expenseTotal,
        savings: factsBundle.savings,
        fromSavings: factsBundle.fromSavings,
        debt: factsBundle.debt,
        debtInfo,
        latestSalary,
        emiStats,
      })
    );

    previousMonthBalance = monthly.remaining;
    cursor = nextMonth(cursor.year, cursor.month);
  }

  return results;
}

async function buildMonthOverviewWithSource(userId, year, month, factsSource) {
  const target = { year: Number(year), month: Number(month) };
  const earliest = await findEarliestYearMonth(userId);
  const from = walkStartForTarget(earliest, target);
  const map = await walkMonthOverviewRange(userId, from, target, {
    factsSource,
    extraMonths: [target],
  });
  return map.get(yearMonthKey(target.year, target.month)) || null;
}

async function buildMonthOverviewFromSource(userId, year, month) {
  return buildMonthOverviewWithSource(userId, year, month, "source");
}

async function buildMonthOverviewFromSummary(userId, year, month) {
  return buildMonthOverviewWithSource(userId, year, month, "summary");
}

async function buildMonthOverview(userId, year, month) {
  return buildMonthOverviewFromSummary(userId, year, month);
}

async function buildMonthOverviewsForCalendarYear(userId, year, options = {}) {
  const y = Number(year);
  const factsSource = options.factsSource || "summary";
  const extraMonths = options.extraMonths || [];
  const jan = { year: y, month: 1 };
  const dec = { year: y, month: 12 };
  const earliest = await findEarliestYearMonth(userId);
  const map = new Map();

  let summaryMap;
  let previousMap;
  if (factsSource === "summary") {
    const from =
      earliest && compareYearMonth(earliest, jan) < 0 ? earliest : jan;
    summaryMap = await loadMonthlyFinancialSummariesInRange(userId, from, dec);
    previousMap = await loadStoredPreviousBalancesInRange(userId, from, dec);
  }

  const mergeRange = async (from, to) => {
    const part = await walkMonthOverviewRange(userId, from, to, {
      factsSource,
      extraMonths,
      summaryMap,
      previousMap,
    });
    part.forEach((value, key) => map.set(key, value));
  };

  if (!earliest) {
    for (let m = 1; m <= 12; m++) {
      await mergeRange({ year: y, month: m }, { year: y, month: m });
    }
    return map;
  }

  if (compareYearMonth(jan, earliest) >= 0) {
    await mergeRange(earliest, dec);
    return map;
  }

  const lastStandalone = earliest.year === y ? earliest.month - 1 : 12;
  for (let m = 1; m <= lastStandalone; m++) {
    await mergeRange({ year: y, month: m }, { year: y, month: m });
  }
  if (earliest.year === y && compareYearMonth(earliest, dec) <= 0) {
    await mergeRange(earliest, dec);
  }
  return map;
}

function collectTrendPointsFromOverviews(overviews, year) {
  const points = [];
  for (let m = 1; m <= 12; m++) {
    const overview = overviews.get(yearMonthKey(year, m));
    if (!overview) continue;
    points.push({
      month: m,
      year: Number(year),
      income: overview.salary,
      earned: overview.earned || 0,
      not_earned: overview.not_earned || 0,
      spent: roundMoney(
        overview.expense_total + overview.outgoing_payments_total
      ),
      from_savings: overview.from_savings,
      debt: overview.debt,
      balance: overview.current_balance,
      expense_total: overview.expense_total,
      necessary: 0,
      unnecessary: 0,
    });
  }
  return points;
}

/**
 * Dashboard card payload — same month math as overview, clear labels for UI.
 * Available = earned + previous_month_balance
 * Spendable (total_amount_to_spend) = Incoming + Prev. balance
 * Total Spent = expenses (net) + outgoing payments (flow=outgoing)
 * Remaining  = Spendable − Total Spent − Savings − Debt
 *
 * mode "month" → one month; mode "year" → full calendar year totals
 * charts: polar_area, expense_type, cashflow, spending_breakdown, monthly_trend
 */
async function buildDashboard(userId, year, month, mode = "month") {
  if (mode === "year") {
    return buildDashboardForYear(userId, year);
  }

  const overviews = await buildMonthOverviewsForCalendarYear(userId, year, {
    factsSource: "summary",
    extraMonths: [{ year: Number(year), month: Number(month) }],
  });
  const overview = overviews.get(yearMonthKey(year, month));
  if (!overview) return null;

  const { start, end } = periodRange(year, month, "month");
  const expenseCharts = await getExpenseChartsForMonth(userId, year, month);
  const typeNets = expenseCharts.typeNets;
  const polar_area = expenseCharts.polar_area;
  const payment_groups = await getOutgoingPaymentsGrouped(userId, start, end);
  const monthly_trend_points = collectTrendPointsFromOverviews(overviews, year);

  const income = overview.salary;
  const earned = overview.earned;
  const not_earned = overview.not_earned;
  const previous_balance = overview.previous_month_balance;
  const from_savings = overview.from_savings;
  const available = overview.available;
  const available_split = overview.available_split;
  const spent = roundMoney(
    overview.expense_total + overview.outgoing_payments_total
  );
  const debt = overview.debt;
  const balance = overview.current_balance;

  const financial = buildDashboardFinancialBlock(overview, {
    necessary: typeNets.necessary,
    unnecessary: typeNets.unnecessary,
    saved: overview.savings_amount_saved,
    debited: overview.savings_amount_debited,
  });

  const charts = buildChartsBundle({
    polar_area,
    necessary: typeNets.necessary,
    unnecessary: typeNets.unnecessary,
    income,
    previous_balance,
    available,
    spent,
    from_savings,
    debt,
    balance,
    expense_total: overview.expense_total,
    payment_groups,
    monthly_trend_points,
  });

  return {
    user_id: overview.user_id,
    month: overview.month,
    year: overview.year,
    date: overview.date,

    filter: {
      mode: "month",
      month: overview.month,
      year: overview.year,
      months: getMonths(),
      years: getYears(),
    },

    // Legacy flat card fields (preserved for existing consumers)
    income,
    earned,
    not_earned,
    previous_balance,
    from_savings,
    available,
    available_split,
    spent,
    debt,
    balance,
    necessary: typeNets.necessary,
    unnecessary: typeNets.unnecessary,

    // Canonical nested financial block (additive)
    financial,

    // Charts (prefer data.charts.*). polar_area kept at root for compatibility.
    // EMI details live under charts.spending_breakdown.emi / slices[key=emi]
    charts,
    polar_area: charts.polar_area,

    details: {
      previous_balance_manual: overview.previous_month_balance_manual,
      previous_balance_calculated: overview.previous_month_balance_calculated,
      savings_amount_saved: overview.savings_amount_saved,
      savings_amount_debited: overview.savings_amount_debited,
      expense_total: overview.expense_total,
      outgoing_payments_total: overview.outgoing_payments_total,
      debt_given_net: overview.debt_given_net,
      debt_received_net: overview.debt_received_net,
      debt_received_returned: overview.debt_received_returned,
      debt_received_repaid_this_month:
        overview.debt_received_repaid_this_month,
      debt_received_repaid_past_months:
        overview.debt_received_repaid_past_months,
      total_deductions: overview.total_deductions,
      dashboard_used_percentage:
        financial?.percentages?.dashboard_used_percentage ?? 0,
      necessary_share_percentage:
        financial?.percentages?.necessary_share_percentage ?? 0,
      saved_share_percentage:
        financial?.percentages?.saved_share_percentage ?? 0,
    },
  };
}

async function collectMonthlyTrendPoints(userId, year) {
  const overviews = await buildMonthOverviewsForCalendarYear(userId, year, {
    factsSource: "summary",
    extraMonths: [],
  });
  return collectTrendPointsFromOverviews(overviews, year);
}

async function buildDashboardForYear(userId, year) {
  let income = 0;
  let earned = 0;
  let not_earned = 0;
  let expenseTotal = 0;
  let outgoingPayments = 0;
  let fromSavings = 0;
  let debt = 0;
  let necessary = 0;
  let unnecessary = 0;
  let savingsSaved = 0;
  let savingsDebited = 0;
  let debtGivenNet = 0;
  let debtReceivedNet = 0;
  let previous_balance = 0;
  let previous_balance_manual = false;
  let balance = 0;
  let date = null;
  const monthly_trend_points = [];

  const overviews = await buildMonthOverviewsForCalendarYear(userId, year, {
    factsSource: "summary",
    extraMonths: [{ year: Number(year), month: 12 }],
  });
  const expenseCharts = await getExpenseChartsForYear(userId, year);
  const typeNetsByMonth = expenseCharts.typeNetsByMonth;

  for (let m = 1; m <= 12; m++) {
    const overview = overviews.get(yearMonthKey(year, m));
    if (!overview) continue;

    const typeNets = typeNetsByMonth[m - 1];

    if (m === 1) {
      previous_balance = overview.previous_month_balance;
      previous_balance_manual = overview.previous_month_balance_manual;
    }

    const monthSpent = roundMoney(
      overview.expense_total + overview.outgoing_payments_total
    );

    income = roundMoney(income + overview.salary);
    earned = roundMoney(earned + (overview.earned || 0));
    not_earned = roundMoney(not_earned + (overview.not_earned || 0));
    expenseTotal = roundMoney(expenseTotal + overview.expense_total);
    outgoingPayments = roundMoney(
      outgoingPayments + overview.outgoing_payments_total
    );
    fromSavings = roundMoney(fromSavings + overview.from_savings);
    debt = roundMoney(debt + overview.debt);
    necessary = roundMoney(necessary + typeNets.necessary);
    unnecessary = roundMoney(unnecessary + typeNets.unnecessary);
    savingsSaved = roundMoney(savingsSaved + overview.savings_amount_saved);
    savingsDebited = roundMoney(
      savingsDebited + overview.savings_amount_debited
    );
    debtGivenNet = roundMoney(debtGivenNet + overview.debt_given_net);
    debtReceivedNet = roundMoney(debtReceivedNet + overview.debt_received_net);

    monthly_trend_points.push({
      month: m,
      year: Number(year),
      income: overview.salary,
      earned: overview.earned || 0,
      not_earned: overview.not_earned || 0,
      spent: monthSpent,
      from_savings: overview.from_savings,
      debt: overview.debt,
      balance: overview.current_balance,
      expense_total: overview.expense_total,
      necessary: typeNets.necessary,
      unnecessary: typeNets.unnecessary,
    });

    if (m === 12) {
      balance = overview.current_balance;
      date = overview.date;
    }
  }

  // Available = earned + previous_month_balance
  const available = roundMoney(earned + previous_balance);
  const available_split = {
    total: available,
    earned,
    not_earned,
    previous: previous_balance,
  };
  const spent = roundMoney(expenseTotal + outgoingPayments);
  // Remaining = Incoming + Previous − Spent − Savings − Debt
  const total_deductions = roundMoney(fromSavings + spent + debt);

  const { start, end } = periodRange(year, null, "year");
  const polar_area = expenseCharts.polar_area;
  const payment_groups = await getOutgoingPaymentsGrouped(userId, start, end);

  const charts = buildChartsBundle({
    polar_area,
    necessary,
    unnecessary,
    income,
    previous_balance,
    available,
    spent,
    from_savings: fromSavings,
    debt,
    balance,
    expense_total: expenseTotal,
    payment_groups,
    monthly_trend_points,
  });

  return {
    user_id: Number(userId),
    month: null,
    year: Number(year),
    date,

    filter: {
      mode: "year",
      month: null,
      year: Number(year),
      months: getMonths(),
      years: getYears(),
    },

    income,
    earned,
    not_earned,
    previous_balance,
    from_savings: fromSavings,
    available,
    available_split,
    spent,
    debt,
    balance,
    necessary,
    unnecessary,

    charts,
    polar_area: charts.polar_area,

    details: {
      previous_balance_manual,
      savings_amount_saved: savingsSaved,
      savings_amount_debited: savingsDebited,
      expense_total: expenseTotal,
      outgoing_payments_total: outgoingPayments,
      debt_given_net: debtGivenNet,
      debt_received_net: debtReceivedNet,
      total_deductions,
      total_amount_to_spend: roundMoney(income + previous_balance),
    },
  };
}

// Dashboard — must be before /
// GET /api/overview/dashboard?user_id=1
// GET /api/overview/dashboard?user_id=1&month=8&year=2026
// GET /api/overview/dashboard?user_id=1&year=2026
router.get("/dashboard", async (req, res) => {
  try {
    const { user_id, month, year } = req.query;

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const parsed = parseDashboardPeriod(month, year);
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    const dashboard = await buildDashboard(
      user_id,
      parsed.year,
      parsed.month,
      parsed.mode
    );

    return success(res, dashboard, "Dashboard fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching dashboard");
  }
});

// Monthly overview
// GET /api/overview?user_id=1
// GET /api/overview?user_id=1&month=8&year=2026
router.get("/", async (req, res) => {
  try {
    const { user_id, month, year } = req.query;

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const parsed = parseMonthYear(month, year);
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    const overview = await buildMonthOverview(
      user_id,
      parsed.year,
      parsed.month
    );

    return success(res, overview, "Monthly overview fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching monthly overview");
  }
});

// Update previous month balance for a given month
// PUT|PATCH /api/overview/previous-balance
async function updatePreviousBalance(req, res) {
  try {
    const { user_id, month, year, previous_month_balance } = req.body;

    if (user_id === undefined || user_id === null || user_id === "") {
      return badRequest(res, "user_id is required");
    }

    if (
      previous_month_balance === undefined ||
      previous_month_balance === null ||
      previous_month_balance === ""
    ) {
      return badRequest(res, "previous_month_balance is required");
    }

    const balance = Number(previous_month_balance);
    if (Number.isNaN(balance)) {
      return badRequest(res, "previous_month_balance must be a number");
    }

    const parsed = parseMonthYear(month, year);
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    // Override row only. The 10 monthly_financial_summary facts are unchanged.
    const result = await db.query(
      `INSERT INTO monthly_balances (user_id, month, year, previous_month_balance, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, month, year)
       DO UPDATE SET
         previous_month_balance = EXCLUDED.previous_month_balance,
         updated_at = NOW()
       RETURNING id, user_id, month, year, previous_month_balance, updated_at`,
      [user_id, parsed.month, parsed.year, roundMoney(balance)]
    );

    const overview = await buildMonthOverview(
      user_id,
      parsed.year,
      parsed.month
    );

    return success(
      res,
      {
        previous_balance: {
          id: result.rows[0].id,
          user_id: result.rows[0].user_id,
          month: result.rows[0].month,
          year: result.rows[0].year,
          previous_month_balance: toAmount(
            result.rows[0].previous_month_balance
          ),
          updated_at: result.rows[0].updated_at,
        },
        overview,
      },
      "Previous month balance updated successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating previous month balance");
  }
}

router.put("/previous-balance", updatePreviousBalance);
router.patch("/previous-balance", updatePreviousBalance);

module.exports = router;
module.exports.buildDashboard = buildDashboard;
module.exports.buildMonthOverview = buildMonthOverview;
module.exports.buildMonthOverviewFromSource = buildMonthOverviewFromSource;
module.exports.buildMonthOverviewFromSummary = buildMonthOverviewFromSummary;
module.exports.parseMonthYear = parseMonthYear;
module.exports.parseDashboardPeriod = parseDashboardPeriod;
module.exports.getExpenseTypeNetsForMonth = getExpenseTypeNetsForMonth;
module.exports.getExpenseTypeNetsForYear = getExpenseTypeNetsForYear;
module.exports.getCategoryPolarArea = getCategoryPolarArea;
module.exports.getExpenseChartsForMonth = getExpenseChartsForMonth;
module.exports.getExpenseChartsForYear = getExpenseChartsForYear;
