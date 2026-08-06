const crypto = require("node:crypto");

const PROVIDER_NAMES = Object.freeze(["google", "facebook"]);
const GOOGLE_FALLBACK = Object.freeze({
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
});

function clean(value, maximum = 255) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum);
}

function configuredProvider(provider) {
  if (provider === "google") {
    const clientId = clean(process.env.WORDRUSH_GOOGLE_CLIENT_ID);
    const clientSecret = clean(process.env.WORDRUSH_GOOGLE_CLIENT_SECRET);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
  if (provider === "facebook") {
    const clientId = clean(process.env.WORDRUSH_FACEBOOK_APP_ID);
    const clientSecret = clean(process.env.WORDRUSH_FACEBOOK_APP_SECRET);
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
  return null;
}

function enabledProviders() {
  return PROVIDER_NAMES.filter((provider) => configuredProvider(provider));
}

function publicOrigin(req) {
  if (process.env.WORDRUSH_PUBLIC_ORIGIN)
    return process.env.WORDRUSH_PUBLIC_ORIGIN.replace(/\/$/, "");
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwarded || (req.socket.encrypted ? "https" : "http");
  return protocol + "://" + req.headers.host;
}

function redirectUri(req, provider) {
  return publicOrigin(req) + "/auth/" + provider + "/callback";
}

function facebookVersion() {
  return clean(process.env.WORDRUSH_FACEBOOK_GRAPH_VERSION || "v23.0", 20)
    .replace(/[^a-zA-Z0-9.]/g, "");
}

function providerEndpoints(provider) {
  if (provider === "google") return { ...GOOGLE_FALLBACK };
  if (provider === "facebook") {
    const version = facebookVersion();
    return {
      authorization_endpoint: "https://www.facebook.com/" + version + "/dialog/oauth",
      token_endpoint: "https://graph.facebook.com/" + version + "/oauth/access_token",
      userinfo_endpoint: "https://graph.facebook.com/" + version + "/me",
    };
  }
  throw new Error("AUTH_PROVIDER_INVALID");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.error)
    throw new Error("AUTH_PROVIDER_REQUEST_FAILED");
  return payload;
}

async function googleEndpoints() {
  return { ...GOOGLE_FALLBACK };
}

async function authorizationUrl(provider, req, state) {
  const credentials = configuredProvider(provider);
  if (!credentials) throw new Error("AUTH_PROVIDER_NOT_CONFIGURED");
  const endpoints = provider === "google" ? await googleEndpoints() : providerEndpoints(provider);
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: redirectUri(req, provider),
    response_type: "code",
    state,
  });
  if (provider === "google") {
    params.set("scope", "openid email profile");
    params.set("access_type", "online");
    params.set("prompt", "select_account");
  } else {
    params.set("scope", "public_profile");
  }
  return endpoints.authorization_endpoint + "?" + params;
}

async function providerIdentity(provider, req, code) {
  const credentials = configuredProvider(provider);
  if (!credentials) throw new Error("AUTH_PROVIDER_NOT_CONFIGURED");
  const endpoints = provider === "google" ? await googleEndpoints() : providerEndpoints(provider);
  let token;
  if (provider === "google") {
    token = await fetchJson(endpoints.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: redirectUri(req, provider),
        grant_type: "authorization_code",
      }),
    });
  } else {
    const tokenUrl = new URL(endpoints.token_endpoint);
    tokenUrl.search = new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: redirectUri(req, provider),
    });
    token = await fetchJson(tokenUrl);
  }
  if (typeof token.access_token !== "string" || !token.access_token)
    throw new Error("AUTH_ACCESS_TOKEN_MISSING");
  let identity;
  if (provider === "google") {
    identity = await fetchJson(endpoints.userinfo_endpoint, {
      headers: { Authorization: "Bearer " + token.access_token },
    });
    if (typeof identity.sub !== "string" || !identity.sub)
      throw new Error("AUTH_IDENTITY_INVALID");
    return {
      provider,
      providerId: identity.sub,
      displayName: identity.name || identity.given_name || "Player",
      avatar: identity.picture || "🐈",
    };
  }
  const userUrl = new URL(endpoints.userinfo_endpoint);
  userUrl.search = new URLSearchParams({
    fields: "id,name,picture.type(large)",
    access_token: token.access_token,
  });
  identity = await fetchJson(userUrl);
  if (typeof identity.id !== "string" || !identity.id)
    throw new Error("AUTH_IDENTITY_INVALID");
  return {
    provider,
    providerId: identity.id,
    displayName: identity.name || "Player",
    avatar: identity.picture?.data?.url || "🐈",
  };
}

function randomState() {
  return crypto.randomBytes(32).toString("base64url");
}

module.exports = {
  PROVIDER_NAMES,
  authorizationUrl,
  configuredProvider,
  enabledProviders,
  facebookVersion,
  googleEndpoints,
  providerEndpoints,
  providerIdentity,
  publicOrigin,
  randomState,
  redirectUri,
};
