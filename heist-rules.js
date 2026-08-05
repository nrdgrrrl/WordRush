(function exposeWordrushHeistRules(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushHeistRules = api;
})(globalThis, () => {
  const DEFAULT_MINIMUM_CLAIM_LENGTH = 6;
  const MAX_PLAYERS = 32;
  const MAX_IDENTIFIER_LENGTH = 128;
  const MAX_WORD_LENGTH = 64;
  const MAX_TEAM_SCORE = 1_000_000;

  function frozenArray(values) {
    return Object.freeze([...values]);
  }

  function frozenObject(values) {
    return Object.freeze(values);
  }

  function identifier(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return text && text.length <= MAX_IDENTIFIER_LENGTH ? text : null;
  }

  function word(value) {
    const text = typeof value === "string" ? value.trim().toLocaleUpperCase() : "";
    return text && text.length <= MAX_WORD_LENGTH ? text : null;
  }

  function minimumLength(value) {
    if (!Number.isSafeInteger(value)) return DEFAULT_MINIMUM_CLAIM_LENGTH;
    return Math.max(1, Math.min(MAX_WORD_LENGTH, value));
  }

  function playerIds(values) {
    const unique = [];
    for (const value of Array.isArray(values) ? values : []) {
      const id = identifier(value);
      if (id && !unique.includes(id) && unique.length < MAX_PLAYERS) unique.push(id);
    }
    return frozenArray(unique);
  }

  function sourceTeams(assignments) {
    if (Array.isArray(assignments)) return assignments;
    if (!assignments || typeof assignments !== "object") return [];
    return Object.entries(assignments).map(([id, values]) => ({ id, playerIds: values }));
  }

  function normalizeTeamAssignments(players, assignments) {
    const expected = playerIds(players);
    const expectedSet = new Set(expected);
    const teams = [];
    const assigned = new Set();
    for (const source of sourceTeams(assignments)) {
      if (teams.length === 2) break;
      const id = identifier(source?.id);
      if (!id || teams.some((team) => team.id === id)) continue;
      const members = [];
      for (const playerId of playerIds(source?.playerIds ?? source?.players)) {
        if (!expectedSet.has(playerId) || assigned.has(playerId)) continue;
        assigned.add(playerId);
        members.push(playerId);
      }
      teams.push(frozenObject({ id, playerIds: frozenArray(members) }));
    }
    return frozenArray(teams);
  }

  function validateTeamAssignments(players, assignments) {
    const expected = playerIds(players);
    const teams = normalizeTeamAssignments(expected, assignments);
    const assigned = teams.flatMap((team) => team.playerIds);
    const seen = new Set();
    let malformedAssignment = false;
    for (const source of sourceTeams(assignments)) {
      for (const value of Array.isArray(source?.playerIds ?? source?.players)
        ? (source.playerIds ?? source.players)
        : []) {
        const id = identifier(value);
        if (!id || !expected.includes(id) || seen.has(id)) malformedAssignment = true;
        else seen.add(id);
      }
    }
    let reason = null;
    if (expected.length < 2) reason = "players";
    else if (teams.length !== 2) reason = "teams";
    else if (teams.some((team) => team.playerIds.length === 0)) reason = "empty_team";
    else if (malformedAssignment || assigned.length !== expected.length) reason = "assignment";
    return frozenObject({
      valid: reason === null,
      reason,
      teams,
      unassignedPlayerIds: frozenArray(expected.filter((id) => !assigned.includes(id))),
    });
  }

  function eligibleClaimWord(value, options = {}) {
    const normalized = word(value);
    const requiredLength = minimumLength(options?.minimumLength);
    return frozenObject({
      eligible: Boolean(normalized && normalized.length >= requiredLength),
      word: normalized,
      minimumLength: requiredLength,
    });
  }

  function normalizedScores(values, teamIds) {
    const source = values && typeof values === "object" ? values : {};
    const scores = {};
    for (const teamId of teamIds) {
      const score = Number(source[teamId]);
      scores[teamId] = Number.isFinite(score)
        ? Math.max(0, Math.min(MAX_TEAM_SCORE, Math.floor(score)))
        : 0;
    }
    return frozenObject(scores);
  }

  function normalizedClaims(values, teamIds) {
    const allowedTeams = new Set(teamIds);
    const claims = [];
    const seen = new Set();
    const source = Array.isArray(values) ? values : [];
    for (const claim of source) {
      if (claims.length >= 500) break;
      const claimedWord = word(claim?.word);
      const teamId = identifier(claim?.teamId);
      if (!claimedWord || !teamId || !allowedTeams.has(teamId) || seen.has(claimedWord)) continue;
      seen.add(claimedWord);
      claims.push(frozenObject({ word: claimedWord, teamId }));
    }
    return frozenArray(claims);
  }

  // Claims deliberately contain words, never board positions: a claimed word is
  // exclusive across teams, while tiles remain available for every later trace.
  function applyWordClaim(state, request) {
    const teamIds = frozenArray(
      sourceTeams(state?.teams).map((team) => identifier(team?.id)).filter(Boolean).slice(0, 2),
    );
    const teamId = identifier(request?.teamId);
    const claim = eligibleClaimWord(request?.word, request);
    const teamScores = normalizedScores(state?.teamScores, teamIds);
    const claims = normalizedClaims(state?.claims, teamIds);
    const points = Number.isSafeInteger(request?.points)
      ? Math.max(0, Math.min(MAX_TEAM_SCORE, request.points))
      : 0;
    const existing = claim.word ? claims.find((entry) => entry.word === claim.word) : null;
    let status = "claimed";
    if (!teamIds.includes(teamId)) status = "team";
    else if (!claim.eligible) status = "ineligible";
    else if (existing?.teamId === teamId) status = "same_team_duplicate";
    else if (existing) status = "cross_team_duplicate";

    const changed = status === "claimed";
    const nextScores = { ...teamScores };
    if (changed) nextScores[teamId] = Math.min(MAX_TEAM_SCORE, nextScores[teamId] + points);
    const nextClaims = changed
      ? frozenArray([...claims, frozenObject({ word: claim.word, teamId })])
      : claims;
    return frozenObject({
      changed,
      status,
      word: claim.word,
      teamId,
      pointsAwarded: changed ? points : 0,
      teamScores: frozenObject(nextScores),
      claims: nextClaims,
    });
  }

  return frozenObject({
    DEFAULT_MINIMUM_CLAIM_LENGTH,
    MAX_PLAYERS,
    applyWordClaim,
    eligibleClaimWord,
    normalizeTeamAssignments,
    validateTeamAssignments,
  });
});
