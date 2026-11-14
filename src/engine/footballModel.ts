import type {
  AvailabilityStatus,
  DataFreshnessStatus,
  DataReliability,
  FootballPredictionResult,
  FootballPropStat,
  LoggedPrediction,
  MatchNarrativeExplanation,
  MatchRecord,
  PlayerProfile,
  PropDistributionBin,
  PropProjectionResult,
  StatExpectationWithInterval,
  TimeframeSplit,
} from '../types/sports.ts';
import {
  applyThreeWayCalibration,
  fitEmpiricalCalibrationProfile,
} from './calibrationEngine.ts';
import {
  evaluateMatchStatOverUnder,
  negBinPmf,
  normalCdf,
  poissonPmf,
} from './distributionMath.ts';

export { evaluateMatchStatOverUnder };

export function isGoalkeeperPosition(position?: string): boolean {
  const pos = (position ?? '').trim().toUpperCase();
  return pos === 'GK' || pos === 'G' || pos.includes('PORTERO') || pos.includes('GOALKEEPER');
}

export const FOOTBALL_GK_STATS: FootballPropStat[] = ['saves', 'goalsConceded'];
export const FOOTBALL_FIELD_STATS: FootballPropStat[] = [
  'shots',
  'shotsOnTarget',
  'goals',
  'assists',
  'passes',
  'foulsCommitted',
  'foulsDrawn',
  'yellowCards',
  'redCards',
];

function getAvailabilityFactor(status: AvailabilityStatus): number {
  switch (status) {
    case 'confirmed_starter':
    case 'possible_starter':
    case 'starter':
    case 'available':
      return 1;
    case 'probable':
      return 0.9;
    case 'bench':
      return 0.32;
    case 'doubtful':
      return 0.48;
    case 'out':
    case 'suspended':
      return 0;
  }
}

function parseFootballPlayedGames(record?: string, explicitPlayed?: number): number {
  if (explicitPlayed !== undefined && explicitPlayed > 0) return explicitPlayed;
  if (!record) return 0;
  const m = record.match(/(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/);
  if (m) return Number(m[1]) + Number(m[2]) + Number(m[3]);
  return 0;
}

export function calculateTeamAbsenceAdjustments(
  players: PlayerProfile[],
  teamLabel: string
): {
  offenseShift: number;
  defenseShift: number;
  missingUsageShare: number;
  missingAssistShare: number;
  notes: string[];
} {
  let offenseShift = 0;
  let defenseShift = 0;
  let missingUsageShare = 0;
  let missingAssistShare = 0;
  const notes: string[] = [];

  for (const p of players) {
    const availFactor = getAvailabilityFactor(p.availability);
    if (availFactor < 0.99 && p.isKeyPlayer) {
      const lossRatio = 1 - availFactor;
      offenseShift -= p.impact.offenseDelta * lossRatio;
      defenseShift += p.impact.defenseDelta * lossRatio;
      missingUsageShare += p.impact.usageShare * lossRatio;
      missingAssistShare += p.impact.assistShare * lossRatio;
      const statusText =
        p.availability === 'out'
          ? 'Baja'
          : p.availability === 'suspended'
            ? 'Sancionado'
            : p.availability === 'doubtful'
              ? 'Dudoso'
              : 'Suplente';
      notes.push(
        `${teamLabel}: ${p.shortName} (${statusText}) ajusta ataque ${(-p.impact.offenseDelta * lossRatio).toFixed(2)} xG`
      );
    }
  }

  return {
    offenseShift,
    defenseShift,
    missingUsageShare: Math.min(0.45, missingUsageShare),
    missingAssistShare: Math.min(0.45, missingAssistShare),
    notes,
  };
}

/**
 * Dixon-Coles adjusted bivariate Poisson model for Football matches
 * with Bayesian shrinkage, transparent data quality scoring, and empirical calibration.
 */
export function computeFootballMatchPrediction(
  match: MatchRecord,
  homePlayersOverride?: PlayerProfile[],
  awayPlayersOverride?: PlayerProfile[],
  calibrationHistory?: LoggedPrediction[]
): FootballPredictionResult {
  const homePlayers = homePlayersOverride ?? match.homePlayers;
  const awayPlayers = awayPlayersOverride ?? match.awayPlayers;
  const modelWarnings: string[] = [];

  const leagueAvg = 1.35;
  const hasHomeMetrics =
    (match.homeTeam.attackHome !== undefined && match.homeTeam.defenseHome !== undefined) ||
    (match.homeTeam.ppgOrGpg !== undefined && match.homeTeam.oppgOrGapg !== undefined);
  const hasAwayMetrics =
    (match.awayTeam.attackAway !== undefined && match.awayTeam.defenseAway !== undefined) ||
    (match.awayTeam.ppgOrGpg !== undefined && match.awayTeam.oppgOrGapg !== undefined);

  const homeGames = parseFootballPlayedGames(
    match.homeTeam.record,
    match.homeTeam.playedGames ?? match.homeTeam.recentGames?.length
  );
  const awayGames = parseFootballPlayedGames(
    match.awayTeam.record,
    match.awayTeam.playedGames ?? match.awayTeam.recentGames?.length
  );

  // Neutral baseline ~1.45 home / ~1.22 away when team data is unavailable, shrunk by sample size k=10
  const rawHomeAtk =
    match.homeTeam.attackHome ??
    (match.homeTeam.ppgOrGpg !== undefined ? match.homeTeam.ppgOrGpg * 1.08 : 1.45);
  const rawHomeDef =
    match.homeTeam.defenseHome ??
    (match.homeTeam.oppgOrGapg !== undefined ? match.homeTeam.oppgOrGapg * 0.92 : 1.2);
  const rawAwayAtk =
    match.awayTeam.attackAway ??
    (match.awayTeam.ppgOrGpg !== undefined ? match.awayTeam.ppgOrGpg * 0.94 : 1.22);
  const rawAwayDef =
    match.awayTeam.defenseAway ??
    (match.awayTeam.oppgOrGapg !== undefined ? match.awayTeam.oppgOrGapg * 1.06 : 1.35);

  const wHome = hasHomeMetrics ? (homeGames > 0 ? homeGames / (homeGames + 10) : 0.62) : 0;
  const wAway = hasAwayMetrics ? (awayGames > 0 ? awayGames / (awayGames + 10) : 0.62) : 0;

  const baseHomeAttack = wHome * rawHomeAtk + (1 - wHome) * 1.46;
  const baseHomeDefense = wHome * rawHomeDef + (1 - wHome) * 1.24;
  const baseAwayAttack = wAway * rawAwayAtk + (1 - wAway) * 1.22;
  const baseAwayDefense = wAway * rawAwayDef + (1 - wAway) * 1.38;

  if (!hasHomeMetrics || !hasAwayMetrics) {
    modelWarnings.push(
      'Faltan métricas ofensivas/defensivas verificadas de al menos un equipo; se aplica línea base neutral de liga.'
    );
  } else if ((homeGames > 0 && homeGames < 8) || (awayGames > 0 && awayGames < 8)) {
    modelWarnings.push(
      'Muestra temprana de temporada (<8 partidos); las tasas xG incorporan regresión bayesiana a la media.'
    );
  }

  const homeAdj = calculateTeamAbsenceAdjustments(homePlayers, match.homeTeam.shortName);
  const awayAdj = calculateTeamAbsenceAdjustments(awayPlayers, match.awayTeam.shortName);

  const formScore = (form: ('W' | 'D' | 'L')[]) => {
    if (!form.length) return 0.5;
    const pts = form.reduce((acc, r) => acc + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
    return pts / (form.length * 3);
  };
  const homeFormBoost = match.homeTeam.formRecent.length
    ? 1 + (formScore(match.homeTeam.formRecent) - 0.5) * 0.12
    : 1;
  const awayFormBoost = match.awayTeam.formRecent.length
    ? 1 + (formScore(match.awayTeam.formRecent) - 0.5) * 0.12
    : 1;

  if (!match.homeTeam.formRecent.length && !match.awayTeam.formRecent.length) {
    modelWarnings.push('Sin racha L5 reciente registrada; factor de forma mantenido en neutro (1.00).');
  }

  // H2H subtle shrinkage only when played >= 3
  const h2hWeight = match.h2hSummary.played >= 3 ? Math.min(0.05, match.h2hSummary.played * 0.008) : 0;
  const h2hHomeEdge =
    match.h2hSummary.played > 0
      ? (match.h2hSummary.homeWins - match.h2hSummary.awayWins) / match.h2hSummary.played
      : 0;

  let lambdaHome =
    ((baseHomeAttack * baseAwayDefense) / leagueAvg) * homeFormBoost * (1 + h2hHomeEdge * h2hWeight) +
    homeAdj.offenseShift +
    awayAdj.defenseShift;
  let lambdaAway =
    ((baseAwayAttack * baseHomeDefense) / leagueAvg) * awayFormBoost * (1 - h2hHomeEdge * h2hWeight) +
    awayAdj.offenseShift +
    homeAdj.defenseShift;

  // When data is incomplete, pull lambdas subtly toward league baseline
  if (!hasHomeMetrics || !hasAwayMetrics) {
    lambdaHome = lambdaHome * 0.8 + 1.42 * 0.2;
    lambdaAway = lambdaAway * 0.8 + 1.18 * 0.2;
  }

  lambdaHome = Math.max(0.42, Math.min(3.45, lambdaHome));
  lambdaAway = Math.max(0.35, Math.min(3.15, lambdaAway));

  const rho = -0.075;
  const maxGoals = 8;
  let rawProbHome = 0;
  let rawProbDraw = 0;
  let rawProbAway = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let bttsYes = 0;
  const exactScores: Array<{ home: number; away: number; probability: number }> = [];

  let totalMass = 0;
  const matrix: number[][] = [];

  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      let tau = 1;
      if (h === 0 && a === 0) tau = Math.max(0.05, 1 - lambdaHome * lambdaAway * rho);
      else if (h === 0 && a === 1) tau = Math.max(0.05, 1 + lambdaHome * rho);
      else if (h === 1 && a === 0) tau = Math.max(0.05, 1 + lambdaAway * rho);
      else if (h === 1 && a === 1) tau = Math.max(0.05, 1 - rho);

      const p = Math.max(0, tau * poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway));
      matrix[h][a] = p;
      totalMass += p;
    }
  }

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = matrix[h][a] / Math.max(1e-9, totalMass);
      if (h > a) rawProbHome += p;
      else if (h === a) rawProbDraw += p;
      else rawProbAway += p;

      const sum = h + a;
      if (sum > 1.5) over15 += p;
      if (sum > 2.5) over25 += p;
      if (sum > 3.5) over35 += p;
      if (h >= 1 && a >= 1) bttsYes += p;
      exactScores.push({ home: h, away: a, probability: p });
    }
  }

  exactScores.sort((a, b) => b.probability - a.probability);

  // Guard extreme 1X2 probabilities before match
  const clamp1X2 = (arr: [number, number, number]): [number, number, number] => {
    const c = arr.map((v) => Math.max(0.03, Math.min(0.92, v)));
    const s = c[0] + c[1] + c[2];
    return [c[0] / s, c[1] / s, c[2] / s];
  };

  [rawProbHome, rawProbDraw, rawProbAway] = clamp1X2([rawProbHome, rawProbDraw, rawProbAway]);

  // Apply uncertainty damping when key team/lineup inputs are missing
  if (!hasHomeMetrics || !hasAwayMetrics) {
    const damp = 0.78;
    const uniform = [0.38, 0.27, 0.35];
    rawProbHome = damp * rawProbHome + (1 - damp) * uniform[0];
    rawProbDraw = damp * rawProbDraw + (1 - damp) * uniform[1];
    rawProbAway = damp * rawProbAway + (1 - damp) * uniform[2];
  }

  let probHome = rawProbHome;
  let probDraw = rawProbDraw;
  let probAway = rawProbAway;
  let calibrationApplied = false;
  let calibrationNote: string | undefined;

  if (calibrationHistory && calibrationHistory.length > 0) {
    const profile = fitEmpiricalCalibrationProfile(calibrationHistory, 'football');
    if (profile.active && (profile.temperature !== 1 || profile.bias !== 0)) {
      [probHome, probDraw, probAway] = applyThreeWayCalibration(
        rawProbHome,
        rawProbDraw,
        rawProbAway,
        profile
      );
      [probHome, probDraw, probAway] = clamp1X2([probHome, probDraw, probAway]);
      calibrationApplied = true;
      calibrationNote = profile.summary;
    }
  }

  const expectedCorners =
    (match.homeTeam.avgCorners ?? 5.3) +
    (match.awayTeam.avgCorners ?? 4.6) +
    (lambdaHome + lambdaAway - 2.6) * 0.65;

  const expectedCardsHome = (match.homeTeam.avgYellowCards ?? 1.9) + (lambdaAway > 1.5 ? 0.25 : 0);
  const expectedCardsAway = (match.awayTeam.avgYellowCards ?? 2.2) + (lambdaHome > 1.5 ? 0.3 : 0);

  // Strict data confidence calculation (NOT match win likelihood!)
  let dataConfidence = 28;
  if (hasHomeMetrics && hasAwayMetrics) dataConfidence += 28;
  else if (hasHomeMetrics || hasAwayMetrics) dataConfidence += 12;

  if (match.homeTeam.formRecent.length > 0 && match.awayTeam.formRecent.length > 0) {
    dataConfidence += 10;
  } else if (match.homeTeam.formRecent.length > 0 || match.awayTeam.formRecent.length > 0) {
    dataConfidence += 5;
  }

  if (match.lineupStatus === 'confirmed') dataConfidence += 16;
  else if (match.lineupStatus === 'provisional') dataConfidence += 8;
  else modelWarnings.push('Alineaciones no confirmadas todavía; impacto de jugadores estimado.');

  if (match.h2hSummary.played >= 3) dataConfidence += 10;
  else if (match.h2hSummary.played > 0) dataConfidence += 4;

  const minGames = Math.min(homeGames || 10, awayGames || 10);
  if ((hasHomeMetrics || hasAwayMetrics) && minGames < 6) {
    dataConfidence -= 8;
  }

  dataConfidence = Math.max(20, Math.min(93, Math.round(dataConfidence)));

  const dataQuality: DataReliability =
    hasHomeMetrics && hasAwayMetrics && (homePlayers.length > 0 || match.lineupStatus === 'confirmed')
      ? 'verified'
      : hasHomeMetrics || hasAwayMetrics
        ? 'estimated'
        : 'unavailable';

  // Expected Shots & Shots on Target per team (verified when team averages exist, else estimated from xG)
  const expectedGoalsTotal = lambdaHome + lambdaAway;
  const hasRealShotsHome = match.homeTeam.avgShots !== undefined;
  const hasRealShotsAway = match.awayTeam.avgShots !== undefined;
  const hasRealSotHome = match.homeTeam.avgShotsOnTarget !== undefined;
  const hasRealSotAway = match.awayTeam.avgShotsOnTarget !== undefined;

  const expectedShotsHome = hasRealShotsHome
    ? match.homeTeam.avgShots!
    : +(lambdaHome * 8.6 + 1.8).toFixed(1);
  const expectedShotsAway = hasRealShotsAway
    ? match.awayTeam.avgShots!
    : +(lambdaAway * 8.4 + 1.4).toFixed(1);

  const expectedShotsOnTargetHome = hasRealSotHome
    ? match.homeTeam.avgShotsOnTarget!
    : +(lambdaHome * 3.15 + 0.5).toFixed(1);
  const expectedShotsOnTargetAway = hasRealSotAway
    ? match.awayTeam.avgShotsOnTarget!
    : +(lambdaAway * 3.05 + 0.4).toFixed(1);

  const poissonInterval80 = (mean: number, scaleSd = 1.0): [number, number] => {
    const sd = Math.sqrt(Math.max(0.25, mean)) * scaleSd;
    return [Math.max(0, +(mean - 1.28 * sd).toFixed(1)), +(mean + 1.28 * sd).toFixed(1)];
  };

  const cornersMean = Math.max(5.5, expectedCorners);
  const cardsTotalMean = expectedCardsHome + expectedCardsAway;
  const cornersInt = poissonInterval80(cornersMean, 1.05);
  const cardsInt = poissonInterval80(cardsTotalMean, 1.1);
  const shotsHInt = poissonInterval80(expectedShotsHome, 1.18);
  const shotsAInt = poissonInterval80(expectedShotsAway, 1.18);
  const sotHInt = poissonInterval80(expectedShotsOnTargetHome, 1.12);
  const sotAInt = poissonInterval80(expectedShotsOnTargetAway, 1.12);

  const hasRealCorners =
    match.homeTeam.avgCorners !== undefined && match.awayTeam.avgCorners !== undefined;
  const hasPartialCorners =
    match.homeTeam.avgCorners !== undefined || match.awayTeam.avgCorners !== undefined;
  const hasRealCards =
    match.homeTeam.avgYellowCards !== undefined && match.awayTeam.avgYellowCards !== undefined;
  const hasPartialCards =
    match.homeTeam.avgYellowCards !== undefined || match.awayTeam.avgYellowCards !== undefined;
  const hasAnyTeamScoringBasis = hasHomeMetrics || hasAwayMetrics;

  const cornersRel: DataReliability = hasRealCorners
    ? 'verified'
    : hasPartialCorners || hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';
  const cardsRel: DataReliability = hasRealCards
    ? 'verified'
    : hasPartialCards || hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';

  const xgHomeRel: DataReliability = hasHomeMetrics
    ? 'verified'
    : hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';
  const xgAwayRel: DataReliability = hasAwayMetrics
    ? 'verified'
    : hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';
  const goalRel: DataReliability =
    hasHomeMetrics && hasAwayMetrics ? 'verified' : hasAnyTeamScoringBasis ? 'estimated' : 'unavailable';
  const shotsHomeRel: DataReliability = hasRealShotsHome
    ? 'verified'
    : hasHomeMetrics || hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';
  const shotsAwayRel: DataReliability = hasRealShotsAway
    ? 'verified'
    : hasAwayMetrics || hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';
  const sotHomeRel: DataReliability = hasRealSotHome
    ? 'verified'
    : hasHomeMetrics || hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';
  const sotAwayRel: DataReliability = hasRealSotAway
    ? 'verified'
    : hasAwayMetrics || hasAnyTeamScoringBasis
      ? 'estimated'
      : 'unavailable';

  const halfStepNear = (mean: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.floor(mean) + 0.5));

  const expectedStats: StatExpectationWithInterval[] = [
    xgHomeRel === 'unavailable'
      ? {
          key: 'xg_home',
          label: `Goles / xG esperados (${match.homeTeam.shortName})`,
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'goles',
          reliability: 'unavailable',
          note: 'Sin métricas ofensivas/defensivas suficientes del equipo',
        }
      : {
          key: 'xg_home',
          label: `Goles / xG esperados (${match.homeTeam.shortName})`,
          pointEstimate: +lambdaHome.toFixed(2),
          intervalLow: Math.max(0, +(lambdaHome - 1.28 * Math.sqrt(lambdaHome)).toFixed(2)),
          intervalHigh: +(lambdaHome + 1.28 * Math.sqrt(lambdaHome)).toFixed(2),
          unit: 'goles',
          reliability: xgHomeRel,
          note: hasHomeMetrics ? 'Basado en tasas xG/goles reales' : 'Estimado desde fortaleza del rival y liga',
          distributionSpec: {
            kind: 'poisson',
            mean: +lambdaHome.toFixed(3),
            minLine: 0.5,
            maxLine: 4.5,
            step: 0.5,
            defaultLine: halfStepNear(lambdaHome, 0.5, 4.5),
          },
        },
    xgAwayRel === 'unavailable'
      ? {
          key: 'xg_away',
          label: `Goles / xG esperados (${match.awayTeam.shortName})`,
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'goles',
          reliability: 'unavailable',
          note: 'Sin métricas ofensivas/defensivas suficientes del equipo',
        }
      : {
          key: 'xg_away',
          label: `Goles / xG esperados (${match.awayTeam.shortName})`,
          pointEstimate: +lambdaAway.toFixed(2),
          intervalLow: Math.max(0, +(lambdaAway - 1.28 * Math.sqrt(lambdaAway)).toFixed(2)),
          intervalHigh: +(lambdaAway + 1.28 * Math.sqrt(lambdaAway)).toFixed(2),
          unit: 'goles',
          reliability: xgAwayRel,
          note: hasAwayMetrics ? 'Basado en tasas xG/goles reales' : 'Estimado desde fortaleza del rival y liga',
          distributionSpec: {
            kind: 'poisson',
            mean: +lambdaAway.toFixed(3),
            minLine: 0.5,
            maxLine: 4.5,
            step: 0.5,
            defaultLine: halfStepNear(lambdaAway, 0.5, 4.5),
          },
        },
    goalRel === 'unavailable'
      ? {
          key: 'goals_total',
          label: 'Goles totales esperados',
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'goles',
          reliability: 'unavailable',
          note: 'Sin datos reales de ambos equipos para calcular total de goles',
        }
      : {
          key: 'goals_total',
          label: 'Goles totales esperados',
          pointEstimate: +expectedGoalsTotal.toFixed(2),
          intervalLow: Math.max(0, +(expectedGoalsTotal - 1.28 * Math.sqrt(expectedGoalsTotal)).toFixed(2)),
          intervalHigh: +(expectedGoalsTotal + 1.28 * Math.sqrt(expectedGoalsTotal)).toFixed(2),
          unit: 'goles',
          reliability: goalRel,
          note: goalRel === 'verified' ? 'Suma Poisson bivariante con tasas reales' : 'Estimación parcial del modelo',
          distributionSpec: {
            kind: 'poisson',
            mean: +expectedGoalsTotal.toFixed(3),
            minLine: 0.5,
            maxLine: 6.5,
            step: 0.5,
            defaultLine: halfStepNear(expectedGoalsTotal, 0.5, 6.5),
          },
        },
    shotsHomeRel === 'unavailable'
      ? {
          key: 'shots_home',
          label: `Tiros totales (${match.homeTeam.shortName})`,
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'tiros',
          reliability: 'unavailable',
          note: 'Sin datos de tiros ni métricas base del equipo',
        }
      : {
          key: 'shots_home',
          label: `Tiros totales (${match.homeTeam.shortName})`,
          pointEstimate: +expectedShotsHome.toFixed(1),
          intervalLow: shotsHInt[0],
          intervalHigh: shotsHInt[1],
          unit: 'tiros',
          reliability: shotsHomeRel,
          note: hasRealShotsHome ? 'Promedio verificado del equipo' : 'Estimación del modelo desde xG ofensivo',
          distributionSpec: {
            kind: 'negbin',
            mean: +expectedShotsHome.toFixed(2),
            overdispersion: 0.08,
            minLine: 5.5,
            maxLine: 26.5,
            step: 1,
            defaultLine: halfStepNear(expectedShotsHome, 5.5, 26.5),
          },
        },
    shotsAwayRel === 'unavailable'
      ? {
          key: 'shots_away',
          label: `Tiros totales (${match.awayTeam.shortName})`,
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'tiros',
          reliability: 'unavailable',
          note: 'Sin datos de tiros ni métricas base del equipo',
        }
      : {
          key: 'shots_away',
          label: `Tiros totales (${match.awayTeam.shortName})`,
          pointEstimate: +expectedShotsAway.toFixed(1),
          intervalLow: shotsAInt[0],
          intervalHigh: shotsAInt[1],
          unit: 'tiros',
          reliability: shotsAwayRel,
          note: hasRealShotsAway ? 'Promedio verificado del equipo' : 'Estimación del modelo desde xG ofensivo',
          distributionSpec: {
            kind: 'negbin',
            mean: +expectedShotsAway.toFixed(2),
            overdispersion: 0.08,
            minLine: 4.5,
            maxLine: 24.5,
            step: 1,
            defaultLine: halfStepNear(expectedShotsAway, 4.5, 24.5),
          },
        },
    sotHomeRel === 'unavailable'
      ? {
          key: 'sot_home',
          label: `Tiros a puerta (${match.homeTeam.shortName})`,
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'a puerta',
          reliability: 'unavailable',
          note: 'Sin datos de tiros a puerta ni métricas base del equipo',
        }
      : {
          key: 'sot_home',
          label: `Tiros a puerta (${match.homeTeam.shortName})`,
          pointEstimate: +expectedShotsOnTargetHome.toFixed(1),
          intervalLow: sotHInt[0],
          intervalHigh: sotHInt[1],
          unit: 'a puerta',
          reliability: sotHomeRel,
          note: hasRealSotHome ? 'Promedio verificado del equipo' : 'Estimación del modelo desde xG ofensivo',
          distributionSpec: {
            kind: 'negbin',
            mean: +expectedShotsOnTargetHome.toFixed(2),
            overdispersion: 0.1,
            minLine: 1.5,
            maxLine: 11.5,
            step: 0.5,
            defaultLine: halfStepNear(expectedShotsOnTargetHome, 1.5, 11.5),
          },
        },
    sotAwayRel === 'unavailable'
      ? {
          key: 'sot_away',
          label: `Tiros a puerta (${match.awayTeam.shortName})`,
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'a puerta',
          reliability: 'unavailable',
          note: 'Sin datos de tiros a puerta ni métricas base del equipo',
        }
      : {
          key: 'sot_away',
          label: `Tiros a puerta (${match.awayTeam.shortName})`,
          pointEstimate: +expectedShotsOnTargetAway.toFixed(1),
          intervalLow: sotAInt[0],
          intervalHigh: sotAInt[1],
          unit: 'a puerta',
          reliability: sotAwayRel,
          note: hasRealSotAway ? 'Promedio verificado del equipo' : 'Estimación del modelo desde xG ofensivo',
          distributionSpec: {
            kind: 'negbin',
            mean: +expectedShotsOnTargetAway.toFixed(2),
            overdispersion: 0.1,
            minLine: 1.5,
            maxLine: 10.5,
            step: 0.5,
            defaultLine: halfStepNear(expectedShotsOnTargetAway, 1.5, 10.5),
          },
        },
    cornersRel === 'unavailable'
      ? {
          key: 'corners',
          label: 'Córners totales esperados',
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'córners',
          reliability: 'unavailable',
          note: 'No disponible: sin promedios históricos de córners ni métricas base suficientes',
        }
      : {
          key: 'corners',
          label: 'Córners totales esperados',
          pointEstimate: +cornersMean.toFixed(1),
          intervalLow: cornersInt[0],
          intervalHigh: cornersInt[1],
          unit: 'córners',
          reliability: cornersRel,
          note:
            cornersRel === 'verified'
              ? 'Basado en promedios reales de córners de ambos equipos'
              : 'Estimación del modelo derivada de xG y presión ofensiva',
          distributionSpec: {
            kind: 'negbin',
            mean: +cornersMean.toFixed(2),
            overdispersion: 0.06,
            minLine: 4.5,
            maxLine: 16.5,
            step: 0.5,
            defaultLine: halfStepNear(cornersMean, 4.5, 16.5),
          },
        },
    cardsRel === 'unavailable'
      ? {
          key: 'yellow_cards',
          label: 'Tarjetas amarillas esperadas',
          pointEstimate: null,
          intervalLow: null,
          intervalHigh: null,
          unit: 'tarjetas',
          reliability: 'unavailable',
          note: 'No disponible: sin promedios disciplinarios ni métricas base suficientes',
        }
      : {
          key: 'yellow_cards',
          label: 'Tarjetas amarillas esperadas',
          pointEstimate: +cardsTotalMean.toFixed(1),
          intervalLow: cardsInt[0],
          intervalHigh: cardsInt[1],
          unit: 'tarjetas',
          reliability: cardsRel,
          note:
            cardsRel === 'verified'
              ? 'Basado en promedios disciplinarios verificados de ambos equipos'
              : 'Estimación del modelo derivada de contexto de partido',
          distributionSpec: {
            kind: 'negbin',
            mean: +cardsTotalMean.toFixed(2),
            overdispersion: 0.08,
            minLine: 1.5,
            maxLine: 9.5,
            step: 0.5,
            defaultLine: halfStepNear(cardsTotalMean, 1.5, 9.5),
          },
        },
  ];

  return {
    lambdaHome,
    lambdaAway,
    expectedGoalsTotal,
    probHome,
    probDraw,
    probAway,
    rawProbHome,
    rawProbDraw,
    rawProbAway,
    over15,
    over25,
    over35,
    bttsYes,
    expectedCorners: cornersMean,
    expectedCardsHome,
    expectedCardsAway,
    expectedShotsHome,
    expectedShotsAway,
    expectedShotsOnTargetHome,
    expectedShotsOnTargetAway,
    expectedStats,
    exactScores: exactScores.slice(0, 6),
    absenceImpactSummary: [...homeAdj.notes, ...awayAdj.notes],
    dataConfidence,
    dataQuality,
    calibrationApplied,
    calibrationNote,
    modelWarnings,
  };
}

export const FOOTBALL_STAT_CONFIG: Record<
  FootballPropStat,
  { label: string; min: number; max: number; step: number; overdispersion: number; isNormal?: boolean }
> = {
  goals: { label: 'Goles', min: 0.5, max: 3.5, step: 0.5, overdispersion: 0.08 },
  assists: { label: 'Asistencias', min: 0.5, max: 2.5, step: 0.5, overdispersion: 0.1 },
  shots: { label: 'Tiros totales', min: 0.5, max: 7.5, step: 0.5, overdispersion: 0.22 },
  shotsOnTarget: { label: 'Tiros a puerta', min: 0.5, max: 4.5, step: 0.5, overdispersion: 0.18 },
  foulsCommitted: { label: 'Faltas cometidas', min: 0.5, max: 4.5, step: 0.5, overdispersion: 0.24 },
  foulsDrawn: { label: 'Faltas recibidas', min: 0.5, max: 5.5, step: 0.5, overdispersion: 0.25 },
  yellowCards: { label: 'Tarjetas amarillas', min: 0.5, max: 1.5, step: 0.5, overdispersion: 0.05 },
  redCards: { label: 'Tarjetas rojas', min: 0.5, max: 1.5, step: 0.5, overdispersion: 0.02 },
  passes: { label: 'Pases completados', min: 19.5, max: 99.5, step: 1, overdispersion: 0.12, isNormal: true },
  saves: { label: 'Paradas del portero', min: 0.5, max: 9.5, step: 0.5, overdispersion: 0.16 },
  goalsConceded: { label: 'Goles encajados', min: 0.5, max: 4.5, step: 0.5, overdispersion: 0.09 },
};

function evaluatePlayerLogFreshness(
  player: PlayerProfile,
  referenceIso: string
): { freshness: DataFreshnessStatus; warning?: string } {
  const latest = player.recentLogs[0]?.date ?? player.lastLogDate;
  if (!latest) {
    return {
      freshness: player.sampleSizeGames > 0 ? 'aging' : 'unknown',
      warning: player.sampleSizeGames === 0 ? 'Sin partidos individuales recientes registrados.' : undefined,
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
      warning: `Último partido registrado hace ${ageDays} días (${latest}); la proyección aumenta la incertidumbre por posible cambio de rol o inactividad.`,
    };
  }
  if (ageDays > 21) {
    return {
      freshness: 'aging',
      warning: `Último registro individual hace ${ageDays} días (${latest}).`,
    };
  }
  return { freshness: 'fresh' };
}

/**
 * Computes Football Player Prop Over/Under distribution combining Season, L5, L10,
 * Home/Away context, opponent defense/shots, expected minutes/starter role, freshness check,
 * goalkeeper-specific modeling, and zero-sum normalized teammate redistribution.
 */
export function computeFootballPlayerProp(
  player: PlayerProfile,
  match: MatchRecord,
  statKey: FootballPropStat,
  customLine?: number,
  timeframe: TimeframeSplit = 'season',
  teammatesOverride?: PlayerProfile[]
): PropProjectionResult {
  const cfg = FOOTBALL_STAT_CONFIG[statKey];
  const isHome = player.teamId === match.homeTeam.id;
  const isGk = isGoalkeeperPosition(player.position);
  const teamPlayers =
    teammatesOverride ?? (isHome ? match.homePlayers : match.awayPlayers);

  const statsQuality: DataReliability =
    player.statsQuality ??
    (player.sampleSizeGames >= 5 ? 'verified' : player.sampleSizeGames > 0 ? 'estimated' : 'unavailable');

  const seasonData = player.splits.season;
  const rawSeasonOpt = seasonData[statKey];

  const gkAttackStatMismatch =
    isGk && ['goals', 'assists', 'shots', 'shotsOnTarget'].includes(statKey);
  const unavailableStat =
    gkAttackStatMismatch ||
    statsQuality === 'unavailable' ||
    rawSeasonOpt === undefined ||
    !Number.isFinite(rawSeasonOpt);

  if (unavailableStat) {
    const line = customLine ?? cfg.min;
    return {
      statKey,
      statLabel: cfg.label,
      line,
      minLine: cfg.min,
      maxLine: cfg.max,
      step: cfg.step,
      expectedValue: 0,
      median: 0,
      stdDev: 0,
      intervalLow: 0,
      intervalHigh: 0,
      probOver: 0,
      probUnder: 0,
      expectedMinutes: 0,
      absenceAdjustmentPct: 0,
      sampleConfidence: 0,
      sampleSizeGames: player.sampleSizeGames,
      statsQuality: 'unavailable',
      statsOriginNote:
        player.statsOriginNote ??
        (gkAttackStatMismatch
          ? 'Métrica ofensiva de jugador de campo no aplicable a porteros'
          : 'Estadísticas individuales reales no disponibles en esta fuente'),
      dataFreshness: 'unknown',
      unavailable: true,
      unavailableReason: gkAttackStatMismatch
        ? `La estadística "${cfg.label}" no aplica a porteros; consulta Paradas o Goles encajados.`
        : `No hay registros individuales reales de "${cfg.label}" para ${player.name}.`,
      distribution: [],
    };
  }

  const last5Data = player.splits.last5 ?? seasonData;
  const last10Data = player.splits.last10 ?? seasonData;
  const venueData = isHome ? (player.splits.home ?? seasonData) : (player.splits.away ?? seasonData);
  const splitData = player.splits[timeframe] ?? seasonData;

  const rawSeasonVal = rawSeasonOpt;
  const rawLast5Val = last5Data[statKey] ?? rawSeasonVal;
  const rawLast10Val = last10Data[statKey] ?? rawSeasonVal;
  const rawVenueVal = venueData[statKey] ?? rawSeasonVal;
  const rawSplitVal = splitData[statKey] ?? rawSeasonVal;

  const hasMultiWindowSamples =
    (last5Data.games ?? 0) > 0 && (last10Data.games ?? 0) > 0 && (seasonData.games ?? 0) > 0;

  // When default 'season' is active and verified multi-window splits exist, blend Season + L10 + L5 + Home/Away cleanly
  const compositeMean = hasMultiWindowSamples
    ? rawSeasonVal * 0.30 + rawLast10Val * 0.25 + rawLast5Val * 0.30 + rawVenueVal * 0.15
    : rawSeasonVal;

  const baseMean =
    timeframe === 'season'
      ? compositeMean
      : rawSplitVal * 0.65 + compositeMean * 0.35;

  const { freshness: dataFreshness, warning: freshnessWarning } = evaluatePlayerLogFreshness(
    player,
    match.kickoffIso
  );

  const availFactor = getAvailabilityFactor(player.availability);
  const starterMinutes = Math.max(45, splitData.minutes || (isGk ? 90 : 82));
  const expectedMinutes =
    player.availability === 'out' || player.availability === 'suspended'
      ? 0
      : player.availability === 'bench'
        ? isGk
          ? 0
          : Math.min(34, starterMinutes * 0.38)
        : player.availability === 'doubtful'
          ? starterMinutes * 0.62
          : starterMinutes;
  const minutesRatio =
    player.splits.season.minutes > 0 ? expectedMinutes / player.splits.season.minutes : availFactor;

  // Normalized zero-sum redistribution among active teammates (outfield players only)
  let missingUsage = 0;
  let missingAssists = 0;
  let activeUsageWeight = Math.max(0.05, player.impact.usageShare * availFactor);
  let activeAssistWeight = Math.max(0.05, player.impact.assistShare * availFactor);

  for (const mate of teamPlayers) {
    if (mate.id === player.id) continue;
    const mateAvail = getAvailabilityFactor(mate.availability);
    if (mateAvail < 0.99 && mate.isKeyPlayer) {
      const loss = 1 - mateAvail;
      missingUsage += mate.impact.usageShare * loss;
      missingAssists += mate.impact.assistShare * loss;
    }
    if (mateAvail > 0) {
      activeUsageWeight += mate.impact.usageShare * mateAvail;
      activeAssistWeight += mate.impact.assistShare * mateAvail;
    }
  }

  let teammateBoost = 0;
  if (availFactor > 0 && !isGk) {
    if (statKey === 'shots' || statKey === 'shotsOnTarget' || statKey === 'goals') {
      const share = (player.impact.usageShare * availFactor) / Math.max(0.25, activeUsageWeight);
      teammateBoost = Math.min(0.26, missingUsage * share * 1.45);
    } else if (statKey === 'assists' || statKey === 'passes') {
      const share = (player.impact.assistShare * availFactor) / Math.max(0.25, activeAssistWeight);
      teammateBoost = Math.min(0.22, missingAssists * share * 1.35);
    }
  }

  const oppTeam = isHome ? match.awayTeam : match.homeTeam;
  const oppDef = isHome ? (match.awayTeam.defenseAway ?? 1.15) : (match.homeTeam.defenseHome ?? 1.05);
  const oppAtk = isHome
    ? (oppTeam.attackAway ?? oppTeam.ppgOrGpg ?? 1.28)
    : (oppTeam.attackHome ?? oppTeam.ppgOrGpg ?? 1.38);
  const oppSot = oppTeam.avgShotsOnTarget ?? oppAtk * 3.1 + 0.45;

  const oppMultiplier =
    statKey === 'saves'
      ? Math.max(0.75, Math.min(1.38, oppSot / 4.2))
      : statKey === 'goalsConceded'
        ? Math.max(0.72, Math.min(1.42, oppAtk / 1.32))
        : statKey === 'goals' || statKey === 'assists' || statKey === 'shots' || statKey === 'shotsOnTarget'
          ? Math.max(0.78, Math.min(1.26, oppDef / 1.12))
          : 1.0;

  const expectedValue = Math.max(
    0,
    baseMean * minutesRatio * oppMultiplier * (1 + teammateBoost)
  );

  const defaultLine =
    cfg.step === 1
      ? Math.max(cfg.min, Math.min(cfg.max, Math.round(expectedValue) - 0.5))
      : Math.max(
          cfg.min,
          Math.min(cfg.max, Math.max(0.5, Math.floor(expectedValue) + 0.5))
        );
  const line = customLine ?? defaultLine;

  const freshnessPenalty = dataFreshness === 'stale' ? 14 : dataFreshness === 'aging' ? 5 : 0;
  const sampleConfidence = Math.max(
    18,
    (player.sampleSizeGames <= 0 || statsQuality !== 'verified'
      ? Math.min(48, 32 + (match.lineupStatus === 'confirmed' ? 12 : 4))
      : Math.min(
          92,
          50 + Math.min(32, player.sampleSizeGames * 1.4) + (match.lineupStatus === 'confirmed' ? 8 : 0)
        )) - freshnessPenalty
  );

  const dispersionInflation =
    (statsQuality === 'verified' ? 1.0 : 1.28) * (dataFreshness === 'stale' ? 1.18 : 1.0);

  const multiSplitSummary = {
    seasonAvg: +rawSeasonVal.toFixed(2),
    last5Avg: +rawLast5Val.toFixed(2),
    last10Avg: +rawLast10Val.toFixed(2),
    homeAwayAvg: +rawVenueVal.toFixed(2),
    h2hAvg: player.splits.h2h?.games ? +(player.splits.h2h[statKey] ?? rawSeasonVal).toFixed(2) : undefined,
    weightsNote: hasMultiWindowSamples
      ? 'Modelo ponderado: 30% Temp + 30% L5 + 25% L10 + 15% Local/Visitante'
      : 'Sin logs completos multi-ventana; se aplica base disponible',
  };

  if (cfg.isNormal) {
    const stdDev = Math.max(5.0, expectedValue * 0.22 * dispersionInflation);
    const pUnderRaw = normalCdf(line, expectedValue, stdDev);
    const probUnder = Math.max(1.0, Math.min(99.0, Math.round(pUnderRaw * 1000) / 10));
    const probOver = Math.round((100 - probUnder) * 10) / 10;
    const bins: PropDistributionBin[] = [];
    const center = Math.round(expectedValue);
    const stepBin = 6;
    for (let i = -4; i <= 4; i++) {
      const val = Math.max(0, center + i * stepBin);
      const lo = val - stepBin / 2;
      const hi = val + stepBin / 2;
      const p = Math.max(0, normalCdf(hi, expectedValue, stdDev) - normalCdf(lo, expectedValue, stdDev));
      bins.push({
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
      absenceAdjustmentPct: teammateBoost * 100,
      sampleConfidence,
      sampleSizeGames: player.sampleSizeGames,
      statsQuality,
      statsOriginNote: player.statsOriginNote,
      dataFreshness,
      freshnessWarning,
      multiSplitSummary,
      distribution: bins,
    };
  }

  const effAlpha = cfg.overdispersion * dispersionInflation;
  const maxK = Math.max(Math.ceil(cfg.max) + 4, Math.ceil(expectedValue * 3) + 3);
  const distribution: PropDistributionBin[] = [];
  let rawSum = 0;
  const probs: number[] = [];
  for (let k = 0; k <= maxK; k++) {
    const p = negBinPmf(k, expectedValue, effAlpha);
    probs.push(p);
    rawSum += p;
  }

  let cumUnder = 0;
  let cum = 0;
  let median = 0;
  let q10 = 0;
  let q90 = maxK;
  let foundMed = false;
  let found10 = false;
  let found90 = false;

  for (let k = 0; k <= maxK; k++) {
    const p = probs[k] / Math.max(1e-9, rawSum);
    cum += p;
    if (!found10 && cum >= 0.1) {
      q10 = k;
      found10 = true;
    }
    if (!foundMed && cum >= 0.5) {
      median = k;
      foundMed = true;
    }
    if (!found90 && cum >= 0.9) {
      q90 = k;
      found90 = true;
    }
    if (k < line) {
      cumUnder += p;
    }
    if (k <= Math.ceil(cfg.max) + 2) {
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
    absenceAdjustmentPct: teammateBoost * 100,
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
 * Generates a specific, transparent pre-match explanation grounded strictly in each team's
 * verified numbers, recent form, absences, tactical matchup and data sample constraints.
 */
export function buildFootballMatchExplanation(
  match: MatchRecord,
  pred: FootballPredictionResult
): MatchNarrativeExplanation {
  const h = match.homeTeam;
  const a = match.awayTeam;
  const homePtsL5 = h.formRecent.reduce((acc, r) => acc + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
  const awayPtsL5 = a.formRecent.reduce((acc, r) => acc + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);

  const favLabel =
    pred.probHome >= pred.probAway + 0.05
      ? `Ventaja estadística de ${h.name} (${(pred.probHome * 100).toFixed(1)}% vs ${(pred.probAway * 100).toFixed(1)}%)`
      : pred.probAway >= pred.probHome + 0.05
        ? `Ligero favoritismo visitante para ${a.name} (${(pred.probAway * 100).toFixed(1)}% vs ${(pred.probHome * 100).toFixed(1)}%)`
        : `Duelo muy equilibrado entre ${h.shortName} (${(pred.probHome * 100).toFixed(1)}%) y ${a.shortName} (${(pred.probAway * 100).toFixed(1)}%)`;

  const homeShotsStat = pred.expectedStats.find((s) => s.key === 'shots_home');
  const awayShotsStat = pred.expectedStats.find((s) => s.key === 'shots_away');
  const cornersStat = pred.expectedStats.find((s) => s.key === 'corners');
  const cardsStat = pred.expectedStats.find((s) => s.key === 'yellow_cards');

  const homeFavoringFactors: string[] = [
    `Localía y producción esperada de ${pred.lambdaHome.toFixed(2)} xG${
      homeShotsStat?.pointEstimate != null ? ` (${homeShotsStat.pointEstimate.toFixed(1)} tiros totales est.)` : ''
    }.`,
  ];
  if (h.homeRecord) homeFavoringFactors.push(`Balance en casa registrado: ${h.homeRecord}.`);
  if (h.formRecent.length > 0) homeFavoringFactors.push(`Forma L${h.formRecent.length}: ${h.formRecent.join('-')} (${homePtsL5} de ${h.formRecent.length * 3} pts).`);
  if (h.ppgOrGpg !== undefined) homeFavoringFactors.push(`Promedio ofensivo reciente: ${h.ppgOrGpg.toFixed(2)} goles/partido.`);

  const awayFavoringFactors: string[] = [
    `Proyección ofensiva visitante de ${pred.lambdaAway.toFixed(2)} xG${
      awayShotsStat?.pointEstimate != null ? ` (${awayShotsStat.pointEstimate.toFixed(1)} tiros est.)` : ''
    }.`,
  ];
  if (a.awayRecord) awayFavoringFactors.push(`Rendimiento fuera de casa: ${a.awayRecord}.`);
  if (a.formRecent.length > 0) awayFavoringFactors.push(`Forma L${a.formRecent.length}: ${a.formRecent.join('-')} (${awayPtsL5} de ${a.formRecent.length * 3} pts).`);
  if (a.ppgOrGpg !== undefined) awayFavoringFactors.push(`Media anotadora: ${a.ppgOrGpg.toFixed(2)} goles/partido.`);

  const homeStrengthsWeaknesses = `${h.shortName}: ${h.ppgOrGpg !== undefined ? `${h.ppgOrGpg.toFixed(2)} GF` : 'GF N/D'} / ${h.oppgOrGapg !== undefined ? `${h.oppgOrGapg.toFixed(2)} GC` : 'GC N/D'} · Formación ${h.formation ?? 'N/D'}.`;
  const awayStrengthsWeaknesses = `${a.shortName}: ${a.ppgOrGpg !== undefined ? `${a.ppgOrGpg.toFixed(2)} GF` : 'GF N/D'} / ${a.oppgOrGapg !== undefined ? `${a.oppgOrGapg.toFixed(2)} GC` : 'GC N/D'} · Formación ${a.formation ?? 'N/D'}.`;

  const h2hAssessment =
    match.h2hSummary.played >= 4
      ? `H2H con muestra útil (${match.h2hSummary.played} duelos: ${match.h2hSummary.homeWins}V ${h.shortName}, ${match.h2hSummary.draws}E, ${match.h2hSummary.awayWins}V ${a.shortName}, media ${match.h2hSummary.avgTotalPointsOrGoals.toFixed(2)} goles).`
      : match.h2hSummary.played > 0
        ? `Muestra H2H reducida (${match.h2hSummary.played} duelo${match.h2hSummary.played === 1 ? '' : 's'}); el modelo limita su peso al ${Math.min(5, match.h2hSummary.played * 0.8).toFixed(1)}% para evitar conclusiones engañosas.`
        : 'Sin duelos H2H recientes suficientes; el modelo no aplica ajuste por historial directo.';

  const tacticalMatchups = [
    `Ritmo esperado del partido: ${pred.expectedGoalsTotal.toFixed(2)} goles totales (BTTS ${(pred.bttsYes * 100).toFixed(1)}% · Over 2.5 ${(pred.over25 * 100).toFixed(1)}%).`,
    cornersStat?.pointEstimate != null || cardsStat?.pointEstimate != null
      ? `Volumen territorial estimado: ${
          cornersStat?.pointEstimate != null ? `${cornersStat.pointEstimate.toFixed(1)} córners` : 'córners N/D'
        } y ${
          cardsStat?.pointEstimate != null ? `${cardsStat.pointEstimate.toFixed(1)} tarjetas amarillas` : 'tarjetas N/D'
        }.`
      : 'Sin datos históricos suficientes de córners o tarjetas para estimar volumen territorial.',
  ];

  const uncertaintiesAndLimits = [...pred.modelWarnings];
  if (match.lineupStatus !== 'confirmed') {
    uncertaintiesAndLimits.push(
      `Alineación actualmente en estado "${match.lineupStatus === 'provisional' ? 'probable' : 'por confirmar'}"; los porcentajes pueden variar al conocerse el once oficial.`
    );
  }
  if (match.provenance?.isStale) {
    uncertaintiesAndLimits.push(
      `Advertencia de frescura: datos con ${match.provenance.staleAgeMinutes} min de antigüedad (${match.provenance.errorMessage ?? 'revisar actualización'}).`
    );
  }

  return {
    headline: `${favLabel}. Total esperado: ${pred.expectedGoalsTotal.toFixed(2)} goles.`,
    homeFavoringFactors,
    awayFavoringFactors,
    homeStrengthsWeaknesses,
    awayStrengthsWeaknesses,
    keyAbsencesImpact:
      pred.absenceImpactSummary.length > 0
        ? pred.absenceImpactSummary
        : ['No hay bajas de jugadores clave registradas que alteren significativamente el xG proyectado.'],
    h2hAssessment,
    tacticalMatchups,
    uncertaintiesAndLimits:
      uncertaintiesAndLimits.length > 0
        ? uncertaintiesAndLimits
        : [`Cobertura estadística del ${pred.dataConfidence}% sobre métricas verificadas.`],
  };
}
