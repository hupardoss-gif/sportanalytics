import type {
  AvailabilityStatus,
  FootballPredictionResult,
  FootballPropStat,
  MatchRecord,
  PlayerProfile,
  PropDistributionBin,
  PropProjectionResult,
  TimeframeSplit,
} from '../types/sports.ts';

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
  // Compute in log space via gamma approximation (Lanczos) for numerical stability
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
  // Abramowitz & Stegun erf approximation
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
      defenseShift += p.impact.defenseDelta * lossRatio; // Losing defensive anchor increases opponent xG
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
 * Dixon-Coles adjusted bivariate Poisson model for Football matches.
 */
export function computeFootballMatchPrediction(
  match: MatchRecord,
  homePlayersOverride?: PlayerProfile[],
  awayPlayersOverride?: PlayerProfile[]
): FootballPredictionResult {
  const homePlayers = homePlayersOverride ?? match.homePlayers;
  const awayPlayers = awayPlayersOverride ?? match.awayPlayers;

  const baseHomeAttack = match.homeTeam.attackHome ?? 1.55;
  const baseHomeDefense = match.homeTeam.defenseHome ?? 0.98;
  const baseAwayAttack = match.awayTeam.attackAway ?? 1.25;
  const baseAwayDefense = match.awayTeam.defenseAway ?? 1.15;

  const homeAdj = calculateTeamAbsenceAdjustments(homePlayers, match.homeTeam.shortName);
  const awayAdj = calculateTeamAbsenceAdjustments(awayPlayers, match.awayTeam.shortName);

  // Recent form momentum modifier (L5 points / 15)
  const formScore = (form: ('W' | 'D' | 'L')[]) => {
    if (!form.length) return 0.5;
    const pts = form.reduce((acc, r) => acc + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
    return pts / (form.length * 3);
  };
  const homeFormBoost = 1 + (formScore(match.homeTeam.formRecent) - 0.5) * 0.14;
  const awayFormBoost = 1 + (formScore(match.awayTeam.formRecent) - 0.5) * 0.14;

  // H2H subtle shrinkage (10% weight)
  const h2hPlayed = Math.max(1, match.h2hSummary.played);
  const h2hHomeEdge = (match.h2hSummary.homeWins - match.h2hSummary.awayWins) / h2hPlayed;

  // League average baseline ~1.35 goals per team
  const leagueAvg = 1.35;
  let lambdaHome =
    ((baseHomeAttack * baseAwayDefense) / leagueAvg) * homeFormBoost * (1 + h2hHomeEdge * 0.05) +
    homeAdj.offenseShift +
    awayAdj.defenseShift;
  let lambdaAway =
    ((baseAwayAttack * baseHomeDefense) / leagueAvg) * awayFormBoost * (1 - h2hHomeEdge * 0.04) +
    awayAdj.offenseShift +
    homeAdj.defenseShift;

  lambdaHome = Math.max(0.35, Math.min(4.2, lambdaHome));
  lambdaAway = Math.max(0.28, Math.min(3.8, lambdaAway));

  // Dixon-Coles rho correlation parameter for low-scoring draws/0-0/1-1
  const rho = -0.075;
  const maxGoals = 7;
  let probHome = 0;
  let probDraw = 0;
  let probAway = 0;
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
      if (h === 0 && a === 0) tau = 1 - lambdaHome * lambdaAway * rho;
      else if (h === 0 && a === 1) tau = 1 + lambdaHome * rho;
      else if (h === 1 && a === 0) tau = 1 + lambdaAway * rho;
      else if (h === 1 && a === 1) tau = 1 - rho;

      const p = Math.max(0, tau * poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway));
      matrix[h][a] = p;
      totalMass += p;
    }
  }

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = matrix[h][a] / totalMass;
      if (h > a) probHome += p;
      else if (h === a) probDraw += p;
      else probAway += p;

      const sum = h + a;
      if (sum > 1.5) over15 += p;
      if (sum > 2.5) over25 += p;
      if (sum > 3.5) over35 += p;
      if (h >= 1 && a >= 1) bttsYes += p;
      exactScores.push({ home: h, away: a, probability: p });
    }
  }

  exactScores.sort((a, b) => b.probability - a.probability);

  const expectedCorners =
    (match.homeTeam.avgCorners ?? 5.4) +
    (match.awayTeam.avgCorners ?? 4.6) +
    (lambdaHome + lambdaAway - 2.6) * 0.65;

  const expectedCardsHome = (match.homeTeam.avgYellowCards ?? 1.9) + (lambdaAway > 1.5 ? 0.25 : 0);
  const expectedCardsAway = (match.awayTeam.avgYellowCards ?? 2.2) + (lambdaHome > 1.5 ? 0.3 : 0);

  const lineupBonus = match.lineupStatus === 'confirmed' ? 14 : 4;
  const h2hBonus = Math.min(10, match.h2hSummary.played * 1.5);
  const dataConfidence = Math.round(Math.min(94, 64 + lineupBonus + h2hBonus));

  return {
    lambdaHome,
    lambdaAway,
    probHome,
    probDraw,
    probAway,
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
 * expected minutes, and missing teammates' usage/assist redistribution.
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

  // Weighted blend: 55% selected split + 45% season baseline (unless split IS season)
  const splitData = player.splits[timeframe] ?? player.splits.season;
  const seasonData = player.splits.season;
  const rawSplitVal = splitData[statKey] ?? seasonData[statKey] ?? 0;
  const rawSeasonVal = seasonData[statKey] ?? 0;
  const baseMean = timeframe === 'season' ? rawSeasonVal : rawSplitVal * 0.62 + rawSeasonVal * 0.38;

  // Expected minutes based on availability
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
  const minutesRatio = player.splits.season.minutes > 0 ? expectedMinutes / player.splits.season.minutes : availFactor;

  // Check missing teammates usage/assist redistribution
  let teammateBoost = 0;
  for (const mate of teamPlayers) {
    if (mate.id === player.id) continue;
    const mateAvail = getAvailabilityFactor(mate.availability);
    if (mateAvail < 0.99 && mate.isKeyPlayer) {
      const loss = 1 - mateAvail;
      if (statKey === 'shots' || statKey === 'shotsOnTarget' || statKey === 'goals') {
        teammateBoost += mate.impact.usageShare * loss * 0.38;
      } else if (statKey === 'assists' || statKey === 'passes') {
        teammateBoost += mate.impact.assistShare * loss * 0.32;
      }
    }
  }

  // Opponent difficulty multiplier
  const oppDef = isHome ? (match.awayTeam.defenseAway ?? 1.1) : (match.homeTeam.defenseHome ?? 1.0);
  const oppMultiplier =
    statKey === 'goals' || statKey === 'assists' || statKey === 'shots' || statKey === 'shotsOnTarget'
      ? Math.max(0.75, Math.min(1.32, oppDef / 1.1))
      : 1.0;

  const expectedValue = Math.max(
    0,
    baseMean * minutesRatio * oppMultiplier * (1 + teammateBoost)
  );

  // Default line close to expected value at .5 increment
  const defaultLine =
    cfg.step === 1
      ? Math.max(cfg.min, Math.min(cfg.max, Math.round(expectedValue) - 0.5))
      : Math.max(
          cfg.min,
          Math.min(cfg.max, Math.max(0.5, Math.floor(expectedValue) + 0.5))
        );
  const line = customLine ?? defaultLine;

  if (cfg.isNormal) {
    const stdDev = Math.max(4.5, expectedValue * 0.21);
    const pUnderRaw = normalCdf(line, expectedValue, stdDev);
    const probUnder = Math.round(pUnderRaw * 1000) / 10;
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
      sampleConfidence: Math.min(92, 55 + player.sampleSizeGames * 1.4),
      distribution: bins,
    };
  }

  // Discrete Negative Binomial PMF
  const maxK = Math.max(Math.ceil(cfg.max) + 4, Math.ceil(expectedValue * 3) + 3);
  const distribution: PropDistributionBin[] = [];
  let rawSum = 0;
  const probs: number[] = [];
  for (let k = 0; k <= maxK; k++) {
    const p = negBinPmf(k, expectedValue, cfg.overdispersion);
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

  const probUnder = Math.max(0.1, Math.min(99.9, Math.round(cumUnder * 1000) / 10));
  const probOver = Math.round((100 - probUnder) * 10) / 10;
  const stdDev = Math.sqrt(expectedValue + cfg.overdispersion * expectedValue * expectedValue);

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
    sampleConfidence: Math.min(
      93,
      54 + player.sampleSizeGames * 1.3 + (match.lineupStatus === 'confirmed' ? 8 : 0)
    ),
    distribution,
  };
}
