(() => {
  const socketUrl = location.protocol === 'https:' ? 'wss://' + location.host : 'ws://' + location.host;
  const guestId = localStorage.getItem('wordrush-guest-id') || (crypto.randomUUID ? crypto.randomUUID() : 'guest-' + Math.random().toString(36).slice(2));
  localStorage.setItem('wordrush-guest-id', guestId);
  let socket, sessionCode = '', endedSessionCode = '', creator = false;
  const $ = selector => document.querySelector(selector);
  const goHome = () => document.querySelector('[data-screen="homeScreen"]')?.click();
  const identity = () => window.wordrushProfile ? window.wordrushProfile() : { name: 'Guest', avatar: '🐈' };
  const toast = message => { const el = $('#toast'); if (!el) return; el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 1800); };
  function clearSession(code = sessionCode) { if (code) endedSessionCode = code; sessionCode = ''; window.wordrushSessionCode = ''; creator = false; localStorage.removeItem('wordrush-room'); $('#multiplayerBanner').hidden = true; $('#multiplayerBannerText').textContent = 'No active session'; $('#sessionLobby').hidden = true; $('#sessionChoices').hidden = false; $('#roomTitle').textContent = 'No active session'; $('#roomSubtitle').textContent = 'Create or join a multiplayer session'; $('#sessionPlayersText').textContent = '1 player connected'; }
  function renderPlayers(players) {
    const target = $('#livePlayers'); if (!target) return;
    target.innerHTML = (players || []).map(player => '<div class="live-player"><span class="player-avatar">' + (player.avatar || '🐈') + '</span><span class="player-name">' + player.name + '</span><b>' + player.score + '</b></div>').join('');
    if (sessionCode) { $('#multiplayerBanner').hidden = false; $('#multiplayerBannerText').textContent = (players || []).length + ' player' + ((players || []).length === 1 ? '' : 's') + ' in session'; $('#roomTitle').textContent = 'Multiplayer · ' + sessionCode; $('#roomSubtitle').textContent = (players || []).length + ' player' + ((players || []).length === 1 ? '' : 's') + ' connected'; $('#sessionPlayersText').textContent = (players || []).length + ' player' + ((players || []).length === 1 ? '' : 's') + ' connected'; }
  }
  function sessionDialog(open = true) { if (open) $('#multiplayerDialog').showModal(); else $('#multiplayerDialog').close(); }
  function showLobby(code, isCreator) { sessionCode = code; window.wordrushSessionCode = code; creator = isCreator; $('#multiplayerBanner').hidden = false; $('#sessionChoices').hidden = true; $('#sessionLobby').hidden = false; $('#sessionCode').textContent = code; $('#sessionStart').hidden = !creator; $('#sessionType').disabled = !creator; sessionDialog(); }
  function sendWhenReady(payload) { const send = () => socket.send(JSON.stringify(payload)); socket.readyState === 1 ? send() : socket.addEventListener('open', send, { once: true }); }
  function connect() {
    if (socket && socket.readyState <= 1) return socket;
    socket = new WebSocket(socketUrl); window.wordrushSocket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', guestId, ...identity() })));
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'session_closed') { clearSession(message.code); goHome(); if ($('#multiplayerDialog').open) $('#multiplayerDialog').close(); toast('Multiplayer session ended'); }
      if (message.type === 'session_left') { clearSession(message.code); goHome(); if ($('#multiplayerDialog').open) $('#multiplayerDialog').close(); toast('Left multiplayer session'); }
      if (message.type === 'room_created') { localStorage.setItem('wordrush-room', message.code); showLobby(message.code, true); toast('Session ' + message.code + ' created'); }
      if (message.type === 'joined_room') { localStorage.setItem('wordrush-room', message.code); showLobby(message.code, false); toast('Joined session ' + message.code); }
      if (message.type === 'room_state' && message.code !== endedSessionCode) { renderPlayers(message.players); if (message.code && !sessionCode) showLobby(message.code, message.creatorId === guestId); if (message.round && message.status === 'playing') window.wordrushOnlineRound?.(message.round, { label: message.mode.toUpperCase(), rule: 'Multiplayer round' }, message.mode); }
      if (message.type === 'round_started') { renderPlayers(message.players); window.wordrushOnlineRound?.(message.round, message.config, message.mode); sessionDialog(false); toast('Round started · ' + message.players.length + ' players'); }
      if (message.type === 'word_accepted') { if (message.playerId === guestId) window.wordrushRecordOnlineWord?.(message.word); renderPlayers(message.scores); const own = message.scores.find(score => score.id === message.playerId); if (own && $('#gameScore')) $('#gameScore').textContent = own.score; }
      if (message.type === 'word_rejected') { if (message.playerId === guestId) window.wordrushRecordOnlineIncorrect?.(); toast(message.reason === 'path' ? 'Invalid path' : 'Word rejected'); }
      if (message.type === 'round_finished') { window.wordrushOnlineFinish?.(message.ranking,{cooperative:message.cooperative,teamScore:message.teamScore,stats:message.stats}); toast(message.cooperative ? 'Team round complete' : 'Round complete'); }
      if (message.type === 'error') toast(message.code.replaceAll('_', ' ').toLowerCase());
    });
    socket.addEventListener('close', () => { window.wordrushSocket = null; clearSession(); goHome(); }); return socket;
  }
  window.wordrushIdentityChanged=()=>{if(socket?.readyState===1&&sessionCode)socket.send(JSON.stringify({type:'update_identity',...identity()}))};
  $('#multiplayerButton')?.addEventListener('click', () => { $('#sessionChoices').hidden = false; $('#sessionLobby').hidden = true; sessionDialog(); });
  $('#sessionManage')?.addEventListener('click', () => sessionDialog());
  $('#sessionCreate')?.addEventListener('click', () => { const ws = connect(); sendWhenReady({ type: 'create_room', ...identity() }); });
  $('#sessionJoin')?.addEventListener('click', () => { const code = prompt('Enter the 5-letter session code')?.trim().toUpperCase(); if (!/^[A-Z]{5}$/.test(code || '')) return toast('Enter a 5-letter code'); socket = connect(); sendWhenReady({ type: 'join_room', code, ...identity() }); });
  $('#sessionStart')?.addEventListener('click', () => { const mode = $('#sessionType').value; sendWhenReady({ type: 'start_game', mode }); });
  $('#sessionLeave')?.addEventListener('click', () => leaveSession());$('#exitMultiplayer')?.addEventListener('click', () => { if (confirm(creator ? 'Exit multiplayer mode? This will end the session for everyone.' : 'Exit multiplayer mode?')) leaveSession(); });function leaveSession(){if(socket?.readyState===1&&sessionCode)sendWhenReady({type:'leave_session'});else { clearSession(); goHome(); sessionDialog(false); }}
})();
