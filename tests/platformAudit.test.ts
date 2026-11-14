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
  promoteOfficialToConfirmedLineup,
  selectProbableSideFromHistory,
  type EspnSoccerTeamLineupHistory,
} from '../server/footballIntelligence.ts';
import { evaluateFeedStaleness, evaluateMatchProvenance } from '../server/dataHealth.ts';
import type { LoggedPrediction, PlayerProfile } from '../src/types/sports.ts';

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
  const fbPlayer = cloneMatch(fbMatch.homePlayers[0]);
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
