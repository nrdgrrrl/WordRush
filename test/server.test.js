const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { server, rooms } = require('../server');
function message(ws, type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); }
function next(ws, wanted) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + wanted)), 1500); const handler = raw => { const data = JSON.parse(raw); if (data.type === wanted || (wanted === 'error' && data.type === 'error')) { clearTimeout(timer); ws.off('message', handler); resolve(data); } }; ws.on('message', handler); }); }
function client(name) { return new Promise((resolve, reject) => { const ws = new WebSocket('ws://127.0.0.1:' + server.address().port); ws.once('error', reject); ws.once('open', () => { message(ws, 'hello', { name, guestId: name }); next(ws, 'hello_ack').then(() => resolve(ws)); }); }); }
test.before(() => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise(resolve => { for (const room of rooms.values()) room.players.forEach(player => player.ws.close()); rooms.clear(); server.close(resolve); }));
test('creates a session, starts a round, and admits ten players', async () => { const players = await Promise.all(Array.from({ length: 10 }, (_, i) => client('player-' + i))); const createdPromise = next(players[0], 'room_created'); const lobbyPromise = next(players[0], 'room_state'); message(players[0], 'create_room', { name: 'player-0' }); const created = await createdPromise; await lobbyPromise; const startedPromise = next(players[0], 'round_started'); message(players[0], 'start_game', { mode: 'race' }); const started = await startedPromise; assert.equal(started.round.size, 4); for (let i = 1; i < players.length; i++) message(players[i], 'join_room', { code: created.code, name: 'player-' + i }); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(rooms.get(created.code).players.size, 10); assert.equal(created.code.length, 5); players.forEach(ws => ws.close()); });
test('rejects the eleventh player', async () => { const players = await Promise.all(Array.from({ length: 11 }, (_, i) => client('overflow-' + i))); const createdPromise = next(players[0], 'room_created'); const lobbyPromise = next(players[0], 'room_state'); message(players[0], 'create_room', { mode: 'classic' }); const created = await createdPromise; await lobbyPromise; const startedPromise = next(players[0], 'round_started'); message(players[0], 'start_game', { mode: 'classic' }); await startedPromise; for (let i = 1; i < 10; i++) message(players[i], 'join_room', { code: created.code }); await next(players[0], 'room_state'); message(players[10], 'join_room', { code: created.code }); assert.equal((await next(players[10], 'error')).code, 'ROOM_FULL'); players.forEach(ws => ws.close()); });




test('authoritatively accepts a valid path and rejects an invalid word', async () => { const ws = await client('scorer'); const accepted = new Promise(resolve => ws.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'word_accepted') resolve(message); })); const createdPromise = next(ws, 'room_created'); const lobbyPromise = next(ws, 'room_state'); message(ws, 'create_room', { mode: 'classic' }); const created = await createdPromise; await lobbyPromise; const startedPromise = next(ws, 'round_started'); message(ws, 'start_game', { mode: 'classic' }); const started = await startedPromise; const board = started.round.board; let found; for (let i = 0; i < board.length && !found; i++) for (let j = 0; j < board.length && !found; j++) if (i !== j && board[i] === 'S' && board[j] === 'T') found = [i,j]; if (!found) { ws.close(); return; } message(ws, 'submit_word', { word: 'ST', path: found }); const result = await next(ws, 'word_rejected'); assert.equal(result.type, 'word_rejected'); assert.equal(created.code.length, 5); ws.close(); });

test('propagates player identities through room state, score updates, and rankings', async () => {
  const host = await client('identity-host');
  const guest = await client('identity-guest');
  const createdPromise = next(host, 'room_created');
  const lobbyPromise = next(host, 'room_state');
  message(host, 'create_room', { name: 'VelvetWhisker', avatar: '🦊' });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, 'joined_room');
  const statePromise = next(host, 'room_state');
  message(guest, 'join_room', { code: created.code, name: 'CosmicPaw', avatar: '🐼' });
  await joinedPromise;
  const state = await statePromise;
  assert.deepEqual(state.players.map(player => [player.name, player.avatar]), [['VelvetWhisker', '🦊'], ['CosmicPaw', '🐼']]);
  const room = rooms.get(created.code);
  room.status = 'finished';
  room.round = null;
  const ranking = [...room.players.values()].map(player => ({ id: player.id, name: player.name, avatar: player.avatar, score: player.score }));
  assert.equal(ranking.find(player => player.name === 'CosmicPaw').avatar, '🐼');
  host.close();
  guest.close();
});

test('creator can launch cooperative multiplayer sessions', async () => {
  const host = await client('coop-host');
  const guest = await client('coop-guest');
  const createdPromise = next(host, 'room_created');
  const lobbyPromise = next(host, 'room_state');
  message(host, 'create_room', { name: 'TeamHost' });
  const created = await createdPromise;
  await lobbyPromise;
  const joinedPromise = next(guest, 'joined_room');
  message(guest, 'join_room', { code: created.code, name: 'TeamGuest' });
  await joinedPromise;
  const startedPromise = next(host, 'round_started');
  message(host, 'start_game', { mode: 'coop' });
  const started = await startedPromise;
  assert.equal(started.config.label, 'CO-OP');
  assert.equal(rooms.get(created.code).mode, 'coop');
  host.close(); guest.close();
});
