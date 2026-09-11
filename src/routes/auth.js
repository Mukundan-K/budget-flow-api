const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const authenticate = require("../middleware/authenticate");
const { getGoogleCallbackUrl } = require("../config/googleCallback");
const {
  createRefreshSession,
  lockSessionByJti,
  assertUsableSession,
  rotateLockedSession,
  revokeSessionByJti,
  loadUserById,
  RefreshAuthError,
} = require("../services/auth/refreshSession.service");
const {
  success,
  unauthorized,
  notFound,
  serverError,
} = require("../utils/response");

const router = express.Router();

async function issueTokens(user, client = pool) {
  return createRefreshSession(user, client);
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

function decodeRefreshClaims(refreshToken) {
  try {
    return jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      throw new RefreshAuthError("expired", "Refresh token expired");
    }
    throw new RefreshAuthError("jwt", "Invalid refresh token");
  }
}

router.get("/google", (req, res, next) => {
  const callbackURL = getGoogleCallbackUrl();
  console.log("Google callback URL being used:", callbackURL);

  return passport.authenticate("google", {
    scope: ["profile", "email"],
    callbackURL,
  })(req, res, next);
});

router.get(
  "/google/callback",
  (req, res, next) => {
    const callbackURL = getGoogleCallbackUrl();
    return passport.authenticate("google", {
      session: false,
      callbackURL,
    })(req, res, next);
  },
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
  const { refreshToken } = req.body || {};

  if (!refreshToken) {
    return unauthorized(res, "Refresh token missing");
  }

  let client;
  try {
    const decoded = decodeRefreshClaims(refreshToken);
    if (!decoded.id || !decoded.jti) {
      return unauthorized(res, "Invalid refresh token");
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const session = await lockSessionByJti(decoded.jti, client);
    assertUsableSession(session, decoded, refreshToken);

    const user = await loadUserById(decoded.id, client);
    if (!user) {
      await client.query("ROLLBACK");
      return unauthorized(res, "User not found");
    }

    const tokens = await rotateLockedSession(session, user, client);
    await client.query("COMMIT");

    return success(res, tokens, "Access token refreshed successfully");
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
    }

    if (err instanceof RefreshAuthError) {
      return unauthorized(res, err.httpMessage);
    }

    console.error("refresh-token failed:", err && err.name, err && err.code);
    return serverError(res, "Error refreshing token");
  } finally {
    if (client) client.release();
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
    const { refreshToken } = req.body || {};
    let jti = null;

    if (refreshToken) {
      try {
        const decoded = jwt.verify(
          refreshToken,
          process.env.JWT_REFRESH_SECRET
        );
        jti = decoded && decoded.jti;
      } catch (err) {
        const decoded = jwt.decode(refreshToken);
        jti = decoded && decoded.jti;
      }
    }

    if (jti) {
      await revokeSessionByJti(jti);
    }

    return success(res, null, "Logged out");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error logging out");
  }
});

module.exports = router;
module.exports.issueTokens = issueTokens;
