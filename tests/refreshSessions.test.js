process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "test-access-secret";
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || "test-refresh-secret";
process.env.GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || "http://localhost:5000/auth/google/callback";

const jwt = require("jsonwebtoken");
const {
  tokenPair,
  generateRefreshToken,
  durationToMs,
} = require("../src/utils/tokens");
const { getGoogleCallbackUrl } = require("../src/config/googleCallback");
const {
  hashRefreshToken,
  createRefreshSession,
  lockSessionByJti,
  assertUsableSession,
  rotateLockedSession,
  revokeSessionByJti,
  RefreshAuthError,
} = require("../src/services/auth/refreshSession.service");

const user = { id: 2, email: "test@example.com", name: "Test" };

function memoryClient() {
  const sessions = [];
  return {
    sessions,
    async query(sql, params = []) {
      const text = String(sql);

      if (text.includes("INSERT INTO refresh_tokens")) {
        const [userId, jti, tokenHash, expiresAt] = params;
        const row = {
          id: sessions.length + 1,
          user_id: userId,
          jti,
          token_hash: tokenHash,
          expires_at: expiresAt,
          revoked_at: null,
        };
        sessions.push(row);
        return { rowCount: 1, rows: [row] };
      }

      if (text.includes("FROM refresh_tokens") && text.includes("FOR UPDATE")) {
        const jti = params[0];
        return { rows: sessions.filter((row) => row.jti === jti) };
      }

      if (text.includes("SET token_hash")) {
        const [tokenHash, expiresAt, id] = params;
        const row = sessions.find((item) => item.id === id && !item.revoked_at);
        if (row) {
          row.token_hash = tokenHash;
          row.expires_at = expiresAt;
        }
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }

      if (text.includes("SET revoked_at")) {
        const jti = params[0];
        const row = sessions.find((item) => item.jti === jti && !item.revoked_at);
        if (row) row.revoked_at = new Date();
        return { rowCount: row ? 1 : 0 };
      }

      if (text.includes("FROM users")) {
        return { rows: [user] };
      }

      throw new Error(`unexpected SQL in test mock: ${text.slice(0, 80)}`);
    },
  };
}

describe("refresh session tokens", () => {
  test("durationToMs parses jwt-style durations", () => {
    expect(durationToMs("15m")).toBe(15 * 60 * 1000);
    expect(durationToMs("30d")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("Google callback URL comes from GOOGLE_CALLBACK_URL", () => {
    const previous = process.env.GOOGLE_CALLBACK_URL;
    process.env.NODE_ENV = "development";
    delete process.env.RENDER;
    process.env.GOOGLE_CALLBACK_URL = "http://localhost:5000/auth/google/callback";
    expect(getGoogleCallbackUrl()).toBe(
      "http://localhost:5000/auth/google/callback"
    );
    process.env.GOOGLE_CALLBACK_URL = previous;
  });

  test("local Google callback URL falls back when env is missing", () => {
    const previousCallback = process.env.GOOGLE_CALLBACK_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRender = process.env.RENDER;
    delete process.env.GOOGLE_CALLBACK_URL;
    process.env.NODE_ENV = "development";
    delete process.env.RENDER;
    expect(getGoogleCallbackUrl()).toBe(
      "http://localhost:5000/auth/google/callback"
    );
    process.env.GOOGLE_CALLBACK_URL = previousCallback;
    process.env.NODE_ENV = previousNodeEnv;
    process.env.RENDER = previousRender;
  });

  test("production Google callback URL never uses localhost", () => {
    const previousCallback = process.env.GOOGLE_CALLBACK_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRender = process.env.RENDER;
    process.env.NODE_ENV = "production";
    delete process.env.RENDER;
    process.env.GOOGLE_CALLBACK_URL = "http://localhost:5000/auth/google/callback";
    expect(getGoogleCallbackUrl()).toBe(
      "https://budget-flow-api.onrender.com/auth/google/callback"
    );
    process.env.GOOGLE_CALLBACK_URL = previousCallback;
    process.env.NODE_ENV = previousNodeEnv;
    process.env.RENDER = previousRender;
  });

  test("refresh JWT includes user id and session jti", () => {
    const tokens = tokenPair(user, "11111111-1111-1111-1111-111111111111");
    const decoded = jwt.verify(tokens.refreshToken, process.env.JWT_REFRESH_SECRET);
    expect(decoded.id).toBe(user.id);
    expect(decoded.jti).toBe("11111111-1111-1111-1111-111111111111");
  });

  test("generateRefreshToken requires jti", () => {
    expect(() => generateRefreshToken(user)).toThrow(/jti/);
  });

  test("hashRefreshToken is stable and does not equal the raw token", () => {
    const token = "abc.def.ghi";
    const hash = hashRefreshToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashRefreshToken(token));
    expect(hash).not.toBe(token);
  });

  test("two logins create independent sessions", async () => {
    const client = memoryClient();
    const sessionA = await createRefreshSession(user, client);
    const sessionB = await createRefreshSession(user, client);

    expect(client.sessions).toHaveLength(2);
    expect(client.sessions[0].jti).not.toBe(client.sessions[1].jti);
    expect(sessionA.refreshToken).not.toBe(sessionB.refreshToken);

    const decodedA = jwt.verify(sessionA.refreshToken, process.env.JWT_REFRESH_SECRET);
    const decodedB = jwt.verify(sessionB.refreshToken, process.env.JWT_REFRESH_SECRET);
    expect(decodedA.id).toBe(decodedB.id);
    expect(decodedA.jti).not.toBe(decodedB.jti);
  });

  test("rotating session A does not change session B", async () => {
    const client = memoryClient();
    const issuedA = await createRefreshSession(user, client);
    const issuedB = await createRefreshSession(user, client);
    const decodedA = jwt.verify(issuedA.refreshToken, process.env.JWT_REFRESH_SECRET);
    const decodedB = jwt.verify(issuedB.refreshToken, process.env.JWT_REFRESH_SECRET);

    const lockedA = await lockSessionByJti(decodedA.jti, client);
    assertUsableSession(lockedA, decodedA, issuedA.refreshToken);
    const rotatedA = await rotateLockedSession(lockedA, user, client);

    const stillB = await lockSessionByJti(decodedB.jti, client);
    expect(() =>
      assertUsableSession(stillB, decodedB, issuedB.refreshToken)
    ).not.toThrow();

    const reusedA = await lockSessionByJti(decodedA.jti, client);
    expect(() =>
      assertUsableSession(reusedA, decodedA, issuedA.refreshToken)
    ).toThrow(RefreshAuthError);

    const newA = jwt.verify(rotatedA.refreshToken, process.env.JWT_REFRESH_SECRET);
    expect(newA.jti).toBe(decodedA.jti);
    expect(() =>
      assertUsableSession(reusedA, newA, rotatedA.refreshToken)
    ).not.toThrow();
  });

  test("logout revokes only the matching session", async () => {
    const client = memoryClient();
    const issuedA = await createRefreshSession(user, client);
    const issuedB = await createRefreshSession(user, client);
    const decodedA = jwt.verify(issuedA.refreshToken, process.env.JWT_REFRESH_SECRET);
    const decodedB = jwt.verify(issuedB.refreshToken, process.env.JWT_REFRESH_SECRET);

    await revokeSessionByJti(decodedA.jti, client);

    const sessionA = await lockSessionByJti(decodedA.jti, client);
    const sessionB = await lockSessionByJti(decodedB.jti, client);

    expect(() =>
      assertUsableSession(sessionA, decodedA, issuedA.refreshToken)
    ).toThrow(/Invalid refresh token/);
    expect(() =>
      assertUsableSession(sessionB, decodedB, issuedB.refreshToken)
    ).not.toThrow();
  });

  test("expired session is rejected", () => {
    const decoded = { id: 2, jti: "jti" };
    const token = "token";
    const session = {
      id: 1,
      user_id: 2,
      jti: "jti",
      token_hash: hashRefreshToken(token),
      expires_at: new Date(Date.now() - 1000),
      revoked_at: null,
    };
    expect(() => assertUsableSession(session, decoded, token)).toThrow(
      /Refresh token expired/
    );
  });

  test("revoked session is rejected", () => {
    const decoded = { id: 2, jti: "jti" };
    const token = "token";
    const session = {
      id: 1,
      user_id: 2,
      jti: "jti",
      token_hash: hashRefreshToken(token),
      expires_at: new Date(Date.now() + 10000),
      revoked_at: new Date(),
    };
    expect(() => assertUsableSession(session, decoded, token)).toThrow(
      /Invalid refresh token/
    );
  });

  test("modified token hash is rejected", () => {
    const decoded = { id: 2, jti: "jti" };
    const session = {
      id: 1,
      user_id: 2,
      jti: "jti",
      token_hash: hashRefreshToken("real-token"),
      expires_at: new Date(Date.now() + 10000),
      revoked_at: null,
    };
    expect(() => assertUsableSession(session, decoded, "tampered-token")).toThrow(
      /Invalid refresh token/
    );
  });

  test("session for another user is rejected", () => {
    const decoded = { id: 2, jti: "jti" };
    const token = "token";
    const session = {
      id: 1,
      user_id: 99,
      jti: "jti",
      token_hash: hashRefreshToken(token),
      expires_at: new Date(Date.now() + 10000),
      revoked_at: null,
    };
    expect(() => assertUsableSession(session, decoded, token)).toThrow(
      /Invalid refresh token/
    );
  });
});
