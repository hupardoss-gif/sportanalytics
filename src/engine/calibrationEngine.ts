import type {
  EmpiricalCalibrationProfile,
  HistoryEvaluationMetrics,
  LoggedPrediction,
  SportType,
} from '../types/sports.ts';

export const MIN_CALIBRATION_SAMPLES = 15;
export const MIN_CALIBRATION_CLASS_COUNT = 3;

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

interface BinarySample {
  rawProb: number;
  y: number;
}

function evaluateSampleSet(samples: BinarySample[], tau: number, bias: number) {
  let brier = 0;
  let logLoss = 0;
  const pairs: Array<{ prob: number; y: number }> = [];
  for (const s of samples) {
    const cal = clampProb(sigmoid(tau * logit(s.rawProb) + bias));
    brier += (cal - s.y) * (cal - s.y);
    logLoss += -(s.y * Math.log(cal) + (1 - s.y) * Math.log(1 - cal));
    pairs.push({ prob: cal, y: s.y });
  }
  const n = Math.max(1, samples.length);
  return {
    brier: brier / n,
    logLoss: logLoss / n,
    ecePct: computeEcePct(pairs),
  };
}

function fitBestParamsOnSamples(trainSamples: BinarySample[]): { tau: number; bias: number } {
  const n = trainSamples.length;
  if (n === 0) return { tau: 1, bias: 0 };

  const baseline = evaluateSampleSet(trainSamples, 1, 0);
  // Adaptive L2 penalty shrinks toward identity (tau=1, bias=0) on moderate sample sizes
  const regScale = 24 / Math.max(12, n);
  const tauPenaltyWeight = 0.045 * regScale;
  const biasPenaltyWeight = 0.055 * regScale;

  let bestTau = 1;
  let bestBias = 0;
  let bestObj = baseline.logLoss;

  for (let tau = 0.72; tau <= 1.1001; tau += 0.02) {
    const tRounded = Math.round(tau * 100) / 100;
    for (let bias = -0.35; bias <= 0.3501; bias += 0.05) {
      const bRounded = Math.round(bias * 100) / 100;
      const stats = evaluateSampleSet(trainSamples, tRounded, bRounded);
      const regPenalty =
        tauPenaltyWeight * Math.pow(tRounded - 1, 2) + biasPenaltyWeight * Math.pow(bRounded, 2);
      const obj = stats.logLoss + regPenalty;
      if (obj < bestObj - 0.001) {
        bestObj = obj;
        bestTau = tRounded;
        bestBias = bRounded;
      }
    }
  }

  return { tau: bestTau, bias: bestBias };
}

function runOutOfSampleValidation(samples: BinarySample[]): {
  cvBrier: number;
  cvLogLoss: number;
} {
  const n = samples.length;
  const useLoocv = n <= 60;
  const numFolds = useLoocv ? n : 5;

  let brierSum = 0;
  let logLossSum = 0;

  for (let fold = 0; fold < numFolds; fold++) {
    const train: BinarySample[] = [];
    const test: BinarySample[] = [];
    for (let i = 0; i < n; i++) {
      const belongsToTest = useLoocv ? i === fold : i % numFolds === fold;
      if (belongsToTest) test.push(samples[i]);
      else train.push(samples[i]);
    }
    if (test.length === 0) continue;

    const { tau, bias } = fitBestParamsOnSamples(train);
    for (const item of test) {
      const cal = clampProb(sigmoid(tau * logit(item.rawProb) + bias));
      brierSum += (cal - item.y) * (cal - item.y);
      logLossSum += -(item.y * Math.log(cal) + (1 - item.y) * Math.log(1 - cal));
    }
  }

  return {
    cvBrier: brierSum / Math.max(1, n),
    cvLogLoss: logLossSum / Math.max(1, n),
  };
}

/**
 * Fits an empirical Platt / Temperature calibration profile on real resolved predictions
 * (excluding reference/illustrative items). Requires at least 15 real resolved samples,
 * at least 3 outcomes per class, and out-of-sample cross-validation improvement before activating.
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
      minSamplesRequired: MIN_CALIBRATION_SAMPLES,
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

  const samples: BinarySample[] = resolved.map((p) => ({
    rawProb: clampProb(p.rawPredictedProb ?? p.predictedProb),
    y: p.status === 'won' ? 1 : 0,
  }));

  const baseline = evaluateSampleSet(samples, 1, 0);
  const wins = samples.filter((s) => s.y === 1).length;
  const losses = samples.length - wins;

  if (samples.length < MIN_CALIBRATION_SAMPLES) {
    return {
      sport,
      sampleCount: samples.length,
      minSamplesRequired: MIN_CALIBRATION_SAMPLES,
      active: false,
      temperature: 1,
      bias: 0,
      rawBrier: baseline.brier,
      calibratedBrier: baseline.brier,
      baselineLogLoss: baseline.logLoss,
      eceBeforePct: baseline.ecePct,
      eceAfterPct: baseline.ecePct,
      summary: `Muestra insuficiente (${samples.length}/${MIN_CALIBRATION_SAMPLES} predicciones reales resueltas mínimas para calibración fiable).`,
    };
  }

  if (wins < MIN_CALIBRATION_CLASS_COUNT || losses < MIN_CALIBRATION_CLASS_COUNT) {
    return {
      sport,
      sampleCount: samples.length,
      minSamplesRequired: MIN_CALIBRATION_SAMPLES,
      active: false,
      temperature: 1,
      bias: 0,
      rawBrier: baseline.brier,
      calibratedBrier: baseline.brier,
      baselineLogLoss: baseline.logLoss,
      eceBeforePct: baseline.ecePct,
      eceAfterPct: baseline.ecePct,
      summary: `Distribución unilateral (${wins} aciertos / ${losses} fallos): se requieren al menos ${MIN_CALIBRATION_CLASS_COUNT} casos de cada resultado para calibrar sin sesgo.`,
    };
  }

  const cv = runOutOfSampleValidation(samples);
  const { tau: bestTau, bias: bestBias } = fitBestParamsOnSamples(samples);
  const fullStats = evaluateSampleSet(samples, bestTau, bestBias);

  const nonTrivialChange = Math.abs(bestTau - 1) >= 0.02 || Math.abs(bestBias) >= 0.05;
  const validatedOutOfSample =
    cv.cvLogLoss < baseline.logLoss - 0.004 &&
    cv.cvBrier <= baseline.brier - 0.001 &&
    fullStats.brier <= baseline.brier;

  if (!nonTrivialChange || !validatedOutOfSample) {
    return {
      sport,
      sampleCount: samples.length,
      minSamplesRequired: MIN_CALIBRATION_SAMPLES,
      active: false,
      temperature: 1,
      bias: 0,
      rawBrier: baseline.brier,
      calibratedBrier: baseline.brier,
      cvBrier: cv.cvBrier,
      cvLogLoss: cv.cvLogLoss,
      baselineLogLoss: baseline.logLoss,
      eceBeforePct: baseline.ecePct,
      eceAfterPct: baseline.ecePct,
      summary: !nonTrivialChange
        ? `Muestra de ${samples.length} pronósticos bien calibrada (ECE ${baseline.ecePct.toFixed(1)}%); se mantiene el modelo base.`
        : `Validación cruzada (${samples.length} muestras) no confirma mejora fuera de muestra (CV LogLoss ${cv.cvLogLoss.toFixed(3)} vs base ${baseline.logLoss.toFixed(3)}); ajuste descartado para evitar sobreajuste.`,
    };
  }

  return {
    sport,
    sampleCount: samples.length,
    minSamplesRequired: MIN_CALIBRATION_SAMPLES,
    active: true,
    temperature: bestTau,
    bias: bestBias,
    rawBrier: baseline.brier,
    calibratedBrier: fullStats.brier,
    cvBrier: cv.cvBrier,
    cvLogLoss: cv.cvLogLoss,
    baselineLogLoss: baseline.logLoss,
    eceBeforePct: baseline.ecePct,
    eceAfterPct: fullStats.ecePct,
    summary: `Calibración validada (${samples.length} muestras): τ=${bestTau.toFixed(2)}, sesgo ${bestBias >= 0 ? '+' : ''}${bestBias.toFixed(2)} (CV Brier ${baseline.brier.toFixed(3)} → ${cv.cvBrier.toFixed(3)}, ECE ${baseline.ecePct.toFixed(1)}% → ${fullStats.ecePct.toFixed(1)}%).`,
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

/**
 * Applies both temperature (τ) and directional confidence bias on the 3-way football simplex:
 *   z_i = τ * ln(p_i) + 1.5 * bias * (p_i - 1/3)
 * For τ >= 0.72 and bias in [-0.35, 0.35], d(z_i)/dp_i = τ/p_i + 1.5*bias >= 0.195 > 0,
 * strictly preserving outcome ranking, tie symmetry, and valid normalized probabilities summing to 1.
 */
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

  if (!profile || !profile.active || (profile.temperature === 1 && profile.bias === 0)) {
    const sum = n1 + nx + n2;
    return [n1 / sum, nx / sum, n2 / sum];
  }

  const t = Math.max(0.72, Math.min(1.15, profile.temperature));
  const b = Math.max(-0.35, Math.min(0.35, profile.bias));
  const uniformThird = 1 / 3;

  const z1 = t * Math.log(n1) + 1.5 * b * (n1 - uniformThird);
  const zx = t * Math.log(nx) + 1.5 * b * (nx - uniformThird);
  const z2 = t * Math.log(n2) + 1.5 * b * (n2 - uniformThird);

  const maxZ = Math.max(z1, zx, z2);
  const w1 = Math.exp(z1 - maxZ);
  const wx = Math.exp(zx - maxZ);
  const w2 = Math.exp(z2 - maxZ);
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
