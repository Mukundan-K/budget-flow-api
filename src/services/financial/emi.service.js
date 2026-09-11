const db = require("../../db");
const { APP_TIMEZONE } = require("../../utils/datetime");
const { toAmount, safePercentage } = require("./_helpers");

/**
 * Distinct calendar-month installment count.
 * One or more payments for an EMI in the same app-timezone month count as 1.
 */
function emiPaidMonthsCountSql(timezoneParam, dateColumn = "payment_date") {
  return `COUNT(DISTINCT DATE_TRUNC('month', timezone(${timezoneParam}, ${dateColumn})))::int`;
}

/**
 * Lifetime paid-month aggregation for one user's EMI products.
 * Join on emi_product_id; filter by user_id in the subquery.
 */
function emiPaidMonthsJoinSql({
  userParam,
  tzParam,
  joinAlias = "emi_paid",
} = {}) {
  return `LEFT JOIN (
    SELECT emi_product_id,
           ${emiPaidMonthsCountSql(tzParam)} AS paid_months
    FROM payments
    WHERE user_id = ${userParam}
      AND emi_product_id IS NOT NULL
    GROUP BY emi_product_id
  ) ${joinAlias} ON ${joinAlias}.emi_product_id = ep.id`;
}

function paidCountFromRow(row) {
  if (!row) return 0;
  if (row.paid_months != null && row.paid_months !== "") {
    return Number(row.paid_months) || 0;
  }
  return 0;
}

function previouslyPaidFromRow(row) {
  if (!row) return 0;
  return Number(row.already_paid || 0);
}

/**
 * Distinct paid months for one user, optionally bounded by payment_date.
 * `through` = inclusive period end; `before` = exclusive period start.
 */
async function getPaidMonthsByUserAsOf(
  userId,
  { through = null, before = null } = {},
  client = db
) {
  const params = [userId, APP_TIMEZONE];
  let dateFilter = "";
  if (through != null) {
    params.push(through);
    dateFilter = `AND payment_date <= $${params.length}`;
  } else if (before != null) {
    params.push(before);
    dateFilter = `AND payment_date < $${params.length}`;
  }

  const result = await client.query(
    `SELECT emi_product_id,
            ${emiPaidMonthsCountSql("$2")} AS paid_months
     FROM payments
     WHERE user_id = $1
       AND emi_product_id IS NOT NULL
       ${dateFilter}
     GROUP BY emi_product_id`,
    params
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.emi_product_id), Number(row.paid_months) || 0);
  }
  return map;
}

/** Dashboard list: only EMIs that have started and are not already finished. */
function emiStartedByPeriodEnd(startFrom, periodEnd) {
  if (startFrom == null || startFrom === "") return true;
  const startMs = new Date(startFrom).getTime();
  const endMs = new Date(periodEnd).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return true;
  return startMs <= endMs;
}

function emiDashboardVisibility({
  startedByPeriodEnd = true,
  completedBeforePeriod,
  completedThroughPeriod,
}) {
  const started = startedByPeriodEnd !== false;
  const completedBefore = Boolean(completedBeforePeriod);
  return {
    include: started && !completedBefore,
    completedThisPeriod: started && Boolean(completedThroughPeriod) && !completedBefore,
  };
}

/**
 * EMI progress fields.
 * previously_paid / already_paid = installments paid before Budget Flow tracking
 * tracked_paid_months = distinct calendar months with EMI payments
 * paid / total_paid = previously_paid + tracked_paid_months
 * remaining = max(0, number_of_emis − total_paid)
 */
function calculateEmiProgress({
  paid = 0,
  total = 0,
  already_paid,
  previously_paid,
  tracked_paid_months,
  paid_months,
  number_of_emis,
} = {}) {
  const previouslyPaid = toAmount(
    previously_paid !== undefined
      ? previously_paid
      : already_paid !== undefined
        ? already_paid
        : paid
  );
  const trackedPaid =
    tracked_paid_months !== undefined
      ? toAmount(tracked_paid_months)
      : paid_months !== undefined
        ? toAmount(paid_months)
        : 0;
  const totalPaid = toAmount(previouslyPaid + trackedPaid);
  const totalCount = toAmount(
    number_of_emis !== undefined ? number_of_emis : total
  );

  let remaining = null;
  if (number_of_emis != null || total) {
    remaining = Math.max(0, totalCount - totalPaid);
  }

  const progress_percentage =
    totalCount > 0 ? safePercentage(totalPaid, totalCount, { clamp: true }) : 0;

  const completed = totalCount > 0 && totalPaid >= totalCount;

  return {
    paid: totalPaid,
    total_paid: totalPaid,
    already_paid: previouslyPaid,
    previously_paid: previouslyPaid,
    tracked_paid_months: trackedPaid,
    total: totalCount || null,
    number_of_emis: totalCount || null,
    remaining,
    emis_left: remaining,
    progress_percentage,
    completed,
  };
}

function isEmiCompleted(progress) {
  if (!progress) return false;
  if (typeof progress.completed === "boolean") return progress.completed;
  const total = Number(progress.number_of_emis);
  if (!Number.isFinite(total) || total <= 0) return false;
  const paid = Number(
    progress.total_paid != null ? progress.total_paid : progress.paid
  );
  return Number.isFinite(paid) && paid >= total;
}

const COMPLETED_EMI_EDIT_MESSAGE = "Completed EMI cannot be edited.";
const COMPLETED_EMI_DELETE_MESSAGE =
  "Completed EMI cannot be deleted because all installments have been paid.";
const COMPLETED_EMI_PAYMENT_MESSAGE =
  "This EMI is already fully paid and cannot receive another installment.";
const LINKED_EMI_DELETE_MESSAGE =
  "This EMI is already linked to one or more payments. Please remove or update the linked payments before deleting it.";

async function getPaidMonthsByUser(userId, client = db) {
  const result = await client.query(
    `SELECT emi_product_id,
            ${emiPaidMonthsCountSql("$2")} AS paid_months
     FROM payments
     WHERE user_id = $1
       AND emi_product_id IS NOT NULL
     GROUP BY emi_product_id`,
    [userId, APP_TIMEZONE]
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.emi_product_id), Number(row.paid_months) || 0);
  }
  return map;
}

async function getPaidMonthsForUsers(userIds, client = db) {
  const ids = [
    ...new Set(
      (userIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
  const byUser = new Map();
  if (!ids.length) return byUser;

  const result = await client.query(
    `SELECT user_id,
            emi_product_id,
            ${emiPaidMonthsCountSql("$2")} AS paid_months
     FROM payments
     WHERE user_id = ANY($1::int[])
       AND emi_product_id IS NOT NULL
     GROUP BY user_id, emi_product_id`,
    [ids, APP_TIMEZONE]
  );

  for (const row of result.rows) {
    const userId = Number(row.user_id);
    if (!byUser.has(userId)) byUser.set(userId, new Map());
    byUser
      .get(userId)
      .set(Number(row.emi_product_id), Number(row.paid_months) || 0);
  }
  return byUser;
}

function paidMonthsForPaymentRow(row, paidMonthsByUser) {
  if (!row || row.emi_product_id == null) return 0;
  const userMap = paidMonthsByUser.get(Number(row.user_id));
  if (!userMap) return 0;
  return userMap.get(Number(row.emi_product_id)) || 0;
}

/**
 * Overlay lifetime distinct-month paid counts onto payment rows (one query).
 */
async function attachPaidMonthsToPaymentRows(rows, client = db) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  const byUser = await getPaidMonthsForUsers(
    list.map((row) => row.user_id),
    client
  );
  return list.map((row) => ({
    ...row,
    paid_months: paidMonthsForPaymentRow(row, byUser),
  }));
}

async function listEmiProductsWithPaidMonths(userId, client = db) {
  const result = await client.query(
    `SELECT ep.id, ep.user_id, ep.product_name, ep.emi_start_from,
            ep.already_paid, ep.number_of_emis, ep.created_at,
            COALESCE(emi_paid.paid_months, 0) AS paid_months
     FROM emi_products ep
     ${emiPaidMonthsJoinSql({ userParam: "$1", tzParam: "$2" })}
     WHERE ep.user_id = $1
     ORDER BY ep.product_name ASC`,
    [userId, APP_TIMEZONE]
  );
  return result.rows;
}

async function fetchEmiProductWithPaidMonths(id, client = db) {
  const result = await client.query(
    `SELECT ep.id, ep.user_id, ep.product_name, ep.emi_start_from,
            ep.already_paid, ep.number_of_emis, ep.created_at,
            COALESCE((
              SELECT ${emiPaidMonthsCountSql("$2", "p.payment_date")}
              FROM payments p
              WHERE p.user_id = ep.user_id
                AND p.emi_product_id = ep.id
            ), 0) AS paid_months
     FROM emi_products ep
     WHERE ep.id = $1`,
    [id, APP_TIMEZONE]
  );
  return result.rows[0] || null;
}

module.exports = {
  emiPaidMonthsCountSql,
  emiPaidMonthsJoinSql,
  paidCountFromRow,
  previouslyPaidFromRow,
  getPaidMonthsByUserAsOf,
  emiStartedByPeriodEnd,
  emiDashboardVisibility,
  calculateEmiProgress,
  isEmiCompleted,
  COMPLETED_EMI_EDIT_MESSAGE,
  COMPLETED_EMI_DELETE_MESSAGE,
  COMPLETED_EMI_PAYMENT_MESSAGE,
  LINKED_EMI_DELETE_MESSAGE,
  getPaidMonthsByUser,
  getPaidMonthsForUsers,
  attachPaidMonthsToPaymentRows,
  listEmiProductsWithPaidMonths,
  fetchEmiProductWithPaidMonths,
};
