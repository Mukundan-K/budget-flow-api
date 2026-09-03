const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  created,
  badRequest,
  notFound,
  serverError,
} = require("../utils/response");
const { isValidMonth } = require("../masters/month.master");
const { isValidYear } = require("../masters/year.master");
const { parseAmount, formatAmount, addAmounts } = require("../utils/money");
const {
  parseTimestamp,
  formatTimestamp,
  dayStart,
  dayEnd,
  monthRangeTimestamps,
} = require("../utils/datetime");
const { calculateExpenseAmounts } = require("../services/financial");

const VALID_FILTERS = new Set(["day", "month", "year"]);
const AMOUNT_EPSILON = 1e-8;
const NOTE_MAX_LENGTH = 500;

function todayDate() {
  return parseTimestamp(new Date());
}

function normalizeNote(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function amountsEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < AMOUNT_EPSILON;
}

/** Parse expense_type as boolean only. true / false (also 1/0, "true"/"false"). */
function parseExpenseType(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return null;
}

function toAmount(value) {
  const amount = parseAmount(value);
  return amount === null ? 0 : amount;
}

function roundMoney(value) {
  return formatAmount(value);
}

/**
 * Equal split of total across n parts; remainder goes to the last part.
 */
function splitEqually(total, count) {
  const totalNum = toAmount(total);
  if (count <= 0) return [];
  if (count === 1) return [totalNum];

  const parts = [];
  let allocated = 0;
  for (let i = 0; i < count - 1; i++) {
    const part = formatAmount(totalNum / count);
    parts.push(part);
    allocated = addAmounts(allocated, part);
  }
  parts.push(formatAmount(totalNum - allocated));
  return parts;
}

/**
 * Resolve category splits from body.
 * Supports:
 * - category: "Food" (+ amount) + optional expense_type / payment_type
 * - categories: ["Food", "Travel"]  → equal split; inherits top-level type
 * - categories: [{ category, amount, expense_type }, ...]
 *   expense_type (alias: payment_type) is per-category necessary/unnecessary
 */
function resolveCategorySplits(body, { partial = false, fallbackTotal } = {}) {
  const errors = [];
  const hasCategories = Array.isArray(body.categories);
  const hasCategory =
    body.category !== undefined && body.category !== null && body.category !== "";

  if (!partial && !hasCategories && !hasCategory) {
    return { errors: ["category or categories is required"] };
  }

  if (partial && !hasCategories && !hasCategory) {
    return { errors: [], splits: undefined };
  }

  const totalAmount =
    body.amount !== undefined && body.amount !== null && body.amount !== ""
      ? parseAmount(body.amount)
      : parseAmount(fallbackTotal);

  const topLevelTypeRaw =
    body.expense_type !== undefined && body.expense_type !== null && body.expense_type !== ""
      ? body.expense_type
      : body.payment_type;
  const parsedTopLevelType = parseExpenseType(topLevelTypeRaw);
  if (
    topLevelTypeRaw !== undefined &&
    topLevelTypeRaw !== null &&
    topLevelTypeRaw !== "" &&
    parsedTopLevelType === null
  ) {
    errors.push("expense_type must be a boolean (true or false)");
  }
  const defaultExpenseType = parsedTopLevelType ?? true;

  if (hasCategories) {
    if (body.categories.length === 0) {
      return { errors: ["categories must include at least one item"] };
    }

    const names = [];
    const rawAmounts = [];
    const types = [];
    let allHaveAmount = true;

    for (let i = 0; i < body.categories.length; i++) {
      const item = body.categories[i];

      if (typeof item === "string" || typeof item === "number") {
        const name = String(item).trim();
        if (!name) {
          errors.push(`categories[${i}] category name is required`);
          continue;
        }
        names.push(name);
        rawAmounts.push(null);
        types.push(defaultExpenseType);
        allHaveAmount = false;
        continue;
      }

      if (!item || typeof item !== "object") {
        errors.push(
          `categories[${i}] must be a string or { category, amount, expense_type }`
        );
        continue;
      }

      const name = String(item.category || item.name || "").trim();
      if (!name) {
        errors.push(`categories[${i}].category is required`);
        continue;
      }

      names.push(name);

      if (item.amount === undefined || item.amount === null || item.amount === "") {
        rawAmounts.push(null);
        allHaveAmount = false;
      } else {
        const amt = parseAmount(item.amount);
        if (amt === null || amt < 0) {
          errors.push(`categories[${i}].amount must be a non-negative number (0 allowed)`);
          rawAmounts.push(null);
        } else {
          rawAmounts.push(amt);
        }
      }

      const typeRaw =
        item.expense_type !== undefined &&
        item.expense_type !== null &&
        item.expense_type !== ""
          ? item.expense_type
          : item.payment_type;
      if (typeRaw !== undefined && typeRaw !== null && typeRaw !== "") {
        const parsed = parseExpenseType(typeRaw);
        if (parsed === null) {
          errors.push(
            `categories[${i}].expense_type must be a boolean (true or false)`
          );
          types.push(defaultExpenseType);
        } else {
          types.push(parsed);
        }
      } else {
        types.push(defaultExpenseType);
      }
    }

    const unique = new Set(names.map((n) => n.toLowerCase()));
    if (unique.size !== names.length) {
      errors.push("categories must not contain duplicate category names");
    }

    if (errors.length) {
      return { errors };
    }

    let amounts;
    if (allHaveAmount) {
      amounts = rawAmounts;
      const splitSum = addAmounts(...amounts);
      if (totalAmount !== null && !amountsEqual(splitSum, totalAmount)) {
        errors.push(
          `sum of category amounts (${splitSum}) must equal expense amount (${totalAmount})`
        );
      }
    } else if (rawAmounts.some((a) => a !== null)) {
      errors.push(
        "provide amount on every categories[] item, or omit all amounts for equal split"
      );
    } else {
      // Equal split — amount may be 0 (placeholder; returns/advances added first)
      if (totalAmount === null || totalAmount < 0) {
        errors.push("amount is required to split equally across categories");
      } else {
        amounts = splitEqually(totalAmount, names.length);
      }
    }

    if (errors.length) {
      return { errors };
    }

    const splits = names.map((category, index) => ({
      category,
      amount: formatAmount(amounts[index]),
      expense_type: types[index],
    }));

    return {
      errors: [],
      splits,
      primaryCategory: splits[0].category,
      primaryExpenseType: splits[0].expense_type,
      totalAmount:
        totalAmount !== null ? formatAmount(totalAmount) : addAmounts(...amounts),
    };
  }

  // Legacy single category
  const category = String(body.category).trim();
  if (!category) {
    return { errors: ["category is required"] };
  }
  if (totalAmount === null || totalAmount < 0) {
    if (!partial) {
      return { errors: ["amount is required"] };
    }
  }

  const amount =
    totalAmount !== null && totalAmount >= 0
      ? formatAmount(totalAmount)
      : undefined;

  if (amount === undefined) {
    return { errors: ["amount is required"] };
  }

  return {
    errors: [],
    splits: [{ category, amount, expense_type: defaultExpenseType }],
    primaryCategory: category,
    primaryExpenseType: defaultExpenseType,
    totalAmount: amount,
  };
}

function mapExpense(row, splits = null, returnsByCategory = {}) {
  if (!row) return row;

  const fallbackType = parseExpenseType(row.expense_type) ?? true;
  const categorySplits =
    splits ||
    (row.splits
      ? row.splits
      : [
          {
            category: row.category,
            amount: toAmount(row.amount),
            expense_type: fallbackType,
          },
        ]);

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
    category: amounts.categories[0]?.category || row.category,
    categories: amounts.categories,
    is_split: amounts.is_split,
    note: row.note || null,
    user_id: row.user_id,
    created_at: row.created_at,
  };
}

function mapExpenseReturn(row) {
  return {
    id: row.id,
    expense_id: row.expense_id,
    category: row.category,
    user_id: row.user_id,
    amount: toAmount(row.amount),
    date: formatTimestamp(row.return_date),
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

async function replaceExpenseSplits(client, expenseId, splits) {
  await client.query(`DELETE FROM expense_category_splits WHERE expense_id = $1`, [
    expenseId,
  ]);

  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    await client.query(
      `INSERT INTO expense_category_splits
         (expense_id, category, amount, expense_type, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        expenseId,
        split.category,
        split.amount,
        split.expense_type ?? true,
        i,
      ]
    );
  }

  // Drop returns for categories no longer on the expense
  await client.query(
    `DELETE FROM expense_returns er
     WHERE er.expense_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM expense_category_splits s
         WHERE s.expense_id = er.expense_id
           AND LOWER(s.category) = LOWER(er.category)
       )`,
    [expenseId]
  );
}

/**
 * Resolve inclusive date range from filter + selectors.
 */
function resolveFilterRange({ filter, date, month, year }) {
  const currentYear = new Date().getFullYear();

  if (filter === "day") {
    if (!date) {
      return { error: "date is required for day filter" };
    }
    const start = dayStart(date);
    const end = dayEnd(date);
    if (!start || !end) {
      return { error: "date must be a valid date or timestamp" };
    }
    return { start, end };
  }

  if (filter === "month") {
    if (month === undefined || month === null || month === "") {
      return { error: "month is required for month filter (1-12)" };
    }
    if (!isValidMonth(month)) {
      return { error: "month must be an integer between 1 and 12" };
    }

    const selectedYear =
      year === undefined || year === null || year === ""
        ? currentYear
        : Number(year);

    if (!isValidYear(selectedYear)) {
      return { error: "year must be a valid year from the years master" };
    }

    return monthRangeTimestamps(selectedYear, Number(month));
  }

  if (filter === "year") {
    if (year === undefined || year === null || year === "") {
      return { error: "year is required for year filter" };
    }
    if (!isValidYear(year)) {
      return { error: "year must be a valid year from the years master" };
    }

    const y = Number(year);
    const jan = monthRangeTimestamps(y, 1);
    const dec = monthRangeTimestamps(y, 12);
    return { start: jan.start, end: dec.end };
  }

  return { error: "filter must be one of: day, month, year" };
}

function validateExpensePayload(body, { partial = false } = {}) {
  const errors = [];
  const { amount, expense_date, user_id } = body;
  const expense_type = parseExpenseType(body.expense_type);

  if (!partial || amount !== undefined) {
    if (amount === undefined || amount === null || amount === "") {
      errors.push("amount is required");
    } else if (Number.isNaN(Number(amount)) || Number(amount) < 0) {
      errors.push("amount must be a non-negative number (0 allowed)");
    }
  }

  if (
    body.expense_type !== undefined &&
    body.expense_type !== null &&
    body.expense_type !== ""
  ) {
    if (expense_type === null) {
      errors.push("expense_type must be a boolean (true or false)");
    }
  }

  if (!partial || user_id !== undefined) {
    if (user_id === undefined || user_id === null || user_id === "") {
      errors.push("user_id is required");
    }
  }

  if (expense_date !== undefined && expense_date !== null && expense_date !== "") {
    if (parseTimestamp(expense_date) === null) {
      errors.push("expense_date must be a valid date or timestamp");
    }
  }

  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") {
      errors.push("note must be a string");
    } else if (body.note.trim().length > NOTE_MAX_LENGTH) {
      errors.push(`note must be at most ${NOTE_MAX_LENGTH} characters`);
    }
  }

  return errors;
}

function groupExpensesByCategory(mappedRows) {
  const byCategory = {};
  let necessaryTotal = 0;
  let unnecessaryTotal = 0;

  mappedRows.forEach((exp) => {
    const splits =
      exp.categories && exp.categories.length
        ? exp.categories
        : [
            {
              category: exp.category,
              amount: exp.amount,
              expense_type: exp.expense_type,
            },
          ];

    splits.forEach((split) => {
      const categoryName = split.category;
      const amount = toAmount(split.net_amount ?? split.amount);
      const isNecessary = parseExpenseType(split.expense_type) ?? true;

      if (!byCategory[categoryName]) {
        byCategory[categoryName] = {
          category: categoryName,
          total: 0,
          necessary_total: 0,
          unnecessary_total: 0,
          items: [],
        };
      }

      const group = byCategory[categoryName];
      group.total = roundMoney(group.total + amount);
      group.items.push({
        ...exp,
        category: categoryName,
        amount,
        expense_type: isNecessary,
        total_amount: exp.net_amount ?? exp.amount,
      });

      if (isNecessary) {
        group.necessary_total = roundMoney(group.necessary_total + amount);
        necessaryTotal = roundMoney(necessaryTotal + amount);
      } else {
        group.unnecessary_total = roundMoney(group.unnecessary_total + amount);
        unnecessaryTotal = roundMoney(unnecessaryTotal + amount);
      }
    });
  });

  return {
    necessary_total: necessaryTotal,
    unnecessary_total: unnecessaryTotal,
    grand_total: roundMoney(necessaryTotal + unnecessaryTotal),
    categories: Object.values(byCategory),
  };
}

function inferPeriodFilter({ filter, date, month, year }) {
  if (filter) return filter;

  const hasDate = date !== undefined && date !== null && date !== "";
  const hasMonth = month !== undefined && month !== null && month !== "";
  const hasYear = year !== undefined && year !== null && year !== "";

  if (hasDate) return "day";
  if (hasMonth) return "month";
  if (hasYear) return "year";
  return null;
}

function buildExpenseFilterQuery({ user_id, filter, date, month, year }) {
  const conditions = [];
  const params = [];

  if (user_id) {
    params.push(user_id);
    conditions.push(`user_id = $${params.length}`);
  }

  const effectiveFilter = inferPeriodFilter({ filter, date, month, year });
  if (effectiveFilter) {
    if (!VALID_FILTERS.has(effectiveFilter)) {
      return { error: "filter must be one of: day, month, year" };
    }

    const range = resolveFilterRange({
      filter: effectiveFilter,
      date,
      month,
      year,
    });
    if (range.error) {
      return { error: range.error };
    }

    params.push(range.start);
    conditions.push(`expense_date >= $${params.length}`);
    params.push(range.end);
    conditions.push(`expense_date <= $${params.length}`);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  return { whereClause, params };
}

function buildPieChartByCategory(mappedRows) {
  const byCategory = {};

  mappedRows.forEach((exp) => {
    const splits =
      exp.categories && exp.categories.length
        ? exp.categories
        : [
            {
              category: exp.category,
              amount: exp.amount,
              expense_type: exp.expense_type,
            },
          ];

    splits.forEach((split) => {
      const categoryName = split.category;
      const amount = toAmount(split.net_amount ?? split.amount);
      const isNecessary = parseExpenseType(split.expense_type) ?? true;

      if (!byCategory[categoryName]) {
        byCategory[categoryName] = {
          category: categoryName,
          total: 0,
          necessary_total: 0,
          unnecessary_total: 0,
        };
      }

      const group = byCategory[categoryName];
      group.total = roundMoney(group.total + amount);

      if (isNecessary) {
        group.necessary_total = roundMoney(group.necessary_total + amount);
      } else {
        group.unnecessary_total = roundMoney(group.unnecessary_total + amount);
      }
    });
  });

  const slices = Object.values(byCategory)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const grandTotal = roundMoney(
    slices.reduce((sum, group) => sum + group.total, 0)
  );

  return {
    grand_total: grandTotal,
    slices: slices.map((group) => ({
      ...group,
      percentage:
        grandTotal > 0 ? roundMoney((group.total / grandTotal) * 100) : 0,
    })),
  };
}

function buildPieChartByType(mappedRows) {
  let necessaryTotal = 0;
  let unnecessaryTotal = 0;

  mappedRows.forEach((exp) => {
    const splits =
      exp.categories && exp.categories.length
        ? exp.categories
        : [
            {
              category: exp.category,
              amount: exp.amount,
              expense_type: exp.expense_type,
            },
          ];

    splits.forEach((split) => {
      const amount = toAmount(split.net_amount ?? split.amount);
      if (parseExpenseType(split.expense_type) ?? true) {
        necessaryTotal = roundMoney(necessaryTotal + amount);
      } else {
        unnecessaryTotal = roundMoney(unnecessaryTotal + amount);
      }
    });
  });

  const grandTotal = roundMoney(necessaryTotal + unnecessaryTotal);

  const slices = [
    {
      label: "necessary",
      expense_type: true,
      total: necessaryTotal,
      percentage:
        grandTotal > 0 ? roundMoney((necessaryTotal / grandTotal) * 100) : 0,
    },
    {
      label: "unnecessary",
      expense_type: false,
      total: unnecessaryTotal,
      percentage:
        grandTotal > 0 ? roundMoney((unnecessaryTotal / grandTotal) * 100) : 0,
    },
  ].filter((slice) => slice.total > 0);

  return {
    grand_total: grandTotal,
    necessary_total: necessaryTotal,
    unnecessary_total: unnecessaryTotal,
    slices,
  };
}

// Create expense — 201
router.post("/", async (req, res) => {
  const client = await db.connect();
  try {
    const errors = validateExpensePayload(req.body);
    const resolved = resolveCategorySplits(req.body);
    const allErrors = [...errors, ...resolved.errors];
    if (allErrors.length) {
      return badRequest(res, allErrors.join(", "));
    }

    const amount = resolved.totalAmount;
    const expense_type = resolved.primaryExpenseType ?? true;
    const expense_date = parseTimestamp(req.body.expense_date) || todayDate();
    const category = resolved.primaryCategory;
    const user_id = req.body.user_id;
    const note = normalizeNote(req.body.note);

    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO expenses
       (amount, expense_type, expense_date, category, user_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [amount, expense_type, expense_date, category, user_id, note]
    );

    const expense = result.rows[0];
    await replaceExpenseSplits(client, expense.id, resolved.splits);
    await client.query("COMMIT");

    const [mapped] = await mapExpensesWithSplits([expense]);
    return created(res, mapped, "Expense created successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return serverError(res, "Error creating expense");
  } finally {
    client.release();
  }
});

// List expenses — 200
// GET /api/expenses?user_id=1&month=8&year=2026
// GET /api/expenses?user_id=1&year=2026
// GET /api/expenses?user_id=1&filter=month&month=8&year=2026
// GET /api/expenses?user_id=1&filter=year&year=2026
router.get("/", async (req, res) => {
  try {
    const { user_id, flat, filter, date, month, year } = req.query;

    const query = buildExpenseFilterQuery({
      user_id,
      filter,
      date,
      month,
      year,
    });
    if (query.error) {
      return badRequest(res, query.error);
    }

    const result = await db.query(
      `SELECT * FROM expenses
       ${query.whereClause}
       ORDER BY expense_date DESC, id DESC`,
      query.params
    );

    const mapped = await mapExpensesWithSplits(result.rows);

    if (flat === "true") {
      return success(res, mapped, "Expenses fetched successfully");
    }

    return success(
      res,
      groupExpensesByCategory(mapped),
      "Expenses fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching expenses");
  }
});

// Pie charts
router.get("/pie-chart", async (req, res) => {
  try {
    const { user_id, filter, date, month, year } = req.query;

    const query = buildExpenseFilterQuery({
      user_id,
      filter,
      date,
      month,
      year,
    });
    if (query.error) {
      return badRequest(res, query.error);
    }

    const result = await db.query(
      `SELECT * FROM expenses
       ${query.whereClause}
       ORDER BY category ASC`,
      query.params
    );

    const mapped = await mapExpensesWithSplits(result.rows);

    return success(
      res,
      {
        by_category: buildPieChartByCategory(mapped),
        by_type: buildPieChartByType(mapped),
      },
      "Expense pie charts fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching expense pie chart");
  }
});

// List returns for an expense
router.get("/:id/returns", async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    const [mapped] = await mapExpensesWithSplits(result.rows);
    const returns = await db.query(
      `SELECT * FROM expense_returns
       WHERE expense_id = $1
       ORDER BY return_date DESC, id DESC`,
      [req.params.id]
    );

    return success(
      res,
      {
        expense: mapped,
        returns: returns.rows.map(mapExpenseReturn),
      },
      "Expense returns fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching expense returns");
  }
});

// Add return against an expense category
router.post("/:id/returns", async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    const category = String(req.body.category || "").trim();
    if (!category) {
      return badRequest(res, "category is required");
    }

    const amount = parseAmount(req.body.amount);
    if (amount === null || amount <= 0) {
      return badRequest(res, "amount must be a positive number");
    }

    const [mapped] = await mapExpensesWithSplits(result.rows);
    const split = mapped.categories.find(
      (c) => c.category.toLowerCase() === category.toLowerCase()
    );
    if (!split) {
      return badRequest(res, "category is not part of this expense");
    }

    // Returns may exceed the category/paid amount (over-refund); net_amount can be negative.

    const user_id = req.body.user_id ?? mapped.user_id;
    if (String(user_id) !== String(mapped.user_id)) {
      return badRequest(res, "user_id does not match expense owner");
    }

    if (
      req.body.date !== undefined &&
      req.body.date !== null &&
      req.body.date !== ""
    ) {
      if (parseTimestamp(req.body.date) === null) {
        return badRequest(res, "date must be a valid date or timestamp");
      }
    }
    const return_date = parseTimestamp(req.body.date) || todayDate();

    const inserted = await db.query(
      `INSERT INTO expense_returns
         (expense_id, category, user_id, amount, return_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.params.id, split.category, user_id, amount, return_date]
    );

    const refreshed = await db.query(`SELECT * FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    const [updatedExpense] = await mapExpensesWithSplits(refreshed.rows);

    return created(
      res,
      {
        return: mapExpenseReturn(inserted.rows[0]),
        expense: updatedExpense,
      },
      "Expense return added successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error adding expense return");
  }
});

// Delete an expense return
router.delete("/:id/returns/:returnId", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM expense_returns
       WHERE id = $1 AND expense_id = $2
       RETURNING *`,
      [req.params.returnId, req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Expense return not found");
    }

    const expenseRows = await db.query(`SELECT * FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    const [expense] = expenseRows.rows.length
      ? await mapExpensesWithSplits(expenseRows.rows)
      : [null];

    return success(
      res,
      {
        return: mapExpenseReturn(result.rows[0]),
        expense,
      },
      "Expense return deleted successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting expense return");
  }
});

// Get one expense — 200
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    const [mapped] = await mapExpensesWithSplits(result.rows);
    const returns = await db.query(
      `SELECT * FROM expense_returns
       WHERE expense_id = $1
       ORDER BY return_date DESC, id DESC`,
      [req.params.id]
    );

    return success(
      res,
      {
        ...mapped,
        returns: returns.rows.map(mapExpenseReturn),
      },
      "Expense fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching expense");
  }
});

// Update expense — 200
router.put("/:id", async (req, res) => {
  const client = await db.connect();
  try {
    const errors = validateExpensePayload(req.body);
    const resolved = resolveCategorySplits(req.body);
    const allErrors = [...errors, ...resolved.errors];
    if (allErrors.length) {
      return badRequest(res, allErrors.join(", "));
    }

    const amount = resolved.totalAmount;
    const expense_type = resolved.primaryExpenseType ?? true;
    const expense_date = parseTimestamp(req.body.expense_date) || todayDate();
    const category = resolved.primaryCategory;
    const user_id = req.body.user_id;
    const note = normalizeNote(req.body.note);

    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE expenses
       SET amount = $1,
           expense_type = $2,
           expense_date = $3,
           category = $4,
           user_id = $5,
           note = $6
       WHERE id = $7
       RETURNING *`,
      [amount, expense_type, expense_date, category, user_id, note, req.params.id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return notFound(res, "Expense not found");
    }

    await replaceExpenseSplits(client, result.rows[0].id, resolved.splits);
    await client.query("COMMIT");

    const [mapped] = await mapExpensesWithSplits(result.rows);
    return success(res, mapped, "Expense updated successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return serverError(res, "Error updating expense");
  } finally {
    client.release();
  }
});

// Partial update — 200
router.patch("/:id", async (req, res) => {
  const client = await db.connect();
  try {
    const existing = await client.query(`SELECT * FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);

    if (existing.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    const errors = validateExpensePayload(req.body, { partial: true });
    const current = existing.rows[0];
    const amount =
      req.body.amount !== undefined ? req.body.amount : current.amount;

    const categoryFieldsProvided =
      req.body.categories !== undefined ||
      (req.body.category !== undefined &&
        req.body.category !== null &&
        req.body.category !== "");

    const resolved = categoryFieldsProvided
      ? resolveCategorySplits(
          { ...req.body, amount },
          { fallbackTotal: amount }
        )
      : { errors: [], splits: undefined };

    // If categories not sent, keep existing splits (rescale when amount changes)
    let splits = resolved.splits;
    if (splits === undefined) {
      const existingSplits = await fetchSplitsByExpenseIds([current.id]);
      const currentSplits =
        existingSplits[current.id] ||
        [
          {
            category: current.category,
            amount: toAmount(current.amount),
            expense_type: parseExpenseType(current.expense_type) ?? true,
          },
        ];

      const topTypeRaw =
        req.body.expense_type !== undefined &&
        req.body.expense_type !== null &&
        req.body.expense_type !== ""
          ? req.body.expense_type
          : req.body.payment_type;
      const patchedType = parseExpenseType(topTypeRaw);

      if (
        req.body.amount !== undefined &&
        !amountsEqual(toAmount(req.body.amount), toAmount(current.amount))
      ) {
        const newTotal = toAmount(req.body.amount);
        const oldTotal = toAmount(current.amount) || 1;
        const scaled = currentSplits.map((s, index, arr) => {
          if (index === arr.length - 1) {
            return {
              category: s.category,
              amount: 0,
              expense_type:
                patchedType !== undefined
                  ? patchedType
                  : parseExpenseType(s.expense_type) ?? true,
            };
          }
          return {
            category: s.category,
            amount: formatAmount((toAmount(s.amount) / oldTotal) * newTotal),
            expense_type:
              patchedType !== undefined
                ? patchedType
                : parseExpenseType(s.expense_type) ?? true,
          };
        });
        const allocated = addAmounts(
          ...scaled.slice(0, -1).map((s) => s.amount)
        );
        scaled[scaled.length - 1] = {
          category: currentSplits[currentSplits.length - 1].category,
          amount: formatAmount(newTotal - allocated),
          expense_type:
            patchedType !== undefined
              ? patchedType
              : parseExpenseType(
                  currentSplits[currentSplits.length - 1].expense_type
                ) ?? true,
        };
        splits = scaled;
      } else if (patchedType !== undefined) {
        // Apply top-level type to every split when categories not re-sent
        splits = currentSplits.map((s) => ({
          ...s,
          expense_type: patchedType,
        }));
      } else {
        splits = currentSplits;
      }
    }

    const allErrors = [...errors, ...(resolved.errors || [])];
    if (allErrors.length) {
      return badRequest(res, allErrors.join(", "));
    }

    const expense_type = splits[0].expense_type ?? true;
    const expense_date =
      req.body.expense_date !== undefined
        ? parseTimestamp(req.body.expense_date) || todayDate()
        : parseTimestamp(current.expense_date) || todayDate();
    const primaryCategory = splits[0].category;
    const totalAmount =
      req.body.amount !== undefined
        ? formatAmount(req.body.amount)
        : formatAmount(addAmounts(...splits.map((s) => s.amount)));
    const user_id = req.body.user_id ?? current.user_id;
    const note =
      req.body.note !== undefined ? normalizeNote(req.body.note) : current.note;

    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE expenses
       SET amount = $1,
           expense_type = $2,
           expense_date = $3,
           category = $4,
           user_id = $5,
           note = $6
       WHERE id = $7
       RETURNING *`,
      [totalAmount, expense_type, expense_date, primaryCategory, user_id, note, req.params.id]
    );

    await replaceExpenseSplits(client, result.rows[0].id, splits);
    await client.query("COMMIT");

    const [mapped] = await mapExpensesWithSplits(result.rows);
    return success(res, mapped, "Expense updated successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return serverError(res, "Error updating expense");
  } finally {
    client.release();
  }
});

// Delete expense — 200
router.delete("/:id", async (req, res) => {
  try {
    const existing = await db.query(`SELECT * FROM expenses WHERE id = $1`, [
      req.params.id,
    ]);
    if (existing.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    const [mapped] = await mapExpensesWithSplits(existing.rows);

    await db.query(`DELETE FROM expenses WHERE id = $1`, [req.params.id]);

    return success(res, mapped, "Expense deleted successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting expense");
  }
});

module.exports = router;
