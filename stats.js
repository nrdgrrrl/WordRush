(() => {
  const metric = [
    ['wordsPerMinute', 'Words / minute', p => p.totalGameSeconds ? p.words / (p.totalGameSeconds / 60) : 0, true],
    ['averageScore', 'Average score', p => p.rounds ? p.score / p.rounds : 0, true],
    ['averageWordLength', 'Average word length', p => p.words ? p.totalWordLength / p.words : 0, true],
    ['correctRate', 'Correct words', p => (p.correct + p.incorrect) ? p.correct / (p.correct + p.incorrect) * 100 : 0, true, '%'],
    ['incorrectRate', 'Incorrect words', p => (p.correct + p.incorrect) ? p.incorrect / (p.correct + p.incorrect) * 100 : 0, true, '%'],
    ['gamesWon', 'Games won', p => p.gamesWon || 0],
    ['gamesLost', 'Games lost', p => p.gamesLost || 0],
    ['winRate', 'Win rate', p => (p.gamesWon + p.gamesLost) ? p.gamesWon / (p.gamesWon + p.gamesLost) * 100 : 0, true, '%'],
    ['totalScore', 'Total score', p => p.score || 0],
    ['totalWords', 'Words found', p => p.words || 0],
    ['longestWord', 'Longest word', p => p.longest || 0, false, ' letters'],
    ['rounds', 'Rounds played', p => p.rounds || 0]
    ,['multiplayerWins', 'Multiplayer wins', p => p.multiplayerWins || 0]
    ,['multiplayerWinRate', 'Multiplayer win rate', p => (p.multiplayerWins + p.multiplayerLosses) ? p.multiplayerWins / (p.multiplayerWins + p.multiplayerLosses) * 100 : 0, true, '%']
  ];
  const read = () => { try { return JSON.parse(localStorage.getItem('wordrush-profile') || '{}'); } catch { return {}; } };
  const value = (number, decimal, suffix = '') => (decimal ? Number(number || 0).toFixed(1) : Math.round(number || 0).toLocaleString()) + suffix;
  function render() {
    const profile = read();
    const grid = document.querySelector('#statsGrid');
    if (!grid) return;
    grid.innerHTML = metric.map(([id, label, get, decimal, suffix]) => '<article class="stat-card" data-stat="' + id + '"><small>' + label + '</small><strong>' + value(get(profile), decimal, suffix) + '</strong></article>').join('');
  }
  render();
  window.wordrushStatsEvent = render;
})();
