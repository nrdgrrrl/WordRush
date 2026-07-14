(() => {
  const socketUrl = location.protocol === 'https:' ? 'wss://' + location.host : 'ws://' + location.host;
  let socket;
  const guestId = localStorage.getItem('wordrush-guest-id') || (crypto.randomUUID ? crypto.randomUUID() : 'guest-' + Math.random().toString(36).slice(2));
  localStorage.setItem('wordrush-guest-id', guestId);
  const name = localStorage.getItem('wordrush-name') || 'Jordan';
  const toast = message => { const el = document.querySelector('#toast'); if (!el) return; el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 1800); };
  function connect() {
    if (socket && socket.readyState <= 1) return socket;
    socket = new WebSocket(socketUrl);
    window.wordrushSocket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', guestId, name })));
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'room_created') { localStorage.setItem('wordrush-room', message.code); toast('Room ' + message.code + ' created'); }
      if (message.type === 'joined_room') { localStorage.setItem('wordrush-room', message.code); toast('Joined room ' + message.code); }
      if (message.type === 'round_started') { window.wordrushOnlineRound?.(message.round, message.config, message.mode); toast('Round started · ' + message.players.length + ' players'); } if (message.type === 'room_state' && message.round && message.status === 'playing') { window.wordrushOnlineRound?.(message.round, { label: message.mode.toUpperCase(), rule: 'Multiplayer round' }, message.mode); }
      if (message.type === 'word_accepted') { document.querySelector('#gameScore').textContent = message.scores.find(score => score.id === message.playerId)?.score || document.querySelector('#gameScore').textContent; }
      if (message.type === 'word_rejected') toast(message.reason === 'path' ? 'Invalid path' : 'Word rejected');
      if (message.type === 'round_finished') { window.wordrushOnlineFinish?.(message.ranking); toast('Round complete'); } 
      if (message.type === 'error') toast(message.code.replaceAll('_', ' ').toLowerCase());
    });
    socket.addEventListener('close', () => { window.wordrushSocket = null; });
    return socket;
  }
  document.querySelector('#createRoom')?.addEventListener('click', () => {
    const ws = connect();
    const requested = (prompt('Mode: classic, minimum, sudden, race, or dirty', 'classic') || 'classic').trim().toLowerCase(); const mode = ['classic','minimum','sudden','race','dirty'].includes(requested) ? requested : 'classic'; const send = () => ws.send(JSON.stringify({ type: 'create_room', mode, name }));
    ws.readyState === 1 ? send() : ws.addEventListener('open', send, { once: true });
  });
  document.querySelector('#joinFeatured')?.addEventListener('click', () => {
    const code = prompt('Enter room code')?.trim().toUpperCase();
    if (!code) return;
    const ws = connect();
    const send = () => ws.send(JSON.stringify({ type: 'join_room', code, name }));
    ws.readyState === 1 ? send() : ws.addEventListener('open', send, { once: true });
  });
})();



