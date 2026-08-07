const express = require("express");
const router = express.Router();
const {
  success,
  badRequest,
  serverError,
} = require("../utils/response");
const overview = require("./overview.routes");

/**
 * GET /api/dashboard?user_id=1
 * GET /api/dashboard?user_id=1&month=8&year=2026   (month filter)
 * GET /api/dashboard?user_id=1&year=2026           (year filter)
 *
 * Same payload as GET /api/overview/dashboard
 */
router.get("/", async (req, res) => {
  try {
    const { user_id, month, year } = req.query;

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const parsed = overview.parseDashboardPeriod(month, year);
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    const dashboard = await overview.buildDashboard(
      user_id,
      parsed.year,
      parsed.month,
      parsed.mode
    );

    return success(res, dashboard, "Dashboard fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching dashboard");
  }
});

module.exports = router;
