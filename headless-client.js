const WebSocket = require('ws');
const { setTimeout: wait } = require('node:timers/promises');
const count = Number(process.argv[process.argv.indexOf('--clients') + 1] || 2);
const mode = process.argv[process.argv.indexOf('--mode') + 1] || 'classic';
const port = Number(process.env.PORT || 8000);
const clients = [];
function connect(index) { return new Promise((resolve, reject) => { const ws = new WebSocket('ws://127.0.0.1:' + port); ws.once('error', reject); ws.once('open', () => { ws.send(JSON.stringify({ type: 'hello', name: 'Bot ' + (index + 1), guestId: 'headless-' + index })); resolve(ws); }); }); }
(async () => { if (count < 1 || count > 10) throw new Error('--clients must be between 1 and 10'); for (let i = 0; i < count; i++) clients.push(await connect(i)); let roomCode; clients[0].on('message', raw => { const message = JSON.parse(raw); if (message.type === 'room_created') roomCode = message.code; if (message.type === 'round_started') console.log(JSON.stringify({ event: 'round_started', room: roomCode, players: count, mode: message.mode, size: message.round.size })); }); clients[0].send(JSON.stringify({ type: 'create_room', mode, name: 'Bot 1' })); await wait(250); for (let i = 1; i < clients.length; i++) clients[i].send(JSON.stringify({ type: 'join_room', code: roomCode, name: 'Bot ' + (i + 1) })); await wait(500); console.log(JSON.stringify({ event: 'headless_ready', players: clients.length, mode })); await wait(300); clients.forEach(ws => ws.close()); })().catch(error => { console.error(error.message); process.exitCode = 1; });
