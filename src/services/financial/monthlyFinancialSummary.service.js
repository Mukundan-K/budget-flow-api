/**
 * Derived monthly financial facts cache.
 * Source transaction tables remain authoritative.
 * Does not store Remaining / available / previous / percentages.
 */
const db = require("../../db");
const { getZonedCalendarParts } = require("../../utils/datetime");
const { toAmount, roundMoney } = require("./_helpers");
const {
  getIncomingBreakdownForMonth,
  getOutgoingPaymentsTotalForMonth,
  getExpenseTotalForMonth,
  getSavingsMonthNetForMonth,
  findEarliestYearMonth,
  findLatestYearMonth,
} = require("./monthFacts.query");
const { getDebtMonthNetForMonth } = require("./debtMonth.service");
const { calculateSavingsNet } = require("./savings.service");
const { calculateDebtSummary } = require("./debt.service");

const FACT_FIELDS = [
  "earned",
  "not_earned",
  "outgoing",
  "expenses",
  "savings_credited",
  "savings_debited",
  "given_total",
  "given_returned",
  "received_total",
  "received_returned",
];

const EMPTY_FACTS = {
  earned: 0,
  not_earned: 0,
  outgoing: 0,
  expenses: 0,
  savings_credited: 0,
  savings_debited: 0,
  given_total: 0,
  given_returned: 0,
  received_total: 0,
  received_returned: 0,
};

function nextYearMonth(year, month) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function compareYearMonth(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

function currentZonedYearMonth() {
  const parts = getZonedCalendarParts(new Date());
  return { year: parts.year, month: parts.month };
}

function mapFactsRow(row) {
  if (!row) return null;
  const facts = { ...EMPTY_FACTS };
  FACT_FIELDS.forEach((field) => {
    facts[field] = toAmount(row[field]);
  });
  return {
    id: row.id,
    user_id: Number(row.user_id),
    year: Number(row.year),
    month: Number(row.month),
    ...facts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function factsFromSources({
  incomingBreakdown,
  outgoing,
  expenses,
  savings,
  debtInfo,
}) {
  return {
    earned: toAmount(incomingBreakdown.earned),
    not_earned: toAmount(incomingBreakdown.not_earned),
    outgoing: toAmount(outgoing),
    expenses: toAmount(expenses),
    savings_credited: toAmount(savings.credited),
    savings_debited: toAmount(savings.debited),
    given_total: toAmount(debtInfo.given_total),
    given_returned: toAmount(debtInfo.given_returned),
    received_total: toAmount(debtInfo.received_total),
    received_returned: toAmount(debtInfo.received_returned),
  };
}

/**
 * Same 10 base values the Remaining engine uses for a month.
 * Does not compute Remaining / available / previous.
 */
async function computeMonthFacts(userId, year, month, client = db) {
  const incomingBreakdown = await getIncomingBreakdownForMonth(
    userId,
    year,
    month,
    client
  );
  const outgoing = await getOutgoingPaymentsTotalForMonth(
    userId,
    year,
    month,
    client
  );
  const expenses = await getExpenseTotalForMonth(userId, year, month, client);
  const savings = await getSavingsMonthNetForMonth(userId, year, month, client);
  const debtInfo = await getDebtMonthNetForMonth(userId, year, month, client);

  return factsFromSources({
    incomingBreakdown,
    outgoing,
    expenses,
    savings,
    debtInfo,
  });
}

async function rebuildMonthlyFinancialSummary(
  userId,
  year,
  month,
  client = db
) {
  await lockMonthlyFinancialSummary(userId, year, month, client);
  const facts = await computeMonthFacts(userId, year, month, client);

  const result = await client.query(
    `INSERT INTO monthly_financial_summary (
       user_id, year, month,
       earned, not_earned, outgoing, expenses,
       savings_credited, savings_debited,
       given_total, given_returned,
       received_total, received_returned,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6, $7,
       $8, $9,
       $10, $11,
       $12, $13,
       NOW(), NOW()
     )
     ON CONFLICT (user_id, year, month)
     DO UPDATE SET
       earned = EXCLUDED.earned,
       not_earned = EXCLUDED.not_earned,
       outgoing = EXCLUDED.outgoing,
       expenses = EXCLUDED.expenses,
       savings_credited = EXCLUDED.savings_credited,
       savings_debited = EXCLUDED.savings_debited,
       given_total = EXCLUDED.given_total,
       given_returned = EXCLUDED.given_returned,
       received_total = EXCLUDED.received_total,
       received_returned = EXCLUDED.received_returned,
       updated_at = NOW()
     RETURNING *`,
    [
      userId,
      year,
      month,
      facts.earned,
      facts.not_earned,
      facts.outgoing,
      facts.expenses,
      facts.savings_credited,
      facts.savings_debited,
      facts.given_total,
      facts.given_returned,
      facts.received_total,
      facts.received_returned,
    ]
  );

  return mapFactsRow(result.rows[0]);
}

async function getMonthlyFinancialSummary(userId, year, month, client = db) {
  const result = await client.query(
    `SELECT *
     FROM monthly_financial_summary
     WHERE user_id = $1 AND year = $2 AND month = $3`,
    [userId, year, month]
  );
  if (result.rows.length === 0) return null;
  return mapFactsRow(result.rows[0]);
}

function yearMonthKey(year, month) {
  return `${Number(year)}-${Number(month)}`;
}

/**
 * Transaction-scoped advisory lock for one summary key.
 * pg_advisory_xact_lock(int4, int4): (user_id, year * 12 + month).
 * users.id is SERIAL (int4). year*12+month is unique for month 1–12,
 * so different (user, year, month) keys cannot collide.
 * Released automatically on COMMIT / ROLLBACK. Same-session reentrant.
 * Callers must use an open transaction client; autocommit pool queries
 * release the lock at the end of that statement.
 */
function monthlySummaryLockKeys(userId, year, month) {
  const uid = Number(userId);
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error("invalid user_id for monthly summary lock");
  }
  if (!Number.isInteger(y)) {
    throw new Error("invalid year for monthly summary lock");
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error("invalid month for monthly summary lock");
  }
  return { userKey: uid, monthKey: y * 12 + m };
}

async function lockMonthlyFinancialSummary(userId, year, month, client) {
  const { userKey, monthKey } = monthlySummaryLockKeys(userId, year, month);
  await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
    userKey,
    monthKey,
  ]);
}

function uniqueSummaryTargets(targets) {
  const unique = [];
  const seen = new Set();
  for (const target of targets || []) {
    if (!target) continue;
    const userId = Number(target.user_id);
    const year = Number(target.year);
    const month = Number(target.month);
    if (!userId || !year || !month) continue;
    const key = `${userId}:${yearMonthKey(year, month)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ user_id: userId, year, month });
  }
  unique.sort((a, b) => {
    if (a.user_id !== b.user_id) return a.user_id - b.user_id;
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
  return unique;
}

function factsOrEmpty(row) {
  if (!row) return { ...EMPTY_FACTS };
  const facts = { ...EMPTY_FACTS };
  FACT_FIELDS.forEach((field) => {
    facts[field] = toAmount(row[field]);
  });
  return facts;
}

/**
 * Read-path helper: missing summary row → all 10 base facts are 0.
 * Does not fall back to source-table recalculation.
 */
async function getMonthlyFinancialSummaryOrEmpty(
  userId,
  year,
  month,
  client = db
) {
  const row = await getMonthlyFinancialSummary(userId, year, month, client);
  return factsOrEmpty(row);
}

async function loadMonthlyFinancialSummariesInRange(
  userId,
  from,
  to,
  client = db
) {
  const result = await client.query(
    `SELECT *
     FROM monthly_financial_summary
     WHERE user_id = $1
       AND (year > $2 OR (year = $2 AND month >= $3))
       AND (year < $4 OR (year = $4 AND month <= $5))`,
    [userId, from.year, from.month, to.year, to.month]
  );
  const map = new Map();
  result.rows.forEach((row) => {
    map.set(yearMonthKey(row.year, row.month), factsOrEmpty(row));
  });
  return map;
}

/**
 * Map.has() is required: previous_month_balance = 0 is a valid override.
 */
async function loadStoredPreviousBalancesInRange(
  userId,
  from,
  to,
  client = db
) {
  const result = await client.query(
    `SELECT year, month, previous_month_balance
     FROM monthly_balances
     WHERE user_id = $1
       AND (year > $2 OR (year = $2 AND month >= $3))
       AND (year < $4 OR (year = $4 AND month <= $5))`,
    [userId, from.year, from.month, to.year, to.month]
  );
  const map = new Map();
  result.rows.forEach((row) => {
    map.set(
      yearMonthKey(row.year, row.month),
      toAmount(row.previous_month_balance)
    );
  });
  return map;
}

/**
 * 10 stored facts → existing derived nets used by Remaining.
 * repaid this/past month are live overlays, not summary columns.
 */
function monthInputsFromFacts(facts, repaid = {}) {
  const f = factsOrEmpty(facts);
  const savingsNet = calculateSavingsNet(f.savings_credited, f.savings_debited);
  const debtInfo = calculateDebtSummary({
    given_total: f.given_total,
    given_returned: f.given_returned,
    received_total: f.received_total,
    received_returned: f.received_returned,
    received_repaid_this_month: repaid.received_repaid_this_month || 0,
    received_repaid_past_months: repaid.received_repaid_past_months || 0,
  });
  return {
    earned: f.earned,
    not_earned: f.not_earned,
    incoming: roundMoney(f.earned + f.not_earned),
    outgoing: f.outgoing,
    expenses: f.expenses,
    savings: {
      credited: f.savings_credited,
      debited: f.savings_debited,
      month_net: savingsNet,
    },
    debtInfo,
  };
}

function maxYearMonth(a, b) {
  if (!a) return b;
  if (!b) return a;
  return compareYearMonth(a, b) >= 0 ? a : b;
}

/**
 * Inclusive range: earliest activity through the later of last activity and
 * the current calendar month in APP_TIMEZONE.
 */
async function resolveBackfillRange(userId, client = db) {
  const earliest = await findEarliestYearMonth(userId, client);
  const latestActivity = await findLatestYearMonth(userId, client);
  const current = currentZonedYearMonth();
  const end = maxYearMonth(latestActivity, current);
  const start = earliest || current;
  return { start, end };
}

async function backfillUserMonthlyFinancialSummary(userId, client = db) {
  const { start, end } = await resolveBackfillRange(userId, client);
  const months = [];
  let cursor = { year: start.year, month: start.month };

  while (compareYearMonth(cursor, end) <= 0) {
    const row = await rebuildMonthlyFinancialSummary(
      userId,
      cursor.year,
      cursor.month,
      client
    );
    months.push(row);
    cursor = nextYearMonth(cursor.year, cursor.month);
  }

  return {
    user_id: Number(userId),
    from: start,
    to: end,
    months_written: months.length,
    months,
  };
}

async function backfillAllUsersMonthlyFinancialSummary(client = db) {
  const users = await client.query(`SELECT id FROM users ORDER BY id ASC`);
  const results = [];
  for (const user of users.rows) {
    results.push(await backfillUserMonthlyFinancialSummary(user.id, client));
  }
  return results;
}

function compareFacts(currentFacts, summaryFacts) {
  return FACT_FIELDS.map((field) => {
    const current = toAmount(currentFacts ? currentFacts[field] : 0);
    const summary = toAmount(summaryFacts ? summaryFacts[field] : 0);
    return {
      field,
      current,
      summary,
      difference: toAmount(summary - current),
    };
  });
}

function factsFromOverview(overview) {
  if (!overview) return { ...EMPTY_FACTS };
  return {
    earned: toAmount(overview.earned),
    not_earned: toAmount(overview.not_earned),
    outgoing: toAmount(overview.outgoing_payments_total),
    expenses: toAmount(overview.expense_total),
    savings_credited: toAmount(overview.savings_amount_saved),
    savings_debited: toAmount(overview.savings_amount_debited),
    given_total: toAmount(overview.debt_given_total),
    given_returned: toAmount(overview.debt_given_returned),
    received_total: toAmount(overview.debt_received_total),
    received_returned: toAmount(overview.debt_received_returned),
  };
}

function yearMonthFromTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const parts = getZonedCalendarParts(new Date(value));
  if (!parts.year || !parts.month) return null;
  return { year: parts.year, month: parts.month };
}

/**
 * Rebuild distinct (user, year, month) targets from canonical source tables.
 * Dedupes so a same-month update only rebuilds once.
 *
 * Production mutation → summary sync (same transaction + client):
 *   payment CRUD / payment returns     → payment_date month (returns use parent month)
 *   payment type flow / is_income      → every payment using that type
 *   payment type name / unused delete  → none
 *   expense CRUD / expense returns     → expense_date month (returns use parent month)
 *   expense split/category-only        → none unless header amount/date/user or returns change
 *   savings CRUD                       → transaction_date (old + new user/month)
 *   debt create/update                 → debt_date old + new; type change also rebuilds return months
 *   debt delete                        → origin + each return_date month
 *   debt return create/delete          → return_date month
 *   monthly_balances upsert            → none (Remaining is read-time)
 */
async function rebuildAffectedMonthlyFinancialSummaries(
  targets,
  client = db
) {
  const unique = uniqueSummaryTargets(targets);
  for (const target of unique) {
    await rebuildMonthlyFinancialSummary(
      target.user_id,
      target.year,
      target.month,
      client
    );
  }
}

module.exports = {
  FACT_FIELDS,
  EMPTY_FACTS,
  computeMonthFacts,
  rebuildMonthlyFinancialSummary,
  getMonthlyFinancialSummary,
  getMonthlyFinancialSummaryOrEmpty,
  loadMonthlyFinancialSummariesInRange,
  loadStoredPreviousBalancesInRange,
  monthInputsFromFacts,
  yearMonthKey,
  factsOrEmpty,
  resolveBackfillRange,
  backfillUserMonthlyFinancialSummary,
  backfillAllUsersMonthlyFinancialSummary,
  compareFacts,
  factsFromOverview,
  yearMonthFromTimestamp,
  rebuildAffectedMonthlyFinancialSummaries,
  nextYearMonth,
  compareYearMonth,
  currentZonedYearMonth,
  monthlySummaryLockKeys,
  uniqueSummaryTargets,
};
