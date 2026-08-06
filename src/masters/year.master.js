/** Read-only years master (no create/update/delete). */
const START_YEAR = 2020;

function getYears(endYear = new Date().getFullYear() + 1) {
  const years = [];
  for (let year = endYear; year >= START_YEAR; year -= 1) {
    years.push({
      id: year,
      name: String(year),
      label: String(year),
    });
  }
  return years;
}

function isValidYear(year) {
  const y = Number(year);
  const max = new Date().getFullYear() + 1;
  return Number.isInteger(y) && y >= START_YEAR && y <= max;
}

module.exports = {
  START_YEAR,
  getYears,
  isValidYear,
};
