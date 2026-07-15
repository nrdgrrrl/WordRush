const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}
async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 3000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Wordrush listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code})`));
    });
  });
}
test("production beta gate protects HTTP and WebSocket access", async (t) => {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      WORDRUSH_BETA_PASSWORD_HASH: passwordHash("correct horse battery staple"),
      WORDRUSH_ALLOWED_ORIGINS: origin,
      WORDRUSH_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      WORDRUSH_SESSION_COOKIE_SECURE: "0",
      WORDRUSH_CAST_APPLICATION_ID: "87810A91",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const anonymous = await fetch(origin, { redirect: "manual" });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/auth/login");
  const receiver = await fetch(origin + "/receiver/", { redirect: "manual" });
  assert.equal(receiver.status, 200);
  assert.match(
    receiver.headers.get("content-security-policy"),
    /https:\/\/www\.gstatic\.com/,
  );
  const qr = await fetch(origin + "/qr.svg?join=ABCDE", { redirect: "manual" });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
  assert.equal((await fetch(origin + "/qr.svg?join=bad")).status, 400);
  const anonymousCastConfig = await fetch(origin + "/api/cast-config");
  assert.equal(anonymousCastConfig.status, 401);
  const anonymousWordCheck = await fetch(origin + "/api/word-check?word=TEA");
  assert.equal(anonymousWordCheck.status, 401);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
  );
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/display`, {
      headers: { Origin: origin },
    });
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify({
      type: "display_hello",
      token: "invalid-display-token",
    })));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.type === "error") {
        assert.equal(message.code, "INVALID_DISPLAY_TOKEN");
        ws.close();
        resolve();
      }
    });
  });

  const login = await fetch(origin + "/auth/login", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=" + encodeURIComponent("correct horse battery staple"),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  assert.match(cookie, /^wordrush_session=/);
  const castConfig = await fetch(origin + "/api/cast-config", {
    headers: { Cookie: cookie },
  });
  assert.equal(castConfig.status, 200);
  assert.deepEqual(await castConfig.json(), { applicationId: "87810A91" });

  for (const [query, expected] of [
    ["word=TEA", true],
    ["word=CAR", true],
    ["word=WORDRUSHISNOTAWORD", false],
    ["word=SHIT", false],
    ["word=SHIT&adult=1", true],
  ]) {
    const wordCheck = await fetch(origin + "/api/word-check?" + query, {
      headers: { Cookie: cookie },
    });
    assert.equal(wordCheck.status, 200);
    assert.equal(wordCheck.headers.get("cache-control"), "private, max-age=86400");
    const body = await wordCheck.text();
    assert.ok(body.length < 32, "word-check response should stay tiny");
    assert.deepEqual(JSON.parse(body), { valid: expected });
  }
  assert.equal(
    (
      await fetch(origin + "/api/word-check?word=TEA!", {
        headers: { Cookie: cookie },
      })
    ).status,
    400,
  );

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Cookie: cookie, Origin: origin },
    });
    ws.once("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "hello", guestId: "beta-test" }));
    });
    ws.on("message", (raw) => {
      if (JSON.parse(raw).type === "hello_ack") {
        ws.close();
        resolve();
      }
    });
  });
});
