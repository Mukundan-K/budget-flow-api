const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  badRequest,
  serverError,
} = require("../utils/response");
const { getMonths, isValidMonth } = require("../masters/month.master");
const { isValidYear } = require("../masters/year.master");
const { formatAmount, addAmounts } = require("../utils/money");
const {
  formatTimestamp,
  monthRangeTimestamps,
  toDateObject,
  getZonedCalendarParts,
} = require("../utils/datetime");
const { buildMonthOverview } = require("./overview.routes");
const {
  calculatePaymentAmounts,
  calculateExpenseAmounts,
  enrichEmiProduct,
  buildActivityMonthFinancials,
  calculateSavingsNet,
} = require("../services/financial");

function toAmount(value) {
  return formatAmount(value);
}

function roundMoney(value) {
  return formatAmount(value);
}

function parseExpenseType(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return null;
}

function calendarMonth(value) {
  const dateObj = toDateObject(value);
  if (!dateObj) return null;
  const parts = getZonedCalendarParts(dateObj);
  return parts.month || null;
}

function mapEmiProduct(row) {
  if (!row || !row.emi_product_id) return null;
  return enrichEmiProduct({
    id: row.emi_product_id,
    product_name: row.emi_product_name,
    start_date: formatTimestamp(row.emi_start_from),
    already_paid: row.already_paid != null ? Number(row.already_paid) : 0,
    number_of_emis:
      row.number_of_emis != null ? Number(row.number_of_emis) : null,
  });
}

function mapPayment(row) {
  const amounts = calculatePaymentAmounts({
    amount: row.amount,
    returned_amount: row.returned_amount || 0,
  });
  return {
    id: row.id,
    ...amounts,
    is_income: Boolean(row.payment_type_is_income),
    date: formatTimestamp(row.payment_date),
    user_id: row.user_id,
    payment_type_id: row.payment_type_id,
    payment_type: row.payment_type_name
      ? {
          id: row.payment_type_id,
          name: row.payment_type_name,
          flow:
            row.payment_type_flow === "incoming" ||
            row.payment_type_flow === "outgoing"
              ? row.payment_type_flow
              : Boolean(row.payment_type_is_income)
                ? "incoming"
                : "outgoing",
          is_income: Boolean(row.payment_type_is_income),
        }
      : undefined,
    emi_product_id: row.emi_product_id || null,
    product_name: row.emi_product_name || null,
    emi: mapEmiProduct(row),
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

function mapExpense(row, splits = null, returnsByCategory = {}) {
  const fallbackType = parseExpenseType(row.expense_type) ?? true;
  const categorySplits =
    splits ||
    [
      {
        category: row.category,
        amount: toAmount(row.amount),
        expense_type: fallbackType,
      },
    ];

  const amounts = calculateExpenseAmounts({
    amount: row.amount,
    headerReturnedAmount: row.returned_amount || 0,
    splits: categorySplits.map((s) => ({
      category: s.category,
      amount: s.amount,
      expense_type: parseExpenseType(s.expense_type) ?? fallbackType,
    })),
    returnsByCategory,
    fallbackExpenseType: fallbackType,
  });

  return {
    id: row.id,
    amount: amounts.amount,
    returned_amount: amounts.returned_amount,
    net_amount: amounts.net_amount,
    my_contribution: amounts.my_contribution,
    expense_type: amounts.categories[0]?.expense_type ?? fallbackType,
    expense_date: formatTimestamp(row.expense_date),
    date: formatTimestamp(row.expense_date),
    category: amounts.categories[0]?.category || row.category,
    categories: amounts.categories,
    is_split: amounts.is_split,
    note: row.note || null,
    user_id: row.user_id,
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

async function fetchSplitsByExpenseIds(expenseIds) {
  if (!expenseIds.length) return {};

  const result = await db.query(
    `SELECT expense_id, category, amount, expense_type, sort_order
     FROM expense_category_splits
     WHERE expense_id = ANY($1::int[])
     ORDER BY sort_order ASC, id ASC`,
    [expenseIds]
  );

  const byExpense = {};
  result.rows.forEach((row) => {
    if (!byExpense[row.expense_id]) byExpense[row.expense_id] = [];
    byExpense[row.expense_id].push({
      category: row.category,
      amount: toAmount(row.amount),
      expense_type: parseExpenseType(row.expense_type) ?? true,
    });
  });
  return byExpense;
}

async function fetchReturnsByExpenseIds(expenseIds) {
  if (!expenseIds.length) return {};

  const result = await db.query(
    `SELECT expense_id, category, SUM(amount) AS returned_amount
     FROM expense_returns
     WHERE expense_id = ANY($1::int[])
     GROUP BY expense_id, category`,
    [expenseIds]
  );

  const byExpense = {};
  result.rows.forEach((row) => {
    if (!byExpense[row.expense_id]) byExpense[row.expense_id] = {};
    byExpense[row.expense_id][row.category] = toAmount(row.returned_amount);
  });
  return byExpense;
}

async function mapExpensesWithSplits(rows) {
  const ids = rows.map((r) => r.id);
  const splitsMap = await fetchSplitsByExpenseIds(ids);
  const returnsMap = await fetchReturnsByExpenseIds(ids);

  return rows.map((row) =>
    mapExpense(
      row,
      splitsMap[row.id] || [
        {
          category: row.category,
          amount: toAmount(row.amount),
          expense_type: parseExpenseType(row.expense_type) ?? true,
        },
      ],
      returnsMap[row.id] || {}
    )
  );
}

/** Category splits on an expense (fallback to single category). */
function getExpenseSplits(expense) {
  if (expense.categories && expense.categories.length) {
    return expense.categories;
  }
  return [
    {
      category: expense.category,
      amount: expense.amount,
      expense_type: expense.expense_type,
      returned_amount: expense.returned_amount || 0,
      net_amount: expense.net_amount,
      my_contribution: expense.my_contribution ?? expense.net_amount,
    },
  ];
}

/**
 * Group expenses by category for necessary or unnecessary.
 * Each group: { category, total, count, expenses[] } — for table row expansion.
 */
function addExpenseToCategoryGroups(groupsMap, expense, isNecessary) {
  const splits = getExpenseSplits(expense).filter((s) =>
    isNecessary ? s.expense_type !== false : s.expense_type === false
  );
  if (!splits.length) return false;

  splits.forEach((split) => {
    const categoryName = split.category || "Uncategorized";
    const key = String(categoryName).toLowerCase();
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        category: categoryName,
        total: 0,
        count: 0,
        expenses: [],
      });
    }

    const group = groupsMap.get(key);
    const amount = toAmount(split.amount);
    const returned_amount = toAmount(split.returned_amount || 0);
    const net_amount = roundMoney(
      split.net_amount != null ? split.net_amount : amount - returned_amount
    );

    group.expenses.push({
      ...expense,
      amount,
      returned_amount,
      net_amount,
      my_contribution: net_amount,
      expense_type: isNecessary,
      category: categoryName,
      categories: [
        {
          ...split,
          category: categoryName,
          amount,
          returned_amount,
          net_amount,
          my_contribution: net_amount,
          expense_type: isNecessary,
        },
      ],
      is_split: false,
    });
    group.total = roundMoney(group.total + net_amount);
    group.count += 1;
  });

  return true;
}

function finalizeCategoryGroups(groupsMap) {
  return Array.from(groupsMap.values()).sort((a, b) => {
    const totalDiff = Number(b.total) - Number(a.total);
    if (totalDiff !== 0) return totalDiff;
    return String(a.category).localeCompare(String(b.category));
  });
}

/**
 * Group payments by payment type (category).
 * Each group: { category, total, count, is_income, payments[] }
 */
function addPaymentToCategoryGroups(groupsMap, payment) {
  const categoryName =
    payment.payment_type?.name ||
    payment.product_name ||
    "Uncategorized";
  const key = String(categoryName).toLowerCase();
  const is_income = Boolean(payment.payment_type?.is_income);
  const net = Number(payment.net_amount) || 0;

  if (!groupsMap.has(key)) {
    groupsMap.set(key, {
      category: categoryName,
      total: 0,
      count: 0,
      is_income,
      payments: [],
    });
  }

  const group = groupsMap.get(key);
  group.payments.push(payment);
  group.total = roundMoney(group.total + net);
  group.count += 1;
}

const PAYMENT_SELECT = `
  SELECT p.id, p.amount, p.payment_date, p.user_id, p.payment_type_id,
         p.emi_product_id, p.created_at,
         pt.name AS payment_type_name, pt.flow AS payment_type_flow,
         pt.is_income AS payment_type_is_income,
         ep.product_name AS emi_product_name,
         ep.emi_start_from,
         ep.already_paid,
         ep.number_of_emis,
         COALESCE(ret.returned_amount, 0) AS returned_amount
  FROM payments p
  JOIN payment_types pt ON pt.id = p.payment_type_id
  LEFT JOIN emi_products ep ON ep.id = p.emi_product_id
  LEFT JOIN (
    SELECT payment_id, SUM(amount) AS returned_amount
    FROM payment_returns
    GROUP BY payment_id
  ) ret ON ret.payment_id = p.id
`;

function buildMonthBuckets(year, monthFilter) {
  const monthsMaster = getMonths();
  const selected = monthFilter
    ? monthsMaster.filter((m) => m.id === monthFilter)
    : monthsMaster;

  return selected.map((m) => ({
    id: m.id,
    name: m.name,
    short: m.short,
    year,
    previous_month_balance: 0,
    previous_month_balance_calculated: 0,
    previous_balance_manual: false,
    payments: {
      categories: new Map(),
      incoming_total: 0,
      earned_total: 0,
      not_earned_total: 0,
      outgoing_total: 0,
      total: 0,
      count: 0,
      bank_balance: 0,
      savings_balance: 0,
    },
    expenses: {
      necessary: new Map(),
      unnecessary: new Map(),
      necessary_total: 0,
      unnecessary_total: 0,
      total: 0,
      count: 0,
      _expenseIds: new Set(),
    },
  }));
}

/**
 * Remaining balance for each month (same as overview current_balance):
 * (Incoming + Prev. balance) − Total Spent − Savings − Debt
 * Total Spent = expenses + outgoing payments
 * Debt = month debt_net (given_net − received_net)
 */
async function getOverviewBalancesForMonths(userId, year, monthIds) {
  const byMonth = new Map();
  await Promise.all(
    monthIds.map(async (monthId) => {
      const overview = await buildMonthOverview(userId, year, monthId);
      byMonth.set(monthId, {
        // Remaining for this month (feeds next month's calculated previous)
        bank_balance: overview ? roundMoney(overview.current_balance) : 0,
        // Effective previous (manual edit if set, else prev month Remaining)
        previous_month_balance: overview
          ? roundMoney(overview.previous_month_balance)
          : 0,
        previous_month_balance_calculated: overview
          ? roundMoney(overview.previous_month_balance_calculated)
          : 0,
        previous_balance_manual: overview
          ? Boolean(overview.previous_month_balance_manual)
          : false,
      });
    })
  );
  return byMonth;
}

/**
 * Savings bank balance total as of end of each month (credit − debit, all banks).
 */
async function getSavingsBalancesForMonths(userId, year, monthIds) {
  const byMonth = new Map();
  monthIds.forEach((monthId) => byMonth.set(monthId, 0));
  if (!monthIds.length) return byMonth;

  const lastMonth = Math.max(...monthIds);
  const { end: periodEnd } = monthRangeTimestamps(year, lastMonth);

  const txns = await db.query(
    `SELECT amount, transaction_type, transaction_date
     FROM savings_transactions
     WHERE user_id = $1
       AND transaction_date <= $2
     ORDER BY transaction_date ASC, id ASC`,
    [userId, periodEnd]
  );

  monthIds.forEach((monthId) => {
    const { end } = monthRangeTimestamps(year, monthId);
    const endMs = new Date(end).getTime();
    let credited = 0;
    let debited = 0;

    txns.rows.forEach((txn) => {
      const txnMs = new Date(txn.transaction_date).getTime();
      if (Number.isNaN(txnMs) || txnMs > endMs) return;
      const amount = toAmount(txn.amount);
      if (txn.transaction_type === "credit") {
        credited = roundMoney(credited + amount);
      } else if (txn.transaction_type === "debit") {
        debited = roundMoney(debited + amount);
      }
    });

    byMonth.set(monthId, roundMoney(credited - debited));
  });

  return byMonth;
}

/**
 * Resolve year/month filter for activities.
 * - filter=month|month  → that month (year defaults to current)
 * - filter=year|year    → full year
 * - neither             → current year
 */
function resolveActivityPeriod({ filter, month, year }) {
  const currentYear = new Date().getFullYear();
  const hasMonth = month !== undefined && month !== null && month !== "";
  const hasYear = year !== undefined && year !== null && year !== "";

  let effectiveFilter = filter || null;
  if (!effectiveFilter) {
    if (hasMonth) effectiveFilter = "month";
    else if (hasYear) effectiveFilter = "year";
    else effectiveFilter = "year"; // default: current year
  }

  if (effectiveFilter !== "month" && effectiveFilter !== "year") {
    return { error: "filter must be one of: month, year" };
  }

  if (effectiveFilter === "month") {
    if (!hasMonth) {
      return { error: "month is required for month filter (1-12)" };
    }
    if (!isValidMonth(month)) {
      return { error: "month must be an integer between 1 and 12" };
    }
    const selectedYear = hasYear ? Number(year) : currentYear;
    if (!isValidYear(selectedYear)) {
      return { error: "year must be a valid year from the years master" };
    }
    const selectedMonth = Number(month);
    return {
      mode: "month",
      year: selectedYear,
      month: selectedMonth,
      ...monthRangeTimestamps(selectedYear, selectedMonth),
    };
  }

  // year
  const selectedYear = hasYear ? Number(year) : currentYear;
  if (!isValidYear(selectedYear)) {
    return { error: "year must be a valid year from the years master" };
  }
  const jan = monthRangeTimestamps(selectedYear, 1);
  const dec = monthRangeTimestamps(selectedYear, 12);
  return {
    mode: "year",
    year: selectedYear,
    month: null,
    start: jan.start,
    end: dec.end,
  };
}

/**
 * GET /api/activities?user_id=1
 * GET /api/activities?user_id=1&year=2026
 * GET /api/activities?user_id=1&month=8&year=2026
 * GET /api/activities?user_id=1&filter=year&year=2026
 * GET /api/activities?user_id=1&filter=month&month=8&year=2026
 *
 * Returns months list; each month has payments + expenses.
 * Payment totals split into incoming (flow) / outgoing (flow),
 * and incoming further into earned (is_income) / not_earned.
 */
router.get("/", async (req, res) => {
  try {
    const { user_id, filter, month, year } = req.query;

    if (user_id === undefined || user_id === null || user_id === "") {
      return badRequest(res, "user_id is required");
    }

    const period = resolveActivityPeriod({ filter, month, year });
    if (period.error) {
      return badRequest(res, period.error);
    }

    const [paymentsResult, expensesResult] = await Promise.all([
      db.query(
        `${PAYMENT_SELECT}
         WHERE p.user_id = $1
           AND p.payment_date >= $2
           AND p.payment_date <= $3
         ORDER BY p.payment_date DESC, p.id DESC`,
        [user_id, period.start, period.end]
      ),
      db.query(
        `SELECT * FROM expenses
         WHERE user_id = $1
           AND expense_date >= $2
           AND expense_date <= $3
         ORDER BY expense_date DESC, id DESC`,
        [user_id, period.start, period.end]
      ),
    ]);

    const payments = paymentsResult.rows.map(mapPayment);
    const expenses = await mapExpensesWithSplits(expensesResult.rows);

    const buckets = buildMonthBuckets(period.year, period.month);
    const byMonth = new Map(buckets.map((b) => [b.id, b]));

    const [overviewByMonth, savingsByMonth] = await Promise.all([
      getOverviewBalancesForMonths(
        user_id,
        period.year,
        buckets.map((b) => b.id)
      ),
      getSavingsBalancesForMonths(
        user_id,
        period.year,
        buckets.map((b) => b.id)
      ),
    ]);

    payments.forEach((payment) => {
      const m = calendarMonth(payment.date);
      const bucket = byMonth.get(m);
      if (!bucket) return;

      addPaymentToCategoryGroups(bucket.payments.categories, payment);

      const net = payment.net_amount || 0;
      const flow = payment.payment_type?.flow;
      const isIncoming =
        flow === "incoming" ||
        (flow !== "outgoing" && Boolean(payment.payment_type?.is_income));

      if (isIncoming) {
        bucket.payments.incoming_total = roundMoney(
          bucket.payments.incoming_total + net
        );
        if (payment.payment_type?.is_income) {
          bucket.payments.earned_total = roundMoney(
            bucket.payments.earned_total + net
          );
        } else {
          bucket.payments.not_earned_total = roundMoney(
            bucket.payments.not_earned_total + net
          );
        }
      } else {
        bucket.payments.outgoing_total = roundMoney(
          bucket.payments.outgoing_total + net
        );
      }
      bucket.payments.count += 1;
      bucket.payments.total = roundMoney(
        bucket.payments.incoming_total + bucket.payments.outgoing_total
      );
    });

    buckets.forEach((bucket) => {
      const overviewBalances = overviewByMonth.get(bucket.id) || {
        bank_balance: 0,
        previous_month_balance: 0,
        previous_month_balance_calculated: 0,
        previous_balance_manual: false,
      };
      bucket.previous_month_balance = overviewBalances.previous_month_balance;
      bucket.previous_month_balance_calculated =
        overviewBalances.previous_month_balance_calculated;
      bucket.previous_balance_manual = overviewBalances.previous_balance_manual;
      bucket.payments.bank_balance = overviewBalances.bank_balance;
      bucket.payments.savings_balance = savingsByMonth.get(bucket.id) ?? 0;
    });

    expenses.forEach((expense) => {
      const m = calendarMonth(expense.date || expense.expense_date);
      const bucket = byMonth.get(m);
      if (!bucket) return;

      const addedNecessary = addExpenseToCategoryGroups(
        bucket.expenses.necessary,
        expense,
        true
      );
      const addedUnnecessary = addExpenseToCategoryGroups(
        bucket.expenses.unnecessary,
        expense,
        false
      );

      if (addedNecessary || addedUnnecessary) {
        bucket.expenses._expenseIds.add(expense.id);
      }

      let necessary_total = 0;
      bucket.expenses.necessary.forEach((g) => {
        necessary_total = roundMoney(necessary_total + g.total);
      });
      let unnecessary_total = 0;
      bucket.expenses.unnecessary.forEach((g) => {
        unnecessary_total = roundMoney(unnecessary_total + g.total);
      });

      bucket.expenses.necessary_total = necessary_total;
      bucket.expenses.unnecessary_total = unnecessary_total;
      bucket.expenses.total = roundMoney(necessary_total + unnecessary_total);
      bucket.expenses.count = bucket.expenses._expenseIds.size;
    });

    const months = buckets.map((bucket) => {
      const financial = buildActivityMonthFinancials({
        earned_total: bucket.payments.earned_total,
        not_earned_total: bucket.payments.not_earned_total,
        outgoing_total: bucket.payments.outgoing_total,
        expense_total: bucket.expenses.total,
        overviewBalances: {
          bank_balance: bucket.payments.bank_balance,
          savings_balance: bucket.payments.savings_balance,
          previous_month_balance: bucket.previous_month_balance,
          previous_month_balance_calculated:
            bucket.previous_month_balance_calculated,
          previous_balance_manual: bucket.previous_balance_manual,
        },
      });

      return {
        id: bucket.id,
        name: bucket.name,
        short: bucket.short,
        year: bucket.year,
        previous_month_balance: financial.previous_month_balance,
        previous_month_balance_calculated:
          financial.previous_month_balance_calculated,
        previous_balance_manual: financial.previous_balance_manual,
        // Canonical month financials (additive)
        incoming: financial.incoming,
        earned: financial.earned,
        not_earned: financial.not_earned,
        available: financial.available,
        outgoing: financial.outgoing,
        spent: financial.spent,
        bank_balance: financial.bank_balance,
        savings_balance: financial.savings_balance,
        payments: {
          categories: finalizeCategoryGroups(bucket.payments.categories),
          incoming_total: bucket.payments.incoming_total,
          earned_total: bucket.payments.earned_total,
          not_earned_total: bucket.payments.not_earned_total,
          outgoing_total: bucket.payments.outgoing_total,
          total: bucket.payments.total,
          count: bucket.payments.count,
          bank_balance: financial.bank_balance,
          savings_balance: financial.savings_balance,
        },
        expenses: {
          necessary: finalizeCategoryGroups(bucket.expenses.necessary),
          unnecessary: finalizeCategoryGroups(bucket.expenses.unnecessary),
          necessary_total: bucket.expenses.necessary_total,
          unnecessary_total: bucket.expenses.unnecessary_total,
          total: bucket.expenses.total,
          count: bucket.expenses.count,
        },
      };
    });

    return success(
      res,
      {
        filter: period.mode,
        year: period.year,
        month: period.month,
        months,
      },
      "Activities fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching activities");
  }
});

module.exports = router;
