const db = require("../../db");
const { formatAmount, addAmounts } = require("../../utils/money");
const {
  formatTimestamp,
  monthRangeTimestamps,
} = require("../../utils/datetime");
const { calculatePersonBalances } = require("./debt.service");
const { getDebtActivityForRange } = require("./debtMonth.service");

const TRANSACTION_TYPES = {
  RECEIVED: "received",
  GIVEN: "given",
  RETURNED_BY_ME: "returned_by_me",
  RETURNED_TO_ME: "returned_to_me",
};

const TRANSACTION_LABELS = {
  received: "Received from them",
  given: "Given to them",
  returned_by_me: "Returned by me",
  returned_to_me: "Returned to me",
};

function parseTransactionType(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "received" ||
    normalized === "received_from_them" ||
    normalized === "receive" ||
    normalized === "taken" ||
    normalized === "borrowed"
  ) {
    return TRANSACTION_TYPES.RECEIVED;
  }
  if (
    normalized === "given" ||
    normalized === "given_to_them" ||
    normalized === "give" ||
    normalized === "lent"
  ) {
    return TRANSACTION_TYPES.GIVEN;
  }
  if (
    normalized === "returned_by_me" ||
    normalized === "returned_by_me_to_them" ||
    normalized === "i_returned" ||
    normalized === "i_repaid"
  ) {
    return TRANSACTION_TYPES.RETURNED_BY_ME;
  }
  if (
    normalized === "returned_to_me" ||
    normalized === "returned_to_me_by_them" ||
    normalized === "they_returned" ||
    normalized === "they_repaid"
  ) {
    return TRANSACTION_TYPES.RETURNED_TO_ME;
  }
  return null;
}

function originDebtTypeFromTransactionType(type) {
  return type === TRANSACTION_TYPES.GIVEN ||
    type === TRANSACTION_TYPES.RETURNED_TO_ME
    ? TRANSACTION_TYPES.GIVEN
    : TRANSACTION_TYPES.RECEIVED;
}

function signedAmountForType(type, amount) {
  const value = formatAmount(amount);
  if (type === TRANSACTION_TYPES.RECEIVED || type === TRANSACTION_TYPES.RETURNED_TO_ME) {
    return value;
  }
  return formatAmount(-value);
}

function mapTransactionRow(row) {
  const type = row.transaction_type;
  const amount = formatAmount(row.amount);
  const originType = originDebtTypeFromTransactionType(
    row.origin_debt_type || type
  );
  const txnDate = formatTimestamp(row.txn_date);
  return {
    id: `debt:${row.id}`,
    kind: "debt",
    transaction_id: Number(row.id),
    transaction_source: "debt",
    record_id: Number(row.id),
    debt_id: Number(row.debt_id),
    return_id: null,
    person_id: Number(row.person_id),
    person_name: row.person_name,
    origin_debt_type: originType,
    transaction_type: type,
    label: TRANSACTION_LABELS[type] || type,
    amount,
    signed_amount: signedAmountForType(type, amount),
    date: txnDate,
    transaction_date: txnDate,
    user_id: Number(row.user_id),
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

function mapOutstandingPerson(row) {
  const balances = calculatePersonBalances({
    received_total: row.received_total,
    returned_by_me: row.returned_by_me,
    given_total: row.given_total,
    returned_to_me: row.returned_to_me,
  });
  return {
    person_id: Number(row.person_id),
    person_name: row.person_name,
    person: row.person_name,
    i_owe_them: balances.i_owe_them,
    they_owe_me: balances.they_owe_me,
    net_amount: balances.net_amount,
    received_total: balances.received_total,
    given_total: balances.given_total,
    returned_by_me: balances.returned_by_me,
    returned_to_me: balances.returned_to_me,
    given_outstanding: balances.they_owe_me,
    received_outstanding: balances.i_owe_them,
    has_pending: balances.i_owe_them !== 0 || balances.they_owe_me !== 0,
  };
}

function withLegacyNet(person) {
  return {
    ...person,
    // Legacy pending-by-person net: they owe me − I owe them (cash-flow style)
    net: formatAmount(person.they_owe_me - person.i_owe_them),
  };
}

async function listOutstandingByPerson(userId, client = db) {
  const result = await client.query(
    `SELECT
       p.id AS person_id,
       p.name AS person_name,
       COALESCE(SUM(CASE WHEN d.debt_type = 'received' THEN d.amount ELSE 0 END), 0) AS received_total,
       COALESCE(SUM(CASE WHEN d.debt_type = 'given' THEN d.amount ELSE 0 END), 0) AS given_total,
       COALESCE(SUM(CASE WHEN d.debt_type = 'returned_by_me' THEN d.amount ELSE 0 END), 0) AS returned_by_me,
       COALESCE(SUM(CASE WHEN d.debt_type = 'returned_to_me' THEN d.amount ELSE 0 END), 0) AS returned_to_me
     FROM persons p
     JOIN debts d ON d.person_id = p.id AND d.user_id = p.user_id
     WHERE p.user_id = $1
     GROUP BY p.id, p.name
     ORDER BY p.name ASC`,
    [userId]
  );

  const allPeople = result.rows.map(mapOutstandingPerson).map(withLegacyNet);

  // Headlines are algebraic sums of every person balance, including negatives.
  // I Owe Them  = SUM(received − returned_by_me)
  // They Owe Me = SUM(given − returned_to_me)
  // Net         = I Owe Them − They Owe Me
  const i_owe_them = formatAmount(
    addAmounts(...allPeople.map((p) => p.i_owe_them))
  );
  const they_owe_me = formatAmount(
    addAmounts(...allPeople.map((p) => p.they_owe_me))
  );

  const people = allPeople
    .filter((row) => row.i_owe_them !== 0 || row.they_owe_me !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.net_amount) - Math.abs(a.net_amount) ||
        String(a.person_name).localeCompare(String(b.person_name))
    );

  return {
    i_owe_them,
    they_owe_me,
    net_amount: formatAmount(i_owe_them - they_owe_me),
    given_outstanding: they_owe_me,
    received_outstanding: i_owe_them,
    debt_net: formatAmount(they_owe_me - i_owe_them),
    people,
  };
}

async function getMonthlyDebtActivity(userId, year, month, client = db) {
  const range =
    month == null
      ? {
          start: monthRangeTimestamps(year, 1).start,
          end: monthRangeTimestamps(year, 12).end,
        }
      : monthRangeTimestamps(year, month);
  const monthNet = await getDebtActivityForRange(
    userId,
    range.start,
    range.end,
    client
  );
  return {
    year,
    month: month == null ? null : month,
    received_this_month: monthNet.received_total,
    given_this_month: monthNet.given_total,
    returned_by_me_this_month: monthNet.received_returned,
    returned_to_me_this_month: monthNet.given_returned,
    given_total: monthNet.given_total,
    given_returned: monthNet.given_returned,
    received_total: monthNet.received_total,
    received_returned: monthNet.received_returned,
    received_repaid_this_month: monthNet.received_repaid_this_month,
    received_repaid_past_months: monthNet.received_repaid_past_months,
    debt_net: monthNet.debt_net,
    debt: monthNet.debt,
  };
}

function transactionDateConditions(alias, params, { month, year, dateStart, dateEnd }) {
  const conditions = [];
  if (dateStart && dateEnd) {
    params.push(dateStart);
    conditions.push(`${alias} >= $${params.length}`);
    params.push(dateEnd);
    conditions.push(`${alias} <= $${params.length}`);
    return conditions;
  }
  if (year != null && month == null) {
    const range = {
      start: monthRangeTimestamps(year, 1).start,
      end: monthRangeTimestamps(year, 12).end,
    };
    params.push(range.start);
    conditions.push(`${alias} >= $${params.length}`);
    params.push(range.end);
    conditions.push(`${alias} <= $${params.length}`);
    return conditions;
  }
  if (month != null && year != null) {
    const range = monthRangeTimestamps(year, month);
    params.push(range.start);
    conditions.push(`${alias} >= $${params.length}`);
    params.push(range.end);
    conditions.push(`${alias} <= $${params.length}`);
  }
  return conditions;
}

async function listDebtTransactions(
  {
    userId,
    personId,
    month,
    year,
    dateStart,
    dateEnd,
  },
  client = db
) {
  const params = [userId];
  const debtPerson = [];

  if (personId !== undefined && personId !== null && personId !== "") {
    params.push(personId);
    debtPerson.push(`d.person_id = $${params.length}`);
  }

  const debtDate = transactionDateConditions("d.debt_date", params, {
    month,
    year,
    dateStart,
    dateEnd,
  });
  const debtWhere = ["d.user_id = $1", ...debtPerson, ...debtDate];

  const result = await client.query(
    `SELECT
       d.id,
       d.id AS debt_id,
       d.user_id,
       d.person_id,
       p.name AS person_name,
       CASE
         WHEN d.debt_type IN ('given', 'returned_to_me') THEN 'given'
         ELSE 'received'
       END AS origin_debt_type,
       d.debt_type AS transaction_type,
       d.amount,
       d.debt_date AS txn_date,
       d.created_at
     FROM debts d
     JOIN persons p ON p.id = d.person_id
     WHERE ${debtWhere.join(" AND ")}
     ORDER BY d.debt_date DESC, d.id DESC`,
    params
  );

  return result.rows.map(mapTransactionRow);
}

module.exports = {
  TRANSACTION_TYPES,
  TRANSACTION_LABELS,
  parseTransactionType,
  originDebtTypeFromTransactionType,
  listOutstandingByPerson,
  getMonthlyDebtActivity,
  listDebtTransactions,
};
