import test from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_MATCHES } from '../src/data/sandboxData.ts';
import {
  buildFootballMatchExplanation,
  computeFootballMatchPrediction,
  computeFootballPlayerProp,
} from '../src/engine/footballModel.ts';
import {
  buildNbaMatchExplanation,
  computeNbaMatchPrediction,
  computeNbaPlayerProp,
} from '../src/engine/nbaModel.ts';
import {
  evaluatePredictionHistory,
  MIN_CALIBRATION_SAMPLES,
  runTemporalValidation,
} from '../src/engine/calibrationEngine.ts';
import {
  buildFootballPlayerFromHistory,
  promoteOfficialToConfirmedLineup,
  selectProbableSideFromHistory,
  type EspnSoccerTeamLineupHistory,
} from '../server/footballIntelligence.ts';
import {
  applyNewsAndInjuriesToNbaPlayers,
  normalizeNbaName,
  type ParsedInjuryRecord,
} from '../server/nbaIntelligence.ts';
import { evaluateMatchStatOverUnder } from '../src/engine/distributionMath.ts';
import { evaluateFeedStaleness, evaluateMatchProvenance } from '../server/dataHealth.ts';
import {
  mergeHydratedMatchDetails,
  mergeMatchesAcrossSources,
  mergeStandingsAcrossSources,
} from '../server/liveAdapters.ts';
import type { LoggedPrediction, MatchRecord, PlayerNewsItem, PlayerProfile, StandingEntry } from '../src/types/sports.ts';

function cloneMatch<T>(m: T): T {
  return JSON.parse(JSON.stringify(m)) as T;
}

test('Football probable XI reduces starter confidence on cross-source discrepancy and promoteOfficialToConfirmedLineup preserves probableLineup', () => {
  const history: EspnSoccerTeamLineupHistory = {
    teamId: 'espn-1',
    teamName: 'Club Test',
    teamShort: 'CT',
    formation: '4-3-3',
    matchesAnalyzed: 3,
    sources: ['ESPN Soccer Plantilla Oficial'],
    players: [
      { athleteId: 'p1', name: 'Marc Portero', shortName: 'M. Portero', number: 1, posCode: 'G', posLabel: 'GK', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p2', name: 'Luis Defensa', shortName: 'L. Defensa', number: 2, posCode: 'D', posLabel: 'DEF', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p3', name: 'Carlos Central', shortName: 'C. Central', number: 4, posCode: 'D', posLabel: 'DEF', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p4', name: 'Mario Lateral', shortName: 'M. Lateral', number: 3, posCode: 'D', posLabel: 'DEF', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p5', name: 'Hugo Zaguero', shortName: 'H. Zaguero', number: 5, posCode: 'D', posLabel: 'DEF', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p6', name: 'Pablo Pivote', shortName: 'P. Pivote', number: 6, posCode: 'M', posLabel: 'MID', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p7', name: 'Diego Interior', shortName: 'D. Interior', number: 8, posCode: 'M', posLabel: 'MID', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p8', name: 'Lucas Mediapunta', shortName: 'L. Mediapunta', number: 10, posCode: 'M', posLabel: 'MID', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p9', name: 'Rafa Extremo', shortName: 'R. Extremo', number: 7, posCode: 'F', posLabel: 'FWD', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p10', name: 'Mateo Delantero', shortName: 'M. Delantero', number: 9, posCode: 'F', posLabel: 'FWD', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p11', name: 'Sergio Punta', shortName: 'S. Punta', number: 11, posCode: 'F', posLabel: 'FWD', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p12', name: 'Nico Suplente', shortName: 'N. Suplente', number: 14, posCode: 'F', posLabel: 'FWD', recentStarts: 0, recentAppearances: 3 },
    ],
  };

  // Baseline consensus (no conflict)
  const cleanProbable = selectProbableSideFromHistory(history, 't1', 'Club Test', 'CT', [], []);
  assert.equal(cleanProbable.discrepancies.length, 0);
  assert.equal(cleanProbable.starters.length, 11);

  // Discrepancy: ESPN says p8 started 3/3 (94%), press/grounding marks doubtful (~42%)
  const conflictProbable = selectProbableSideFromHistory(
    history,
    't1',
    'Club Test',
    'CT',
    [
      {
        id: 'n1',
        source: 'Marca',
        headline: 'Lucas Mediapunta es duda por molestias musculares',
        summary: 'Lucas Mediapunta tiene molestias y apunta a rotación.',
        publishedAt: new Date().toISOString(),
        confirmed: false,
        playerNames: ['Lucas Mediapunta'],
      },
    ],
    []
  );

  assert.ok(conflictProbable.discrepancies.length > 0, 'Conflict between recent starts and press must be detected');
  assert.ok(
    conflictProbable.avgStarterConfidence < cleanProbable.avgStarterConfidence,
    'Discrepancy must reduce average probable starter confidence'
  );
  const lucas = conflictProbable.allPlayers.find((p) => p.name === 'Lucas Mediapunta');
  assert.equal(lucas?.availability, 'doubtful');
  assert.ok((lucas?.starterConfidence ?? 100) < 60);

  // Promote official confirmed lineup while keeping probableLineup preserved
  const baseMatch = cloneMatch(SANDBOX_MATCHES[0]);
  baseMatch.lineupStatus = 'provisional';
  baseMatch.probableLineup = {
    confirmed: false,
    homeFormation: '4-3-3',
    awayFormation: '4-2-3-1',
    homeStarters: cleanProbable.starters,
    awayStarters: baseMatch.awayPlayers.slice(0, 11),
    homeSubs: cleanProbable.subs,
    awaySubs: [],
    homeAbsences: [],
    awayAbsences: [],
    sourcesConsulted: ['ESPN', 'Marca'],
    updatedAt: new Date().toISOString(),
    overallConfidence: cleanProbable.avgStarterConfidence,
  };

  const upgraded = promoteOfficialToConfirmedLineup(
    baseMatch,
    baseMatch.homePlayers,
    baseMatch.awayPlayers,
    'ESPN Oficial',
    '2026-10-18T18:00:00Z',
    '4-3-3',
    '4-2-3-1'
  );

  assert.equal(upgraded.lineupStatus, 'confirmed');
  assert.equal(upgraded.confirmedLineup?.confirmed, true);
  assert.equal(upgraded.confirmedLineup?.overallConfidence, 100);
  assert.equal(upgraded.probableLineup?.confirmed, false, 'probableLineup must stay preserved separately');
  assert.ok(
    upgraded.confirmedLineup?.homeStarters.every((p) => p.availability === 'confirmed_starter' && p.starterConfidence === 100)
  );
});

test('Expected match metrics provide 80% uncertainty intervals and deterministic match explanations for Football and NBA', () => {
  const fbMatch = SANDBOX_MATCHES.find((m) => m.sport === 'football')!;
  const fbPred = computeFootballMatchPrediction(fbMatch);
  assert.ok(fbPred.expectedStats.length >= 9, 'Football expectedStats should cover goals, shots, SOT, corners, cards');
  for (const st of fbPred.expectedStats) {
    assert.ok(st.pointEstimate !== null && st.intervalLow !== null && st.intervalHigh !== null);
    assert.ok(st.intervalLow! <= st.pointEstimate! && st.pointEstimate! <= st.intervalHigh!);
    assert.ok(['verified', 'estimated', 'unavailable'].includes(st.reliability));
  }
  const fbNarrative = buildFootballMatchExplanation(fbMatch, fbPred);
  assert.ok(fbNarrative.homeFavoringFactors.length > 0 && fbNarrative.awayFavoringFactors.length > 0);
  assert.ok(fbNarrative.tacticalMatchups.length > 0);

  const nbaMatch = SANDBOX_MATCHES.find((m) => m.sport === 'nba')!;
  const nbaPred = computeNbaMatchPrediction(nbaMatch);
  assert.ok(nbaPred.expectedReboundsHome > 25 && nbaPred.expectedAssistsHome > 12);
  assert.ok(nbaPred.expectedStats.length >= 9, 'NBA expectedStats should cover points, pace, rebounds, assists, spread');
  for (const st of nbaPred.expectedStats) {
    assert.ok(st.pointEstimate !== null && st.intervalLow !== null && st.intervalHigh !== null);
    assert.ok(st.intervalLow! <= st.pointEstimate! && st.pointEstimate! <= st.intervalHigh!);
  }
  const nbaNarrative = buildNbaMatchExplanation(nbaMatch, nbaPred);
  assert.ok(nbaNarrative.tacticalMatchups.length >= 2);
});

test('Player projections blend multi-splits, redistribute NBA absences cleanly, and flag stale logs (>45d)', () => {
  const nbaMatch = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'nba')!);
  const homePlayers = cloneMatch(nbaMatch.homePlayers);
  assert.ok(homePlayers.length >= 2);

  const star = homePlayers[0];
  const teammate = homePlayers[1];

  const baseProp = computeNbaPlayerProp(teammate, nbaMatch, 'points', undefined, 'season', homePlayers);
  assert.ok(baseProp.multiSplitSummary !== undefined, 'Expected multiSplitSummary to be computed');
  assert.ok(Math.abs(baseProp.probOver + baseProp.probUnder - 100) < 0.2);

  // Mark top star OUT -> teammate projection should adjust upward cleanly
  star.availability = 'out';
  const boostedProp = computeNbaPlayerProp(teammate, nbaMatch, 'points', undefined, 'season', homePlayers);
  assert.ok(
    boostedProp.expectedValue >= baseProp.expectedValue,
    `Expected teammate projection to rise or hold (${boostedProp.expectedValue} >= ${baseProp.expectedValue})`
  );

  // Test stale log detection (> 45 days before kickoff) on both Football & NBA
  const staleDate = new Date(new Date(nbaMatch.kickoffIso).getTime() - 60 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const freshDate = new Date(new Date(nbaMatch.kickoffIso).getTime() - 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const freshPlayer: PlayerProfile = {
    ...cloneMatch(teammate),
    lastLogDate: freshDate,
    recentLogs: [{ date: freshDate, opponent: 'OPP', isHome: true, minutes: 34, stats: { points: 22 } }],
  };
  const stalePlayer: PlayerProfile = {
    ...cloneMatch(teammate),
    lastLogDate: staleDate,
    recentLogs: [{ date: staleDate, opponent: 'OPP', isHome: true, minutes: 34, stats: { points: 22 } }],
  };

  const freshNba = computeNbaPlayerProp(freshPlayer, nbaMatch, 'points', 20.5, 'season', homePlayers);
  const staleNba = computeNbaPlayerProp(stalePlayer, nbaMatch, 'points', 20.5, 'season', homePlayers);

  assert.equal(freshNba.dataFreshness, 'fresh');
  assert.equal(staleNba.dataFreshness, 'stale');
  assert.ok(staleNba.freshnessWarning, 'Stale NBA player log should produce a warning');
  assert.ok(staleNba.stdDev > freshNba.stdDev, 'Stale log should widen uncertainty stdDev');
  assert.ok(staleNba.sampleConfidence < freshNba.sampleConfidence, 'Stale log should reduce sampleConfidence');

  const fbMatch = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'football')!);
  const fbPlayer = cloneMatch(
    fbMatch.homePlayers.find((p) => p.position !== 'POR') ?? fbMatch.homePlayers[1]
  );
  const fbStaleDate = new Date(new Date(fbMatch.kickoffIso).getTime() - 65 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  fbPlayer.lastLogDate = fbStaleDate;
  fbPlayer.recentLogs = [{ date: fbStaleDate, opponent: 'RIV', isHome: true, minutes: 90, stats: { shots: 3 } }];
  const fbStaleProp = computeFootballPlayerProp(fbPlayer, fbMatch, 'shots', 2.5, 'season');
  assert.equal(fbStaleProp.dataFreshness, 'stale');
  assert.ok(fbStaleProp.freshnessWarning);
});

test('evaluateFeedStaleness and evaluateMatchProvenance report stale cache and provider failures honestly', () => {
  const now = Date.UTC(2026, 9, 20, 18, 0, 0);
  const oldIso = new Date(now - 25 * 60_000).toISOString();
  const freshIso = new Date(now - 2 * 60_000).toISOString();

  const freshMeta = evaluateFeedStaleness({
    fetchedAt: freshIso,
    fromCache: false,
    sources: [{ sport: 'football', provider: 'espn', status: 'ok', updatedAt: freshIso, matchCount: 5 }],
    errors: [],
    nowMs: now,
  });
  assert.equal(freshMeta.isStale, false);

  const staleMeta = evaluateFeedStaleness({
    fetchedAt: oldIso,
    fromCache: true,
    sources: [{ sport: 'football', provider: 'espn', status: 'ok', updatedAt: oldIso, matchCount: 5 }],
    errors: [],
    nowMs: now,
  });
  assert.equal(staleMeta.isStale, true);
  assert.ok(staleMeta.cacheAgeMinutes >= 25);
  assert.ok(staleMeta.staleReason);

  const errorMatch = cloneMatch(SANDBOX_MATCHES[0]);
  errorMatch.hydrationStatus = 'network_error';
  errorMatch.hydrationNote = 'Timeout consultando proveedor';
  const prov = evaluateMatchProvenance(errorMatch, now);
  assert.equal(prov.status, 'error');
  assert.equal(prov.isStale, true);
  assert.equal(prov.dataType, 'unavailable');
});

test('runTemporalValidation prevents future data leakage and produces sport/competition/market breakdowns', () => {
  const baseTime = Date.UTC(2026, 8, 1, 12, 0, 0);
  const makeSeq = (futureWon: boolean): LoggedPrediction[] =>
    Array.from({ length: 24 }, (_, i) => {
      const createdAt = new Date(baseTime + i * 86_400_000).toISOString();
      const resolvedAt = new Date(baseTime + i * 86_400_000 + 3 * 3600_000).toISOString();
      const isFutureTail = i >= 18;
      return {
        id: `seq-${i}`,
        createdAt,
        resolvedAt,
        sport: i % 3 === 0 ? 'nba' : 'football',
        competition: i % 3 === 0 ? 'NBA' : i % 2 === 0 ? 'LaLiga' : 'Premier League',
        matchId: `m-${i}`,
        matchLabel: `Equipo A vs Equipo B (${i})`,
        market: i % 3 === 0 ? 'Ganador (Moneyline)' : 'Resultado Final (1X2)',
        selection: 'Local',
        predictedProb: 0.78,
        rawPredictedProb: 0.78,
        status: isFutureTail ? (futureWon ? 'won' : 'lost') : i % 2 === 0 ? 'won' : 'lost',
        isReferenceExample: false,
      };
    });

  // Check warmup gating cleanly
  const shortRun = runTemporalValidation(makeSeq(true).slice(0, MIN_CALIBRATION_SAMPLES));
  assert.equal(shortRun.leakFreeVerified, true);
  assert.equal(shortRun.evaluatedCount, 0);

  // Proof of zero future leakage:
  // Index 0 starts early (before warmup ends) but finishes (resolvedAt) AFTER index 16!
  // Changing index 0's outcome ('won' vs 'lost') MUST NOT leak into index 16's calibration fit or metrics.
  const makeLeakTestHistory = (delayedOutcome: 'won' | 'lost'): LoggedPrediction[] => {
    const delayedEarlyStart: LoggedPrediction = {
      id: 'delayed-0',
      createdAt: new Date(baseTime - 86_400_000).toISOString(),
      resolvedAt: new Date(baseTime + 30 * 86_400_000).toISOString(), // resolved in the future!
      sport: 'football',
      competition: 'LaLiga',
      matchId: 'm-delayed',
      matchLabel: 'Future Resolved vs Early Start',
      market: 'Resultado Final (1X2)',
      selection: 'Local',
      predictedProb: 0.80,
      rawPredictedProb: 0.80,
      status: delayedOutcome,
      isReferenceExample: false,
    };

    const resolvedBeforeTarget: LoggedPrediction[] = Array.from({ length: 16 }, (_, idx) => ({
      id: `ss-${idx}`,
      createdAt: new Date(baseTime + idx * 86_400_000).toISOString(),
      resolvedAt: new Date(baseTime + idx * 86_400_000 + 2 * 3600_000).toISOString(),
      sport: 'football',
      competition: idx < 8 ? 'LaLiga' : 'Premier League',
      matchId: `ms-${idx}`,
      matchLabel: `A vs B ${idx}`,
      market: idx < 12 ? 'Resultado Final (1X2)' : 'Más de 2.5 goles',
      selection: 'Local',
      predictedProb: 0.80,
      rawPredictedProb: 0.80,
      status: idx % 2 === 0 ? 'won' : 'lost',
      isReferenceExample: false,
    }));

    return [delayedEarlyStart, ...resolvedBeforeTarget];
  };

  const valDelayedWin = runTemporalValidation(makeLeakTestHistory('won'));
  const valDelayedLoss = runTemporalValidation(makeLeakTestHistory('lost'));
  assert.equal(valDelayedWin.evaluatedCount, 1); // only index 16 has >= 15 already-resolved prior samples
  assert.equal(valDelayedWin.skippedWarmup, 16);
  assert.equal(valDelayedWin.calibratedBrier, valDelayedLoss.calibratedBrier);
  assert.equal(valDelayedWin.baseBrier, valDelayedLoss.baseBrier);
  assert.equal(valDelayedWin.calibratedLogLoss, valDelayedLoss.calibratedLogLoss);

  const metrics = evaluatePredictionHistory(makeSeq(false));
  assert.equal(metrics.temporalValidation.leakFreeVerified, true);
  assert.ok(metrics.breakdownBySport.length === 2);
  assert.ok(metrics.breakdownByCompetition.length === 3);
  assert.ok(metrics.breakdownByMarket.length === 2);
});

test('buildFootballPlayerFromHistory never invents positional stats and computeFootballPlayerProp returns unavailable', () => {
  const player = buildFootballPlayerFromHistory(
    {
      athleteId: 'no-stats-9',
      name: 'Delantero Sin Stats',
      shortName: 'Sin Stats',
      number: 9,
      posCode: 'F',
      posLabel: 'FWD',
      recentStarts: 4,
      recentAppearances: 5,
    },
    0,
    true,
    5,
    'team-x',
    'Equipo X',
    'EQX',
    true
  );

  assert.equal(player.statsQuality, 'unavailable');
  assert.equal(player.sampleSizeGames, 0);
  assert.equal(player.splits.season.goals, undefined);
  assert.equal(player.splits.season.shots, undefined);
  assert.equal(player.splits.season.assists, undefined);
  assert.equal(player.splits.season.passes, undefined);

  const fbMatch = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'football')!);
  const propRes = computeFootballPlayerProp(player, fbMatch, 'shots', 1.5, 'season');
  assert.equal(propRes.unavailable, true);
  assert.equal(propRes.statsQuality, 'unavailable');
  assert.equal(propRes.distribution.length, 0);
});

test('Strict publication-date freshness ignores stale and undated news in Football and NBA', () => {
  const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
  const oldIso = new Date(nowMs - 14 * 86_400_000).toISOString();
  const freshIso = new Date(nowMs - 1 * 86_400_000).toISOString();

  // Football: stale (>7d) and undated news must NOT change starter status
  const history: EspnSoccerTeamLineupHistory = {
    teamId: 'espn-fresh',
    teamName: 'Club Actual',
    teamShort: 'CA',
    formation: '4-3-3',
    matchesAnalyzed: 3,
    sources: ['ESPN'],
    players: [
      { athleteId: 'p1', name: 'Carlos Meta', shortName: 'Meta', number: 1, posCode: 'G', posLabel: 'GK', recentStarts: 3, recentAppearances: 3 },
      { athleteId: 'p2', name: 'Marco Estrella', shortName: 'Estrella', number: 9, posCode: 'F', posLabel: 'FWD', recentStarts: 3, recentAppearances: 3 },
    ],
  };

  const ignoredFb = selectProbableSideFromHistory(
    history,
    'ca',
    'Club Actual',
    'CA',
    [
      {
        id: 'old-fb',
        source: 'Marca',
        headline: 'Marco Estrella lesionado y baja',
        summary: 'Noticia antigua de hace dos semanas.',
        publishedAt: oldIso,
        confirmed: true,
        playerNames: ['Marco Estrella'],
      },
      {
        id: 'undated-fb',
        source: 'AS',
        headline: 'Marco Estrella descartado hoy',
        summary: 'Sin fecha de publicación verificable.',
        confirmed: false,
        playerNames: ['Marco Estrella'],
      },
    ],
    [],
    nowMs
  );
  const estrellaIgnored = ignoredFb.allPlayers.find((p) => p.name === 'Marco Estrella');
  assert.equal(estrellaIgnored?.availability, 'possible_starter');

  // NBA: stale (>10d injury / >5d news) & undated news must NOT mutate availability
  const nbaMatch = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'nba')!);
  const targetNba = cloneMatch(nbaMatch.homePlayers[0]);
  targetNba.availability = 'confirmed_starter';
  targetNba.injuryNote = undefined;

  const staleAndUndatedInjuries: ParsedInjuryRecord[] = [
    {
      athleteId: targetNba.id.replace('espn-nba-p-', ''),
      playerName: targetNba.name,
      normalizedName: normalizeNbaName(targetNba.name),
      teamId: targetNba.teamId,
      teamName: targetNba.teamName,
      status: 'out',
      statusTag: 'OUT',
      confirmed: true,
      source: 'ESPN NBA Injuries',
      publishedAt: oldIso,
      headline: `${targetNba.name} is OUT (old)`,
      summary: 'Old injury report',
    },
    {
      athleteId: targetNba.id.replace('espn-nba-p-', ''),
      playerName: targetNba.name,
      normalizedName: normalizeNbaName(targetNba.name),
      teamId: targetNba.teamId,
      teamName: targetNba.teamName,
      status: 'doubtful',
      statusTag: 'DOUBTFUL',
      confirmed: false,
      source: 'NBA Wire',
      headline: `${targetNba.name} doubtful tonight`,
      summary: 'Missing timestamp',
    },
  ];
  const stalePressNews: PlayerNewsItem[] = [
    {
      id: 'nba-old-press',
      source: 'ESPN NBA',
      confirmed: false,
      teamShort: targetNba.teamShort,
      playerNames: [targetNba.name],
      headline: `${targetNba.name} questionable`,
      summary: 'Old news',
      publishedAt: new Date(nowMs - 7 * 86_400_000).toISOString(),
    },
  ];
  const untouchedNba = applyNewsAndInjuriesToNbaPlayers(
    [targetNba],
    staleAndUndatedInjuries,
    stalePressNews,
    true,
    nowMs
  );
  assert.equal(untouchedNba[0].availability, 'confirmed_starter');

  // Fresh injury (<2d) MUST update availability
  const freshNbaInjury: ParsedInjuryRecord[] = [
    {
      athleteId: targetNba.id.replace('espn-nba-p-', ''),
      playerName: targetNba.name,
      normalizedName: normalizeNbaName(targetNba.name),
      teamId: targetNba.teamId,
      teamName: targetNba.teamName,
      status: 'out',
      statusTag: 'OUT',
      confirmed: true,
      source: 'ESPN NBA Injuries',
      publishedAt: freshIso,
      headline: `${targetNba.name} ruled out`,
      summary: 'Ruled out today',
    },
  ];
  const updatedNba = applyNewsAndInjuriesToNbaPlayers(
    [targetNba],
    freshNbaInjury,
    [],
    true,
    nowMs
  );
  assert.equal(updatedNba[0].availability, 'out');
});

test('Team expected stats mark missing bases as unavailable and never label derived metrics as verified', () => {
  // Unhydrated Football match with zero scoring/corners/cards/recentGames
  const emptyFb = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'football')!);
  emptyFb.homeTeam.attackHome = undefined;
  emptyFb.homeTeam.defenseHome = undefined;
  emptyFb.homeTeam.attackAway = undefined;
  emptyFb.homeTeam.defenseAway = undefined;
  emptyFb.homeTeam.ppgOrGpg = undefined;
  emptyFb.homeTeam.oppgOrGapg = undefined;
  emptyFb.homeTeam.avgCorners = undefined;
  emptyFb.homeTeam.avgYellowCards = undefined;
  emptyFb.homeTeam.avgShots = undefined;
  emptyFb.homeTeam.avgShotsOnTarget = undefined;
  emptyFb.homeTeam.recentGames = [];
  emptyFb.awayTeam.attackHome = undefined;
  emptyFb.awayTeam.defenseHome = undefined;
  emptyFb.awayTeam.attackAway = undefined;
  emptyFb.awayTeam.defenseAway = undefined;
  emptyFb.awayTeam.ppgOrGpg = undefined;
  emptyFb.awayTeam.oppgOrGapg = undefined;
  emptyFb.awayTeam.avgCorners = undefined;
  emptyFb.awayTeam.avgYellowCards = undefined;
  emptyFb.awayTeam.avgShots = undefined;
  emptyFb.awayTeam.avgShotsOnTarget = undefined;
  emptyFb.awayTeam.recentGames = [];

  const fbPred = computeFootballMatchPrediction(emptyFb);
  const corners = fbPred.expectedStats.find((s) => s.key === 'corners')!;
  const cards = fbPred.expectedStats.find((s) => s.key === 'yellow_cards')!;
  assert.equal(corners.reliability, 'unavailable');
  assert.equal(corners.pointEstimate, null);
  assert.equal(corners.distributionSpec, undefined);
  assert.equal(cards.reliability, 'unavailable');
  assert.equal(cards.pointEstimate, null);

  // When only goals/attack exist (no real corners/cards), derived values MUST be 'estimated' (never 'verified')
  const scoringOnlyFb = cloneMatch(emptyFb);
  scoringOnlyFb.homeTeam.ppgOrGpg = 1.9;
  scoringOnlyFb.homeTeam.oppgOrGapg = 0.9;
  scoringOnlyFb.awayTeam.ppgOrGpg = 1.4;
  scoringOnlyFb.awayTeam.oppgOrGapg = 1.2;
  const scoringOnlyPred = computeFootballMatchPrediction(scoringOnlyFb);
  assert.equal(scoringOnlyPred.expectedStats.find((s) => s.key === 'corners')?.reliability, 'estimated');
  assert.equal(scoringOnlyPred.expectedStats.find((s) => s.key === 'yellow_cards')?.reliability, 'estimated');

  // Unhydrated NBA match missing rebounds, assists, pace & empty players
  const emptyNba = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'nba')!);
  emptyNba.homeTeam.avgRebounds = undefined;
  emptyNba.homeTeam.avgAssists = undefined;
  emptyNba.homeTeam.pace = undefined;
  emptyNba.homeTeam.offRating = undefined;
  emptyNba.homeTeam.defRating = undefined;
  emptyNba.homeTeam.ppgOrGpg = undefined;
  emptyNba.homeTeam.oppgOrGapg = undefined;
  emptyNba.awayTeam.avgRebounds = undefined;
  emptyNba.awayTeam.avgAssists = undefined;
  emptyNba.awayTeam.pace = undefined;
  emptyNba.awayTeam.offRating = undefined;
  emptyNba.awayTeam.defRating = undefined;
  emptyNba.awayTeam.ppgOrGpg = undefined;
  emptyNba.awayTeam.oppgOrGapg = undefined;
  emptyNba.homeTeam.recentGames = [];
  emptyNba.awayTeam.recentGames = [];
  emptyNba.homePlayers = [];
  emptyNba.awayPlayers = [];

  const nbaPred = computeNbaMatchPrediction(emptyNba);
  for (const key of ['pace', 'reb_home', 'reb_away', 'ast_home', 'ast_away']) {
    const stat = nbaPred.expectedStats.find((s) => s.key === key)!;
    assert.equal(stat.reliability, 'unavailable');
    assert.equal(stat.pointEstimate, null);
    assert.equal(stat.distributionSpec, undefined);
  }
});

test('runTemporalValidation strictly excludes resolved records without valid resolvedAt (zero createdAt fallback)', () => {
  const baseTime = Date.UTC(2026, 8, 1, 12, 0, 0);
  const validItems: LoggedPrediction[] = Array.from({ length: 18 }, (_, i) => ({
    id: `valid-${i}`,
    createdAt: new Date(baseTime + i * 86_400_000).toISOString(),
    resolvedAt: new Date(baseTime + i * 86_400_000 + 3 * 3600_000).toISOString(),
    sport: 'football',
    competition: 'LaLiga',
    matchId: `mv-${i}`,
    matchLabel: `Equipo ${i}`,
    market: 'Resultado Final (1X2)',
    selection: 'Local',
    predictedProb: 0.65,
    rawPredictedProb: 0.65,
    status: i % 2 === 0 ? 'won' : 'lost',
  }));

  const missingResolvedAt: LoggedPrediction = {
    id: 'missing-resolved',
    createdAt: new Date(baseTime - 10 * 86_400_000).toISOString(),
    resolvedAt: undefined,
    sport: 'football',
    competition: 'LaLiga',
    matchId: 'm-missing',
    matchLabel: 'Sin resolvedAt',
    market: 'Resultado Final (1X2)',
    selection: 'Local',
    predictedProb: 0.99,
    rawPredictedProb: 0.99,
    status: 'lost',
  };

  const withMissing = runTemporalValidation([...validItems, missingResolvedAt]);
  const withoutMissing = runTemporalValidation(validItems);
  assert.equal(withMissing.evaluatedCount, withoutMissing.evaluatedCount);
  assert.equal(withMissing.calibratedBrier, withoutMissing.calibratedBrier);
  assert.match(withMissing.note, /excluida/i);
});

test('Goalkeepers use exclusive saves/conceded stats cleanly and return unavailable for outfield attack stats', () => {
  const fbMatch = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'football')!);
  const courtois = fbMatch.homePlayers.find((p) => p.id === 'rma-1')!;
  assert.equal(courtois.position, 'POR');
  assert.equal(courtois.splits.season.goals, undefined);
  assert.equal(courtois.splits.season.shots, undefined);
  assert.ok((courtois.splits.season.saves ?? 0) > 1.5);
  assert.ok((courtois.splits.last5?.saves ?? 0) > 0);
  assert.ok((courtois.splits.last10?.saves ?? 0) > 0);

  const savesProp = computeFootballPlayerProp(courtois, fbMatch, 'saves', 2.5, 'season');
  assert.notEqual(savesProp.unavailable, true);
  assert.ok(savesProp.expectedValue > 0.5 && savesProp.distribution.length > 0);
  assert.ok(Math.abs(savesProp.probOver + savesProp.probUnder - 100) < 0.2);

  const concededProp = computeFootballPlayerProp(courtois, fbMatch, 'goalsConceded', 0.5, 'season');
  assert.notEqual(concededProp.unavailable, true);
  assert.ok(concededProp.distribution.length > 0);

  const attackMismatch = computeFootballPlayerProp(courtois, fbMatch, 'goals', 0.5, 'season');
  assert.equal(attackMismatch.unavailable, true);
  assert.equal(attackMismatch.distribution.length, 0);
});

test('evaluateMatchStatOverUnder computes monotonic complementary Over/Under probabilities for all match markets', () => {
  const fbMatch = SANDBOX_MATCHES.find((m) => m.sport === 'football')!;
  const fbPred = computeFootballMatchPrediction(fbMatch);
  for (const stat of fbPred.expectedStats) {
    assert.ok(stat.distributionSpec, `Expected distributionSpec on Football market ${stat.key}`);
    const baseEval = evaluateMatchStatOverUnder(stat);
    assert.equal(baseEval.available, true);
    if (baseEval.available) {
      assert.ok(Math.abs(baseEval.probOver + baseEval.probUnder - 100) < 0.2);
      const lowEval = evaluateMatchStatOverUnder(stat, baseEval.minLine);
      const highEval = evaluateMatchStatOverUnder(stat, baseEval.maxLine);
      assert.ok(lowEval.available && highEval.available);
      if (lowEval.available && highEval.available) {
        assert.ok(
          lowEval.probOver >= highEval.probOver,
          `Monotonicity violated on ${stat.key}: ${lowEval.probOver} < ${highEval.probOver}`
        );
      }
    }
  }

  const nbaMatch = SANDBOX_MATCHES.find((m) => m.sport === 'nba')!;
  const nbaPred = computeNbaMatchPrediction(nbaMatch);
  for (const stat of nbaPred.expectedStats) {
    assert.ok(stat.distributionSpec, `Expected distributionSpec on NBA market ${stat.key}`);
    const baseEval = evaluateMatchStatOverUnder(stat);
    assert.equal(baseEval.available, true);
    if (baseEval.available) {
      assert.ok(Math.abs(baseEval.probOver + baseEval.probUnder - 100) < 0.2);
      const lowEval = evaluateMatchStatOverUnder(stat, baseEval.minLine);
      const highEval = evaluateMatchStatOverUnder(stat, baseEval.maxLine);
      assert.ok(lowEval.available && highEval.available);
      if (lowEval.available && highEval.available) {
        assert.ok(
          lowEval.probOver >= highEval.probOver,
          `Monotonicity violated on ${stat.key}: ${lowEval.probOver} < ${highEval.probOver}`
        );
      }
    }
  }

  // Unavailable market returns available: false
  const unavailableEval = evaluateMatchStatOverUnder({
    key: 'corners',
    label: 'Córners totales esperados',
    pointEstimate: null,
    intervalLow: null,
    intervalHigh: null,
    reliability: 'unavailable',
  });
  assert.equal(unavailableEval.available, false);
});

test('mergeMatchesAcrossSources combines user APIs and ESPN simultaneously and detects cross-source discrepancies', () => {
  const baseFb = cloneMatch(SANDBOX_MATCHES.find((m) => m.sport === 'football')!);
  const fdMatch: MatchRecord = {
    ...baseFb,
    id: 'fd-99901',
    venue: 'Sede oficial',
    score: { home: 2, away: 1 },
    homeTeam: {
      ...baseFb.homeTeam,
      id: 'fd-team-1',
      name: 'Real Madrid CF',
      record: 'Football-Data.org',
      formRecent: [],
      recentGames: [],
    },
    awayTeam: {
      ...baseFb.awayTeam,
      id: 'fd-team-2',
      name: 'FC Barcelona',
      record: 'Football-Data.org',
      formRecent: [],
      recentGames: [],
    },
    teamStatsQuality: 'unavailable',
    dataOrigin: 'Football-Data.org v4',
  };

  const espnMatch: MatchRecord = {
    ...baseFb,
    id: 'espnsoc-esp.1-888',
    venue: 'Santiago Bernabéu',
    score: { home: 2, away: 0 }, // Intentional discrepancy with Football-Data
    homeTeam: {
      ...baseFb.homeTeam,
      id: 'espnsoc-team-86',
      name: 'Real Madrid',
      record: '10-2-1 · 32 pts',
      formRecent: ['W', 'W', 'D', 'W', 'W'],
    },
    awayTeam: {
      ...baseFb.awayTeam,
      id: 'espnsoc-team-83',
      name: 'Barcelona',
      record: '9-2-2 · 29 pts',
      formRecent: ['W', 'L', 'W', 'W', 'D'],
    },
    teamStatsQuality: 'verified',
    dataOrigin: 'ESPN Soccer Oficial',
  };

  const merged = mergeMatchesAcrossSources([
    { provider: 'football-data', label: 'Football-Data.org v4', matches: [fdMatch] },
    { provider: 'espn-football', label: 'ESPN Fútbol Oficial', matches: [espnMatch] },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'fd-99901');
  assert.equal(merged[0].sourceIds?.['football-data'], 'fd-99901');
  assert.equal(merged[0].sourceIds?.['espn-football'], 'espnsoc-esp.1-888');
  assert.equal(merged[0].venue, 'Santiago Bernabéu');
  assert.equal(merged[0].homeTeam.record, '10-2-1 · 32 pts');
  assert.deepEqual(merged[0].homeTeam.formRecent, ['W', 'W', 'D', 'W', 'W']);
  assert.equal(merged[0].teamStatsQuality, 'verified');
  assert.ok((merged[0].verifiedSources?.length ?? 0) === 2);
  assert.ok(merged[0].sourceDiscrepancies?.some((d) => d.includes('Marcador distinto')));

  // Hydrated merge enriches skeleton players from Football-Data with real stats/injuries from ESPN
  const fdSkeletonPlayer: PlayerProfile = {
    ...cloneMatch(baseFb.homePlayers[1]),
    id: 'fd-p-101',
    name: 'Vinicius Junior',
    availability: 'possible_starter',
    statsQuality: 'unavailable',
    sampleSizeGames: 0,
    recentLogs: [],
  };
  const espnRichPlayer: PlayerProfile = {
    ...cloneMatch(baseFb.homePlayers[1]),
    id: 'espn-p-101',
    name: 'Vinicius Júnior',
    availability: 'out',
    availabilityConfidence: 'confirmed',
    injuryNote: 'Sobrecarga confirmada',
    statsQuality: 'verified',
    sampleSizeGames: 12,
  };

  const fdHydratedVariant: MatchRecord = {
    ...merged[0],
    lineupStatus: 'provisional',
    homePlayers: [fdSkeletonPlayer],
    hydrationStatus: 'ok',
  };
  const espnHydratedVariant: MatchRecord = {
    ...espnMatch,
    lineupStatus: 'provisional',
    homePlayers: [espnRichPlayer],
    hydrationStatus: 'ok',
  };

  const hydrated = mergeHydratedMatchDetails(merged[0], [
    { provider: 'football-data', label: 'Football-Data.org v4', match: fdHydratedVariant },
    { provider: 'espn-football', label: 'ESPN Fútbol Oficial', match: espnHydratedVariant },
  ]);

  assert.equal(hydrated.homePlayers[0].availability, 'out');
  assert.equal(hydrated.homePlayers[0].statsQuality, 'verified');
  assert.equal(hydrated.homePlayers[0].sampleSizeGames, 12);
  assert.match(hydrated.dataOrigin, /contrastado 2 fuentes/i);

  // Standings merge keeps richest entry per team without duplicating
  const stFd: StandingEntry = {
    rank: 1,
    teamId: 'fd-t1',
    teamName: 'Real Madrid CF',
    teamShort: 'RMA',
    league: 'LaLiga',
    played: 13,
    won: 10,
    drawn: 2,
    lost: 1,
    goalsForOrPtsFor: 28,
    goalsAgainstOrPtsAgainst: 10,
    diff: 18,
    pointsOrWinPct: '32',
    form: [],
    homeRecord: '-',
    awayRecord: '-',
  };
  const stEspn: StandingEntry = {
    ...stFd,
    teamId: 'espn-t1',
    teamName: 'Real Madrid',
    form: ['W', 'W', 'D', 'W', 'W'],
    homeRecord: '6-1-0',
    awayRecord: '4-1-1',
  };
  const mergedStandings = mergeStandingsAcrossSources([[stFd], [stEspn]]);
  assert.equal(mergedStandings.length, 1);
  assert.equal(mergedStandings[0].homeRecord, '6-1-0');
  assert.deepEqual(mergedStandings[0].form, ['W', 'W', 'D', 'W', 'W']);
});


