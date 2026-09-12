require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const db = require("../src/db");
const seedDebts = require("../src/seed/debts");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const debtRoutes = require("../src/routes/debt.routes");

const SUFFIX = `dconcept_${Date.now()}`;
const YEAR = 2020;

let userId;
let personId;
let otherPersonId;
let server;
let baseUrl;

async function jsonRequest(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { raw: text.slice(0, 80) };
  }
  return { status: res.status, json };
}

describe("debt concept: four types stored only in debts", () => {
  beforeAll(async () => {
    await seedDebts();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Debt Concept", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const person = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, "John"]
    );
    personId = person.rows[0].id;

    const other = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, "David"]
    );
    otherPersonId = other.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/debts", debtRoutes);

    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (userId) {
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  test("application code no longer uses debt_returns or /returns", () => {
    const files = [
      "src/routes/debt.routes.js",
      "src/services/financial/debtTransactions.service.js",
      "src/services/financial/debtMonth.service.js",
      "src/seed/debts.js",
    ];
    files.forEach((rel) => {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      expect(src).not.toMatch(/debt_returns/);
      expect(src).not.toMatch(/allocateReturn/);
    });
    const routes = fs.readFileSync(
      path.join(__dirname, "..", "src/routes/debt.routes.js"),
      "utf8"
    );
    expect(routes).not.toMatch(/\/:id\/returns/);
  });

  test("four transaction types create debts rows and outstanding ignores month", async () => {
    const received = await jsonRequest("POST", "/api/debts/transactions", {
      user_id: userId,
      person_id: personId,
      transaction_type: "received",
      amount: 10000,
      date: `${YEAR}-01-01`,
    });
    expect(received.status).toBe(201);
    expect(received.json.data.transaction_type).toBe("received");
    expect(received.json.data.debt.debt_type).toBe("received");

    const given = await jsonRequest("POST", "/api/debts/transactions", {
      user_id: userId,
      person_id: personId,
      transaction_type: "given",
      amount: 4000,
      date: `${YEAR}-01-05`,
    });
    expect(given.status).toBe(201);

    const returnedByMe = await jsonRequest("POST", "/api/debts/transactions", {
      user_id: userId,
      person_id: personId,
      transaction_type: "returned_by_me",
      amount: 3000,
      transaction_date: `${YEAR}-09-11`,
    });
    expect(returnedByMe.status).toBe(201);
    expect(returnedByMe.json.data.debt.debt_type).toBe("returned_by_me");
    expect(returnedByMe.json.data.returns).toBeUndefined();

    const returnedToMe = await jsonRequest("POST", "/api/debts/transactions", {
      user_id: userId,
      person_id: personId,
      transaction_type: "returned_to_me",
      amount: 1000,
      date: `${YEAR}-09-15`,
    });
    expect(returnedToMe.status).toBe(201);
    expect(returnedToMe.json.data.debt.debt_type).toBe("returned_to_me");

    const stored = await db.query(
      `SELECT debt_type, COUNT(*)::int AS n
       FROM debts WHERE user_id = $1
       GROUP BY debt_type
       ORDER BY debt_type`,
      [userId]
    );
    expect(stored.rows).toEqual([
      { debt_type: "given", n: 1 },
      { debt_type: "received", n: 1 },
      { debt_type: "returned_by_me", n: 1 },
      { debt_type: "returned_to_me", n: 1 },
    ]);

    const original = await jsonRequest(
      "GET",
      `/api/debts/${received.json.data.debt.id}`
    );
    expect(original.json.data.amount).toBe(10000);
    expect(original.json.data.returned_amount).toBe(0);

    const outstanding = await jsonRequest(
      "GET",
      `/api/debts/outstanding?user_id=${userId}`
    );
    const john = outstanding.json.data.people.find((p) => p.person_name === "John");
    expect(john.i_owe_them).toBe(7000);
    expect(john.they_owe_me).toBe(3000);
    expect(john.net_amount).toBe(4000);
    expect(outstanding.json.data.i_owe_them).toBe(7000);
    expect(outstanding.json.data.they_owe_me).toBe(3000);
    expect(outstanding.json.data.net_amount).toBe(4000);

    const september = await jsonRequest(
      "GET",
      `/api/debts/summary?user_id=${userId}&year=${YEAR}&month=9`
    );
    expect(september.json.data.received_this_month).toBe(0);
    expect(september.json.data.given_this_month).toBe(0);
    expect(september.json.data.returned_by_me_this_month).toBe(3000);
    expect(september.json.data.returned_to_me_this_month).toBe(1000);

    const january = await jsonRequest(
      "GET",
      `/api/debts/summary?user_id=${userId}&year=${YEAR}&month=1`
    );
    expect(january.json.data.received_this_month).toBe(10000);
    expect(january.json.data.given_this_month).toBe(4000);
    expect(january.json.data.returned_by_me_this_month).toBe(0);
    expect(january.json.data.returned_to_me_this_month).toBe(0);

    const septemberTxns = await jsonRequest(
      "GET",
      `/api/debts/transactions?user_id=${userId}&year=${YEAR}&month=9`
    );
    expect(
      septemberTxns.json.data.map((row) => row.transaction_type).sort()
    ).toEqual(["returned_by_me", "returned_to_me"]);
    expect(
      septemberTxns.json.data.every((row) => row.transaction_source === "debt")
    ).toBe(true);
  });

  test("PUT /api/debts/:id updates all four types including type changes", async () => {
    const isolated = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Debt Update", `${SUFFIX}_put@example.com`, `${SUFFIX}_put`]
    );
    const isolatedUserId = isolated.rows[0].id;
    const person = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [isolatedUserId, "Mercy"]
    );
    const mercyId = person.rows[0].id;
    const other = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [isolatedUserId, "Anoop"]
    );
    const anoopId = other.rows[0].id;

    try {
      const created = await jsonRequest("POST", "/api/debts/transactions", {
        user_id: isolatedUserId,
        person_id: mercyId,
        transaction_type: "returned_by_me",
        amount: 500,
        date: `${YEAR}-09-01`,
      });
      expect(created.status).toBe(201);
      const debtId = created.json.data.debt.id;

      const updated = await jsonRequest("PUT", `/api/debts/${debtId}`, {
        user_id: isolatedUserId,
        person_id: anoopId,
        amount: 750,
        debt_type: "returned_to_me",
        date: `${YEAR}-07-15`,
      });
      expect(updated.status).toBe(200);
      expect(updated.json.data.debt_type).toBe("returned_to_me");
      expect(updated.json.data.transaction_type).toBe("returned_to_me");
      expect(updated.json.data.amount).toBe(750);
      expect(updated.json.data.person_id).toBe(anoopId);

      const july = await jsonRequest(
        "GET",
        `/api/debts/summary?user_id=${isolatedUserId}&year=${YEAR}&month=7`
      );
      const september = await jsonRequest(
        "GET",
        `/api/debts/summary?user_id=${isolatedUserId}&year=${YEAR}&month=9`
      );
      expect(july.json.data.returned_to_me_this_month).toBe(750);
      expect(september.json.data.returned_by_me_this_month).toBe(0);

      const deleted = await jsonRequest("DELETE", `/api/debts/${debtId}`);
      expect(deleted.status).toBe(200);
      const outstanding = await jsonRequest(
        "GET",
        `/api/debts/outstanding?user_id=${isolatedUserId}`
      );
      expect(outstanding.json.data.i_owe_them).toBe(0);
      expect(outstanding.json.data.they_owe_me).toBe(0);
    } finally {
      await db.query(`DELETE FROM users WHERE id = $1`, [isolatedUserId]);
    }
  });

  test("legacy /returns endpoints no longer exist", async () => {
    const given = await jsonRequest("POST", "/api/debts/transactions", {
      user_id: userId,
      person_id: otherPersonId,
      transaction_type: "given",
      amount: 2500,
      date: `${YEAR}-02-01`,
    });
    const debtId = given.json.data.debt.id;
    const post = await jsonRequest("POST", `/api/debts/${debtId}/returns`, {
      user_id: userId,
      amount: 100,
    });
    expect(post.status).toBe(404);
    const put = await jsonRequest("PUT", `/api/debts/${debtId}/returns/1`, {
      user_id: userId,
      amount: 100,
    });
    expect(put.status).toBe(404);
  });

  test("POST /transactions does not FIFO-split; multiple returns stay separate rows", async () => {
    const isolated = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Debt FIFO", `${SUFFIX}_fifo@example.com`, `${SUFFIX}_fifo`]
    );
    const isolatedUserId = isolated.rows[0].id;
    const person = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [isolatedUserId, "Amma"]
    );
    const ammaId = person.rows[0].id;

    try {
      await jsonRequest("POST", "/api/debts/transactions", {
        user_id: isolatedUserId,
        person_id: ammaId,
        transaction_type: "received",
        amount: 10000,
        date: `${YEAR}-07-10`,
      });
      await jsonRequest("POST", "/api/debts/transactions", {
        user_id: isolatedUserId,
        person_id: ammaId,
        transaction_type: "received",
        amount: 2000,
        date: `${YEAR}-07-12`,
      });
      await jsonRequest("POST", "/api/debts/transactions", {
        user_id: isolatedUserId,
        person_id: ammaId,
        transaction_type: "returned_by_me",
        amount: 100,
        transaction_date: `${YEAR}-09-01`,
      });
      await jsonRequest("POST", "/api/debts/transactions", {
        user_id: isolatedUserId,
        person_id: ammaId,
        transaction_type: "returned_by_me",
        amount: 200,
        transaction_date: `${YEAR}-09-10`,
      });
      await jsonRequest("POST", "/api/debts/transactions", {
        user_id: isolatedUserId,
        person_id: ammaId,
        transaction_type: "returned_by_me",
        amount: 300,
        transaction_date: `${YEAR}-09-20`,
      });

      const rows = await db.query(
        `SELECT amount::float8 AS amount
         FROM debts
         WHERE user_id = $1 AND debt_type = 'returned_by_me'
         ORDER BY debt_date, id`,
        [isolatedUserId]
      );
      expect(rows.rows.map((row) => row.amount)).toEqual([100, 200, 300]);
      expect(rows.rows).toHaveLength(3);

      const outstanding = await jsonRequest(
        "GET",
        `/api/debts/outstanding?user_id=${isolatedUserId}`
      );
      expect(outstanding.json.data.i_owe_them).toBe(11400);

      const july = await jsonRequest(
        "GET",
        `/api/debts/summary?user_id=${isolatedUserId}&year=${YEAR}&month=7`
      );
      const september = await jsonRequest(
        "GET",
        `/api/debts/summary?user_id=${isolatedUserId}&year=${YEAR}&month=9`
      );
      expect(july.json.data.returned_by_me_this_month).toBe(0);
      expect(september.json.data.returned_by_me_this_month).toBe(600);
    } finally {
      await db.query(`DELETE FROM users WHERE id = $1`, [isolatedUserId]);
    }
  });

  test("outstanding headlines are algebraic sums of person balances including negatives", async () => {
    const isolated = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Debt Outstanding", `${SUFFIX}_out@example.com`, `${SUFFIX}_out`]
    );
    const isolatedUserId = isolated.rows[0].id;

    async function addPerson(name) {
      const row = await db.query(
        `INSERT INTO persons (user_id, name) VALUES ($1, $2) RETURNING id`,
        [isolatedUserId, name]
      );
      return row.rows[0].id;
    }

    async function addTxn(personId, type, amount) {
      const res = await jsonRequest("POST", "/api/debts/transactions", {
        user_id: isolatedUserId,
        person_id: personId,
        transaction_type: type,
        amount,
        date: `${YEAR}-03-01`,
      });
      expect(res.status).toBe(201);
    }

    try {
      const alice = await addPerson("Alice");
      const bob = await addPerson("Bob");
      const carol = await addPerson("Carol");
      const dave = await addPerson("Dave");
      const eve = await addPerson("Eve");

      await addTxn(alice, "received", 1000);
      await addTxn(bob, "given", 800);
      await addTxn(carol, "received", 500);
      await addTxn(carol, "returned_by_me", 500);
      await addTxn(dave, "received", 200);
      await addTxn(dave, "returned_by_me", 350);
      await addTxn(eve, "given", 100);
      await addTxn(eve, "returned_to_me", 180);

      const outstanding = await jsonRequest(
        "GET",
        `/api/debts/outstanding?user_id=${isolatedUserId}`
      );
      expect(outstanding.status).toBe(200);
      const data = outstanding.json.data;
      const byName = Object.fromEntries(
        data.people.map((p) => [p.person_name, p])
      );

      expect(byName.Alice.i_owe_them).toBe(1000);
      expect(byName.Alice.they_owe_me).toBe(0);
      expect(byName.Bob.i_owe_them).toBe(0);
      expect(byName.Bob.they_owe_me).toBe(800);
      expect(byName.Carol).toBeUndefined();
      expect(byName.Dave.i_owe_them).toBe(-150);
      expect(byName.Dave.they_owe_me).toBe(0);
      expect(byName.Eve.i_owe_them).toBe(0);
      expect(byName.Eve.they_owe_me).toBe(-80);

      expect(data.i_owe_them).toBe(850);
      expect(data.they_owe_me).toBe(720);
      expect(data.net_amount).toBe(130);
      expect(data.net_amount).toBe(data.i_owe_them - data.they_owe_me);

      const fromPeopleIOwe = data.people.reduce((sum, p) => sum + p.i_owe_them, 0);
      const fromPeopleTheyOwe = data.people.reduce(
        (sum, p) => sum + p.they_owe_me,
        0
      );
      expect(fromPeopleIOwe).toBe(data.i_owe_them);
      expect(fromPeopleTheyOwe).toBe(data.they_owe_me);
    } finally {
      await db.query(`DELETE FROM users WHERE id = $1`, [isolatedUserId]);
    }
  });

  test("user 2 outstanding matches algebraic sums from debts when present", async () => {
    const exists = await db.query(`SELECT 1 FROM users WHERE id = 2`);
    if (!exists.rows.length) return;

    const sql = await db.query(`
      SELECT
        (COALESCE(SUM(CASE WHEN debt_type = 'received' THEN amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN debt_type = 'returned_by_me' THEN amount ELSE 0 END), 0))::float8 AS i_owe,
        (COALESCE(SUM(CASE WHEN debt_type = 'given' THEN amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN debt_type = 'returned_to_me' THEN amount ELSE 0 END), 0))::float8 AS they_owe
      FROM debts
      WHERE user_id = 2
    `);
    const iOwe = Number(sql.rows[0].i_owe);
    const theyOwe = Number(sql.rows[0].they_owe);

    const outstanding = await jsonRequest(
      "GET",
      "/api/debts/outstanding?user_id=2"
    );
    expect(outstanding.status).toBe(200);
    expect(outstanding.json.data.i_owe_them).toBe(iOwe);
    expect(outstanding.json.data.they_owe_me).toBe(theyOwe);
    expect(outstanding.json.data.net_amount).toBe(iOwe - theyOwe);
    expect(outstanding.json.data.net_amount).toBe(
      outstanding.json.data.i_owe_them - outstanding.json.data.they_owe_me
    );

    const fromPeopleIOwe = outstanding.json.data.people.reduce(
      (sum, p) => sum + p.i_owe_them,
      0
    );
    const fromPeopleTheyOwe = outstanding.json.data.people.reduce(
      (sum, p) => sum + p.they_owe_me,
      0
    );
    expect(fromPeopleIOwe).toBe(outstanding.json.data.i_owe_them);
    expect(fromPeopleTheyOwe).toBe(outstanding.json.data.they_owe_me);
  });
});
