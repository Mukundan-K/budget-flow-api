const { toAmount } = require("./_helpers");

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function normalizeLeaf(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return toAmount(value);
  if (value === undefined) return null;
  return value;
}

function flattenOverview(value, prefix, out) {
  if (isPlainObject(value)) {
    Object.keys(value)
      .sort()
      .forEach((key) => {
        const next = prefix ? `${prefix}.${key}` : key;
        flattenOverview(value[key], next, out);
      });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenOverview(item, `${prefix}[${index}]`, out);
    });
    return;
  }
  out.set(prefix || "(root)", normalizeLeaf(value));
}

function flattenToMap(overview) {
  const map = new Map();
  flattenOverview(overview || null, "", map);
  if (overview == null) {
    map.set("(root)", null);
  }
  return map;
}

/**
 * Full month-overview comparison (all fields, including nested objects).
 * Does not change formulas when values differ — callers should STOP.
 */
function compareOverviews(sourceOverview, summaryOverview) {
  const sourceMap = flattenToMap(sourceOverview);
  const summaryMap = flattenToMap(summaryOverview);
  const fields = new Set([...sourceMap.keys(), ...summaryMap.keys()]);
  const rows = [...fields].sort().map((field) => {
    const source = sourceMap.has(field) ? sourceMap.get(field) : undefined;
    const summary = summaryMap.has(field) ? summaryMap.get(field) : undefined;
    const equal =
      source === summary ||
      (typeof source === "number" &&
        typeof summary === "number" &&
        source === summary);
    return {
      field,
      source: source === undefined ? null : source,
      summary: summary === undefined ? null : summary,
      difference:
        typeof source === "number" && typeof summary === "number"
          ? toAmount(summary - source)
          : equal
            ? 0
            : "mismatch",
      equal,
    };
  });
  return {
    rows,
    mismatches: rows.filter((row) => !row.equal),
  };
}

module.exports = {
  compareOverviews,
  flattenToMap,
};
