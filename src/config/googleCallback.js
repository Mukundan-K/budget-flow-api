const PRODUCTION_CALLBACK_URL =
  "https://budget-flow-api.onrender.com/auth/google/callback";
const LOCAL_CALLBACK_URL = "http://localhost:5000/auth/google/callback";

function isProductionRuntime() {
  return (
    process.env.NODE_ENV === "production" || process.env.RENDER === "true"
  );
}

function getGoogleCallbackUrl() {
  const fromEnv = String(process.env.GOOGLE_CALLBACK_URL || "").trim();

  if (isProductionRuntime()) {
    if (fromEnv && !/localhost|127\.0\.0\.1/i.test(fromEnv)) {
      return fromEnv;
    }
    return PRODUCTION_CALLBACK_URL;
  }

  return fromEnv || LOCAL_CALLBACK_URL;
}

module.exports = { getGoogleCallbackUrl, LOCAL_CALLBACK_URL, PRODUCTION_CALLBACK_URL };
