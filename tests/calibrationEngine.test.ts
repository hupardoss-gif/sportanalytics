import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBinaryCalibration,
  applyThreeWayCalibration,
  evaluatePredictionHistory,
  fitEmpiricalCalibrationProfile,
  MIN_CALIBRATION_SAMPLES,
} from '../src/engine/calibrationEngine.ts';
import { computeFootballMatchPrediction } from '../src/engine/footballModel.ts';
import { SANDBOX_MATCHES, INITIAL_PREDICTION_HISTORY } from '../src/data/sandboxData.ts';
import type { EmpiricalCalibrationProfile, LoggedPrediction } from '../src/types/sports.ts';

function makeFootballHistory(
  entries: Array<{ prob: number; won: boolean; isRef?: boolean }>
): LoggedPrediction[] {
  return entries.map((e, i) => ({
    id: `test-fb-${i}`,
    createdAt: new Date(Date.now() - (entries.length - i) * 3600_000).toISOString(),
    sport: 'football',
    matchId: `m-fb-${i}`,
    matchLabel: `Equipo A vs Equipo B (${i})`,
    market: 'Resultado Final (1X2)',
    selection: 'Local',
    predictedProb: e.prob,
    rawPredictedProb: e.prob,
    status: e.won ? 'won' : 'lost',
    isReferenceExample: e.isRef ?? false,
  }));
}

test('applyThreeWayCalibration applies bias even when temperature === 1 and normalizes cleanly', () => {
  const base: [number, number, number] = [0.60, 0.25, 0.15];

  const identityProfile: EmpiricalCalibrationProfile = {
    sport: 'football',
    sampleCount: 24,
    active: true,
    temperature: 1,
    bias: 0,
    rawBrier: 0.2,
    calibratedBrier: 0.2,
    eceBeforePct: 5,
    eceAfterPct: 5,
    summary: 'identity',
  };
  const negBiasProfile: EmpiricalCalibrationProfile = {
    ...identityProfile,
    bias: -0.30,
  };
  const posBiasProfile: EmpiricalCalibrationProfile = {
    ...identityProfile,
    bias: 0.30,
  };

  const [idH, idX, idA] = applyThreeWayCalibration(...base, identityProfile);
  const [negH, negX, negA] = applyThreeWayCalibration(...base, negBiasProfile);
  const [posH, posX, posA] = applyThreeWayCalibration(...base, posBiasProfile);

  // Normalization & bounds
  for (const triple of [
    [idH, idX, idA],
    [negH, negX, negA],
    [posH, posX, posA],
  ]) {
    const sum = triple[0] + triple[1] + triple[2];
    assert.ok(Math.abs(sum - 1) < 1e-9, `Expected sum 1, got ${sum}`);
    for (const p of triple) {
      assert.ok(p > 0 && p < 1, `Probability out of (0,1): ${p}`);
    }
    // Strict ranking preserved
    assert.ok(triple[0] > triple[1] && triple[1] > triple[2], 'Ranking must be preserved');
  }

  // Negative bias reduces overconfident favorite and shifts probability to draw/away
  assert.ok(negH < idH - 0.02, `Expected negBias to reduce probHome (${negH} < ${idH})`);
  assert.ok(negX > idX && negA > idA, 'Expected negBias to lift draw and underdog');

  // Positive bias boosts favorite and compresses draw/away
  assert.ok(posH > idH + 0.02, `Expected posBias to increase probHome (${posH} > ${idH})`);
  assert.ok(posX < idX && posA < idA, 'Expected posBias to reduce draw and underdog');

  // Exact symmetry on tied home/away probabilities
  const [symH, symX, symA] = applyThreeWayCalibration(0.40, 0.20, 0.40, negBiasProfile);
  assert.ok(Math.abs(symH - symA) < 1e-12, 'Tied 1/2 probabilities must stay symmetric');
  assert.ok(Math.abs(symH + symX + symA - 1) < 1e-9);
});

test('applyThreeWayCalibration combines both temperature and bias in football match predictions', () => {
  const fbMatch = SANDBOX_MATCHES[0];

  // Construct 24 football samples where raw predictions (~0.75) only hit 50% (12/24),
  // requiring negative bias and/or temperature < 1 to calibrate properly
  const miscalibratedHistory = makeFootballHistory(
    Array.from({ length: 24 }, (_, i) => ({
      prob: 0.76,
      won: i % 2 === 0,
    }))
  );

  const profile = fitEmpiricalCalibrationProfile(miscalibratedHistory, 'football');
  assert.equal(profile.active, true, 'Validated miscalibration on 24 samples should activate');
  assert.ok(
    profile.bias < 0 || profile.temperature < 1,
    `Expected negative bias or tau < 1, got tau=${profile.temperature}, bias=${profile.bias}`
  );

  const uncalibrated = computeFootballMatchPrediction(fbMatch, undefined, undefined, []);
  const calibrated = computeFootballMatchPrediction(
    fbMatch,
    undefined,
    undefined,
    miscalibratedHistory
  );

  assert.equal(calibrated.calibrationApplied, true);
  assert.ok(
    Math.abs(calibrated.probHome - uncalibrated.probHome) > 0.005,
    'Calibrated football probabilities must differ from raw probabilities when active'
  );
  assert.ok(
    Math.abs(calibrated.probHome + calibrated.probDraw + calibrated.probAway - 1) < 1e-9
  );
});

test('calibration stays inactive with 6 samples or fewer than MIN_CALIBRATION_SAMPLES', () => {
  // 6 real samples + reference examples must NOT activate calibration
  const sixRealPlusRefs = [
    ...INITIAL_PREDICTION_HISTORY,
    ...makeFootballHistory([
      { prob: 0.8, won: false },
      { prob: 0.8, won: false },
      { prob: 0.8, won: false },
      { prob: 0.8, won: true },
      { prob: 0.8, won: true },
      { prob: 0.8, won: false },
    ]),
  ];

  const profileAtSix = fitEmpiricalCalibrationProfile(sixRealPlusRefs, 'football');
  assert.equal(profileAtSix.sampleCount, 6);
  assert.equal(profileAtSix.active, false);
  assert.equal(profileAtSix.temperature, 1);
  assert.equal(profileAtSix.bias, 0);

  // Even 14 samples (< MIN_CALIBRATION_SAMPLES = 15) must remain inactive
  const fourteenSamples = makeFootballHistory(
    Array.from({ length: MIN_CALIBRATION_SAMPLES - 1 }, (_, i) => ({
      prob: 0.8,
      won: i < 5,
    }))
  );
  const profileAtFourteen = fitEmpiricalCalibrationProfile(fourteenSamples, 'football');
  assert.equal(profileAtFourteen.sampleCount, MIN_CALIBRATION_SAMPLES - 1);
  assert.equal(profileAtFourteen.active, false);
});

test('calibration rejects noisy or already-calibrated data via cross-validation (no overfitting)', () => {
  // 16 samples where predicted prob (0.625) matches observed rate (10/16 = 0.625) closely
  const wellCalibratedNoise = makeFootballHistory(
    Array.from({ length: 16 }, (_, i) => ({
      prob: i % 2 === 0 ? 0.65 : 0.60,
      won: i < 10,
    }))
  );

  const profile = fitEmpiricalCalibrationProfile(wellCalibratedNoise, 'football');
  assert.equal(profile.sampleCount, 16);
  assert.equal(profile.active, false, 'Well-calibrated / noisy 16-sample set must not overfit');
  assert.equal(profile.temperature, 1);
  assert.equal(profile.bias, 0);
});

test('calibration rejects one-sided class distribution even when sampleCount >= 15', () => {
  const oneSided = makeFootballHistory(
    Array.from({ length: 16 }, (_, i) => ({
      prob: 0.72,
      won: i < 14, // only 2 losses (< 3)
    }))
  );

  const profile = fitEmpiricalCalibrationProfile(oneSided, 'football');
  assert.equal(profile.sampleCount, 16);
  assert.equal(profile.active, false);
});

test('validated miscalibration passes LOOCV and improves binary + evaluation metrics', () => {
  const nbaSamples: LoggedPrediction[] = Array.from({ length: 24 }, (_, i) => ({
    id: `nba-${i}`,
    createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
    sport: 'nba',
    matchId: `m-nba-${i}`,
    matchLabel: `Team H vs Team A`,
    market: 'Moneyline',
    selection: 'Team H',
    predictedProb: 0.82,
    rawPredictedProb: 0.82,
    status: i % 2 === 0 ? 'won' : 'lost', // true hit rate 50% vs 82% predicted
    isReferenceExample: false,
  }));

  const metrics = evaluatePredictionHistory(nbaSamples);
  const nbaProfile = metrics.calibrationProfiles.nba;
  assert.equal(nbaProfile.active, true);
  assert.ok(nbaProfile.cvLogLoss !== undefined && nbaProfile.baselineLogLoss !== undefined);
  assert.ok(nbaProfile.cvLogLoss < nbaProfile.baselineLogLoss);
  assert.ok(nbaProfile.cvBrier !== undefined && nbaProfile.cvBrier < nbaProfile.rawBrier);
  assert.ok(nbaProfile.calibratedBrier < nbaProfile.rawBrier);

  const adjustedProb = applyBinaryCalibration(0.82, nbaProfile);
  assert.ok(adjustedProb < 0.72 && adjustedProb > 0.45, `Expected moderated prob, got ${adjustedProb}`);
});
