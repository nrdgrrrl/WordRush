const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

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

test("production serves players without a main password", async (t) => {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      // A stale deployment variable must not bring the removed gate back.
      WORDRUSH_BETA_PASSWORD_HASH: "obsolete-password-setting",
      WORDRUSH_ALLOWED_ORIGINS: origin,
      WORDRUSH_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      WORDRUSH_CAST_APPLICATION_ID: "87810A91",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const home = await fetch(origin, { redirect: "manual" });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="homeScreen"/);

  const castConfig = await fetch(origin + "/api/cast-config");
  assert.equal(castConfig.status, 200);
  assert.deepEqual(await castConfig.json(), { applicationId: "87810A91" });

  const wordCheck = await fetch(origin + "/api/word-check?word=TEA");
  assert.equal(wordCheck.status, 200);
  assert.deepEqual(await wordCheck.json(), { valid: true });

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: origin },
    });
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify({
      type: "hello",
      guestId: "public-player",
    })));
    ws.on("message", (raw) => {
      if (JSON.parse(raw).type === "hello_ack") {
        ws.close();
        resolve();
      }
    });
  });
});

test("public production routes still enforce configured host and origin", async (t) => {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      WORDRUSH_ALLOWED_ORIGINS: origin,
      WORDRUSH_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/",
      headers: { Host: "example.invalid" },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
  });
  assert.equal(badHostStatus, 421);

  const badOrigin = await fetch(origin + "/api/leaderboard/score", {
    method: "POST",
    headers: { Origin: "https://example.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ id: "blocked" }),
  });
  assert.equal(badOrigin.status, 403);
});
