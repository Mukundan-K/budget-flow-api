const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "../src/routes/overview.routes.js"),
  "utf8"
);

function sliceFn(name, nextName) {
  const start = src.indexOf(`async function ${name}`);
  const end = nextName ? src.indexOf(`async function ${nextName}`) : src.length;
  return src.slice(start, end);
}

describe("dashboard production read path uses summary facts", () => {
  test("buildDashboard month mode walks summary, not source", () => {
    const fn = sliceFn("buildDashboard", "collectMonthlyTrendPoints");
    expect(fn).toMatch(/factsSource: "summary"/);
    expect(fn).not.toMatch(/factsSource: "source"/);
    expect(fn).not.toMatch(/buildMonthOverviewFromSource/);
    expect(fn).toMatch(/collectTrendPointsFromOverviews/);
    expect(fn).toMatch(/getExpenseChartsForMonth/);
    expect(fn).toMatch(/getMonthlyDebtTrendForYear/);
    expect(fn).not.toMatch(/getExpenseTypeNetsForMonth/);
    expect(fn).not.toMatch(/getCategoryPolarArea/);
  });

  test("buildDashboardForYear walks summary and does not replay source facts per trend month", () => {
    const fn = sliceFn("buildDashboardForYear", "updatePreviousBalance");
    expect(fn).toMatch(/factsSource: "summary"/);
    expect(fn).not.toMatch(/factsSource: "source"/);
    expect(fn).not.toMatch(/buildMonthOverviewFromSource/);
    expect(fn).toMatch(/getExpenseChartsForYear/);
    expect(fn).toMatch(/getMonthlyDebtTrendForYear/);
    expect(fn).not.toMatch(/getExpenseTypeNetsForMonth/);
    expect(fn).not.toMatch(/getExpenseTypeNetsForYear/);
    expect(fn).not.toMatch(/getCategoryPolarArea/);
  });

  test("production buildMonthOverview aliases the summary builder", () => {
    const fn = sliceFn("buildMonthOverview", "buildMonthOverviewsForCalendarYear");
    expect(fn).toMatch(/return buildMonthOverviewFromSummary/);
    expect(fn).not.toMatch(/return buildMonthOverviewFromSource/);
  });
});
