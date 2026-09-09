/**
 * Rebuild monthly_financial_summary from canonical source queries.
 * Does not modify payments/expenses/savings/debts or monthly_balances.
 * Reuses backfillUserMonthlyFinancialSummary (same as backfill:monthly-summary).
 *
 * Usage:
 *   node scripts/repair-monthly-financial-summary.js
 *   node scripts/repair-monthly-financial-summary.js --user_id=2
 */
require("dotenv").config();
const db = require("../src/db");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  backfillUserMonthlyFinancialSummary,
  backfillAllUsersMonthlyFinancialSummary,
  resolveBackfillRange,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  compareFacts,
  nextYearMonth,
  compareYearMonth,
} = require("../src/services/financial/monthlyFinancialSummary.service");

function parseUserId() {
  const arg = process.argv.find((item) => item.startsWith("--user_id="));
  if (!arg) return null;
  const value = Number(arg.slice("--user_id=".length));
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function countMismatches(userId) {
  const { start, end } = await resolveBackfillRange(userId);
  let cursor = { year: start.year, month: start.month };
  let monthsChecked = 0;
  let mismatchedMonths = 0;

  while (compareYearMonth(cursor, end) <= 0) {
    monthsChecked += 1;
    const current = await computeMonthFacts(userId, cursor.year, cursor.month);
    const summary = await getMonthlyFinancialSummary(
      userId,
      cursor.year,
      cursor.month
    );
    const bad = compareFacts(current, summary).filter(
      (row) => row.difference !== 0
    );
    if (bad.length) mismatchedMonths += 1;
    cursor = nextYearMonth(cursor.year, cursor.month);
  }

  return {
    from: start,
    to: end,
    monthsChecked,
    mismatchedMonths,
  };
}

async function repairUser(userId) {
  const before = await countMismatches(userId);
  const result = await backfillUserMonthlyFinancialSummary(userId);
  const after = await countMismatches(userId);
  return { userId: Number(userId), before, result, after };
}

function printUserReport(report) {
  const { before, result, after } = report;
  console.log(
    `User ${report.userId}: ${result.from.year}-${result.from.month} → ${result.to.year}-${result.to.month}`
  );
  console.log(
    `  before: ${before.mismatchedMonths} mismatched month(s) / ${before.monthsChecked}`
  );
  console.log(`  rebuilt: ${result.months_written} month(s)`);
  console.log(
    `  after:  ${after.mismatchedMonths} mismatched month(s) / ${after.monthsChecked}`
  );
}

async function main() {
  await seedMonthlyFinancialSummary();

  console.log(
    "Repair monthly_financial_summary from canonical source (source tables and monthly_balances are not modified)"
  );

  const userId = parseUserId();
  const reports = [];

  if (userId) {
    reports.push(await repairUser(userId));
  } else {
    const users = await db.query(`SELECT id FROM users ORDER BY id ASC`);
    for (const row of users.rows) {
      reports.push(await repairUser(row.id));
    }
    if (users.rows.length === 0) {
      await backfillAllUsersMonthlyFinancialSummary();
    }
  }

  reports.forEach(printUserReport);

  const mismatchedAfter = reports.reduce(
    (sum, report) => sum + report.after.mismatchedMonths,
    0
  );
  const rebuilt = reports.reduce(
    (sum, report) => sum + report.result.months_written,
    0
  );
  console.log(
    `\nRepaired ${reports.length} user(s), ${rebuilt} month(s). Remaining mismatches: ${mismatchedAfter}.`
  );

  if (mismatchedAfter > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
