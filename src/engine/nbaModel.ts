import type {
  AvailabilityStatus,
  MatchRecord,
  NbaPredictionResult,
  NbaPropStat,
  PlayerProfile,
  PropDistributionBin,
  PropProjectionResult,
  TimeframeSplit,
} from '../types/sports.ts';

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
      defRatingDelta += defHit; // Positive DRtg delta means worse defense
      paceDelta -= p.isKeyPlayer ? 0.8 * lossRatio : 0;
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
    offRatingDelta,
    defRatingDelta,
    paceDelta,
    vacatedUsage: Math.min(0.42, vacatedUsage),
    vacatedAssistShare: Math.min(0.45, vacatedAssistShare),
    vacatedMinutes: Math.min(96, vacatedMinutes),
    notes,
  };
}

/**
 * Pace-Adjusted Efficiency Rating & Monte Carlo-calibrated Normal NBA Game Model.
 */
export function computeNbaMatchPrediction(
  match: MatchRecord,
  homePlayersOverride?: PlayerProfile[],
  awayPlayersOverride?: PlayerProfile[]
): NbaPredictionResult {
  const homePlayers = homePlayersOverride ?? match.homePlayers;
  const awayPlayers = awayPlayersOverride ?? match.awayPlayers;

  const homeImpact = calculateNbaAbsenceImpact(homePlayers, match.homeTeam.shortName);
  const awayImpact = calculateNbaAbsenceImpact(awayPlayers, match.awayTeam.shortName);

  const basePaceHome = match.homeTeam.pace ?? 99.5;
  const basePaceAway = match.awayTeam.pace ?? 99.2;
  const expectedPace = Math.max(
    91,
    Math.min(108, (basePaceHome + basePaceAway) / 2 + (homeImpact.paceDelta + awayImpact.paceDelta) * 0.5)
  );

  // League average baseline ~114.5 pts / 100 possessions
  const leagueAvgEff = 114.5;
  const homeOff = (match.homeTeam.offRating ?? 116.5) + homeImpact.offRatingDelta;
  const homeDef = (match.homeTeam.defRating ?? 112.8) + homeImpact.defRatingDelta;
  const awayOff = (match.awayTeam.offRating ?? 115.0) + awayImpact.offRatingDelta;
  const awayDef = (match.awayTeam.defRating ?? 113.5) + awayImpact.defRatingDelta;

  // Back-to-back fatigue adjustment
  const homeFatigue = match.homeTeam.isBackToBack ? -1.4 : match.homeTeam.restDays >= 2 ? 0.5 : 0;
  const awayFatigue = match.awayTeam.isBackToBack ? -1.7 : match.awayTeam.restDays >= 2 ? 0.4 : 0;
  const homeCourtBoost = match.homeTeam.homeCourtBoost ?? 2.6;

  // Recent form momentum
  const winRate = (form: ('W' | 'D' | 'L')[]) =>
    form.length ? form.filter((f) => f === 'W').length / form.length : 0.5;
  const formDelta = (winRate(match.homeTeam.formRecent) - winRate(match.awayTeam.formRecent)) * 1.6;

  const homeEffExpected = homeOff + awayDef - leagueAvgEff + homeCourtBoost / 2 + homeFatigue + formDelta * 0.5;
  const awayEffExpected = awayOff + homeDef - leagueAvgEff - homeCourtBoost / 2 + awayFatigue - formDelta * 0.5;

  const expectedHomePts = (homeEffExpected / 100) * expectedPace;
  const expectedAwayPts = (awayEffExpected / 100) * expectedPace;
  const expectedTotal = expectedHomePts + expectedAwayPts;
  const expectedSpreadHome = expectedHomePts - expectedAwayPts;

  // NBA game spread standard deviation ~ 11.8 pts; widens slightly when starters are doubtful
  const doubtfulPenalty =
    [...homePlayers, ...awayPlayers].filter((p) => p.availability === 'doubtful').length * 0.55;
  const spreadStdDev = 11.8 + doubtfulPenalty;
  const totalStdDev = 14.2 + doubtfulPenalty;

  const probHomeWin = 1 - normalCdf(0, expectedSpreadHome, spreadStdDev);
  const probAwayWin = 1 - probHomeWin;

  const lineupBonus = match.lineupStatus === 'confirmed' ? 12 : 4;
  const dataConfidence = Math.round(
    Math.max(55, Math.min(93, 72 + lineupBonus - doubtfulPenalty * 4))
  );

  return {
    expectedPace,
    expectedHomePts,
    expectedAwayPts,
    expectedTotal,
    expectedSpreadHome,
    probHomeWin,
    probAwayWin,
    spreadStdDev,
    totalStdDev,
    absenceImpactSummary: [...homeImpact.notes, ...awayImpact.notes],
    dataConfidence,
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

/**
 * Computes NBA Player Prop Over/Under distribution accounting for:
 * - Selected split (Season, L5, L10, L15, Home, Away, H2H)
 * - Minutes & rotation projection
 * - Pace & Opponent Defense matchup
 * - Usage / Minutes / Assist redistribution when a teammate (e.g., Stephen Curry) is OUT!
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

  const splitVals = player.splits[timeframe] ?? player.splits.season;
  const seasonVals = player.splits.season;

  const extractStat = (v: typeof seasonVals): number => {
    if (statKey === 'pra') {
      return (v.points ?? 0) + (v.rebounds ?? 0) + (v.assists ?? 0);
    }
    return v[statKey] ?? 0;
  };

  const splitStat = extractStat(splitVals);
  const seasonStat = extractStat(seasonVals);
  const basePerGame = timeframe === 'season' ? seasonStat : splitStat * 0.62 + seasonStat * 0.38;

  // Calculate vacated usage/minutes/assists from teammates who are OUT, DOUBTFUL, PROBABLE, or minutes-restricted
  let vacatedUsage = 0;
  let vacatedAssists = 0;
  let vacatedMinutes = 0;
  for (const mate of teamPlayers) {
    if (mate.id === player.id) continue;
    const mateBaseMin = mate.splits.season.minutes || 30;
    const avail = getNbaAvailabilityFactor(mate.availability, mate.minutesRestriction, mateBaseMin);
    if (avail < 0.99 && (mate.isKeyPlayer || avail === 0 || mate.minutesRestriction)) {
      const loss = 1 - avail;
      vacatedUsage += mate.impact.usageShare * loss;
      vacatedAssists += mate.impact.assistShare * loss;
      vacatedMinutes += mateBaseMin * loss;
    }
  }

  // Distribute vacated minutes & usage proportionally to active players, respecting minutes restrictions
  const baseMinutes = Math.max(10, seasonVals.minutes || 26);
  let expectedMinutes = 0;
  if (player.availability === 'out' || player.availability === 'suspended') {
    expectedMinutes = 0;
  } else if (player.availability === 'doubtful') {
    expectedMinutes = baseMinutes * 0.52;
  } else if (player.minutesRestriction) {
    expectedMinutes = player.minutesRestriction.maxMinutes
      ? Math.min(baseMinutes, player.minutesRestriction.maxMinutes)
      : baseMinutes * 0.78;
  } else {
    const isStarterRole =
      player.availability === 'confirmed_starter' ||
      player.availability === 'possible_starter' ||
      player.availability === 'starter';
    const isBenchRole = player.availability === 'bench' || player.availability === 'available';
    const boostCap = isBenchRole
      ? Math.min(8.5, vacatedMinutes * 0.28)
      : Math.min(4.2, vacatedMinutes * 0.14);
    const probableDiscount = player.availability === 'probable' ? 0.92 : 1;
    const roleBaseline = isStarterRole ? Math.max(baseMinutes, 24) : baseMinutes;
    expectedMinutes = Math.min(41.5, roleBaseline * probableDiscount + boostCap);
  }

  const minutesRatio = expectedMinutes / baseMinutes;

  // Usage boost when star teammates sit
  let absenceBoostRatio = 0;
  if (expectedMinutes > 0) {
    if (statKey === 'points' || statKey === 'threes') {
      absenceBoostRatio = vacatedUsage * (player.isKeyPlayer ? 0.52 : 0.42);
    } else if (statKey === 'assists') {
      absenceBoostRatio = vacatedAssists * 0.48;
    } else if (statKey === 'rebounds') {
      absenceBoostRatio = vacatedUsage * 0.14;
    } else if (statKey === 'pra') {
      absenceBoostRatio = vacatedUsage * 0.38 + vacatedAssists * 0.18;
    } else if (statKey === 'turnovers') {
      absenceBoostRatio = vacatedUsage * 0.3;
    }
  }

  // Pace & opponent defensive rating multiplier
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

  if (cfg.discreteAlpha !== undefined) {
    // Discrete Negative Binomial distribution for 3PM, Steals, Blocks, Turnovers
    const maxK = Math.max(Math.ceil(cfg.max) + 3, Math.ceil(expectedValue * 3) + 3);
    const probs: number[] = [];
    let rawSum = 0;
    for (let k = 0; k <= maxK; k++) {
      const p = negBinPmf(k, expectedValue, cfg.discreteAlpha);
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
    const probUnder = Math.max(0.1, Math.min(99.9, Math.round(cumUnder * 1000) / 10));
    const probOver = Math.round((100 - probUnder) * 10) / 10;
    const stdDev = Math.sqrt(expectedValue + cfg.discreteAlpha * expectedValue * expectedValue);

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
      sampleConfidence: Math.min(93, 60 + player.sampleSizeGames * 0.7),
      distribution,
    };
  }

  // Continuous-approximated Normal distribution for Points, Rebounds, Assists, PRA
  const coeffVar =
    statKey === 'points'
      ? 0.27
      : statKey === 'rebounds'
      ? 0.34
      : statKey === 'assists'
      ? 0.36
      : 0.24; // PRA
  const doubtfulUncertainty = player.availability === 'doubtful' ? 1.25 : 1.0;
  const stdDev = Math.max(1.4, expectedValue * coeffVar * doubtfulUncertainty);

  const probUnderRaw = normalCdf(line, expectedValue, stdDev);
  const probUnder = Math.max(0.1, Math.min(99.9, Math.round(probUnderRaw * 1000) / 10));
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
    sampleConfidence: Math.min(94, 62 + player.sampleSizeGames * 0.65),
    distribution,
  };
}
