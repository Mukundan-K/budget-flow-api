function getGoogleCallbackUrl() {
  return process.env.GOOGLE_CALLBACK_URL;
}

module.exports = { getGoogleCallbackUrl };
