# Learn this backend (Budget Flow API)

A beginner-friendly map of this project.  
If you know **MEAN** (MongoDB + Express + Angular + Node), this API is the **E + N** parts — Express + Node — talking to **PostgreSQL** instead of MongoDB. Angular (or any frontend) is a separate app that calls these URLs.

---

## 1. Big picture (what a backend does)

```text
Browser / Angular app
        │  HTTP request  (GET /api/expenses?user_id=2)
        ▼
   Node.js server  (this repo)
        │  SQL query
        ▼
   PostgreSQL database
        │  rows
        ▼
   Node calculates numbers (services)
        │  JSON response
        ▼
   Angular shows UI
```

**Your job as backend developer:** receive a request → validate → read/write DB → calculate business numbers → return JSON.

You do **not** build screens here. You build **APIs**.

---

## 2. MEAN → this project (mental bridge)

| MEAN idea | Here |
|-----------|------|
| Node.js | Same — JavaScript runtime |
| Express | Same — `src/app.js` + `src/routes/*` |
| MongoDB / Mongoose models | **PostgreSQL** + raw SQL via `pg` (`src/db.js`) |
| Angular | Separate frontend (not in this repo) |
| Controllers | Mostly inside **route files** |
| Services | `src/services/financial/*` (money formulas) |
| `.env` secrets | DB password, JWT secrets, Google OAuth |

**Module style:** CommonJS (`require` / `module.exports`), not `import`/`export`.

---

## 3. Folder tree (what each folder means)

```text
budget-flow-api/
├── package.json          ← dependencies + scripts (npm start / npm run dev / npm test)
├── .env                  ← secrets (never commit) — PORT, DB_*, JWT_*, FRONTEND_URL
├── NOTES.md              ← API + formula reference
├── LEARNING.md           ← this file
├── tests/                ← Jest unit tests for money formulas
├── uploads/              ← category icon files served as static files
└── src/                  ← ALL application code
    ├── app.js            ← ENTRY POINT — wires middleware + mounts routes + starts server
    ├── db.js             ← one shared PostgreSQL connection pool
    ├── config/           ← Passport Google OAuth setup
    ├── middleware/       ← e.g. JWT authenticate
    ├── routes/           ← HTTP endpoints (one file ≈ one feature)
    ├── services/         ← business calculations (no HTTP here)
    │   └── financial/    ← Remaining, nets, percentages, EMI progress
    ├── masters/          ← static lists (months, years) in code, not DB
    ├── utils/            ← helpers (money, dates, JSON response shape)
    ├── seed/             ← creates tables on startup if missing
    └── sql/              ← SQL reference files (human docs; seeds actually create tables)
```

### Learn folders in this order

1. `app.js` — how the server boots  
2. `db.js` — how DB is connected  
3. `utils/response.js` — how every JSON looks  
4. One simple route — e.g. `person.routes.js` (CRUD)  
5. `services/financial/` — where money math lives  
6. `overview.routes.js` / `activity.routes.js` — harder “report” APIs  

---

## 4. Entry point: `src/app.js`

When you run `npm run dev`, Node runs `src/app.js`.

What it does, step by step:

1. Load `.env` (`dotenv.config()`)
2. Create Express app (`express()`)
3. Add middleware:
   - `cors()` — allow Angular on another origin to call the API
   - `express.json()` — parse JSON body into `req.body`
   - static `/uploads` — serve image files
   - Passport — Google login
4. **Mount routes** — attach URL prefixes to routers:

| URL prefix | File |
|------------|------|
| `/auth` | `routes/auth.js` |
| `/api/expenses` | `routes/expense.routes.js` |
| `/api/categories` | `routes/category.routes.js` |
| `/api/masters` | `routes/master.routes.js` |
| `/api/payment-types` | `routes/paymentType.routes.js` |
| `/api/payments` | `routes/payment.routes.js` |
| `/api/emi-products` | `routes/emiProduct.routes.js` |
| `/api/overview` | `routes/overview.routes.js` |
| `/api/dashboard` | `routes/dashboard.routes.js` |
| `/api/bank-accounts` | `routes/bankAccount.routes.js` |
| `/api/savings` | `routes/saving.routes.js` |
| `/api/debts` | `routes/debt.routes.js` |
| `/api/persons` | `routes/person.routes.js` |
| `/api/activities` | `routes/activity.routes.js` |

5. Run **seeds** (create tables if needed)
6. `app.listen(PORT)` — server is live (e.g. `http://localhost:5000`)

**Example:**  
`GET /api/persons?user_id=2`  
→ Express matches prefix `/api/persons`  
→ runs handler inside `person.routes.js` for `GET /`

---

## 5. Database: `src/db.js`

```js
const { Pool } = require("pg");
const pool = new Pool({ /* from .env */ });
module.exports = pool;
```

- **PostgreSQL** = relational DB (tables, rows, SQL) — not Mongo collections.
- **Pool** = reusable connections (efficient).
- Routes do: `await db.query("SELECT ... WHERE id = $1", [id])`  
  `$1`, `$2` = **parameterized queries** (safe against SQL injection). Never glue user text into SQL with `+`.

Tables are listed in `NOTES.md` and `src/sql/schema.sql`.  
On startup, `src/seed/*.js` runs `CREATE TABLE IF NOT EXISTS ...`.

---

## 6. Standard API response: `src/utils/response.js`

Almost every endpoint returns:

```json
{
  "status": 200,
  "message": "Persons fetched successfully",
  "data": [ ... ]
}
```

Helpers:

| Helper | When |
|--------|------|
| `success(res, data, message)` | 200 OK |
| `created(res, data, message)` | 201 Created |
| `badRequest(res, message)` | 400 |
| `notFound(res, message)` | 404 |
| `conflict(res, message)` | 409 (duplicate / in use) |
| `serverError(res, message)` | 500 |

Angular should read `response.data` for the payload.

---

## 7. Routes = “controllers” (HTTP layer)

A route file typically:

```text
1. require express, db, response helpers, services
2. create router = express.Router()
3. define GET/POST/PUT/PATCH/DELETE handlers
4. module.exports = router
```

### Pattern of one handler (CRUD example)

```js
router.get("/", async (req, res) => {
  try {
    // 1) read query/body
    const { user_id } = req.query;
    if (!user_id) return badRequest(res, "user_id is required");

    // 2) talk to DB
    const result = await db.query(
      `SELECT * FROM persons WHERE user_id = $1 ORDER BY name`,
      [user_id]
    );

    // 3) return JSON
    return success(res, result.rows, "Persons fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching persons");
  }
});
```

### HTTP methods (REST)

| Method | Meaning | Example |
|--------|---------|---------|
| `GET` | Read | list / get one |
| `POST` | Create | new person / expense |
| `PUT` | Full update | replace fields |
| `PATCH` | Partial update | change only name |
| `DELETE` | Remove | delete by id |

### Easy vs hard routes

| Start here | Why |
|------------|-----|
| `person.routes.js` | Simple CRUD |
| `paymentType.routes.js` | Simple CRUD + flags |
| `category.routes.js` | CRUD + file upload |
| `payment.routes.js` | CRUD + returns + EMI |
| `expense.routes.js` | Splits + returns |
| `activity.routes.js` | Groups many rows by month |
| `overview.routes.js` | Month-by-month Remaining math |

---

## 8. Services = business brain (no HTTP)

`src/services/financial/` holds **formulas**, not URLs.

Example idea:

```text
Route: "user asked for August dashboard"
  → fetch income, expenses, savings from DB
  → call calculateMonthlyBalance({ incoming, previous, spent, savings })
  → put result in JSON
```

**Rule of this project:**

```text
Remaining = Incoming + Previous − Spent − Savings − Debt
```

Frontend should **display** `remaining` / `net_amount` — not re-implement the formula.

| Service file | Learns you… |
|--------------|-------------|
| `payment.service.js` | `net = amount − returned` |
| `expense.service.js` | same + splits |
| `savings.service.js` | `net = credited − debited` |
| `debt.service.js` | outstanding / debt_net |
| `balance.service.js` | Remaining + previous balance |
| `percentages.service.js` | used %, necessary share, etc. |

Run `npm test` to see formulas tested without starting the server.

---

## 9. Request lifecycle (follow one call)

Example: create a debt

```text
1. Angular POST http://localhost:5000/api/debts
   body: { user_id, person_id, amount, debt_type }

2. app.js → debt.routes.js  (POST "/")

3. Validate body (amount > 0, person_id exists for user)

4. db.query INSERT INTO debts ...

5. SELECT again + JOIN person name
   mapDebt() uses calculateDebtAmounts() from services

6. created(res, debtObject, "Debt created successfully")

7. Angular shows the new debt using data.net_amount
```

Auth example (Google):

```text
/auth/google → Google login
  → /auth/google/callback
  → JWT access + refresh tokens
  → redirect to FRONTEND_URL with tokens
```

Protected routes can use `middleware/authenticate.js` (Bearer JWT).

---

## 10. Supporting pieces

| Piece | Role |
|-------|------|
| `utils/money.js` | parse/format money numbers safely |
| `utils/datetime.js` | timestamps, month ranges |
| `masters/month.master.js` | Jan–Dec list |
| `masters/year.master.js` | year list |
| `config/passport.js` | Google OAuth strategy |
| `seed/*.js` | auto-create tables on boot |
| `sql/*.sql` | readable schema docs |

---

## 11. How to run & explore locally

```bash
npm install
# create .env with DB_* PORT JWT_* FRONTEND_URL GOOGLE_*
npm run dev          # nodemon — restarts on file change
```

Try in browser or Postman / Thunder Client:

```text
GET  http://localhost:5000/api/masters
GET  http://localhost:5000/api/persons?user_id=2
GET  http://localhost:5000/api/dashboard?user_id=2&month=8&year=2026
GET  http://localhost:5000/api/activities?user_id=2&filter=month&month=8&year=2026
```

Then open the matching route file and find `router.get(...)`.

---

## 12. Suggested learning path (practice)

### Week-style path

1. **Day 1 — Express basics**  
   Read `app.js`. Change a success message in `person.routes.js` and hit the API.

2. **Day 2 — CRUD**  
   Trace POST → GET → PATCH → DELETE for persons.  
   Watch rows in PostgreSQL (pgAdmin / DBeaver / `psql`).

3. **Day 3 — SQL**  
   Read one `db.query` in `payment.routes.js`.  
   Learn `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `$1` params.

4. **Day 4 — Services**  
   Open `balance.service.js`.  
   Run `npm test`. Change nothing — just read assertions in `tests/financial.test.js`.

5. **Day 5 — Reports**  
   Trace `GET /api/dashboard` → `dashboard.routes.js` → `buildDashboard` in overview → `calculateMonthlyBalance`.

6. **Day 6 — Auth**  
   Read `auth.js` + `middleware/authenticate.js` (JWT ideas).

### When you add a new feature

1. Need a new table? → seed + `sql/` reference  
2. Need CRUD URLs? → new `routes/xyz.routes.js` + mount in `app.js`  
3. Need money math? → put formula in `services/financial/`, call from route  
4. Document fields in `NOTES.md`

---

## 13. Common beginner mistakes

| Mistake | Better |
|---------|--------|
| Put formulas in Angular | Put in `services/financial` |
| String-concatenate SQL | Use `$1`, `$2` |
| Forget `try/catch` | Always catch and `serverError` |
| Return random JSON shapes | Use `success` / `created` helpers |
| Commit `.env` | Keep secrets local |
| Edit `node_modules` | Never |

---

## 14. Glossary

| Term | Meaning |
|------|---------|
| **API** | URL that returns data (not a webpage) |
| **Route** | One URL + method handler |
| **Router** | Group of routes for one feature |
| **Middleware** | Function that runs before the handler (auth, JSON parse) |
| **CRUD** | Create, Read, Update, Delete |
| **JWT** | Token proving the user is logged in |
| **Seed** | Code that prepares DB tables/data |
| **Pool** | Shared DB connections |
| **Net amount** | Amount after subtracting returns |
| **Remaining** | Month’s leftover money after income/spent/savings |

---

## 15. Where to look next

- Full API + equations: `NOTES.md`  
- Money formulas: `src/services/financial/`  
- Simplest CRUD to copy: `src/routes/person.routes.js`  
- Hardest report flow: `src/routes/overview.routes.js`

You do not need to memorize every file. Learn the **flow**:

```text
app.js → route → db.query → service calculate → response.json
```

Once that is clear, every feature in this project is a variation of the same pattern.
