const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const authenticate = require("../middleware/authenticate");
const { tokenPair } = require("../utils/tokens");
const {
  success,
  unauthorized,
  notFound,
  serverError,
} = require("../utils/response");

const router = express.Router();

async function issueTokens(user) {
  const tokens = tokenPair(user);

  await pool.query("UPDATE users SET refresh_token=$1 WHERE id=$2", [
    tokens.refreshToken,
    user.id,
  ]);

  return tokens;
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    photo: row.photo,
    google_id: row.google_id,
  };
}

router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
  }),
  async (req, res) => {
    try {
      const { accessToken, refreshToken } = await issueTokens(req.user);
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:4200";

      res.redirect(
        `${frontendUrl}/login?accessToken=${encodeURIComponent(
          accessToken
        )}&refreshToken=${encodeURIComponent(refreshToken)}`
      );
    } catch (err) {
      console.error(err);
      return serverError(res, "Error completing login");
    }
  }
);

router.post("/refresh-token", async (req, res) => {
  const startedAt = Date.now();
  const { refreshToken } = req.body || {};
  let step = "received";

  console.log("[refresh] request received");
  console.log("[refresh] refreshToken exists:", Boolean(refreshToken));
  console.log(
    "[refresh] JWT_REFRESH_SECRET configured:",
    Boolean(process.env.JWT_REFRESH_SECRET)
  );

  if (!refreshToken) {
    console.log("[refresh] request completed");
    console.log("[refresh] total duration:", Date.now() - startedAt, "ms");
    return unauthorized(res, "Refresh token missing");
  }

  try {
    step = "jwt.verify";
    console.log("[refresh] JWT verification started");
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    console.log("[refresh] JWT verification completed");
    console.log("[refresh] decoded user id:", decoded && decoded.id);

    step = "SELECT";
    console.log("[refresh] SELECT started");
    const user = await pool.query("SELECT * FROM users WHERE id=$1", [
      decoded.id,
    ]);
    console.log("[refresh] SELECT completed");
    console.log("[refresh] user found:", user.rows.length > 0);

    if (user.rows.length === 0) {
      console.log("[refresh] request completed");
      console.log("[refresh] total duration:", Date.now() - startedAt, "ms");
      return unauthorized(res, "User not found");
    }

    const storedExists = Boolean(user.rows[0].refresh_token);
    const matches =
      storedExists && user.rows[0].refresh_token === refreshToken;
    console.log("[refresh] stored refresh token exists:", storedExists);
    console.log("[refresh] submitted token matches DB:", matches);

    if (!user.rows[0].refresh_token || user.rows[0].refresh_token !== refreshToken) {
      console.log("[refresh] request completed");
      console.log("[refresh] total duration:", Date.now() - startedAt, "ms");
      return unauthorized(res, "Invalid refresh token");
    }

    step = "issueTokens";
    console.log("[refresh] issueTokens started");
    const tokens = await issueTokens(user.rows[0]);
    console.log("[refresh] issueTokens completed");
    console.log("[refresh] request completed");
    console.log("[refresh] total duration:", Date.now() - startedAt, "ms");

    return success(res, tokens, "Access token refreshed successfully");
  } catch (err) {
    console.log("[refresh] error name:", err && err.name);
    console.log("[refresh] error code:", err && err.code);
    console.log("[refresh] error message:", err && err.message);
    console.log("[refresh] failed step:", step);
    console.log("[refresh] request completed");
    console.log("[refresh] total duration:", Date.now() - startedAt, "ms");

    if (err.name === "TokenExpiredError") {
      return unauthorized(res, "Refresh token expired");
    }
    return unauthorized(res, "Invalid refresh token");
  }
});

// Current user details (from access token)
router.get("/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, photo, google_id
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "User not found");
    }

    return success(res, mapUser(result.rows[0]), "User details fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching user details");
  }
});

// User details by id
router.get("/user/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, photo, google_id
       FROM users
       WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "User not found");
    }

    return success(res, mapUser(result.rows[0]), "User details fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching user details");
  }
});

router.post("/logout", async (req, res) => {
  try {
    const { userId, refreshToken } = req.body || {};
    let id = userId;

    if (!id && refreshToken) {
      try {
        const decoded = jwt.verify(
          refreshToken,
          process.env.JWT_REFRESH_SECRET
        );
        id = decoded.id;
      } catch (err) {
        const decoded = jwt.decode(refreshToken);
        id = decoded && decoded.id;
      }
    }

    if (id) {
      await pool.query("UPDATE users SET refresh_token=NULL WHERE id=$1", [id]);
    }

    return success(res, null, "Logged out");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error logging out");
  }
});

module.exports = router;
