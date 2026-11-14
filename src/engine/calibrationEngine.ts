import type {
  EmpiricalCalibrationProfile,
  HistoryEvaluationMetrics,
  LoggedPrediction,
  SportType,
} from '../types/sports.ts';

function clampProb(p: number): number {
  return Math.max(0.005, Math.min(0.995, p));
}

function logit(p: number): number {
  const c = clampProb(p);
  return Math.log(c / (1 - c));
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function computeEcePct(pairs: Array<{ prob: number; y: number }>): number {
  if (pairs.length === 0) return 0;
  const bins = [
    { min: 0, max: 0.25 },
    { min: 0.25, max: 0.45 },
    { min: 0.45, max: 0.6 },
    { min: 0.6, max: 0.75 },
    { min: 0.75, max: 1.01 },
  ];
  let ece = 0;
  const n = pairs.length;
  for (const b of bins) {
    const bucket = pairs.filter((item) => item.prob >= b.min && item.prob < b.max);
    if (bucket.length === 0) continue;
    const avgP = bucket.reduce((acc, i) => acc + i.prob, 0) / bucket.length;
    const avgY = bucket.reduce((acc, i) => acc + i.y, 0) / bucket.length;
    ece += (bucket.length / n) * Math.abs(avgP - avgY);
  }
  return ece * 100;
}

/**
 * Fits an empirical Platt / Temperature calibration profile on real resolved predictions
 * (excluding reference/illustrative items). Requires at least 6 real resolved samples.
 */
export function fitEmpiricalCalibrationProfile(
  predictions: LoggedPrediction[],
  sport: SportType
): EmpiricalCalibrationProfile {
  const resolved = predictions.filter(
    (p) =>
      p.sport === sport &&
      (p.status === 'won' || p.status === 'lost') &&
      !p.isReferenceExample
  );

  if (resolved.length === 0) {
    return {
      sport,
      sampleCount: 0,
      active: false,
      temperature: 1,
      bias: 0,
      rawBrier: 0,
      calibratedBrier: 0,
      eceBeforePct: 0,
      eceAfterPct: 0,
      summary: 'Sin predicciones reales resueltas aún; el modelo opera sin ajuste empírico.',
    };
  }

  const samples = resolved.map((p) => ({
    rawProb: clampProb(p.rawPredictedProb ?? p.predictedProb),
    y: p.status === 'won' ? 1 : 0,
  }));

  const evalMetrics = (tau: number, bias: number) => {
    let brier = 0;
    let logLoss = 0;
    const pairs: Array<{ prob: number; y: number }> = [];
    for (const s of samples) {
      const cal = clampProb(sigmoid(tau * logit(s.rawProb) + bias));
      brier += (cal - s.y) * (cal - s.y);
      logLoss += -(s.y * Math.log(cal) + (1 - s.y) * Math.log(1 - cal));
      pairs.push({ prob: cal, y: s.y });
    }
    const n = samples.length;
    return {
      brier: brier / n,
      logLoss: logLoss / n,
      ecePct: computeEcePct(pairs),
    };
  };

  const baseline = evalMetrics(1, 0);

  if (samples.length < 6) {
    return {
      sport,
      sampleCount: samples.length,
      active: false,
      temperature: 1,
      bias: 0,
      rawBrier: baseline.brier,
      calibratedBrier: baseline.brier,
      eceBeforePct: baseline.ecePct,
      eceAfterPct: baseline.ecePct,
      summary: `Muestra insuficiente (${samples.length}/6 predicciones resueltas mínimas para activar calibración empírica).`,
    };
  }

  let bestTau = 1;
  let bestBias = 0;
  let bestObj = baseline.logLoss;
  let bestStats = baseline;

  // Bounded regularized search prevents overfitting on moderate sample sizes
  for (let tau = 0.68; tau <= 1.1201; tau += 0.02) {
    const tRounded = Math.round(tau * 100) / 100;
    for (let bias = -0.35; bias <= 0.3501; bias += 0.05) {
      const bRounded = Math.round(bias * 100) / 100;
      const stats = evalMetrics(tRounded, bRounded);
      const regPenalty = 0.015 * Math.pow(tRounded - 1, 2) + 0.02 * Math.pow(bRounded, 2);
      const obj = stats.logLoss + regPenalty;
      if (obj < bestObj - 0.002) {
        bestObj = obj;
        bestTau = tRounded;
        bestBias = bRounded;
        bestStats = stats;
      }
    }
  }

  const improved =
    bestStats.brier <= baseline.brier + 0.002 &&
    (Math.abs(bestTau - 1) >= 0.02 || Math.abs(bestBias) >= 0.05);

  if (!improved) {
    return {
      sport,
      sampleCount: samples.length,
      active: true,
      temperature: 1,
      bias: 0,
      rawBrier: baseline.brier,
      calibratedBrier: baseline.brier,
      eceBeforePct: baseline.ecePct,
      eceAfterPct: baseline.ecePct,
      summary: `Muestra de ${samples.length} pronósticos ya bien calibrada (τ=1.00, ECE ${baseline.ecePct.toFixed(1)}%).`,
    };
  }

  return {
    sport,
    sampleCount: samples.length,
    active: true,
    temperature: bestTau,
    bias: bestBias,
    rawBrier: baseline.brier,
    calibratedBrier: bestStats.brier,
    eceBeforePct: baseline.ecePct,
    eceAfterPct: bestStats.ecePct,
    summary: `Calibración activa (${samples.length} muestras): τ=${bestTau.toFixed(2)}, sesgo ${bestBias >= 0 ? '+' : ''}${bestBias.toFixed(2)} (Brier ${baseline.brier.toFixed(3)} → ${bestStats.brier.toFixed(3)}).`,
  };
}

export function applyBinaryCalibration(
  rawProb: number,
  profile: EmpiricalCalibrationProfile | undefined
): number {
  const clamped = clampProb(rawProb);
  if (!profile || !profile.active || (profile.temperature === 1 && profile.bias === 0)) {
    return clamped;
  }
  return clampProb(sigmoid(profile.temperature * logit(clamped) + profile.bias));
}

export function applyThreeWayCalibration(
  pHome: number,
  pDraw: number,
  pAway: number,
  profile: EmpiricalCalibrationProfile | undefined
): [number, number, number] {
  const s = Math.max(1e-9, pHome + pDraw + pAway);
  const n1 = Math.max(0.005, pHome / s);
  const nx = Math.max(0.005, pDraw / s);
  const n2 = Math.max(0.005, pAway / s);

  if (!profile || !profile.active || profile.temperature === 1) {
    const sum = n1 + nx + n2;
    return [n1 / sum, nx / sum, n2 / sum];
  }

  // Temperature scaling on simplex preserves ranking and softens extreme logits when tau < 1
  const t = Math.max(0.65, Math.min(1.15, profile.temperature));
  const w1 = Math.pow(n1, t);
  const wx = Math.pow(nx, t);
  const w2 = Math.pow(n2, t);
  const wSum = Math.max(1e-9, w1 + wx + w2);
  return [w1 / wSum, wx / wSum, w2 / wSum];
}

/**
 * Evaluates historical predictions using Brier Score, Log Loss, ECE, MAE, RMSE,
 * and per-sport empirical calibration profiles.
 */
export function evaluatePredictionHistory(predictions: LoggedPrediction[]): HistoryEvaluationMetrics {
  const resolved = predictions.filter((p) => p.status === 'won' || p.status === 'lost');
  const footballProfile = fitEmpiricalCalibrationProfile(predictions, 'football');
  const nbaProfile = fitEmpiricalCalibrationProfile(predictions, 'nba');

  if (resolved.length === 0) {
    return {
      totalLogged: predictions.length,
      resolvedCount: 0,
      hitRatePct: 0,
      brierScore: 0,
      logLoss: 0,
      mae: 0,
      rmse: 0,
      ecePct: 0,
      calibrationBins: [],
      calibrationProfiles: {
        football: footballProfile,
        nba: nbaProfile,
      },
    };
  }

  let wins = 0;
  let brierSum = 0;
  let logLossSum = 0;
  let absErrSum = 0;
  let sqErrSum = 0;
  const pairs: Array<{ prob: number; y: number }> = [];

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
    const prob = Math.max(0.005, Math.min(0.995, p.predictedProb));
    if (y === 1) wins += 1;
    brierSum += Math.pow(prob - y, 2);
    logLossSum += -(y * Math.log(prob) + (1 - y) * Math.log(1 - prob));
    pairs.push({ prob, y });

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
    ecePct: computeEcePct(pairs),
    calibrationBins: binAcc
      .filter((b) => b.count > 0)
      .map((b) => ({
        bucketLabel: b.label,
        avgPredictedPct: (b.predSum / b.count) * 100,
        observedHitPct: (b.obsSum / b.count) * 100,
        count: b.count,
      })),
    calibrationProfiles: {
      football: footballProfile,
      nba: nbaProfile,
    },
  };
}
