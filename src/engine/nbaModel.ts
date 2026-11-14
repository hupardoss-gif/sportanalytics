import type {
  AvailabilityStatus,
  DataFreshnessStatus,
  DataReliability,
  LoggedPrediction,
  MatchNarrativeExplanation,
  MatchRecord,
  NbaPredictionResult,
  NbaPropStat,
  PlayerProfile,
  PropDistributionBin,
  PropProjectionResult,
  StatExpectationWithInterval,
  TimeframeSplit,
} from '../types/sports.ts';
import {
  applyBinaryCalibration,
  fitEmpiricalCalibrationProfile,
} from './calibrationEngine.ts';

function normalCdf(x: number, mean: number, stdDev: number): number {
  const z = (x - mean) / (Math.max(0.05, stdDev) * Math.SQRT2);
  const sign = z < 0 ? -1 : 1;
  const az = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * az);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t) *
      Math.exp(-az * az);
  return 0.5 * (1 + sign * y);
}

function negBinPmf(k: number, mu: number, alpha: number): number {
  if (mu <= 0) return k === 0 ? 1 : 0;
  const effAlpha = Math.max(0.02, alpha);
  const r = 1 / effAlpha;
  const p = r / (r + mu);
  const logGamma = (z: number): number => {
    const g = 7;
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  };
  const logPmf =
    logGamma(k + r) -
    logGamma(k + 1) -
    logGamma(r) +
    r * Math.log(p) +
    k * Math.log(1 - p);
  return Math.exp(logPmf);
}

export function getNbaAvailabilityFactor(
  status: AvailabilityStatus,
  minutesRestriction?: { maxMinutes?: number; note: string },
  baseMinutes = 30
): number {
  let factor = 1;
  switch (status) {
    case 'confirmed_starter':
    case 'possible_starter':
    case 'starter':
      factor = 1;
      break;
    case 'probable':
      factor = 0.9;
      break;
    case 'available':
    case 'bench':
      factor = 0.64;
      break;
    case 'doubtful':
      factor = 0.42;
      break;
    case 'out':
    case 'suspended':
      return 0;
  }
  if (minutesRestriction && factor > 0) {
    const capFactor = minutesRestriction.maxMinutes
      ? Math.max(0.25, Math.min(1, minutesRestriction.maxMinutes / Math.max(12, baseMinutes)))
      : 0.78;
    factor = Math.min(factor, capFactor);
  }
  return factor;
}

function parseNbaPlayedGames(record?: string, explicitPlayed?: number): number {
  if (explicitPlayed !== undefined && explicitPlayed > 0) return explicitPlayed;
  if (!record) return 0;
  const m = record.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return Number(m[1]) + Number(m[2]);
  return 0;
}

export function calculateNbaAbsenceImpact(
  players: PlayerProfile[],
  teamLabel: string
): {
  offRatingDelta: number;
  defRatingDelta: number;
  paceDelta: number;
  vacatedUsage: number;
  vacatedAssistShare: number;
  vacatedMinutes: number;
  notes: string[];
} {
  let offRatingDelta = 0;
  let defRatingDelta = 0;
  let paceDelta = 0;
  let vacatedUsage = 0;
  let vacatedAssistShare = 0;
  let vacatedMinutes = 0;
  const notes: string[] = [];

  for (const p of players) {
    const baseMin = p.splits.season.minutes || 30;
    const avail = getNbaAvailabilityFactor(p.availability, p.minutesRestriction, baseMin);
    const baselineAvail =
      p.availability === 'bench' || p.availability === 'available'
        ? p.isKeyPlayer
          ? 1
          : 0.64
        : 1;
    if (avail < baselineAvail - 0.04) {
      const lossRatio = Math.max(0, 1 - avail);
      const offHit = p.impact.offenseDelta * lossRatio;
      const defHit = p.impact.defenseDelta * lossRatio;
      offRatingDelta -= offHit;
      defRatingDelta += defHit;
      paceDelta -= p.isKeyPlayer ? 0.75 * lossRatio : 0;
      vacatedUsage += p.impact.usageShare * lossRatio;
      vacatedAssistShare += p.impact.assistShare * lossRatio;
      vacatedMinutes += baseMin * lossRatio;

      const label =
        p.availability === 'out'
          ? 'Descartado'
          : p.availability === 'doubtful'
            ? 'Dudoso'
            : p.availability === 'suspended'
              ? 'Sancionado'
              : p.minutesRestriction
                ? `Límite de minutos${p.minutesRestriction.maxMinutes ? ` (${p.minutesRestriction.maxMinutes}')` : ''}`
                : p.availability === 'probable'
                  ? 'Probable (posible carga reducida)'
                  : 'Rotación reducida';
      notes.push(
        `${teamLabel}: ${p.shortName} (${label}) impacta Rating Ofensivo ${(-offHit).toFixed(1)} pts/100pos`
      );
    }
  }

  return {
    offRatingDelta: Math.max(-14, Math.min(8, offRatingDelta)),
    defRatingDelta: Math.max(-6, Math.min(10, defRatingDelta)),
    paceDelta,
    vacatedUsage: Math.min(0.42, vacatedUsage),
    vacatedAssistShare: Math.min(0.45, vacatedAssistShare),
    vacatedMinutes: Math.min(96, vacatedMinutes),
    notes,
  };
}

/**
 * Pace-Adjusted Efficiency Rating & Heteroscedastic Normal NBA Game Model.
 * Applies Bayesian shrinkage toward league mean (114.5), avoids 99.8% overconfident
 * pre-match extremes, and clearly separates dataConfidence from win probability.
 */
export function computeNbaMatchPrediction(
  match: MatchRecord,
  homePlayersOverride?: PlayerProfile[],
  awayPlayersOverride?: PlayerProfile[],
  calibrationHistory?: LoggedPrediction[]
): NbaPredictionResult {
  const homePlayers = homePlayersOverride ?? match.homePlayers;
  const awayPlayers = awayPlayersOverride ?? match.awayPlayers;
  const modelWarnings: string[] = [];

  const homeImpact = calculateNbaAbsenceImpact(homePlayers, match.homeTeam.shortName);
  const awayImpact = calculateNbaAbsenceImpact(awayPlayers, match.awayTeam.shortName);

  const hasHomeRatings = match.homeTeam.offRating !== undefined && match.homeTeam.defRating !== undefined;
  const hasAwayRatings = match.awayTeam.offRating !== undefined && match.awayTeam.defRating !== undefined;
  const hasPaceData = match.homeTeam.pace !== undefined || match.awayTeam.pace !== undefined;

  const basePaceHome = match.homeTeam.pace ?? 99.4;
  const basePaceAway = match.awayTeam.pace ?? 99.4;
  const expectedPace = Math.max(
    91,
    Math.min(108, (basePaceHome + basePaceAway) / 2 + (homeImpact.paceDelta + awayImpact.paceDelta) * 0.5)
  );

  // League average baseline 114.5 pts / 100 possessions with Bayesian shrinkage k=16 games
  const leagueAvgEff = 114.5;
  const homePlayed = parseNbaPlayedGames(
    match.homeTeam.record,
    match.homeTeam.playedGames ?? match.homeTeam.recentGames?.length
  );
  const awayPlayed = parseNbaPlayedGames(
    match.awayTeam.record,
    match.awayTeam.playedGames ?? match.awayTeam.recentGames?.length
  );

  const shrinkHome = hasHomeRatings ? (homePlayed > 0 ? homePlayed / (homePlayed + 16) : 0.65) : 0;
  const shrinkAway = hasAwayRatings ? (awayPlayed > 0 ? awayPlayed / (awayPlayed + 16) : 0.65) : 0;

  const shrunkHomeOff = leagueAvgEff + shrinkHome * ((match.homeTeam.offRating ?? leagueAvgEff) - leagueAvgEff);
  const shrunkHomeDef = leagueAvgEff + shrinkHome * ((match.homeTeam.defRating ?? leagueAvgEff) - leagueAvgEff);
  const shrunkAwayOff = leagueAvgEff + shrinkAway * ((match.awayTeam.offRating ?? leagueAvgEff) - leagueAvgEff);
  const shrunkAwayDef = leagueAvgEff + shrinkAway * ((match.awayTeam.defRating ?? leagueAvgEff) - leagueAvgEff);

  if (!hasHomeRatings || !hasAwayRatings) {
    modelWarnings.push(
      'Faltan ratings ofensivos/defensivos reales de al menos una franquicia; se usa media de liga NBA (114.5).'
    );
  } else if ((homePlayed > 0 && homePlayed < 12) || (awayPlayed > 0 && awayPlayed < 12)) {
    modelWarnings.push(
      'Muestra temprana de temporada (<12 partidos); ratings ajustados por regresión bayesiana.'
    );
  }

  const homeOff = shrunkHomeOff + homeImpact.offRatingDelta;
  const homeDef = shrunkHomeDef + homeImpact.defRatingDelta;
  const awayOff = shrunkAwayOff + awayImpact.offRatingDelta;
  const awayDef = shrunkAwayDef + awayImpact.defRatingDelta;

  const homeFatigue = match.homeTeam.isBackToBack ? -1.4 : match.homeTeam.restDays >= 2 ? 0.45 : 0;
  const awayFatigue = match.awayTeam.isBackToBack ? -1.7 : match.awayTeam.restDays >= 2 ? 0.4 : 0;
  const homeCourtBoost = match.homeTeam.homeCourtBoost ?? 2.4;

  const winRate = (form: ('W' | 'D' | 'L')[]) =>
    form.length ? form.filter((f) => f === 'W').length / form.length : 0.5;
  const formDelta =
    match.homeTeam.formRecent.length > 0 || match.awayTeam.formRecent.length > 0
      ? (winRate(match.homeTeam.formRecent) - winRate(match.awayTeam.formRecent)) * 1.4
      : 0;

  if (!match.homeTeam.formRecent.length && !match.awayTeam.formRecent.length) {
    modelWarnings.push('Sin historial reciente L5 cargado aún; momento de forma en neutro.');
  }

  const homeEffExpected = homeOff + awayDef - leagueAvgEff + homeCourtBoost / 2 + homeFatigue + formDelta * 0.5;
  const awayEffExpected = awayOff + homeDef - leagueAvgEff - homeCourtBoost / 2 + awayFatigue - formDelta * 0.5;

  const expectedHomePts = (homeEffExpected / 100) * expectedPace;
  const expectedAwayPts = (awayEffExpected / 100) * expectedPace;
  const expectedTotal = expectedHomePts + expectedAwayPts;
  const expectedSpreadHome = expectedHomePts - expectedAwayPts;

  // Heteroscedastic spread dispersion (~12.6 base + injury/missing-data/extreme-spread variance)
  const doubtfulCount = [...homePlayers, ...awayPlayers].filter((p) => p.availability === 'doubtful').length;
  const missingRatingsPenalty = (!hasHomeRatings || !hasAwayRatings ? 2.4 : 0) + (!hasPaceData ? 0.6 : 0);
  const spreadStdDev =
    12.6 + doubtfulCount * 0.75 + missingRatingsPenalty + Math.abs(expectedSpreadHome) * 0.08;
  const totalStdDev = 14.8 + doubtfulCount * 0.75 + missingRatingsPenalty;

  const unboundedHome = 1 - normalCdf(0, expectedSpreadHome, spreadStdDev);
  // Pre-match NBA outcome probabilities remain naturally bounded within [4%, 96%]
  const rawProbHomeWin = Math.max(0.04, Math.min(0.96, unboundedHome));
  const rawProbAwayWin = 1 - rawProbHomeWin;

  let probHomeWin = rawProbHomeWin;
  let probAwayWin = rawProbAwayWin;
  let calibrationApplied = false;
  let calibrationNote: string | undefined;

  if (calibrationHistory && calibrationHistory.length > 0) {
    const profile = fitEmpiricalCalibrationProfile(calibrationHistory, 'nba');
    if (profile.active && (profile.temperature !== 1 || profile.bias !== 0)) {
      probHomeWin = Math.max(0.04, Math.min(0.96, applyBinaryCalibration(rawProbHomeWin, profile)));
      probAwayWin = 1 - probHomeWin;
      calibrationApplied = true;
      calibrationNote = profile.summary;
    }
  }

  // Honest dataConfidence (measures input completeness, NOT win probability)
  let dataConfidence = 26;
  if (hasHomeRatings && hasAwayRatings) dataConfidence += 28;
  else if (hasHomeRatings || hasAwayRatings) dataConfidence += 12;

  if (match.homeTeam.formRecent.length > 0 && match.awayTeam.formRecent.length > 0) dataConfidence += 10;
  if (homePlayers.length >= 5 && awayPlayers.length >= 5) dataConfidence += 12;
  if (match.lineupStatus === 'confirmed') dataConfidence += 14;
  else if (match.lineupStatus === 'provisional') dataConfidence += 6;
  else modelWarnings.push('Quintetos no publicados todavía; rotación estimada.');

  if (doubtfulCount > 0) {
    dataConfidence -= Math.min(12, doubtfulCount * 3);
    modelWarnings.push(`${doubtfulCount} jugador(es) en duda (GTD) amplían la varianza esperada.`);
  }

  dataConfidence = Math.max(20, Math.min(93, Math.round(dataConfidence)));

  const dataQuality: DataReliability =
    hasHomeRatings && hasAwayRatings && homePlayers.length >= 5 && awayPlayers.length >= 5
      ? 'verified'
      : hasHomeRatings || hasAwayRatings
        ? 'estimated'
        : 'unavailable';

  // Team Rebounds & Assists projections with 80% uncertainty intervals and explicit reliability
  const paceFactor = expectedPace / 99.5;
  const activeRosterSum = (players: PlayerProfile[], key: 'rebounds' | 'assists'): number =>
    players.reduce((acc, p) => {
      const f = getNbaAvailabilityFactor(p.availability, p.minutesRestriction, p.splits.season.minutes || 28);
      return acc + (p.splits.season[key] ?? 0) * f;
    }, 0);

  const rosterRebHome = activeRosterSum(homePlayers, 'rebounds');
  const rosterRebAway = activeRosterSum(awayPlayers, 'rebounds');
  const rosterAstHome = activeRosterSum(homePlayers, 'assists');
  const rosterAstAway = activeRosterSum(awayPlayers, 'assists');

  const hasHomeReb = match.homeTeam.avgRebounds !== undefined;
  const hasAwayReb = match.awayTeam.avgRebounds !== undefined;
  const hasHomeAst = match.homeTeam.avgAssists !== undefined;
  const hasAwayAst = match.awayTeam.avgAssists !== undefined;

  const expectedReboundsHome = +(
    hasHomeReb
      ? match.homeTeam.avgRebounds! * (0.62 + 0.38 * paceFactor)
      : rosterRebHome > 18
        ? rosterRebHome * 1.07 * (0.7 + 0.3 * paceFactor)
        : 43.4 * paceFactor
  ).toFixed(1);

  const expectedReboundsAway = +(
    hasAwayReb
      ? match.awayTeam.avgRebounds! * (0.62 + 0.38 * paceFactor)
      : rosterRebAway > 18
        ? rosterRebAway * 1.07 * (0.7 + 0.3 * paceFactor)
        : 42.8 * paceFactor
  ).toFixed(1);

  const expectedAssistsHome = +(
    hasHomeAst
      ? match.homeTeam.avgAssists! * (0.6 + 0.4 * paceFactor)
      : rosterAstHome > 10
        ? rosterAstHome * 1.05 * (0.7 + 0.3 * paceFactor)
        : 26.2 * paceFactor
  ).toFixed(1);

  const expectedAssistsAway = +(
    hasAwayAst
      ? match.awayTeam.avgAssists! * (0.6 + 0.4 * paceFactor)
      : rosterAstAway > 10
        ? rosterAstAway * 1.05 * (0.7 + 0.3 * paceFactor)
        : 25.4 * paceFactor
  ).toFixed(1);

  const teamPtsStd = 10.8 + doubtfulCount * 0.5 + missingRatingsPenalty * 0.6;
  const expectedStats: StatExpectationWithInterval[] = [
    {
      key: 'pts_home',
      label: `Puntos esperados (${match.homeTeam.shortName})`,
      pointEstimate: +expectedHomePts.toFixed(1),
      intervalLow: +Math.max(70, expectedHomePts - 1.28 * teamPtsStd).toFixed(1),
      intervalHigh: +(expectedHomePts + 1.28 * teamPtsStd).toFixed(1),
      unit: 'pts',
      reliability: hasHomeRatings ? 'verified' : 'estimated',
    },
    {
      key: 'pts_away',
      label: `Puntos esperados (${match.awayTeam.shortName})`,
      pointEstimate: +expectedAwayPts.toFixed(1),
      intervalLow: +Math.max(70, expectedAwayPts - 1.28 * teamPtsStd).toFixed(1),
      intervalHigh: +(expectedAwayPts + 1.28 * teamPtsStd).toFixed(1),
      unit: 'pts',
      reliability: hasAwayRatings ? 'verified' : 'estimated',
    },
    {
      key: 'pts_total',
      label: 'Total de puntos del partido',
      pointEstimate: +expectedTotal.toFixed(1),
      intervalLow: +Math.max(155, expectedTotal - 1.28 * totalStdDev).toFixed(1),
      intervalHigh: +(expectedTotal + 1.28 * totalStdDev).toFixed(1),
      unit: 'pts',
      reliability: hasHomeRatings && hasAwayRatings ? 'verified' : 'estimated',
    },
    {
      key: 'pace',
      label: 'Ritmo estimado (posesiones)',
      pointEstimate: +expectedPace.toFixed(1),
      intervalLow: +(expectedPace - 3.6).toFixed(1),
      intervalHigh: +(expectedPace + 3.6).toFixed(1),
      unit: 'pos',
      reliability: hasPaceData ? 'verified' : 'estimated',
    },
    {
      key: 'reb_home',
      label: `Rebotes esperados (${match.homeTeam.shortName})`,
      pointEstimate: expectedReboundsHome,
      intervalLow: +Math.max(24, expectedReboundsHome - 5.2).toFixed(1),
      intervalHigh: +(expectedReboundsHome + 5.2).toFixed(1),
      unit: 'reb',
      reliability: hasHomeReb ? 'verified' : 'estimated',
      note: hasHomeReb ? 'Promedio real ajustado por ritmo' : 'Estimado desde rotación/ritmo',
    },
    {
      key: 'reb_away',
      label: `Rebotes esperados (${match.awayTeam.shortName})`,
      pointEstimate: expectedReboundsAway,
      intervalLow: +Math.max(24, expectedReboundsAway - 5.2).toFixed(1),
      intervalHigh: +(expectedReboundsAway + 5.2).toFixed(1),
      unit: 'reb',
      reliability: hasAwayReb ? 'verified' : 'estimated',
      note: hasAwayReb ? 'Promedio real ajustado por ritmo' : 'Estimado desde rotación/ritmo',
    },
    {
      key: 'ast_home',
      label: `Asistencias esperadas (${match.homeTeam.shortName})`,
      pointEstimate: expectedAssistsHome,
      intervalLow: +Math.max(12, expectedAssistsHome - 4.2).toFixed(1),
      intervalHigh: +(expectedAssistsHome + 4.2).toFixed(1),
      unit: 'ast',
      reliability: hasHomeAst ? 'verified' : 'estimated',
      note: hasHomeAst ? 'Promedio real ajustado por ritmo' : 'Estimado desde rotación/ritmo',
    },
    {
      key: 'ast_away',
      label: `Asistencias esperadas (${match.awayTeam.shortName})`,
      pointEstimate: expectedAssistsAway,
      intervalLow: +Math.max(12, expectedAssistsAway - 4.2).toFixed(1),
      intervalHigh: +(expectedAssistsAway + 4.2).toFixed(1),
      unit: 'ast',
      reliability: hasAwayAst ? 'verified' : 'estimated',
      note: hasAwayAst ? 'Promedio real ajustado por ritmo' : 'Estimado desde rotación/ritmo',
    },
    {
      key: 'spread_home',
      label: `Diferencia esperada (${match.homeTeam.shortName})`,
      pointEstimate: +expectedSpreadHome.toFixed(1),
      intervalLow: +(expectedSpreadHome - 1.28 * spreadStdDev).toFixed(1),
      intervalHigh: +(expectedSpreadHome + 1.28 * spreadStdDev).toFixed(1),
      unit: 'pts',
      reliability: hasHomeRatings && hasAwayRatings ? 'verified' : 'estimated',
    },
  ];

  return {
    expectedPace,
    expectedHomePts,
    expectedAwayPts,
    expectedTotal,
    expectedSpreadHome,
    expectedReboundsHome,
    expectedReboundsAway,
    expectedAssistsHome,
    expectedAssistsAway,
    expectedStats,
    probHomeWin,
    probAwayWin,
    rawProbHomeWin,
    rawProbAwayWin,
    spreadStdDev,
    totalStdDev,
    absenceImpactSummary: [...homeImpact.notes, ...awayImpact.notes],
    dataConfidence,
    dataQuality,
    calibrationApplied,
    calibrationNote,
    modelWarnings,
  };
}

export const NBA_STAT_CONFIG: Record<
  NbaPropStat,
  { label: string; min: number; max: number; step: number; discreteAlpha?: number }
> = {
  points: { label: 'Puntos', min: 5.5, max: 45.5, step: 0.5 },
  rebounds: { label: 'Rebotes', min: 1.5, max: 18.5, step: 0.5 },
  assists: { label: 'Asistencias', min: 1.5, max: 15.5, step: 0.5 },
  threes: { label: 'Triples anotados', min: 0.5, max: 8.5, step: 0.5, discreteAlpha: 0.16 },
  steals: { label: 'Robos', min: 0.5, max: 4.5, step: 0.5, discreteAlpha: 0.12 },
  blocks: { label: 'Tapones', min: 0.5, max: 4.5, step: 0.5, discreteAlpha: 0.15 },
  turnovers: { label: 'Pérdidas', min: 0.5, max: 6.5, step: 0.5, discreteAlpha: 0.14 },
  pra: { label: 'Puntos + Rebotes + Asistencias', min: 12.5, max: 62.5, step: 0.5 },
};

function evaluateNbaLogFreshness(
  player: PlayerProfile,
  referenceIso: string
): { freshness: DataFreshnessStatus; warning?: string } {
  const latest = player.recentLogs[0]?.date ?? player.lastLogDate;
  if (!latest) {
    return {
      freshness: player.sampleSizeGames > 0 ? 'aging' : 'unknown',
      warning: player.sampleSizeGames === 0 ? 'Sin registros recientes individuales en esta fuente.' : undefined,
    };
  }
  const latestMs = new Date(latest).getTime();
  const refMs = new Date(referenceIso).getTime();
  if (!Number.isFinite(latestMs) || !Number.isFinite(refMs)) {
    return { freshness: 'unknown' };
  }
  const ageDays = Math.round((refMs - latestMs) / 86_400_000);
  if (ageDays > 45) {
    return {
      freshness: 'stale',
      warning: `Último partido registrado hace ${ageDays} días (${latest}); el modelo amplía la varianza por posible cambio de rol o inactividad.`,
    };
  }
  if (ageDays > 21) {
    return {
      freshness: 'aging',
      warning: `Último game log hace ${ageDays} días (${latest}).`,
    };
  }
  return { freshness: 'fresh' };
}

/**
 * Computes NBA Player Prop Over/Under distribution accounting for:
 * - Multi-split blend (Season 30% + L5 30% + L10 25% + Home/Away 15%) when available
 * - Log staleness detection widening dispersion when recentLogs > 45 days old
 * - Minutes & rotation projection (respecting confirmed/projected status & minutes limits)
 * - Pace & Opponent Defense matchup
 * - Zero-sum proportional teammate redistribution when key players sit or are limited
 */
export function computeNbaPlayerProp(
  player: PlayerProfile,
  match: MatchRecord,
  statKey: NbaPropStat,
  customLine?: number,
  timeframe: TimeframeSplit = 'season',
  teammatesOverride?: PlayerProfile[]
): PropProjectionResult {
  const cfg = NBA_STAT_CONFIG[statKey];
  const isHome = player.teamId === match.homeTeam.id;
  const teamPlayers = teammatesOverride ?? (isHome ? match.homePlayers : match.awayPlayers);
  const oppTeam = isHome ? match.awayTeam : match.homeTeam;
  const ownTeam = isHome ? match.homeTeam : match.awayTeam;

  const statsQuality: DataReliability =
    player.statsQuality ??
    (player.sampleSizeGames >= 8 ? 'verified' : player.sampleSizeGames > 0 ? 'estimated' : 'unavailable');

  const seasonVals = player.splits.season;
  const last5Vals = player.splits.last5 ?? seasonVals;
  const last10Vals = player.splits.last10 ?? seasonVals;
  const venueVals = isHome ? (player.splits.home ?? seasonVals) : (player.splits.away ?? seasonVals);
  const splitVals = player.splits[timeframe] ?? seasonVals;

  const extractStat = (v: typeof seasonVals): number => {
    if (statKey === 'pra') {
      return (v.points ?? 0) + (v.rebounds ?? 0) + (v.assists ?? 0);
    }
    return v[statKey] ?? 0;
  };

  const seasonStat = extractStat(seasonVals);
  const last5Stat = extractStat(last5Vals);
  const last10Stat = extractStat(last10Vals);
  const venueStat = extractStat(venueVals);
  const splitStat = extractStat(splitVals);

  const hasMultiWindowSamples =
    (last5Vals.games ?? 0) > 0 && (last10Vals.games ?? 0) > 0 && (seasonVals.games ?? 0) > 0;

  const compositeMean = hasMultiWindowSamples
    ? seasonStat * 0.30 + last5Stat * 0.30 + last10Stat * 0.25 + venueStat * 0.15
    : seasonStat;

  const basePerGame = timeframe === 'season' ? compositeMean : splitStat * 0.62 + compositeMean * 0.38;

  const { freshness: dataFreshness, warning: freshnessWarning } = evaluateNbaLogFreshness(
    player,
    match.kickoffIso
  );

  // Compute vacated minutes/usage/assists AND total active weights so redistribution sums cleanly <= 100%
  const playerBaseMin = Math.max(10, seasonVals.minutes || 26);
  const playerAvail = getNbaAvailabilityFactor(player.availability, player.minutesRestriction, playerBaseMin);

  let vacatedUsage = 0;
  let vacatedAssists = 0;
  let vacatedMinutes = 0;
  let totalActiveMinutesWeight = playerBaseMin * playerAvail;
  let totalActiveUsageWeight = Math.max(0.05, player.impact.usageShare * playerAvail);
  let totalActiveAssistWeight = Math.max(0.05, player.impact.assistShare * playerAvail);

  for (const mate of teamPlayers) {
    if (mate.id === player.id) continue;
    const mateBaseMin = mate.splits.season.minutes || 28;
    const avail = getNbaAvailabilityFactor(mate.availability, mate.minutesRestriction, mateBaseMin);
    if (avail < 0.99 && (mate.isKeyPlayer || avail === 0 || mate.minutesRestriction)) {
      const loss = 1 - avail;
      vacatedUsage += mate.impact.usageShare * loss;
      vacatedAssists += mate.impact.assistShare * loss;
      vacatedMinutes += mateBaseMin * loss;
    }
    if (avail > 0) {
      totalActiveMinutesWeight += mateBaseMin * avail;
      totalActiveUsageWeight += mate.impact.usageShare * avail;
      totalActiveAssistWeight += mate.impact.assistShare * avail;
    }
  }

  let expectedMinutes = 0;
  if (player.availability === 'out' || player.availability === 'suspended') {
    expectedMinutes = 0;
  } else if (player.availability === 'doubtful') {
    expectedMinutes = playerBaseMin * 0.52;
  } else if (player.minutesRestriction) {
    expectedMinutes = player.minutesRestriction.maxMinutes
      ? Math.min(playerBaseMin, player.minutesRestriction.maxMinutes)
      : playerBaseMin * 0.78;
  } else {
    const isStarterRole =
      player.availability === 'confirmed_starter' ||
      player.availability === 'possible_starter' ||
      player.availability === 'starter';
    const isBenchRole = player.availability === 'bench' || player.availability === 'available';
    const shareOfActiveMin = (playerBaseMin * playerAvail) / Math.max(60, totalActiveMinutesWeight);
    const rawMinShare = vacatedMinutes * shareOfActiveMin * (isBenchRole ? 1.15 : 0.88);
    const boostCap = isBenchRole ? Math.min(7.5, rawMinShare) : Math.min(4.0, rawMinShare);
    const probableDiscount = player.availability === 'probable' ? 0.92 : 1;
    const roleBaseline = isStarterRole ? Math.max(playerBaseMin, 24) : playerBaseMin;
    expectedMinutes = Math.min(40.5, roleBaseline * probableDiscount + boostCap);
  }

  const minutesRatio = expectedMinutes / playerBaseMin;

  // Normalized proportional redistribution (caps extreme blowup if multiple stars sit)
  let absenceBoostRatio = 0;
  if (expectedMinutes > 0 && !player.minutesRestriction) {
    const usageShareOfActive =
      (player.impact.usageShare * playerAvail) / Math.max(0.28, totalActiveUsageWeight);
    const assistShareOfActive =
      (player.impact.assistShare * playerAvail) / Math.max(0.28, totalActiveAssistWeight);

    if (statKey === 'points' || statKey === 'threes') {
      absenceBoostRatio = Math.min(0.24, vacatedUsage * usageShareOfActive * 1.45);
    } else if (statKey === 'assists') {
      absenceBoostRatio = Math.min(0.26, vacatedAssists * assistShareOfActive * 1.5);
    } else if (statKey === 'rebounds') {
      absenceBoostRatio = Math.min(0.14, vacatedUsage * usageShareOfActive * 0.55);
    } else if (statKey === 'pra') {
      absenceBoostRatio = Math.min(
        0.22,
        vacatedUsage * usageShareOfActive * 1.1 + vacatedAssists * assistShareOfActive * 0.65
      );
    } else if (statKey === 'turnovers') {
      absenceBoostRatio = Math.min(0.18, vacatedUsage * usageShareOfActive * 0.9);
    }
  }

  const avgPace = ((ownTeam.pace ?? 99.5) + (oppTeam.pace ?? 99.5)) / 2;
  const paceFactor = avgPace / 99.5;
  const oppDefFactor =
    statKey === 'points' || statKey === 'threes' || statKey === 'assists' || statKey === 'pra'
      ? Math.max(0.88, Math.min(1.14, (oppTeam.defRating ?? 113.5) / 113.5))
      : 1.0;

  const expectedValue = Math.max(
    0,
    basePerGame * minutesRatio * (1 + absenceBoostRatio) * paceFactor * oppDefFactor
  );

  const defaultLine = Math.max(
    cfg.min,
    Math.min(cfg.max, Math.floor(expectedValue) + 0.5)
  );
  const line = customLine ?? defaultLine;

  const freshnessPenalty = dataFreshness === 'stale' ? 14 : dataFreshness === 'aging' ? 5 : 0;
  const sampleConfidence = Math.max(
    18,
    (player.sampleSizeGames <= 0 || statsQuality === 'unavailable'
      ? 28
      : statsQuality === 'estimated'
        ? Math.min(54, 34 + player.sampleSizeGames * 2.2)
        : Math.min(
            93,
            52 + Math.min(32, player.sampleSizeGames * 0.7) + (match.lineupStatus === 'confirmed' ? 8 : 0)
          )) - freshnessPenalty
  );

  const lowSampleVarianceMultiplier =
    (statsQuality === 'verified' ? 1.0 : 1.3) * (dataFreshness === 'stale' ? 1.18 : 1.0);

  const multiSplitSummary = {
    seasonAvg: +seasonStat.toFixed(1),
    last5Avg: +last5Stat.toFixed(1),
    last10Avg: +last10Stat.toFixed(1),
    homeAwayAvg: +venueStat.toFixed(1),
    h2hAvg: player.splits.h2h?.games ? +extractStat(player.splits.h2h).toFixed(1) : undefined,
    weightsNote: hasMultiWindowSamples
      ? 'Modelo ponderado NBA: 30% Temp + 30% L5 + 25% L10 + 15% Local/Visitante'
      : 'Sin logs completos multi-ventana; se aplica base disponible',
  };

  if (cfg.discreteAlpha !== undefined) {
    const effAlpha = cfg.discreteAlpha * lowSampleVarianceMultiplier;
    const maxK = Math.max(Math.ceil(cfg.max) + 3, Math.ceil(expectedValue * 3) + 3);
    const probs: number[] = [];
    let rawSum = 0;
    for (let k = 0; k <= maxK; k++) {
      const p = negBinPmf(k, expectedValue, effAlpha);
      probs.push(p);
      rawSum += p;
    }
    const distribution: PropDistributionBin[] = [];
    let cumUnder = 0;
    let cum = 0;
    let median = 0;
    let q10 = 0;
    let q90 = maxK;
    let f10 = false;
    let f50 = false;
    let f90 = false;
    for (let k = 0; k <= maxK; k++) {
      const p = probs[k] / Math.max(1e-9, rawSum);
      cum += p;
      if (!f10 && cum >= 0.1) { q10 = k; f10 = true; }
      if (!f50 && cum >= 0.5) { median = k; f50 = true; }
      if (!f90 && cum >= 0.9) { q90 = k; f90 = true; }
      if (k < line) cumUnder += p;
      if (k <= Math.ceil(cfg.max) + 1) {
        distribution.push({
          value: k,
          label: `${k}`,
          probability: p,
          isOver: k > line,
        });
      }
    }
    const probUnder = Math.max(0.5, Math.min(99.5, Math.round(cumUnder * 1000) / 10));
    const probOver = Math.round((100 - probUnder) * 10) / 10;
    const stdDev = Math.sqrt(expectedValue + effAlpha * expectedValue * expectedValue);

    return {
      statKey,
      statLabel: cfg.label,
      line,
      minLine: cfg.min,
      maxLine: cfg.max,
      step: cfg.step,
      expectedValue,
      median,
      stdDev,
      intervalLow: q10,
      intervalHigh: q90,
      probOver,
      probUnder,
      expectedMinutes,
      absenceAdjustmentPct: absenceBoostRatio * 100,
      sampleConfidence,
      sampleSizeGames: player.sampleSizeGames,
      statsQuality,
      statsOriginNote: player.statsOriginNote,
      dataFreshness,
      freshnessWarning,
      multiSplitSummary,
      distribution,
    };
  }

  const coeffVar =
    statKey === 'points'
      ? 0.27
      : statKey === 'rebounds'
        ? 0.34
        : statKey === 'assists'
          ? 0.36
          : 0.24;
  const doubtfulUncertainty = player.availability === 'doubtful' ? 1.25 : 1.0;
  const stdDev = Math.max(1.5, expectedValue * coeffVar * doubtfulUncertainty * lowSampleVarianceMultiplier);

  const probUnderRaw = normalCdf(line, expectedValue, stdDev);
  const probUnder = Math.max(0.5, Math.min(99.5, Math.round(probUnderRaw * 1000) / 10));
  const probOver = Math.round((100 - probUnder) * 10) / 10;

  const binStep = statKey === 'pra' ? 4 : statKey === 'points' ? 3 : 1;
  const center = Math.round(expectedValue);
  const distribution: PropDistributionBin[] = [];
  for (let i = -5; i <= 5; i++) {
    const val = Math.max(0, center + i * binStep);
    const lo = val - binStep / 2;
    const hi = val + binStep / 2;
    const p = Math.max(0, normalCdf(hi, expectedValue, stdDev) - normalCdf(lo, expectedValue, stdDev));
    distribution.push({
      value: val,
      label: `${val}`,
      probability: p,
      isOver: val > line,
    });
  }

  return {
    statKey,
    statLabel: cfg.label,
    line,
    minLine: cfg.min,
    maxLine: cfg.max,
    step: cfg.step,
    expectedValue,
    median: expectedValue,
    stdDev,
    intervalLow: Math.max(0, expectedValue - 1.28 * stdDev),
    intervalHigh: expectedValue + 1.28 * stdDev,
    probOver,
    probUnder,
    expectedMinutes,
    absenceAdjustmentPct: absenceBoostRatio * 100,
    sampleConfidence,
    sampleSizeGames: player.sampleSizeGames,
    statsQuality,
    statsOriginNote: player.statsOriginNote,
    dataFreshness,
    freshnessWarning,
    multiSplitSummary,
    distribution,
  };
}

/**
 * Generates a specific pre-match NBA narrative explanation covering pace, ORtg/DRtg,
 * rest/B2B fatigue, absences, positional tactical matchups (Guards, Wings, Paint/Rebounding),
 * H2H sample gating, and data limits.
 */
export function buildNbaMatchExplanation(
  match: MatchRecord,
  pred: NbaPredictionResult,
  homePlayersOverride?: PlayerProfile[],
  awayPlayersOverride?: PlayerProfile[]
): MatchNarrativeExplanation {
  const h = match.homeTeam;
  const a = match.awayTeam;
  const homePlayers = (homePlayersOverride ?? match.homePlayers).filter(
    (p) => p.availability !== 'out' && p.availability !== 'suspended'
  );
  const awayPlayers = (awayPlayersOverride ?? match.awayPlayers).filter(
    (p) => p.availability !== 'out' && p.availability !== 'suspended'
  );

  const favLabel =
    pred.probHomeWin >= 0.55
      ? `Ventaja local para ${h.name} (${(pred.probHomeWin * 100).toFixed(1)}% vs ${(pred.probAwayWin * 100).toFixed(1)}%)`
      : pred.probAwayWin >= 0.55
        ? `Ventaja visitante para ${a.name} (${(pred.probAwayWin * 100).toFixed(1)}% vs ${(pred.probHomeWin * 100).toFixed(1)}%)`
        : `Encuentro muy igualado (${h.shortName} ${(pred.probHomeWin * 100).toFixed(1)}% vs ${a.shortName} ${(pred.probAwayWin * 100).toFixed(1)}%)`;

  const homeFavoringFactors: string[] = [
    `Proyección de ${pred.expectedHomePts.toFixed(1)} puntos (${pred.expectedReboundsHome.toFixed(1)} reb, ${pred.expectedAssistsHome.toFixed(1)} ast).`,
  ];
  if (h.offRating !== undefined && h.defRating !== undefined) {
    homeFavoringFactors.push(`Eficiencia: ORtg ${h.offRating.toFixed(1)} / DRtg ${h.defRating.toFixed(1)} (Net ${(h.offRating - h.defRating >= 0 ? '+' : '')}${(h.offRating - h.defRating).toFixed(1)}).`);
  }
  if (h.homeRecord) homeFavoringFactors.push(`Balance en casa: ${h.homeRecord}.`);
  homeFavoringFactors.push(
    h.isBackToBack
      ? `Situación de Back-to-Back (penalización por fatiga aplicada).`
      : `Descanso de ${h.restDays} días${h.restDays >= 2 ? ' (frescura favorable)' : ''}.`
  );

  const awayFavoringFactors: string[] = [
    `Proyección de ${pred.expectedAwayPts.toFixed(1)} puntos (${pred.expectedReboundsAway.toFixed(1)} reb, ${pred.expectedAssistsAway.toFixed(1)} ast).`,
  ];
  if (a.offRating !== undefined && a.defRating !== undefined) {
    awayFavoringFactors.push(`Eficiencia: ORtg ${a.offRating.toFixed(1)} / DRtg ${a.defRating.toFixed(1)} (Net ${(a.offRating - a.defRating >= 0 ? '+' : '')}${(a.offRating - a.defRating).toFixed(1)}).`);
  }
  if (a.awayRecord) awayFavoringFactors.push(`Rendimiento fuera de casa: ${a.awayRecord}.`);
  awayFavoringFactors.push(
    a.isBackToBack
      ? `Juega en Back-to-Back visitante (-1.7 pts de ajuste de fatiga).`
      : `Descanso de ${a.restDays} días antes del salto inicial.`
  );

  const pickTopRole = (players: PlayerProfile[], posHints: string[]) =>
    players
      .filter((p) => posHints.some((hint) => p.position.toUpperCase().includes(hint)))
      .sort((x, y) => (y.splits.season.points ?? 0) - (x.splits.season.points ?? 0))[0];

  const homeGuard = pickTopRole(homePlayers, ['PG', 'SG', 'G']);
  const awayGuard = pickTopRole(awayPlayers, ['PG', 'SG', 'G']);
  const homeBig = pickTopRole(homePlayers, ['C', 'PF', 'F']);
  const awayBig = pickTopRole(awayPlayers, ['C', 'PF', 'F']);

  const tacticalMatchups: string[] = [
    `Ritmo proyectado de ${pred.expectedPace.toFixed(1)} posesiones/48m y total esperado de ${pred.expectedTotal.toFixed(1)} puntos.`,
    `Batalla en el rebote y juego interior: ${h.shortName} (${pred.expectedReboundsHome.toFixed(1)} reb) vs ${a.shortName} (${pred.expectedReboundsAway.toFixed(1)} reb).`,
  ];
  if (homeGuard && awayGuard) {
    tacticalMatchups.push(
      `Duelo de perímetro y dirección: ${homeGuard.shortName} (${(homeGuard.splits.season.points ?? 0).toFixed(1)}p / ${(homeGuard.splits.season.assists ?? 0).toFixed(1)}a) frente a ${awayGuard.shortName} (${(awayGuard.splits.season.points ?? 0).toFixed(1)}p / ${(awayGuard.splits.season.assists ?? 0).toFixed(1)}a).`
    );
  }
  if (homeBig && awayBig) {
    tacticalMatchups.push(
      `Duelo en la pintura: ${homeBig.shortName} (${(homeBig.splits.season.rebounds ?? 0).toFixed(1)} reb) vs ${awayBig.shortName} (${(awayBig.splits.season.rebounds ?? 0).toFixed(1)} reb).`
    );
  }

  const h2hAssessment =
    match.h2hSummary.played >= 4
      ? `Muestra H2H sólida (${match.h2hSummary.played} enfrentamientos: ${match.h2hSummary.homeWins}V ${h.shortName} - ${match.h2hSummary.awayWins}V ${a.shortName}, media ${match.h2hSummary.avgTotalPointsOrGoals.toFixed(1)} pts).`
      : match.h2hSummary.played > 0
        ? `Muestra H2H reducida (${match.h2hSummary.played} partido${match.h2hSummary.played === 1 ? '' : 's'}); evita sobredimensionar resultados directos con menos de 4 duelos.`
        : 'Sin serie H2H reciente cargada para este emparejamiento.';

  const uncertaintiesAndLimits = [...pred.modelWarnings];
  if (match.provenance?.isStale) {
    uncertaintiesAndLimits.push(
      `Advertencia de actualización: los datos tienen ${match.provenance.staleAgeMinutes} minutos de antigüedad.`
    );
  }

  return {
    headline: `${favLabel}. Margen proyectado: ${pred.expectedSpreadHome >= 0 ? '+' : ''}${pred.expectedSpreadHome.toFixed(1)} ${h.shortName}.`,
    homeFavoringFactors,
    awayFavoringFactors,
    homeStrengthsWeaknesses: `${h.shortName}: ${h.ppgOrGpg !== undefined ? `${h.ppgOrGpg.toFixed(1)} PTS/p` : 'PTS base'} · ${h.oppgOrGapg !== undefined ? `${h.oppgOrGapg.toFixed(1)} REC/p` : 'Def. base'} · Pace ${(h.pace ?? 99.4).toFixed(1)}`,
    awayStrengthsWeaknesses: `${a.shortName}: ${a.ppgOrGpg !== undefined ? `${a.ppgOrGpg.toFixed(1)} PTS/p` : 'PTS base'} · ${a.oppgOrGapg !== undefined ? `${a.oppgOrGapg.toFixed(1)} REC/p` : 'Def. base'} · Pace ${(a.pace ?? 99.4).toFixed(1)}`,
    keyAbsencesImpact:
      pred.absenceImpactSummary.length > 0
        ? pred.absenceImpactSummary
        : ['Rotaciones principales disponibles sin bajas confirmadas de alto impacto.'],
    h2hAssessment,
    tacticalMatchups,
    uncertaintiesAndLimits:
      uncertaintiesAndLimits.length > 0
        ? uncertaintiesAndLimits
        : [`Cobertura estadística del ${pred.dataConfidence}% con métricas NBA verificadas.`],
  };
}

