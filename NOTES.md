# Budget Flow API — Notes

Reference for database tables, calculation equations, and every HTTP API.

Base URL: `http://localhost:5000`

## Architecture (financial calculations)

```text
Database
   ↓
src/services/financial/*   ← authoritative formulas
   ↓
Canonical values (net, remaining, percentages, …)
   ↓
Dashboard / Overview / Activity / domain routes
   ↓
Frontend (presentation only)
```

Central module: `src/services/financial/`

| File | Responsibility |
|------|----------------|
| `payment.service.js` | payment net / amounts |
| `expense.service.js` | expense net, contribution, split returns |
| `savings.service.js` | savings net |
| `debt.service.js` | outstanding, debt_net |
| `emi.service.js` | EMI progress % |
| `balance.service.js` | previous balance, monthly Remaining |
| `percentages.service.js` | used / necessary / saved shares |
| `financialSummary.service.js` | dashboard/activity shaping |
| `index.js` | barrel export |

Primary formula (single implementation in `calculateMonthlyBalance`):

```text
Remaining = Incoming + Previous − Spent − Savings − Debt
```

Run unit tests: `npm test`

---

Standard response shape:

```json
{ "status": 200, "message": "...", "data": ... }
```

| Status | Meaning |
|--------|---------|
| 200 | list / get / update / delete success |
| 201 | create success |
| 400 | validation / bad request |
| 401 | unauthorized |
| 403 | forbidden |
| 404 | not found |
| 409 | conflict (duplicate / in use) |
| 500 | server error |

---

## 1. Database tables

### Core

| Table | Purpose |
|-------|---------|
| `users` | Google OAuth users (`name`, `email`, `google_id`, `photo`, `refresh_token`) |
| `expenses` | Expense records (`amount`, `expense_type` boolean necessary/unnecessary, `expense_date`, `category`, `user_id`) |
| `monthly_balances` | Manual previous-month-balance overrides per `user_id` + `month` + `year` |

### Catalog / masters

| Table | Purpose |
|-------|---------|
| `categories` | Expense category master (`name`) |
| `payment_types` | Payment type master (`name`, `flow`, `is_income` — independent fields) |
| `persons` | Debt counterparty master (per user: `user_id`, `name`) |
| `bank_accounts` | Savings bank accounts (per user: `name`, `is_active`) |
| `emi_products` | EMI product catalog (per user: `product_name`, `emi_start_from`, `already_paid`, `number_of_emis`) |

### Detail / transactions

| Table | Purpose |
|-------|---------|
| `expense_category_splits` | Split one expense across categories (`expense_id`, `category`, `amount`, `expense_type`) |
| `expense_returns` | Partial returns against an expense category |
| `payments` | Income / outgoing payments (`amount`, `payment_date`, `payment_type_id`, optional `emi_product_id`) |
| `payment_returns` | Partial returns against a payment |
| `savings_transactions` | Credit/debit into a bank account (`transaction_type`: `credit` \| `debit`) |
| `debts` | Money given or received (`person_id`, `amount`, `debt_type`: `given` \| `received`, `debt_date`) |
| `debt_returns` | Repayments against a debt |

Static (code) masters — not DB tables:

- Months → `src/masters/month.master.js`
- Years → `src/masters/year.master.js`

---

## 2. Calculation equations

Amounts are net of returns unless noted. Money is rounded via `formatAmount` / `roundMoney`.

### Shared nets

```
payment.net_amount     = payment.amount − SUM(payment_returns.amount)
expense.net_amount     = expense.amount − SUM(expense_returns.amount)
debt.returned_amount   = SUM(debt_returns.amount)
debt.net_amount        = debt.amount − debt.returned_amount
debt.outstanding       = debt.net_amount
```

### Income / spent (per month)

```
Incoming (all)     = SUM(net payments where payment_type.flow = 'incoming')
  earned             = Incoming ∧ is_income = true
  not_earned         = Incoming ∧ is_income = false
Outgoing payments  = SUM(net payments where payment_type.flow = 'outgoing')

Available          = Incoming (= earned + not_earned)
available_split    = { total, earned, not_earned }
Spendable          = Incoming + previous_month_balance  (= total_amount_to_spend)
Expense total      = SUM(net expenses)
Total Spent        = Expense total + Outgoing payments
```

### Savings (per month / lifetime)

```
amount_saved (credited) = SUM(credits)
amount_debited          = SUM(debits)
from_savings / month_net = credited − debited
available_balance (bank) = lifetime credited − lifetime debited
```

`from_savings` used in Remaining is the **month net** (credited − debited) for that month.

### Debt (per month, reported only)

```
given_net     = given_total − given_returned     (returns dated this month)
received_net  = received_total − received_returned
debt (report) = given_net − received_net
```

Debt (`debt_net` = given_net − received_net) **is subtracted** from Remaining.

### Previous balance

```
previous_month_balance_calculated = previous month’s Remaining (current_balance)
previous_month_balance            = manual override if row exists in monthly_balances
                                    else previous_month_balance_calculated
previous_balance_manual           = true if monthly_balances row exists for that month
```

Chain starts from the user’s earliest activity month; each month’s Remaining becomes the next month’s calculated previous (unless overridden).

### Remaining (core balance)

```
Available (available / available_split.total) = Incoming (= earned + not_earned)
Spendable (total_amount_to_spend)             = Incoming + previous_month_balance
Total Spent                                   = Expense total + Outgoing payments
Total deductions                              = Total Spent + from_savings + Debt

Remaining (current_balance)                   = Spendable − Total Spent − from_savings − Debt
                                              = (Incoming + previous_month_balance) − Total Spent − Savings − Debt
```

Also exposed as:

- Overview / dashboard → `current_balance` / `balance`
- Activities → `months[].payments.bank_balance`

### Dashboard cards

```
income / incoming  = all flow=incoming (= earned + not_earned)
earned             = incoming ∧ is_income
not_earned         = incoming ∧ !is_income
available          = income (sum of incoming)
available_split    = { total, earned, not_earned }
previous_balance   = previous_month_balance (effective)
from_savings       = savings month_net
spent              = expense_total + outgoing_payments_total
debt               = given_net − received_net
total_amount_to_spend = income + previous_balance
balance / Remaining   = total_amount_to_spend − spent − from_savings − debt
```

### Activities month fields

```
previous_month_balance             = effective previous (manual or calculated)
previous_month_balance_calculated  = previous month Remaining
previous_balance_manual            = whether edited
payments.incoming_total            = Incoming for that month (flow=incoming)
payments.earned_total              = earned incoming (is_income)
payments.not_earned_total          = not-earned incoming
payments.outgoing_total            = Outgoing payments (flow=outgoing)
payments.bank_balance              = Remaining for that month
payments.savings_balance           = lifetime savings balance as of end of that month
                                    (all credits − all debits with date ≤ month end)
expenses.necessary_total           = sum of necessary category nets
expenses.unnecessary_total         = sum of unnecessary category nets
expenses.total                     = necessary_total + unnecessary_total
```

---

## 3. API list & explanations

### Auth — `/auth`

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/auth/google` | Start Google OAuth login |
| `GET` | `/auth/google/callback` | OAuth callback; issues access + refresh tokens, redirects to frontend |
| `POST` | `/auth/refresh-token` | Body `{ refreshToken }` → new access + refresh tokens (sliding 30-day session) |
| `GET` | `/auth/me` | Current user (requires Bearer access token) |
| `GET` | `/auth/user/:id` | Fetch user by id |
| `POST` | `/auth/logout` | Clears stored refresh token |

---

### Masters — `/api/masters`

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/api/masters?user_id=` | Bundle: months, years, payment_types, persons (persons need `user_id`) |
| `GET` | `/api/masters/months` | Month list (1–12) |
| `GET` | `/api/masters/years` | Year list |

---

### Categories — `/api/categories`

Expense category CRUD.

| Method | Path | Explanation |
|--------|------|-------------|
| `POST` | `/api/categories` | Create (`name`) |
| `GET` | `/api/categories` | List all |
| `GET` | `/api/categories/:id` | Get one |
| `PUT` / `PATCH` | `/api/categories/:id` | Update name |
| `DELETE` | `/api/categories/:id` | Delete |

---

### Payment types — `/api/payment-types`

| Method | Path | Explanation |
|--------|------|-------------|
| `POST` | `/api/payment-types` | Create `{ name, flow?, is_income? }` — `flow` and `is_income` are independent |
| `GET` | `/api/payment-types` | List (`?is_income=` and/or `?flow=incoming\|outgoing`) |
| `GET` | `/api/payment-types/:id` | Get one |
| `PUT` / `PATCH` | `/api/payment-types/:id` | Update |
| `DELETE` | `/api/payment-types/:id` | Delete (409 if used by payments) |

---

### Persons — `/api/persons`

Debt counterparty master (single-select source for debts).

| Method | Path | Explanation |
|--------|------|-------------|
| `POST` | `/api/persons` | Create `{ user_id, name }` |
| `GET` | `/api/persons?user_id=` | List for user |
| `GET` | `/api/persons/:id` | Get one |
| `PUT` / `PATCH` | `/api/persons/:id` | Update |
| `DELETE` | `/api/persons/:id` | Delete (409 if used by debts) |

---

### Bank accounts — `/api/bank-accounts`

| Method | Path | Explanation |
|--------|------|-------------|
| `POST` | `/api/bank-accounts` | Create `{ user_id, name, is_active? }` |
| `GET` | `/api/bank-accounts?user_id=` | List (optional `is_active`) |
| `GET` | `/api/bank-accounts/:id` | Get one |
| `PUT` / `PATCH` | `/api/bank-accounts/:id` | Update |
| `DELETE` | `/api/bank-accounts/:id` | Delete (409 if used by savings txns) |

---

### EMI products — `/api/emi-products`

Read-only list for payment EMI dropdown. Products are also created/updated via payment flows when needed.

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/api/emi-products?user_id=` | List products for user |
| `GET` | `/api/emi-products/:id` | Get one |

---

### Expenses — `/api/expenses`

Supports category splits and per-category returns.

| Method | Path | Explanation |
|--------|------|-------------|
| `POST` | `/api/expenses` | Create expense (optional splits) |
| `GET` | `/api/expenses` | List (`user_id`, date/month/year filters) |
| `GET` | `/api/expenses/pie-chart` | Category pie data for period |
| `GET` | `/api/expenses/:id` | Get one (+ splits/returns) |
| `PUT` / `PATCH` | `/api/expenses/:id` | Update |
| `DELETE` | `/api/expenses/:id` | Delete |
| `GET` | `/api/expenses/:id/returns` | List returns |
| `POST` | `/api/expenses/:id/returns` | Add return `{ amount, category, user_id, date? }` |
| `DELETE` | `/api/expenses/:id/returns/:returnId` | Delete return |

`expense_type`: `true` = necessary, `false` = unnecessary.

---

### Payments — `/api/payments`

Income and outgoing payments; optional EMI product link.

| Method | Path | Explanation |
|--------|------|-------------|
| `POST` | `/api/payments` | Create `{ amount, user_id, payment_type_id, date?, emi… }` |
| `GET` | `/api/payments` | List (`user_id`, type/date/month/year filters) |
| `GET` | `/api/payments/:id` | Get one (+ returns) |
| `PUT` / `PATCH` | `/api/payments/:id` | Update |
| `DELETE` | `/api/payments/:id` | Delete |
| `GET` | `/api/payments/:id/returns` | List returns |
| `POST` | `/api/payments/:id/returns` | Add return |
| `DELETE` | `/api/payments/:id/returns/:returnId` | Delete return |

Response includes `net_amount` = amount − returns.

---

### Savings — `/api/savings`

Credit/debit transactions against bank accounts.

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/api/savings/details?user_id=&month=&year=` | Per-bank saved/debited/month_net + lifetime `available_balance` |
| `POST` | `/api/savings` | Create `{ user_id, bank_account_id, amount, transaction_type, date? }` |
| `GET` | `/api/savings?user_id=` | List transactions (filters) |
| `GET` | `/api/savings/:id` | Get one |
| `PUT` / `PATCH` | `/api/savings/:id` | Update |
| `DELETE` | `/api/savings/:id` | Delete |

`transaction_type`: `credit` (save) \| `debit` (withdraw).

---

### Debts — `/api/debts`

Uses **single** `person_id` (from persons master).

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/api/debts/details?user_id=&month=&year=` | Given vs received totals, outstanding, item lists |
| `POST` | `/api/debts` | Create `{ user_id, person_id, amount, debt_type, date? }` |
| `GET` | `/api/debts?user_id=` | List (optional `person_id`, `debt_type`, date/month) |
| `GET` | `/api/debts/:id` | Get one (+ returns) |
| `PUT` / `PATCH` | `/api/debts/:id` | Update |
| `DELETE` | `/api/debts/:id` | Delete |
| `GET` | `/api/debts/:id/returns` | List returns |
| `POST` | `/api/debts/:id/returns` | Add repayment |
| `DELETE` | `/api/debts/:id/returns/:returnId` | Delete return |

`debt_type`: `given` (I lent) \| `received` (I borrowed).

Debt details equations:

```
given.outstanding     = SUM(given nets)
received.outstanding  = SUM(received nets)
debt_net              = given.outstanding − received.outstanding
```

---

### Overview — `/api/overview`

Month math engine (Remaining, previous balance, deductions).

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/api/overview?user_id=&month=&year=` | Raw month overview (incoming, prev, savings, debt, spent, Remaining) |
| `GET` | `/api/overview/dashboard?user_id=&month=&year=` | Same as `/api/dashboard` (cards + charts) |
| `PUT` / `PATCH` | `/api/overview/previous-balance` | Upsert manual previous balance |

**Edit previous balance body:**

```json
{
  "user_id": 1,
  "month": 8,
  "year": 2026,
  "previous_month_balance": 12500.5
}
```

Sets `previous_balance_manual = true` for that month. Without a row, previous = prior month Remaining.

---

### Dashboard — `/api/dashboard`

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/api/dashboard?user_id=` | Default: current month cards + charts |
| `GET` | `/api/dashboard?user_id=&month=&year=` | Month mode |
| `GET` | `/api/dashboard?user_id=&year=` | Year mode (aggregates + monthly trend) |

Returns: `income`, `previous_balance`, `from_savings`, `available`, `spent`, `debt`, `balance`, necessary/unnecessary, and `charts` (polar area, expense type, cashflow, spending breakdown, monthly trend).

---

### Activities — `/api/activities`

Month-grouped payments + expenses for UI timelines.

| Method | Path | Explanation |
|--------|------|-------------|
| `GET` | `/api/activities?user_id=&filter=month&month=&year=` | One month detail |
| `GET` | `/api/activities?user_id=&filter=year&year=` | All 12 months |
| `GET` | `/api/activities?user_id=&month=&year=` | Same as month filter |
| `GET` | `/api/activities?user_id=&year=` | Same as year filter |

Each `months[]` item includes:

- `previous_month_balance`, `previous_month_balance_calculated`, `previous_balance_manual`
- `payments` (categories, incoming/outgoing totals, `bank_balance` = Remaining, `savings_balance`)
- `expenses` (necessary / unnecessary groups + totals)

---

## 4. Quick formula cheat sheet

```
Incoming     = Σ income payment nets
Spent        = Σ expense nets + Σ outgoing payment nets
Savings      = credited − debited   (month)
Previous     = manual OR previous month Remaining
Spent        = Σ expense nets + Σ outgoing payment nets
Savings      = credited − debited   (month)
Debt         = given_net − received_net   (month)
Remaining    = Incoming + Previous − Spent − Savings − Debt

Next month’s calculated Previous = this month’s Remaining
```

---

## 5. Route mount map (`src/app.js`)

| Prefix | Router |
|--------|--------|
| `/auth` | `auth.js` |
| `/api/expenses` | `expense.routes.js` |
| `/api/categories` | `category.routes.js` |
| `/api/masters` | `master.routes.js` |
| `/api/payment-types` | `paymentType.routes.js` |
| `/api/payments` | `payment.routes.js` |
| `/api/emi-products` | `emiProduct.routes.js` |
| `/api/overview` | `overview.routes.js` |
| `/api/dashboard` | `dashboard.routes.js` |
| `/api/bank-accounts` | `bankAccount.routes.js` |
| `/api/savings` | `saving.routes.js` |
| `/api/debts` | `debt.routes.js` |
| `/api/persons` | `person.routes.js` |
| `/api/activities` | `activity.routes.js` |
| `/uploads` | static category icons |
