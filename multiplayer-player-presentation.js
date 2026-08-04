(function exposeWordrushMultiplayerPlayerPresentation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushMultiplayerPlayerPresentation = api;
})(globalThis, () => {
  function isConnected(player) {
    return player?.connected !== false;
  }

  function describeSeat(player) {
    return {
      connected: isConnected(player),
      status: isConnected(player) ? "Connected" : "Reconnecting",
    };
  }

  function summarizeSeats(players) {
    const seats = Array.isArray(players) ? players : [];
    const connectedCount = seats.filter(isConnected).length;
    return {
      connectedCount,
      retainedCount: seats.length,
      reconnectingCount: seats.length - connectedCount,
    };
  }

  return Object.freeze({ describeSeat, summarizeSeats });
});
