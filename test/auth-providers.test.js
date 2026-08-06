const test = require("node:test");
const assert = require("node:assert/strict");
const { authorizationUrl, providerEndpoints } = require("../auth-providers");

test("provider authorization URLs use the registered callback and required scopes", async () => {
  const previous = {
    googleId: process.env.WORDRUSH_GOOGLE_CLIENT_ID,
    googleSecret: process.env.WORDRUSH_GOOGLE_CLIENT_SECRET,
    facebookId: process.env.WORDRUSH_FACEBOOK_APP_ID,
    facebookSecret: process.env.WORDRUSH_FACEBOOK_APP_SECRET,
    publicOrigin: process.env.WORDRUSH_PUBLIC_ORIGIN,
  };
  process.env.WORDRUSH_GOOGLE_CLIENT_ID = "google-client";
  process.env.WORDRUSH_GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.WORDRUSH_FACEBOOK_APP_ID = "facebook-app";
  process.env.WORDRUSH_FACEBOOK_APP_SECRET = "facebook-secret";
  delete process.env.WORDRUSH_PUBLIC_ORIGIN;
  try {
    const req = { headers: { host: "wordrush.party" }, socket: {} };
    const google = new URL(await authorizationUrl("google", req, "state-google"));
    assert.equal(google.origin, "https://accounts.google.com");
    assert.equal(google.searchParams.get("redirect_uri"), "http://wordrush.party/auth/google/callback");
    assert.equal(google.searchParams.get("scope"), "openid email profile");
    assert.equal(google.searchParams.get("state"), "state-google");
    const facebook = new URL(await authorizationUrl("facebook", req, "state-facebook"));
    assert.equal(facebook.origin, "https://www.facebook.com");
    assert.equal(facebook.searchParams.get("scope"), "public_profile");
    assert.equal(providerEndpoints("facebook").userinfo_endpoint.includes("graph.facebook.com"), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = {
        googleId: "WORDRUSH_GOOGLE_CLIENT_ID",
        googleSecret: "WORDRUSH_GOOGLE_CLIENT_SECRET",
        facebookId: "WORDRUSH_FACEBOOK_APP_ID",
        facebookSecret: "WORDRUSH_FACEBOOK_APP_SECRET",
        publicOrigin: "WORDRUSH_PUBLIC_ORIGIN",
      }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});
