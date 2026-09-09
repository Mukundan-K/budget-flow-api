require("dotenv").config();
const db = require("../src/db");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  backfillAllUsersMonthlyFinancialSummary,
  backfillUserMonthlyFinancialSummary,
} = require("../src/services/financial/monthlyFinancialSummary.service");

function parseUserId() {
  const arg = process.argv.find((item) => item.startsWith("--user_id="));
  if (!arg) return null;
  const value = Number(arg.slice("--user_id=".length));
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function main() {
  await seedMonthlyFinancialSummary();

  const userId = parseUserId();
  if (userId) {
    const result = await backfillUserMonthlyFinancialSummary(userId);
    console.log(
      `Backfilled user ${result.user_id} ${result.from.year}-${result.from.month} → ${result.to.year}-${result.to.month} (${result.months_written} months)`
    );
  } else {
    const results = await backfillAllUsersMonthlyFinancialSummary();
    results.forEach((result) => {
      console.log(
        `User ${result.user_id}: ${result.from.year}-${result.from.month} → ${result.to.year}-${result.to.month} (${result.months_written} months)`
      );
    });
    console.log(`Backfilled ${results.length} user(s)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
