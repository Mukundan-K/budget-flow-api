require("dotenv").config();

const express = require("express");
const db = require("../src/db");
const seedPayments = require("../src/seed/payments");
const seedSavings = require("../src/seed/savings");
const seedDebts = require("../src/seed/debts");
const seedDefaultCategories = require("../src/seed/defaultCategories");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const paymentRoutes = require("../src/routes/payment.routes");
const emiProductRoutes = require("../src/routes/emiProduct.routes");
const categoryRoutes = require("../src/routes/category.routes");
const paymentTypeRoutes = require("../src/routes/paymentType.routes");
const bankAccountRoutes = require("../src/routes/bankAccount.routes");
const personRoutes = require("../src/routes/person.routes");
const {
  COMPLETED_EMI_EDIT_MESSAGE,
  COMPLETED_EMI_DELETE_MESSAGE,
  COMPLETED_EMI_PAYMENT_MESSAGE,
  LINKED_EMI_DELETE_MESSAGE,
} = require("../src/services/financial");
const {
  CATEGORY_IN_USE_MESSAGE,
  PAYMENT_TYPE_IN_USE_MESSAGE,
  BANK_ACCOUNT_IN_USE_MESSAGE,
  PERSON_IN_USE_MESSAGE,
} = require("../src/services/deletionGuards");

const SUFFIX = `ecd_${Date.now()}`;

let userId;
let server;
let baseUrl;
let emiTypeId;
let createdEmiType = false;
let createdCategoryIds = [];
let createdPaymentTypeIds = [];

async function jsonRequest(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function insertEmi({
  name,
  alreadyPaid,
  numberOfEmis = 24,
  startDate = "2026-01-15",
}) {
  const result = await db.query(
    `INSERT INTO emi_products
       (user_id, product_name, emi_start_from, already_paid, number_of_emis)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, name, startDate, alreadyPaid, numberOfEmis]
  );
  return result.rows[0].id;
}

async function insertEmiPayment(emiProductId, paymentDate) {
  await db.query(
    `INSERT INTO payments
       (amount, payment_date, user_id, payment_type_id, emi_product_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [1000, paymentDate, userId, emiTypeId, emiProductId]
  );
}

async function safeDelete(sql, params) {
  try {
    await db.query(sql, params);
  } catch (err) {
    if (err.code !== "42P01") throw err;
  }
}

describe("completed EMI and linked deletion guards", () => {
  beforeAll(async () => {
    await seedPayments();
    await seedSavings();
    await seedDebts();
    await seedDefaultCategories();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ECD Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const existingEmiType = await db.query(
      `SELECT id FROM payment_types WHERE LOWER(name) = 'emi' LIMIT 1`
    );
    if (existingEmiType.rows.length) {
      emiTypeId = existingEmiType.rows[0].id;
    } else {
      const created = await db.query(
        `INSERT INTO payment_types (name, flow, is_income)
         VALUES ('EMI', 'outgoing', FALSE)
         RETURNING id`
      );
      emiTypeId = created.rows[0].id;
      createdEmiType = true;
    }

    const app = express();
    app.use(express.json());
    app.use("/api/payments", paymentRoutes);
    app.use("/api/emi-products", emiProductRoutes);
    app.use("/api/categories", categoryRoutes);
    app.use("/api/payment-types", paymentTypeRoutes);
    app.use("/api/bank-accounts", bankAccountRoutes);
    app.use("/api/persons", personRoutes);

    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }, 30000);

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (userId) {
      await safeDelete(`DELETE FROM expenses WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM payment_returns WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM payments WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM savings_transactions WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM debts WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM emi_products WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM persons WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM bank_accounts WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM monthly_financial_summary WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM monthly_balances WHERE user_id = $1`, [userId]);
      await safeDelete(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    if (createdCategoryIds.length) {
      await safeDelete(`DELETE FROM categories WHERE id = ANY($1::int[])`, [
        createdCategoryIds,
      ]);
    }
    if (createdPaymentTypeIds.length) {
      await safeDelete(`DELETE FROM payment_types WHERE id = ANY($1::int[])`, [
        createdPaymentTypeIds,
      ]);
    }
    if (createdEmiType && emiTypeId) {
      await safeDelete(`DELETE FROM payment_types WHERE id = $1`, [emiTypeId]);
    }
  }, 30000);

  test("24/24 EMI cannot be edited, deleted, selected, or paid again", async () => {
    const emiId = await insertEmi({
      name: `${SUFFIX}_iphone`,
      alreadyPaid: 8,
    });
    const months = [
      "2025-01-10",
      "2025-02-10",
      "2025-03-10",
      "2025-04-10",
      "2025-05-10",
      "2025-06-10",
      "2025-07-10",
      "2025-08-10",
      "2025-09-10",
      "2025-10-10",
      "2025-11-10",
      "2025-12-10",
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
      "2026-04-10",
    ];
    for (const month of months) {
      await insertEmiPayment(emiId, month);
    }

    const listed = await jsonRequest(
      "GET",
      `/api/emi-products?user_id=${userId}`
    );
    const product = listed.json.data.find((row) => row.id === emiId);
    expect(product.total_paid).toBe(24);
    expect(product.completed).toBe(true);

    const selectable = await jsonRequest(
      "GET",
      `/api/emi-products?user_id=${userId}&selectable=true`
    );
    expect(
      selectable.json.data.some((row) => row.id === emiId)
    ).toBe(false);

    const updated = await jsonRequest("PUT", `/api/emi-products/${emiId}`, {
      user_id: userId,
      product_name: `${SUFFIX}_iphone_updated`,
      start_date: "2026-01-15",
      already_paid: 8,
      number_of_emis: 24,
    });
    expect(updated.status).toBe(409);
    expect(updated.json.message).toBe(COMPLETED_EMI_EDIT_MESSAGE);

    const deleted = await jsonRequest(
      "DELETE",
      `/api/emi-products/${emiId}?user_id=${userId}`
    );
    expect(deleted.status).toBe(409);
    expect(deleted.json.message).toBe(COMPLETED_EMI_DELETE_MESSAGE);

    const payment = await jsonRequest("POST", "/api/payments", {
      amount: 1000,
      date: "2026-05-10",
      user_id: userId,
      payment_type_id: emiTypeId,
      emi: { emi_product_id: emiId },
    });
    expect(payment.status).toBe(409);
    expect(payment.json.message).toBe(COMPLETED_EMI_PAYMENT_MESSAGE);
  });

  test("23/24 EMI can be edited, selected, and paid", async () => {
    const emiId = await insertEmi({
      name: `${SUFFIX}_loan`,
      alreadyPaid: 23,
    });

    const listed = await jsonRequest(
      "GET",
      `/api/emi-products?user_id=${userId}`
    );
    const product = listed.json.data.find((row) => row.id === emiId);
    expect(product.total_paid).toBe(23);
    expect(product.completed).toBe(false);

    const selectable = await jsonRequest(
      "GET",
      `/api/emi-products?user_id=${userId}&selectable=true`
    );
    expect(selectable.json.data.some((row) => row.id === emiId)).toBe(true);

    const updated = await jsonRequest("PUT", `/api/emi-products/${emiId}`, {
      user_id: userId,
      product_name: `${SUFFIX}_loan_updated`,
      start_date: "2026-01-15",
      already_paid: 23,
      number_of_emis: 24,
    });
    expect(updated.status).toBe(200);

    const payment = await jsonRequest("POST", "/api/payments", {
      amount: 1000,
      date: "2026-05-10",
      user_id: userId,
      payment_type_id: emiTypeId,
      emi: { emi_product_id: emiId },
    });
    expect(payment.status).toBe(201);
  });

  test("dashboard Remaining EMIs is pending installment count, not money", async () => {
    const emiId = await insertEmi({
      name: `${SUFFIX}_dash_remaining`,
      alreadyPaid: 10,
      numberOfEmis: 24,
      startDate: "2025-01-15",
    });
    await insertEmiPayment(emiId, "2026-03-10");

    const { buildDashboard } = require("../src/routes/overview.routes");
    const dashboard = await buildDashboard(userId, 2026, 3, "month");
    const product = dashboard.emi_overview.products.find(
      (row) => Number(row.emi_product_id) === Number(emiId)
    );

    expect(product).toBeTruthy();
    expect(product.remaining).toBe(13);
    expect(product.total).toBe(1000);
    expect(product.remaining).not.toBe(product.total);
    expect(dashboard.emi_overview.products.reduce((sum, row) => sum + row.remaining, 0)).toBeGreaterThanOrEqual(13);
  });

  test("duplicate same-month payments still count as one installment", async () => {
    const emiId = await insertEmi({
      name: `${SUFFIX}_dup_month`,
      alreadyPaid: 8,
    });
    await insertEmiPayment(emiId, "2026-03-04");
    await insertEmiPayment(emiId, "2026-03-18");

    const listed = await jsonRequest(
      "GET",
      `/api/emi-products/${emiId}`
    );
    expect(listed.json.data.previously_paid).toBe(8);
    expect(listed.json.data.tracked_paid_months).toBe(1);
    expect(listed.json.data.total_paid).toBe(9);
    expect(listed.json.data.completed).toBe(false);
  });

  test("incomplete EMI with linked payments cannot be deleted", async () => {
    const emiId = await insertEmi({
      name: `${SUFFIX}_linked`,
      alreadyPaid: 2,
    });
    await insertEmiPayment(emiId, "2026-02-01");

    const deleted = await jsonRequest(
      "DELETE",
      `/api/emi-products/${emiId}?user_id=${userId}`
    );
    expect(deleted.status).toBe(409);
    expect(deleted.json.message).toBe(LINKED_EMI_DELETE_MESSAGE);
  });

  test("unlinked incomplete EMI can be deleted", async () => {
    const emiId = await insertEmi({
      name: `${SUFFIX}_unlinked`,
      alreadyPaid: 2,
    });

    const deleted = await jsonRequest(
      "DELETE",
      `/api/emi-products/${emiId}?user_id=${userId}`
    );
    expect(deleted.status).toBe(200);
  });

  test("linked category cannot be deleted and unlinked category can", async () => {
    const linked = await db.query(
      `INSERT INTO categories (name) VALUES ($1) RETURNING id, name`,
      [`${SUFFIX}_cat_linked`]
    );
    const unlinked = await db.query(
      `INSERT INTO categories (name) VALUES ($1) RETURNING id, name`,
      [`${SUFFIX}_cat_free`]
    );
    createdCategoryIds.push(linked.rows[0].id, unlinked.rows[0].id);

    await db.query(
      `INSERT INTO expenses (amount, expense_type, expense_date, category, user_id)
       VALUES (50, TRUE, NOW(), $1, $2)`,
      [linked.rows[0].name, userId]
    );

    const blocked = await jsonRequest(
      "DELETE",
      `/api/categories/${linked.rows[0].id}`
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toBe(CATEGORY_IN_USE_MESSAGE);

    const allowed = await jsonRequest(
      "DELETE",
      `/api/categories/${unlinked.rows[0].id}`
    );
    expect(allowed.status).toBe(200);
  });

  test("linked payment type cannot be deleted and unlinked payment type can", async () => {
    const linked = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'outgoing', FALSE)
       RETURNING id`,
      [`${SUFFIX}_pt_linked`]
    );
    const unlinked = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'outgoing', FALSE)
       RETURNING id`,
      [`${SUFFIX}_pt_free`]
    );
    createdPaymentTypeIds.push(linked.rows[0].id, unlinked.rows[0].id);

    await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES (25, NOW(), $1, $2)`,
      [userId, linked.rows[0].id]
    );

    const blocked = await jsonRequest(
      "DELETE",
      `/api/payment-types/${linked.rows[0].id}`
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toBe(PAYMENT_TYPE_IN_USE_MESSAGE);

    const allowed = await jsonRequest(
      "DELETE",
      `/api/payment-types/${unlinked.rows[0].id}`
    );
    expect(allowed.status).toBe(200);
  });

  test("linked bank account cannot be deleted and unlinked bank account can", async () => {
    const linked = await db.query(
      `INSERT INTO bank_accounts (user_id, name, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [userId, `${SUFFIX}_bank_linked`]
    );
    const unlinked = await db.query(
      `INSERT INTO bank_accounts (user_id, name, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [userId, `${SUFFIX}_bank_free`]
    );

    await db.query(
      `INSERT INTO savings_transactions
         (user_id, bank_account_id, amount, transaction_type, transaction_date)
       VALUES ($1, $2, 100, 'credit', NOW())`,
      [userId, linked.rows[0].id]
    );

    const blocked = await jsonRequest(
      "DELETE",
      `/api/bank-accounts/${linked.rows[0].id}`
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toBe(BANK_ACCOUNT_IN_USE_MESSAGE);

    const allowed = await jsonRequest(
      "DELETE",
      `/api/bank-accounts/${unlinked.rows[0].id}`
    );
    expect(allowed.status).toBe(200);
  });

  test("linked person cannot be deleted and unlinked person can", async () => {
    const linked = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, `${SUFFIX}_person_linked`]
    );
    const unlinked = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, `${SUFFIX}_person_free`]
    );

    await db.query(
      `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date)
       VALUES ($1, $2, 40, 'given', NOW())`,
      [userId, linked.rows[0].id]
    );

    const blocked = await jsonRequest(
      "DELETE",
      `/api/persons/${linked.rows[0].id}`
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toBe(PERSON_IN_USE_MESSAGE);

    const allowed = await jsonRequest(
      "DELETE",
      `/api/persons/${unlinked.rows[0].id}?user_id=${userId}`
    );
    expect(allowed.status).toBe(200);
  });
});
