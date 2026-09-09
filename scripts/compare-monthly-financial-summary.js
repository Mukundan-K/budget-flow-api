require("dotenv").config();
const db = require("../src/db");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const { buildMonthOverviewFromSource } = require("../src/routes/overview.routes");
const {
  FACT_FIELDS,
  computeMonthFacts,
  rebuildMonthlyFinancialSummary,
  getMonthlyFinancialSummary,
  compareFacts,
  factsFromOverview,
  resolveBackfillRange,
  nextYearMonth,
  compareYearMonth,
} = require("../src/services/financial/monthlyFinancialSummary.service");

function argValue(name) {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.slice(name.length + 3);
}

function printTable(rows) {
  const header =
    "| Value             | Current calculation | Summary | Difference |";
  const sep =
    "| ----------------- | ------------------: | ------: | ---------: |";
  console.log(header);
  console.log(sep);
  rows.forEach((row) => {
    const field = String(row.field).padEnd(17);
    const current = String(row.current).padStart(19);
    const summary = String(row.summary).padStart(7);
    const difference = String(row.difference).padStart(10);
    console.log(`| ${field} | ${current} | ${summary} | ${difference} |`);
  });
}

const noRebuild = process.argv.includes("--no-rebuild");

async function compareMonth(userId, year, month) {
  if (!noRebuild) {
    await rebuildMonthlyFinancialSummary(userId, year, month);
  }
  const currentFacts = await computeMonthFacts(userId, year, month);
  const summary = await getMonthlyFinancialSummary(userId, year, month);
  const overview = await buildMonthOverviewFromSource(userId, year, month);
  const overviewFacts = factsFromOverview(overview);

  const vsCompute = compareFacts(currentFacts, summary);
  const vsOverview = compareFacts(overviewFacts, summary);

  return {
    userId,
    year,
    month,
    vsCompute,
    vsOverview,
    mismatches: [...vsCompute, ...vsOverview].filter(
      (row) => row.difference !== 0
    ),
  };
}

async function main() {
  await seedMonthlyFinancialSummary();

  const userId = Number(argValue("user_id"));
  const yearArg = argValue("year");
  const monthArg = argValue("month");

  if (!userId) {
    console.error(
      "Usage: node scripts/compare-monthly-financial-summary.js --user_id=1 [--year=2026] [--month=3] [--no-rebuild]"
    );
    process.exitCode = 1;
    return;
  }

  const months = [];
  if (yearArg && monthArg) {
    months.push({ year: Number(yearArg), month: Number(monthArg) });
  } else {
    const { start, end } = await resolveBackfillRange(userId);
    let cursor = { ...start };
    while (compareYearMonth(cursor, end) <= 0) {
      months.push({ ...cursor });
      cursor = nextYearMonth(cursor.year, cursor.month);
    }
  }

  let failed = false;
  for (const period of months) {
    const result = await compareMonth(userId, period.year, period.month);
    console.log(`\nUser ${userId} ${period.year}-${period.month}`);
    console.log("vs computeMonthFacts / Remaining source queries:");
    printTable(result.vsCompute);
    console.log("vs buildMonthOverviewFromSource:");
    printTable(result.vsOverview);
    if (result.mismatches.length) {
      failed = true;
      console.error("MISMATCH", result.mismatches);
    }
  }

  if (failed) {
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${FACT_FIELDS.length} fields matched for ${months.length} month(s).`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
