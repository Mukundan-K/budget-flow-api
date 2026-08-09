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
} = require("../utils/datetime");
const { getMonths, isValidMonth } = require("../masters/month.master");
const { getYears, isValidYear } = require("../masters/year.master");

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

async function getIncomeTotalForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.is_income = TRUE
       AND p.payment_date >= $2
       AND p.payment_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
}

async function getOutgoingPaymentsTotalForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.is_income = FALSE
       AND p.payment_date >= $2
       AND p.payment_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
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

async function getExpenseTotalForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT COALESCE(SUM(e.amount - COALESCE(ret.returned_amount, 0)), 0) AS total
     FROM expenses e
     LEFT JOIN (
       SELECT expense_id, SUM(amount) AS returned_amount
       FROM expense_returns
       GROUP BY expense_id
     ) ret ON ret.expense_id = e.id
     WHERE e.user_id = $1
       AND e.expense_date >= $2
       AND e.expense_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
}

/**
 * Necessary / unnecessary nets for the month (split-aware, after returns).
 */
async function getExpenseTypeNetsForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS necessary,
       COALESCE(SUM(CASE WHEN NOT t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS unnecessary
     FROM (
       SELECT
         COALESCE(s.expense_type, e.expense_type, TRUE) AS is_necessary,
         CASE
           WHEN s.id IS NULL THEN
             GREATEST(
               e.amount - COALESCE((
                 SELECT SUM(er.amount)
                 FROM expense_returns er
                 WHERE er.expense_id = e.id
               ), 0),
               0
             )
           ELSE
             GREATEST(s.amount - COALESCE(r.returned_amount, 0), 0)
         END AS net_amount
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
         AND e.expense_date <= $3
     ) t`,
    [userId, start, end]
  );

  return {
    necessary: toAmount(result.rows[0].necessary),
    unnecessary: toAmount(result.rows[0].unnecessary),
  };
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

async function getCategoryPolarArea(userId, start, end) {
  const result = await db.query(
    `SELECT
       t.category,
       COALESCE(SUM(t.net_amount), 0) AS total,
       COALESCE(SUM(CASE WHEN t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS necessary_total,
       COALESCE(SUM(CASE WHEN NOT t.is_necessary THEN t.net_amount ELSE 0 END), 0) AS unnecessary_total
     FROM (
       SELECT
         COALESCE(s.category, e.category) AS category,
         COALESCE(s.expense_type, e.expense_type, TRUE) AS is_necessary,
         CASE
           WHEN s.id IS NULL THEN
             GREATEST(
               e.amount - COALESCE((
                 SELECT SUM(er.amount)
                 FROM expense_returns er
                 WHERE er.expense_id = e.id
               ), 0),
               0
             )
           ELSE
             GREATEST(s.amount - COALESCE(r.returned_amount, 0), 0)
         END AS net_amount
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
         AND e.expense_date <= $3
     ) t
     GROUP BY t.category
     HAVING COALESCE(SUM(t.net_amount), 0) > 0
     ORDER BY total DESC`,
    [userId, start, end]
  );

  const slices = result.rows.map((row) => ({
    category: row.category,
    total: toAmount(row.total),
    necessary_total: toAmount(row.necessary_total),
    unnecessary_total: toAmount(row.unnecessary_total),
  }));

  const grand_total = roundMoney(
    slices.reduce((sum, s) => sum + s.total, 0)
  );

  const withPct = assignPolarAreaColors(
    slices.map((s) => ({
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

function periodRange(year, month, mode) {
  if (mode === "year") {
    const jan = monthRange(year, 1);
    const dec = monthRange(year, 12);
    return { start: jan.start, end: dec.end };
  }
  return monthRange(year, month);
}

function pct(part, whole) {
  return whole > 0 ? roundMoney((part / whole) * 100) : 0;
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
       ep.number_of_emis,
       COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total,
       COUNT(p.id)::int AS count
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN emi_products ep ON ep.id = p.emi_product_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.is_income = FALSE
       AND p.payment_date >= $2
       AND p.payment_date <= $3
     GROUP BY
       pt.id,
       pt.name,
       ep.id,
       ep.product_name,
       ep.emi_start_from,
       ep.already_paid,
       ep.number_of_emis
     HAVING COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) > 0
     ORDER BY total DESC`,
    [userId, start, end]
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
      const already_paid =
        row.already_paid != null ? Number(row.already_paid) : 0;
      const number_of_emis =
        row.number_of_emis != null ? Number(row.number_of_emis) : null;
      const remaining =
        number_of_emis != null
          ? Math.max(0, number_of_emis - already_paid)
          : null;

      group.groups.push({
        label: row.emi_product_name || "EMI",
        product_name: row.emi_product_name || "EMI",
        emi_product_id: row.emi_product_id || null,
        start_date: formatTimestamp(row.emi_start_from),
        already_paid,
        number_of_emis,
        remaining,
        emis_left: remaining,
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
  from_savings: "#0D9488", // teal
  debt: "#E11D48", // crimson
  balance: "#4F46E5", // indigo
};

function buildMonthlyTrendChart(points) {
  const months = getMonths();
  const labels = points.map(
    (p) => months.find((m) => m.id === p.month)?.short || String(p.month)
  );

  const series = [
    {
      name: "Income",
      key: "income",
      color: MONTHLY_TREND_COLORS.income,
      data: points.map((p) => p.income),
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
      name: "Debt",
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

/** Savings month net (credited − debited) — applied as from_savings in balance. */
async function getSavingsMonthNetForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) AS credited,
       COALESCE(SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END), 0) AS debited
     FROM savings_transactions
     WHERE user_id = $1
       AND transaction_date >= $2
       AND transaction_date <= $3`,
    [userId, start, end]
  );
  const credited = toAmount(result.rows[0].credited);
  const debited = toAmount(result.rows[0].debited);
  return {
    credited,
    debited,
    month_net: roundMoney(credited - debited),
  };
}

/** Debt month net for balance:
 * given_net − received_net
 * given_net     = given this month − returns on given this month
 * received_net  = received this month − repayments this month
 */
async function getDebtMonthNetForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);

  const given = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM debts
     WHERE user_id = $1
       AND debt_type = 'given'
       AND debt_date >= $2
       AND debt_date <= $3`,
    [userId, start, end]
  );

  const givenReturns = await db.query(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
     FROM debt_returns r
     JOIN debts d ON d.id = r.debt_id
     WHERE r.user_id = $1
       AND d.debt_type = 'given'
       AND r.return_date >= $2
       AND r.return_date <= $3`,
    [userId, start, end]
  );

  const received = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM debts
     WHERE user_id = $1
       AND debt_type = 'received'
       AND debt_date >= $2
       AND debt_date <= $3`,
    [userId, start, end]
  );

  const receivedReturns = await db.query(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
     FROM debt_returns r
     JOIN debts d ON d.id = r.debt_id
     WHERE r.user_id = $1
       AND d.debt_type = 'received'
       AND r.return_date >= $2
       AND r.return_date <= $3`,
    [userId, start, end]
  );

  const given_total = toAmount(given.rows[0].total);
  const given_returned = toAmount(givenReturns.rows[0].total);
  const received_total = toAmount(received.rows[0].total);
  const received_returned = toAmount(receivedReturns.rows[0].total);
  const given_net = roundMoney(given_total - given_returned);
  const received_net = roundMoney(received_total - received_returned);

  return {
    given_total,
    given_returned,
    given_net,
    received_total,
    received_returned,
    received_net,
    // Positive = money out of pocket from debt activity this month
    debt: roundMoney(given_net - received_net),
  };
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

async function findEarliestYearMonth(userId) {
  const result = await db.query(
    `
    SELECT MIN(d) AS earliest FROM (
      SELECT MIN(payment_date) AS d FROM payments WHERE user_id = $1
      UNION ALL
      SELECT MIN(expense_date) AS d FROM expenses WHERE user_id = $1
      UNION ALL
      SELECT MIN(transaction_date) AS d FROM savings_transactions WHERE user_id = $1
      UNION ALL
      SELECT MIN(debt_date) AS d FROM debts WHERE user_id = $1
      UNION ALL
      SELECT MAKE_DATE(year, month, 1) AS d FROM monthly_balances WHERE user_id = $1
    ) t
    `,
    [userId]
  );

  const earliest = result.rows[0]?.earliest;
  if (!earliest) return null;

  const date = new Date(earliest);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
}

async function buildMonthOverview(userId, year, month) {
  const target = { year: Number(year), month: Number(month) };
  const earliest = await findEarliestYearMonth(userId);

  let previousMonthBalance = 0;
  let cursor = earliest || target;

  if (earliest && compareYearMonth(target, earliest) < 0) {
    cursor = target;
  }

  while (compareYearMonth(cursor, target) <= 0) {
    const storedPrevious = await getStoredPreviousBalance(
      userId,
      cursor.year,
      cursor.month
    );
    if (storedPrevious !== null) {
      previousMonthBalance = storedPrevious;
    }

    const salary = await getIncomeTotalForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const outgoingPayments = await getOutgoingPaymentsTotalForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const expenseTotal = await getExpenseTotalForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    // From savings = month net (credited − debited)
    const savings = await getSavingsMonthNetForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const fromSavings = savings.month_net;
    const debtInfo = await getDebtMonthNetForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const debt = debtInfo.debt;
    // Balance = (Income + Prev.) − (from_savings + expenses + debt + outgoing)
    const totalAmountToSpend = roundMoney(salary + previousMonthBalance);
    const totalDeductions = roundMoney(
      fromSavings + expenseTotal + debt + outgoingPayments
    );
    const currentBalance = roundMoney(totalAmountToSpend - totalDeductions);

    if (cursor.year === target.year && cursor.month === target.month) {
      const latestSalary = await getLatestSalaryPayment(
        userId,
        cursor.year,
        cursor.month
      );
      const emiStats = await getEmiStatsForMonth(
        userId,
        cursor.year,
        cursor.month
      );

      return {
        user_id: Number(userId),
        month: cursor.month,
        year: cursor.year,
        date: latestSalary
          ? formatTimestamp(latestSalary.payment_date)
          : null,
        salary,
        previous_month_balance: previousMonthBalance,
        previous_month_balance_manual: storedPrevious !== null,
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
        total_amount_to_spend: totalAmountToSpend,
        total_deductions: totalDeductions,
        total_expenses: roundMoney(expenseTotal + outgoingPayments),
        expense_total: expenseTotal,
        outgoing_payments_total: outgoingPayments,
        emis: emiStats.emis,
        emi_count: emiStats.emi_count,
        current_balance: currentBalance,
      };
    }

    previousMonthBalance = currentBalance;
    cursor = nextMonth(cursor.year, cursor.month);
  }

  return null;
}

/**
 * Dashboard card payload — same month math as overview, clear labels for UI.
 * Available = Income + Prev. balance
 * Spent    = expenses (net) + outgoing payments (net)
 * Balance  = Available − From savings − Spent − Debt
 *
 * mode "month" → one month; mode "year" → full calendar year totals
 * charts: polar_area, expense_type, cashflow, spending_breakdown, monthly_trend
 */
async function buildDashboard(userId, year, month, mode = "month") {
  if (mode === "year") {
    return buildDashboardForYear(userId, year);
  }

  const overview = await buildMonthOverview(userId, year, month);
  if (!overview) return null;

  const typeNets = await getExpenseTypeNetsForMonth(userId, year, month);
  const { start, end } = periodRange(year, month, "month");
  const polar_area = await getCategoryPolarArea(userId, start, end);
  const payment_groups = await getOutgoingPaymentsGrouped(userId, start, end);
  const monthly_trend_points = await collectMonthlyTrendPoints(userId, year);

  const income = overview.salary;
  const previous_balance = overview.previous_month_balance;
  const from_savings = overview.from_savings;
  const available = overview.total_amount_to_spend;
  const spent = roundMoney(
    overview.expense_total + overview.outgoing_payments_total
  );
  const debt = overview.debt;
  const balance = overview.current_balance;

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

    income,
    previous_balance,
    from_savings,
    available,
    spent,
    debt,
    balance,
    necessary: typeNets.necessary,
    unnecessary: typeNets.unnecessary,

    // Charts (prefer data.charts.*). polar_area kept at root for compatibility.
    // EMI details live under charts.spending_breakdown.emi / slices[key=emi]
    charts,
    polar_area: charts.polar_area,

    details: {
      previous_balance_manual: overview.previous_month_balance_manual,
      savings_amount_saved: overview.savings_amount_saved,
      savings_amount_debited: overview.savings_amount_debited,
      expense_total: overview.expense_total,
      outgoing_payments_total: overview.outgoing_payments_total,
      debt_given_net: overview.debt_given_net,
      debt_received_net: overview.debt_received_net,
      total_deductions: overview.total_deductions,
    },
  };
}

async function collectMonthlyTrendPoints(userId, year) {
  const points = [];
  for (let m = 1; m <= 12; m++) {
    const overview = await buildMonthOverview(userId, year, m);
    if (!overview) continue;
    points.push({
      month: m,
      year: Number(year),
      income: overview.salary,
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

async function buildDashboardForYear(userId, year) {
  let income = 0;
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

  for (let m = 1; m <= 12; m++) {
    const overview = await buildMonthOverview(userId, year, m);
    if (!overview) continue;

    const typeNets = await getExpenseTypeNetsForMonth(userId, year, m);

    if (m === 1) {
      previous_balance = overview.previous_month_balance;
      previous_balance_manual = overview.previous_month_balance_manual;
    }

    const monthSpent = roundMoney(
      overview.expense_total + overview.outgoing_payments_total
    );

    income = roundMoney(income + overview.salary);
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

  const available = roundMoney(income + previous_balance);
  const spent = roundMoney(expenseTotal + outgoingPayments);
  const total_deductions = roundMoney(fromSavings + spent + debt);

  const { start, end } = periodRange(year, null, "year");
  const polar_area = await getCategoryPolarArea(userId, start, end);
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
    previous_balance,
    from_savings: fromSavings,
    available,
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
module.exports.parseMonthYear = parseMonthYear;
module.exports.parseDashboardPeriod = parseDashboardPeriod;
