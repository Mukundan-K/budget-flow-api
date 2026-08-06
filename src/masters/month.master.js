/** Read-only months master (no create/update/delete). */
const MONTHS = [
  { id: 1, name: "January", short: "Jan" },
  { id: 2, name: "February", short: "Feb" },
  { id: 3, name: "March", short: "Mar" },
  { id: 4, name: "April", short: "Apr" },
  { id: 5, name: "May", short: "May" },
  { id: 6, name: "June", short: "Jun" },
  { id: 7, name: "July", short: "Jul" },
  { id: 8, name: "August", short: "Aug" },
  { id: 9, name: "September", short: "Sep" },
  { id: 10, name: "October", short: "Oct" },
  { id: 11, name: "November", short: "Nov" },
  { id: 12, name: "December", short: "Dec" },
];

function getMonths() {
  return MONTHS.map((item) => ({ ...item }));
}

function isValidMonth(id) {
  const month = Number(id);
  return Number.isInteger(month) && month >= 1 && month <= 12;
}

module.exports = {
  MONTHS,
  getMonths,
  isValidMonth,
};
