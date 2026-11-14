import type {
  AvailabilityStatus,
  DataReliability,
  FootballPredictionResult,
  FootballPropStat,
  LoggedPrediction,
  MatchRecord,
  PlayerProfile,
  PropDistributionBin,
  PropProjectionResult,
  TimeframeSplit,
} from '../types/sports.ts';
import {
  applyThreeWayCalibration,
  fitEmpiricalCalibrationProfile,
} from './calibrationEngine.ts';

function factorial(n: number): number {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

/** Negative Binomial PMF parameterized by mean mu and overdispersion alpha (Var = mu + alpha * mu^2) */
function negBinPmf(k: number, mu: number, alpha: number): number {
  if (mu <= 0) return k === 0 ? 1 : 0;
  if (alpha <= 0.001) return poissonPmf(k, mu);
  const r = 1 / alpha;
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
    if (profile.active && profile.temperature !== 1) {
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

  return {
    lambdaHome,
    lambdaAway,
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
    expectedCorners: Math.max(5.5, expectedCorners),
    expectedCardsHome,
    expectedCardsAway,
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
};

/**
 * Computes Football Player Prop Over/Under distribution adjusted for split, opponent defense,
 * expected minutes, and missing teammates' normalized usage/assist redistribution.
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
  const teamPlayers =
    teammatesOverride ?? (isHome ? match.homePlayers : match.awayPlayers);

  const statsQuality: DataReliability =
    player.statsQuality ?? (player.sampleSizeGames >= 5 ? 'verified' : player.sampleSizeGames > 0 ? 'estimated' : 'estimated');

  const splitData = player.splits[timeframe] ?? player.splits.season;
  const seasonData = player.splits.season;
  const rawSplitVal = splitData[statKey] ?? seasonData[statKey] ?? 0;
  const rawSeasonVal = seasonData[statKey] ?? 0;
  const baseMean = timeframe === 'season' ? rawSeasonVal : rawSplitVal * 0.62 + rawSeasonVal * 0.38;

  const availFactor = getAvailabilityFactor(player.availability);
  const starterMinutes = Math.max(45, splitData.minutes || 82);
  const expectedMinutes =
    player.availability === 'out' || player.availability === 'suspended'
      ? 0
      : player.availability === 'bench'
        ? Math.min(34, starterMinutes * 0.38)
        : player.availability === 'doubtful'
          ? starterMinutes * 0.62
          : starterMinutes;
  const minutesRatio =
    player.splits.season.minutes > 0 ? expectedMinutes / player.splits.season.minutes : availFactor;

  // Normalized zero-sum redistribution among active teammates
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
  if (availFactor > 0) {
    if (statKey === 'shots' || statKey === 'shotsOnTarget' || statKey === 'goals') {
      const share = (player.impact.usageShare * availFactor) / Math.max(0.25, activeUsageWeight);
      teammateBoost = Math.min(0.26, missingUsage * share * 1.45);
    } else if (statKey === 'assists' || statKey === 'passes') {
      const share = (player.impact.assistShare * availFactor) / Math.max(0.25, activeAssistWeight);
      teammateBoost = Math.min(0.22, missingAssists * share * 1.35);
    }
  }

  const oppDef = isHome ? (match.awayTeam.defenseAway ?? 1.15) : (match.homeTeam.defenseHome ?? 1.05);
  const oppMultiplier =
    statKey === 'goals' || statKey === 'assists' || statKey === 'shots' || statKey === 'shotsOnTarget'
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

  const sampleConfidence =
    player.sampleSizeGames <= 0 || statsQuality !== 'verified'
      ? Math.min(48, 32 + (match.lineupStatus === 'confirmed' ? 12 : 4))
      : Math.min(
          92,
          50 + Math.min(32, player.sampleSizeGames * 1.4) + (match.lineupStatus === 'confirmed' ? 8 : 0)
        );

  const dispersionInflation = statsQuality === 'verified' ? 1.0 : 1.28;

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
    distribution,
  };
}
