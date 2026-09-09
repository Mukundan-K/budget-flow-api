require("dotenv").config();
const db = require("../src/db");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  buildMonthOverviewFromSource,
  buildMonthOverviewFromSummary,
} = require("../src/routes/overview.routes");
const {
  rebuildMonthlyFinancialSummary,
  resolveBackfillRange,
  nextYearMonth,
  compareYearMonth,
} = require("../src/services/financial/monthlyFinancialSummary.service");
const {
  compareOverviews,
} = require("../src/services/financial/monthOverviewCompare");

function argValue(name) {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (!arg) return null;
  return arg.slice(name.length + 3);
}

function printMismatches(mismatches) {
  mismatches.forEach((row) => {
    console.error(
      `  ${row.field}: source=${JSON.stringify(row.source)} summary=${JSON.stringify(row.summary)} difference=${row.difference}`
    );
  });
}

async function compareMonth(userId, year, month, { rebuild = true } = {}) {
  if (rebuild) {
    await rebuildMonthlyFinancialSummary(userId, year, month);
  }
  const source = await buildMonthOverviewFromSource(userId, year, month);
  const summary = await buildMonthOverviewFromSummary(userId, year, month);
  const compared = compareOverviews(source, summary);
  return {
    userId,
    year,
    month,
    source,
    summary,
    ...compared,
  };
}

async function main() {
  await seedMonthlyFinancialSummary();

  const userId = Number(argValue("user_id"));
  const yearArg = argValue("year");
  const monthArg = argValue("month");
  const skipRebuild = process.argv.includes("--no-rebuild");

  if (!userId) {
    console.error(
      "Usage: node scripts/compare-month-overview.js --user_id=1 [--year=2026] [--month=3] [--no-rebuild]"
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
    const result = await compareMonth(userId, period.year, period.month, {
      rebuild: !skipRebuild,
    });
    const label = `User ${userId} ${period.year}-${period.month}`;
    if (result.mismatches.length) {
      failed = true;
      console.error(`\nMISMATCH ${label} (${result.mismatches.length} fields)`);
      printMismatches(result.mismatches);
    } else {
      console.log(`OK ${label} (${result.rows.length} fields)`);
    }
  }

  if (failed) {
    process.exitCode = 1;
  } else {
    console.log(
      `\nFull month-overview matched for ${months.length} month(s) (source vs summary).`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.end());

module.exports = { compareMonth };
