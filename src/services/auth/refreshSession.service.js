const crypto = require("crypto");
const db = require("../../db");
const {
  tokenPair,
  REFRESH_TOKEN_EXPIRES_IN,
  durationToMs,
} = require("../../utils/tokens");

class RefreshAuthError extends Error {
  constructor(code, httpMessage) {
    super(httpMessage);
    this.name = "RefreshAuthError";
    this.code = code;
    this.httpMessage = httpMessage;
  }
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function refreshExpiryDate() {
  return new Date(Date.now() + durationToMs(REFRESH_TOKEN_EXPIRES_IN));
}

function newJti() {
  return crypto.randomUUID();
}

async function insertRefreshSession(user, jti, refreshToken, client = db) {
  await client.query(
    `INSERT INTO refresh_tokens (user_id, jti, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, jti, hashRefreshToken(refreshToken), refreshExpiryDate()]
  );
}

/**
 * New login session: new jti + row. Does not touch users.refresh_token
 * or other sessions.
 */
async function createRefreshSession(user, client = db) {
  const jti = newJti();
  const tokens = tokenPair(user, jti);
  await insertRefreshSession(user, jti, tokens.refreshToken, client);
  return tokens;
}

async function lockSessionByJti(jti, client) {
  const result = await client.query(
    `SELECT id, user_id, jti, token_hash, expires_at, revoked_at
     FROM refresh_tokens
     WHERE jti = $1
     FOR UPDATE`,
    [jti]
  );
  return result.rows[0] || null;
}

function assertUsableSession(session, decoded, presentedToken) {
  if (!session) {
    throw new RefreshAuthError("session_not_found", "Invalid refresh token");
  }
  if (Number(session.user_id) !== Number(decoded.id)) {
    throw new RefreshAuthError("user_mismatch", "Invalid refresh token");
  }
  if (session.revoked_at) {
    throw new RefreshAuthError("session_revoked", "Invalid refresh token");
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw new RefreshAuthError("session_expired", "Refresh token expired");
  }
  if (session.token_hash !== hashRefreshToken(presentedToken)) {
    throw new RefreshAuthError("token_mismatch", "Invalid refresh token");
  }
}

/**
 * Rotate THIS session only (same jti, new token hash). Caller must hold
 * a transaction client with the row locked.
 */
async function rotateLockedSession(session, user, client) {
  const tokens = tokenPair(user, session.jti);
  await client.query(
    `UPDATE refresh_tokens
     SET token_hash = $1,
         expires_at = $2,
         updated_at = NOW()
     WHERE id = $3
       AND revoked_at IS NULL`,
    [hashRefreshToken(tokens.refreshToken), refreshExpiryDate(), session.id]
  );
  return tokens;
}

async function revokeSessionByJti(jti, client = db) {
  if (!jti) return { revoked: 0 };
  const result = await client.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW(),
         updated_at = NOW()
     WHERE jti = $1
       AND revoked_at IS NULL`,
    [jti]
  );
  return { revoked: result.rowCount || 0 };
}

async function loadUserById(userId, client = db) {
  const result = await client.query(
    `SELECT id, name, email, photo, google_id
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = {
  RefreshAuthError,
  hashRefreshToken,
  refreshExpiryDate,
  newJti,
  createRefreshSession,
  lockSessionByJti,
  assertUsableSession,
  rotateLockedSession,
  revokeSessionByJti,
  loadUserById,
};
