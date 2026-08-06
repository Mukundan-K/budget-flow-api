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

const VALID_FILTERS = new Set(["day", "month", "year"]);

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function toDateOnly(date) {
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve inclusive date range from filter + selectors.
 * - day:   requires date=YYYY-MM-DD (calendar pick)
 * - month: requires month=1-12, optional year (default current)
 * - year:  requires year=YYYY
 */
function resolveFilterRange({ filter, date, month, year }) {
  const currentYear = new Date().getFullYear();

  if (filter === "day") {
    if (!date) {
      return { error: "date is required for day filter (YYYY-MM-DD)" };
    }
    const day = toDateOnly(date);
    if (!day) {
      return { error: "date must be a valid date (YYYY-MM-DD)" };
    }
    return { start: day, end: day };
  }

  if (filter === "month") {
    if (month === undefined || month === null || month === "") {
      return { error: "month is required for month filter (1-12)" };
    }
    if (!isValidMonth(month)) {
      return { error: "month must be an integer between 1 and 12" };
    }

    const selectedYear = year === undefined || year === null || year === ""
      ? currentYear
      : Number(year);

    if (!isValidYear(selectedYear)) {
      return { error: "year must be a valid year from the years master" };
    }

    const m = Number(month);
    const start = new Date(Date.UTC(selectedYear, m - 1, 1));
    const end = new Date(Date.UTC(selectedYear, m, 0));
    return { start: formatDate(start), end: formatDate(end) };
  }

  if (filter === "year") {
    if (year === undefined || year === null || year === "") {
      return { error: "year is required for year filter" };
    }
    if (!isValidYear(year)) {
      return { error: "year must be a valid year from the years master" };
    }

    const y = Number(year);
    const start = new Date(Date.UTC(y, 0, 1));
    const end = new Date(Date.UTC(y, 11, 31));
    return { start: formatDate(start), end: formatDate(end) };
  }

  return { error: "filter must be one of: day, month, year" };
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
  // Reject string labels like necessary/unnecessary/wanted/unwanted
  return null;
}

function toAmount(value) {
  const amount = Number(value);
  if (Number.isNaN(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function validateExpensePayload(body, { partial = false } = {}) {
  const errors = [];
  const { amount, expense_date, category, user_id } = body;
  const expense_type = parseExpenseType(body.expense_type);

  if (!partial || amount !== undefined) {
    if (amount === undefined || amount === null || amount === "") {
      errors.push("amount is required");
    } else if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
      errors.push("amount must be a positive number");
    }
  }

  if (body.expense_type !== undefined && body.expense_type !== null && body.expense_type !== "") {
    if (expense_type === null) {
      errors.push("expense_type must be a boolean (true or false)");
    }
  }

  if (!partial || category !== undefined) {
    if (!category || String(category).trim() === "") {
      errors.push("category is required");
    }
  }

  if (!partial || user_id !== undefined) {
    if (user_id === undefined || user_id === null || user_id === "") {
      errors.push("user_id is required");
    }
  }

  if (expense_date !== undefined && expense_date !== null && expense_date !== "") {
    if (Number.isNaN(Date.parse(expense_date))) {
      errors.push("expense_date must be a valid date (YYYY-MM-DD)");
    }
  }

  return errors;
}

// Create expense — 201
router.post("/", async (req, res) => {
  try {
    const errors = validateExpensePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const amount = req.body.amount;
    const expense_type = parseExpenseType(req.body.expense_type) ?? true;
    const expense_date = req.body.expense_date || todayDate();
    const category = String(req.body.category).trim();
    const user_id = req.body.user_id;

    const result = await db.query(
      `INSERT INTO expenses
       (amount, expense_type, expense_date, category, user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [amount, expense_type, expense_date, category, user_id]
    );

    return created(res, result.rows[0], "Expense created successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error creating expense");
  }
});

function groupExpensesByCategory(rows) {
  const byCategory = {};
  let necessaryTotal = 0;
  let unnecessaryTotal = 0;

  rows.forEach((exp) => {
    const categoryName = exp.category;
    const isNecessary = parseExpenseType(exp.expense_type) ?? true;
    const amount = toAmount(exp.amount);

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
      expense_type: isNecessary,
      amount,
    });

    if (isNecessary) {
      group.necessary_total = roundMoney(group.necessary_total + amount);
      necessaryTotal = roundMoney(necessaryTotal + amount);
    } else {
      group.unnecessary_total = roundMoney(group.unnecessary_total + amount);
      unnecessaryTotal = roundMoney(unnecessaryTotal + amount);
    }
  });

  return {
    necessary_total: necessaryTotal,
    unnecessary_total: unnecessaryTotal,
    grand_total: roundMoney(necessaryTotal + unnecessaryTotal),
    categories: Object.values(byCategory),
  };
}

function buildExpenseFilterQuery({ user_id, filter, date, month, year }) {
  const conditions = [];
  const params = [];

  if (user_id) {
    params.push(user_id);
    conditions.push(`user_id = $${params.length}`);
  }

  if (filter) {
    if (!VALID_FILTERS.has(filter)) {
      return { error: "filter must be one of: day, month, year" };
    }

    const range = resolveFilterRange({ filter, date, month, year });
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

function buildPieChartByCategory(rows) {
  const byCategory = {};
  let grandTotal = 0;

  rows.forEach((exp) => {
    const categoryName = exp.category;
    const amount = toAmount(exp.amount);
    const isNecessary = parseExpenseType(exp.expense_type) ?? true;

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
    grandTotal = roundMoney(grandTotal + amount);

    if (isNecessary) {
      group.necessary_total = roundMoney(group.necessary_total + amount);
    } else {
      group.unnecessary_total = roundMoney(group.unnecessary_total + amount);
    }
  });

  const slices = Object.values(byCategory)
    .map((group) => ({
      ...group,
      percentage:
        grandTotal > 0
          ? roundMoney((group.total / grandTotal) * 100)
          : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    grand_total: grandTotal,
    slices,
  };
}

function buildPieChartByType(rows) {
  let necessaryTotal = 0;
  let unnecessaryTotal = 0;

  rows.forEach((exp) => {
    const amount = toAmount(exp.amount);
    const isNecessary = parseExpenseType(exp.expense_type) ?? true;

    if (isNecessary) {
      necessaryTotal = roundMoney(necessaryTotal + amount);
    } else {
      unnecessaryTotal = roundMoney(unnecessaryTotal + amount);
    }
  });

  const grandTotal = roundMoney(necessaryTotal + unnecessaryTotal);

  const slices = [
    {
      label: "necessary",
      expense_type: true,
      total: necessaryTotal,
      percentage:
        grandTotal > 0
          ? roundMoney((necessaryTotal / grandTotal) * 100)
          : 0,
    },
    {
      label: "unnecessary",
      expense_type: false,
      total: unnecessaryTotal,
      percentage:
        grandTotal > 0
          ? roundMoney((unnecessaryTotal / grandTotal) * 100)
          : 0,
    },
  ].filter((slice) => slice.total > 0);

  return {
    grand_total: grandTotal,
    necessary_total: necessaryTotal,
    unnecessary_total: unnecessaryTotal,
    slices,
  };
}

// List expenses — 200
// Filters:
//   ?filter=day&date=YYYY-MM-DD
//   ?filter=month&month=1-12&year=YYYY   (year optional, defaults to current)
//   ?filter=year&year=YYYY
// Optional: ?user_id=1, ?flat=true
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

    if (flat === "true") {
      const items = result.rows.map((exp) => ({
        ...exp,
        expense_type: parseExpenseType(exp.expense_type) ?? true,
        amount: toAmount(exp.amount),
      }));
      return success(res, items, "Expenses fetched successfully");
    }

    const grouped = groupExpensesByCategory(result.rows);
    return success(res, grouped, "Expenses fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching expenses");
  }
});

// Pie charts — by category + necessary vs unnecessary (same filters as list)
// GET /api/expenses/pie-chart?filter=day&date=YYYY-MM-DD
// GET /api/expenses/pie-chart?filter=month&month=8&year=2026
// GET /api/expenses/pie-chart?filter=year&year=2026
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
      `SELECT category, amount, expense_type
       FROM expenses
       ${query.whereClause}
       ORDER BY category ASC`,
      query.params
    );

    return success(
      res,
      {
        by_category: buildPieChartByCategory(result.rows),
        by_type: buildPieChartByType(result.rows),
      },
      "Expense pie charts fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching expense pie chart");
  }
});

// Get one expense — 200
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM expenses WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    return success(res, result.rows[0], "Expense fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching expense");
  }
});

// Update expense — 200
router.put("/:id", async (req, res) => {
  try {
    const errors = validateExpensePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const amount = req.body.amount;
    const expense_type = parseExpenseType(req.body.expense_type) ?? true;
    const expense_date = req.body.expense_date || todayDate();
    const category = String(req.body.category).trim();
    const user_id = req.body.user_id;

    const result = await db.query(
      `UPDATE expenses
       SET amount = $1,
           expense_type = $2,
           expense_date = $3,
           category = $4,
           user_id = $5
       WHERE id = $6
       RETURNING *`,
      [amount, expense_type, expense_date, category, user_id, req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    return success(res, result.rows[0], "Expense updated successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating expense");
  }
});

// Partial update — 200
router.patch("/:id", async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT * FROM expenses WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    const errors = validateExpensePayload(req.body, { partial: true });
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const current = existing.rows[0];
    const amount = req.body.amount ?? current.amount;
    const parsedType = parseExpenseType(req.body.expense_type);
    const expense_type =
      parsedType !== undefined ? parsedType : current.expense_type;
    const expense_date = req.body.expense_date ?? current.expense_date;
    const category =
      req.body.category !== undefined
        ? String(req.body.category).trim()
        : current.category;
    const user_id = req.body.user_id ?? current.user_id;

    const result = await db.query(
      `UPDATE expenses
       SET amount = $1,
           expense_type = $2,
           expense_date = $3,
           category = $4,
           user_id = $5
       WHERE id = $6
       RETURNING *`,
      [amount, expense_type, expense_date, category, user_id, req.params.id]
    );

    return success(res, result.rows[0], "Expense updated successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating expense");
  }
});

// Delete expense — 200
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM expenses WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Expense not found");
    }

    return success(res, result.rows[0], "Expense deleted successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting expense");
  }
});

module.exports = router;
