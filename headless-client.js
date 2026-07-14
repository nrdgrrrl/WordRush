const WebSocket = require("ws");
const count = Number(process.argv[process.argv.indexOf("--clients") + 1] || 2);
const mode = process.argv[process.argv.indexOf("--mode") + 1] || "classic";
const port = Number(process.env.PORT || 8000);
const clients = [];
function next(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for " + type)),
      5000,
    );
    const onMessage = (raw) => {
      const message = JSON.parse(raw);
      if (message.type === "error") {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(new Error(message.code));
      } else if (message.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(message);
      }
    };
    ws.on("message", onMessage);
  });
}
function connect(index) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port);
    ws.once("error", reject);
    ws.once("open", async () => {
      const acknowledged = next(ws, "hello_ack");
      ws.send(
        JSON.stringify({
          type: "hello",
          name: "Bot " + (index + 1),
          guestId: "headless-" + index,
        }),
      );
      try {
        await acknowledged;
        resolve(ws);
      } catch (error) {
        reject(error);
      }
    });
  });
}
(async () => {
  if (count < 1 || count > 10)
    throw new Error("--clients must be between 1 and 10");
  if (
    ![
      "classic",
      "minimum",
      "sudden",
      "race",
      "coop",
      "dirty",
      "random",
    ].includes(mode)
  )
    throw new Error("Unsupported --mode " + mode);
  for (let i = 0; i < count; i++) clients.push(await connect(i));
  const createdPromise = next(clients[0], "room_created");
  clients[0].send(JSON.stringify({ type: "create_room", name: "Bot 1" }));
  const { code: roomCode } = await createdPromise;
  for (let i = 1; i < clients.length; i++) {
    const joinedPromise = next(clients[i], "joined_room");
    clients[i].send(
      JSON.stringify({
        type: "join_room",
        code: roomCode,
        name: "Bot " + (i + 1),
      }),
    );
    await joinedPromise;
  }
  const startedPromise = next(clients[0], "round_started");
  clients[0].send(JSON.stringify({ type: "start_game", mode }));
  const started = await startedPromise;
  console.log(
    JSON.stringify({
      event: "round_started",
      room: roomCode,
      players: clients.length,
      mode: started.mode,
      size: started.round.size,
    }),
  );
  clients.forEach((ws) => ws.close());
})().catch((error) => {
  clients.forEach((ws) => ws.close());
  console.error(error.message);
  process.exitCode = 1;
});
