import type {
  BookmakerOdd,
  FootballPropStat,
  HistoryEvaluationMetrics,
  LoggedPrediction,
  MatchRecord,
  NbaPropStat,
  OddsDiscrepancyItem,
  PlayerProfile,
} from '../types/sports.ts';
import { computeFootballMatchPrediction, computeFootballPlayerProp } from './footballModel.ts';
import { computeNbaMatchPrediction, computeNbaPlayerProp } from './nbaModel.ts';

function approxNormalCdf(x: number, mean: number, stdDev: number): number {
  const z = (x - mean) / (Math.max(0.5, stdDev) * Math.SQRT2);
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

/**
 * Removes bookmaker overround (vig) from 2-way or 3-way odds using proportional normalization.
 */
export function deVigTwoWay(oddsA: number, oddsB: number): {
  fairProbA: number;
  fairProbB: number;
  marginPct: number;
} {
  const impA = 1 / Math.max(1.01, oddsA);
  const impB = 1 / Math.max(1.01, oddsB);
  const sum = impA + impB;
  return {
    fairProbA: impA / sum,
    fairProbB: impB / sum,
    marginPct: (sum - 1) * 100,
  };
}

export function deVigThreeWay(odds1: number, oddsX: number, odds2: number): {
  fairProb1: number;
  fairProbX: number;
  fairProb2: number;
  marginPct: number;
} {
  const i1 = 1 / Math.max(1.01, odds1);
  const ix = 1 / Math.max(1.01, oddsX);
  const i2 = 1 / Math.max(1.01, odds2);
  const sum = i1 + ix + i2;
  return {
    fairProb1: i1 / sum,
    fairProbX: ix / sum,
    fairProb2: i2 / sum,
    marginPct: (sum - 1) * 100,
  };
}

/**
 * Evaluates all available odds in a match against SportAnalytics AI mathematical models
 * to detect statistical pricing discrepancies (after de-vigging bookmaker margin).
 */
export function evaluateMatchOddsDiscrepancies(
  match: MatchRecord,
  homePlayersOverride?: PlayerProfile[],
  awayPlayersOverride?: PlayerProfile[]
): OddsDiscrepancyItem[] {
  if (!match.odds || match.odds.length === 0) return [];
  const items: OddsDiscrepancyItem[] = [];
  const matchLabel = `${match.homeTeam.shortName} vs ${match.awayTeam.shortName}`;

  const footballPred =
    match.sport === 'football'
      ? computeFootballMatchPrediction(match, homePlayersOverride, awayPlayersOverride)
      : null;
  const nbaPred =
    match.sport === 'nba'
      ? computeNbaMatchPrediction(match, homePlayersOverride, awayPlayersOverride)
      : null;

  const allPlayers = [
    ...(homePlayersOverride ?? match.homePlayers),
    ...(awayPlayersOverride ?? match.awayPlayers),
  ];

  for (const odd of match.odds) {
    let modelProbability = 0.5;
    let dataQualityScore = 75;
    let uncertaintyBandPct = 5.5;
    let mainReason = 'Diferencia estadística entre proyección del modelo y línea implícita.';

    if (odd.marketCategory === 'match') {
      if (match.sport === 'football' && footballPred) {
        modelProbability =
          odd.side === 'home'
            ? footballPred.probHome
            : odd.side === 'draw'
            ? footballPred.probDraw
            : footballPred.probAway;
        dataQualityScore = footballPred.dataConfidence;
        uncertaintyBandPct = match.lineupStatus === 'confirmed' ? 4.2 : 6.8;
        mainReason =
          footballPred.absenceImpactSummary.length > 0
            ? footballPred.absenceImpactSummary[0]
            : 'Ajuste Dixon-Coles por rendimiento reciente local/visitante y xG esperado.';
      } else if (match.sport === 'nba' && nbaPred) {
        modelProbability = odd.side === 'home' ? nbaPred.probHomeWin : nbaPred.probAwayWin;
        dataQualityScore = nbaPred.dataConfidence;
        uncertaintyBandPct = 4.9;
        mainReason =
          nbaPred.absenceImpactSummary.length > 0
            ? nbaPred.absenceImpactSummary[0]
            : 'Ajuste por eficiencia neta, ritmo esperado y factor descanso.';
      }
    } else if (odd.marketCategory === 'totals' && match.sport === 'football' && footballPred) {
      const overProb =
        odd.line === 1.5 ? footballPred.over15 : odd.line === 3.5 ? footballPred.over35 : footballPred.over25;
      modelProbability = odd.side === 'over' ? overProb : 1 - overProb;
      dataQualityScore = footballPred.dataConfidence;
      uncertaintyBandPct = 5.1;
      mainReason = `Total xG combinado ${(footballPred.lambdaHome + footballPred.lambdaAway).toFixed(2)} frente a línea ${odd.line}.`;
    } else if (odd.marketCategory === 'totals' && match.sport === 'nba' && nbaPred) {
      const lineVal = odd.line ?? nbaPred.expectedTotal;
      const probUnder = approxNormalCdf(lineVal, nbaPred.expectedTotal, nbaPred.totalStdDev);
      modelProbability = odd.side === 'over' ? 1 - probUnder : probUnder;
      dataQualityScore = nbaPred.dataConfidence;
      uncertaintyBandPct = 5.4;
      mainReason = `Total esperado NBA ${nbaPred.expectedTotal.toFixed(1)} pts (ritmo ${nbaPred.expectedPace.toFixed(1)}) frente a línea ${lineVal}.`;
    } else if (odd.marketCategory === 'btts' && match.sport === 'football' && footballPred) {
      modelProbability = odd.side === 'yes' ? footballPred.bttsYes : 1 - footballPred.bttsYes;
      dataQualityScore = footballPred.dataConfidence;
      uncertaintyBandPct = 5.4;
      mainReason = `Tasas ofensivas (${footballPred.lambdaHome.toFixed(2)} vs ${footballPred.lambdaAway.toFixed(2)} xG) y correlación de Poisson.`;
    } else if (odd.marketCategory === 'player_prop' && odd.playerId && odd.statKey) {
      const player = allPlayers.find((p) => p.id === odd.playerId);
      if (!player) continue;
      const isHome = player.teamId === match.homeTeam.id;
      const mates = isHome ? homePlayersOverride ?? match.homePlayers : awayPlayersOverride ?? match.awayPlayers;

      const proj =
        match.sport === 'football'
          ? computeFootballPlayerProp(player, match, odd.statKey as FootballPropStat, odd.line, 'season', mates)
          : computeNbaPlayerProp(player, match, odd.statKey as NbaPropStat, odd.line, 'season', mates);

      modelProbability = odd.side === 'under' ? proj.probUnder / 100 : proj.probOver / 100;
      dataQualityScore = Math.round(proj.sampleConfidence);
      uncertaintyBandPct = Math.round((proj.stdDev / Math.max(1, proj.expectedValue)) * 18 * 10) / 10;
      mainReason =
        proj.absenceAdjustmentPct > 1
          ? `Redistribución de uso (+${proj.absenceAdjustmentPct.toFixed(1)}%) por bajas en el equipo; media esperada ${proj.expectedValue.toFixed(1)}.`
          : `Proyección ${proj.expectedValue.toFixed(1)} ${proj.statLabel.toLowerCase()} en ${proj.expectedMinutes.toFixed(0)} min esperados frente a línea ${odd.line}.`;
    }

    const rawImpliedProbability = 1 / Math.max(1.01, odd.decimalOdds);
    let fairImpliedProbability = rawImpliedProbability;
    let bookmakerMarginPct = 0;

    if (odd.threeWayOdds) {
      const dv = deVigThreeWay(odd.threeWayOdds[0], odd.threeWayOdds[1], odd.threeWayOdds[2]);
      fairImpliedProbability =
        odd.side === 'home' ? dv.fairProb1 : odd.side === 'draw' ? dv.fairProbX : dv.fairProb2;
      bookmakerMarginPct = dv.marginPct;
    } else if (odd.complementOdds) {
      const dv = deVigTwoWay(odd.decimalOdds, odd.complementOdds);
      fairImpliedProbability = dv.fairProbA;
      bookmakerMarginPct = dv.marginPct;
    }

    const clampedModelProb = Math.max(0.02, Math.min(0.98, modelProbability));
    const edgePct = (clampedModelProb - fairImpliedProbability) * 100;
    const expectedValuePct = (clampedModelProb * odd.decimalOdds - 1) * 100;
    const modelFairOdds = 1 / clampedModelProb;

    items.push({
      id: `${match.id}_${odd.id}`,
      sport: match.sport,
      matchId: match.id,
      matchLabel,
      competition: match.competition,
      kickoffIso: match.kickoffIso,
      playerId: odd.playerId,
      playerName: odd.playerName,
      marketLabel: odd.marketLabel,
      marketCategory: odd.marketCategory,
      selectionLabel: odd.selectionLabel,
      line: odd.line,
      availableOdds: odd.decimalOdds,
      bookmaker: odd.bookmaker,
      updatedAt: odd.updatedAt,
      modelProbability: clampedModelProb,
      rawImpliedProbability,
      fairImpliedProbability,
      bookmakerMarginPct: Math.max(0, bookmakerMarginPct),
      modelFairOdds,
      edgePct,
      expectedValuePct,
      dataQualityScore,
      uncertaintyBandPct,
      mainReason,
      isOfflineReference: match.isOfflineReference,
    });
  }

  return items.sort((a, b) => b.edgePct - a.edgePct);
}

/**
 * Evaluates historical predictions using Brier Score, Log Loss, MAE, RMSE, and Calibration bins.
 */
export function evaluatePredictionHistory(predictions: LoggedPrediction[]): HistoryEvaluationMetrics {
  const resolved = predictions.filter((p) => p.status === 'won' || p.status === 'lost');
  if (resolved.length === 0) {
    return {
      totalLogged: predictions.length,
      resolvedCount: 0,
      hitRatePct: 0,
      brierScore: 0,
      logLoss: 0,
      mae: 0,
      rmse: 0,
      calibrationBins: [],
    };
  }

  let wins = 0;
  let brierSum = 0;
  let logLossSum = 0;
  let absErrSum = 0;
  let sqErrSum = 0;

  const binDefs = [
    { label: '0–25%', min: 0, max: 0.25 },
    { label: '25–45%', min: 0.25, max: 0.45 },
    { label: '45–60%', min: 0.45, max: 0.6 },
    { label: '60–75%', min: 0.6, max: 0.75 },
    { label: '75–100%', min: 0.75, max: 1.01 },
  ];
  const binAcc = binDefs.map((b) => ({ ...b, predSum: 0, obsSum: 0, count: 0 }));

  for (const p of resolved) {
    const y = p.status === 'won' ? 1 : 0;
    const prob = Math.max(0.001, Math.min(0.999, p.predictedProb));
    if (y === 1) wins += 1;
    brierSum += Math.pow(prob - y, 2);
    logLossSum += -(y * Math.log(prob) + (1 - y) * Math.log(1 - prob));

    // Error on probability or numeric predictedValue if resolved with actualValue
    if (p.predictedValue !== undefined && p.actualValue !== undefined) {
      const err = Math.abs(p.predictedValue - p.actualValue);
      absErrSum += err;
      sqErrSum += err * err;
    } else {
      const err = Math.abs(prob - y);
      absErrSum += err;
      sqErrSum += err * err;
    }

    const bin = binAcc.find((b) => prob >= b.min && prob < b.max);
    if (bin) {
      bin.predSum += prob;
      bin.obsSum += y;
      bin.count += 1;
    }
  }

  const n = resolved.length;
  return {
    totalLogged: predictions.length,
    resolvedCount: n,
    hitRatePct: (wins / n) * 100,
    brierScore: brierSum / n,
    logLoss: logLossSum / n,
    mae: absErrSum / n,
    rmse: Math.sqrt(sqErrSum / n),
    calibrationBins: binAcc
      .filter((b) => b.count > 0)
      .map((b) => ({
        bucketLabel: b.label,
        avgPredictedPct: (b.predSum / b.count) * 100,
        observedHitPct: (b.obsSum / b.count) * 100,
        count: b.count,
      })),
  };
}
