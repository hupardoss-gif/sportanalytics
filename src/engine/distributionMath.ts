import type { StatExpectationWithInterval } from '../types/sports.ts';

function factorial(n: number): number {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  if (k > 150) {
    // Stirling log approximation for large k
    const logP = -lambda + k * Math.log(lambda) - (k * Math.log(k) - k + 0.5 * Math.log(2 * Math.PI * k));
    return Math.exp(logP);
  }
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

/** Negative Binomial PMF parameterized by mean mu and overdispersion alpha (Var = mu + alpha * mu^2) */
export function negBinPmf(k: number, mu: number, alpha: number): number {
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

export function normalCdf(x: number, mean: number, stdDev: number): number {
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

export interface MatchStatOverUnderEvaluation {
  available: boolean;
  line: number;
  minLine: number;
  maxLine: number;
  step: number;
  probOver: number;
  probUnder: number;
}

/**
 * Evaluates Over / Under probabilities for any team or match expected stat
 * directly from the underlying parametric model distribution (Poisson, NegBin, or Normal).
 */
export function evaluateMatchStatOverUnder(
  stat: StatExpectationWithInterval,
  customLine?: number
): MatchStatOverUnderEvaluation {
  const spec = stat.distributionSpec;
  if (
    !spec ||
    stat.reliability === 'unavailable' ||
    stat.pointEstimate === null ||
    !Number.isFinite(spec.mean)
  ) {
    return {
      available: false,
      line: 0,
      minLine: 0,
      maxLine: 0,
      step: 0.5,
      probOver: 0,
      probUnder: 0,
    };
  }

  const rawLine = customLine !== undefined && Number.isFinite(customLine) ? customLine : spec.defaultLine;
  const line = Math.max(spec.minLine, Math.min(spec.maxLine, rawLine));

  if (spec.kind === 'normal') {
    const sd = Math.max(0.5, spec.stdDev ?? 5.0);
    const pUnderRaw = normalCdf(line, spec.mean, sd);
    const probUnder = Math.max(0.5, Math.min(99.5, Math.round(pUnderRaw * 1000) / 10));
    const probOver = Math.round((100 - probUnder) * 10) / 10;
    return {
      available: true,
      line,
      minLine: spec.minLine,
      maxLine: spec.maxLine,
      step: spec.step,
      probOver,
      probUnder,
    };
  }

  const maxK = Math.max(
    Math.ceil(spec.maxLine) + 12,
    Math.ceil(spec.mean + 6 * Math.sqrt(Math.max(1, spec.mean)) + 6)
  );
  let totalMass = 0;
  const probs: number[] = [];
  for (let k = 0; k <= maxK; k++) {
    const p =
      spec.kind === 'poisson'
        ? poissonPmf(k, Math.max(0.01, spec.mean))
        : negBinPmf(k, Math.max(0.01, spec.mean), spec.overdispersion ?? 0.12);
    probs.push(p);
    totalMass += p;
  }

  let cumUnder = 0;
  for (let k = 0; k <= maxK; k++) {
    if (k < line) {
      cumUnder += probs[k] / Math.max(1e-9, totalMass);
    }
  }

  const probUnder = Math.max(0.5, Math.min(99.5, Math.round(cumUnder * 1000) / 10));
  const probOver = Math.round((100 - probUnder) * 10) / 10;

  return {
    available: true,
    line,
    minLine: spec.minLine,
    maxLine: spec.maxLine,
    step: spec.step,
    probOver,
    probUnder,
  };
}
