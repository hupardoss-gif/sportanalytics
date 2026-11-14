import test from 'node:test';
import assert from 'node:assert/strict';
import {
  americanToDecimal,
  analyzeMarketOutcomes,
  compareProbabilities,
  detectSourceDiscrepancies,
  impliedProbabilityPct,
  modelProbabilitiesForMarket,
  parseAmericanOdds,
} from '../src/engine/oddsMath.ts';
import type { OddsOutcome, OddsSourceSnapshot } from '../src/types/sports.ts';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('probabilidad implícita = 1 / cuota × 100', () => {
  close(impliedProbabilityPct(2)!, 50);
  close(impliedProbabilityPct(4)!, 25);
  close(impliedProbabilityPct(1.25)!, 80);
  assert.equal(impliedProbabilityPct(1), null);
  assert.equal(impliedProbabilityPct(0.5), null);
  assert.equal(impliedProbabilityPct(null), null);
  assert.equal(impliedProbabilityPct(Number.NaN), null);
});

test('conversión de cuotas americanas a decimales', () => {
  close(americanToDecimal(150)!, 2.5);
  close(americanToDecimal(-110)!, 1 + 100 / 110);
  close(americanToDecimal(-200)!, 1.5);
  assert.equal(americanToDecimal(0), null);
  close(parseAmericanOdds('+150')!, 2.5);
  close(parseAmericanOdds('-110')!, 1 + 100 / 110);
  close(parseAmericanOdds('EVEN')!, 2);
  assert.equal(parseAmericanOdds('OFF'), null);
  assert.equal(parseAmericanOdds(''), null);
  assert.equal(parseAmericanOdds(undefined), null);
});

test('margen de la casa y probabilidad sin margen (1X2)', () => {
  const outcomes: OddsOutcome[] = [
    { key: 'home', label: 'Local', decimalOdds: 2.0 },
    { key: 'draw', label: 'Empate', decimalOdds: 3.5 },
    { key: 'away', label: 'Visitante', decimalOdds: 4.0 },
  ];
  const a = analyzeMarketOutcomes(outcomes);
  assert.equal(a.complete, true);
  // 50 + 28.5714… + 25 = 103.5714…
  close(a.sumImpliedPct!, 50 + 100 / 3.5 + 25);
  close(a.marginPct!, a.sumImpliedPct! - 100);
  const fairSum = a.outcomes.reduce((s, o) => s + o.fairPct!, 0);
  close(fairSum, 100);
  close(a.outcomes[0].fairPct!, (50 / a.sumImpliedPct!) * 100);
  // La cuota justa es la inversa de la probabilidad sin margen
  close(a.outcomes[0].fairOdds!, 100 / a.outcomes[0].fairPct!);
});

test('mercado incompleto: no se calcula margen ni normalización', () => {
  const a = analyzeMarketOutcomes([
    { key: 'home', label: 'Local', decimalOdds: 2.0 },
    { key: 'draw', label: 'Empate', decimalOdds: null },
    { key: 'away', label: 'Visitante', decimalOdds: 4.0 },
  ]);
  assert.equal(a.complete, false);
  assert.equal(a.marginPct, null);
  assert.equal(a.sumImpliedPct, null);
  assert.ok(a.outcomes.every((o) => o.fairPct === null));
  close(a.outcomes[0].impliedPct!, 50);
  assert.equal(a.outcomes[1].impliedPct, null);
});

test('mercado a dos vías con margen típico (-110 / -110)', () => {
  const d = parseAmericanOdds('-110')!;
  const a = analyzeMarketOutcomes([
    { key: 'over', label: 'Más', decimalOdds: d },
    { key: 'under', label: 'Menos', decimalOdds: d },
  ]);
  close(a.sumImpliedPct!, (2 * 110) / 210 * 100);
  close(a.outcomes[0].fairPct!, 50);
  assert.ok(a.marginPct! > 4.7 && a.marginPct! < 4.8);
});

test('margen negativo genera aviso', () => {
  const a = analyzeMarketOutcomes([
    { key: 'home', label: 'Local', decimalOdds: 2.2 },
    { key: 'away', label: 'Visitante', decimalOdds: 2.2 },
  ]);
  assert.ok(a.marginPct! < 0);
  assert.ok(a.warnings.length > 0);
});

test('comparación modelo vs referencia en pp y porcentaje relativo', () => {
  const d = compareProbabilities(55, 50)!;
  close(d.diffPp, 5);
  close(d.relativePct!, 10);
  const n = compareProbabilities(40, 50)!;
  close(n.diffPp, -10);
  close(n.relativePct!, -20);
  assert.equal(compareProbabilities(10, 0)!.relativePct, null);
  assert.equal(compareProbabilities(Number.NaN, 10), null);
});

test('modelo NBA: moneyline, total y spread usan el mismo mercado (sin mezclar)', () => {
  const nba = {
    probHomeWin: 0.62,
    probAwayWin: 0.38,
    expectedTotal: 225,
    totalStdDev: 18,
    expectedSpreadHome: 4,
    spreadStdDev: 12,
  } as never;
  const ctx = { sport: 'nba' as const, nba };

  const ml = modelProbabilitiesForMarket({ kind: 'moneyline_2way' }, ctx);
  close(ml.probabilitiesPct.home! + ml.probabilitiesPct.away!, 100);

  const tot = modelProbabilitiesForMarket({ kind: 'totals', line: 225.5 }, ctx);
  assert.equal(tot.available, true);
  close(tot.probabilitiesPct.over! + tot.probabilitiesPct.under!, 100);
  assert.ok(tot.probabilitiesPct.over! < 50); // línea por encima de la media

  const totInt = modelProbabilitiesForMarket({ kind: 'totals', line: 225 }, ctx);
  assert.equal(totInt.available, false);

  // Local favorito por 4 puntos: cubrir −3.5 es algo más probable que no, cubrir −6.5 menos
  const sp1 = modelProbabilitiesForMarket({ kind: 'spread', line: -3.5 }, ctx);
  const sp2 = modelProbabilitiesForMarket({ kind: 'spread', line: -6.5 }, ctx);
  assert.ok(sp1.probabilitiesPct.home! > 50);
  assert.ok(sp2.probabilitiesPct.home! < 50);
  close(sp1.probabilitiesPct.home! + sp1.probabilitiesPct.away!, 100);

  // El modelo de NBA no estima 1X2 ni BTTS
  assert.equal(modelProbabilitiesForMarket({ kind: 'btts' }, ctx).available, false);
});

test('modelo fútbol: 1X2, totales con líneas soportadas y BTTS', () => {
  const football = {
    probHome: 0.5,
    probDraw: 0.27,
    probAway: 0.23,
    over15: 0.8,
    over25: 0.52,
    over35: 0.27,
    bttsYes: 0.55,
  } as never;
  const ctx = { sport: 'football' as const, football };

  const x = modelProbabilitiesForMarket({ kind: 'match_winner_3way' }, ctx);
  close(x.probabilitiesPct.home! + x.probabilitiesPct.draw! + x.probabilitiesPct.away!, 100);

  const o25 = modelProbabilitiesForMarket({ kind: 'totals', line: 2.5 }, ctx);
  close(o25.probabilitiesPct.over!, 52);
  close(o25.probabilitiesPct.under!, 48);

  const o45 = modelProbabilitiesForMarket({ kind: 'totals', line: 4.5 }, ctx);
  assert.equal(o45.available, false);

  const b = modelProbabilitiesForMarket({ kind: 'btts' }, ctx);
  close(b.probabilitiesPct.yes!, 55);
  close(b.probabilitiesPct.no!, 45);

  assert.equal(modelProbabilitiesForMarket({ kind: 'moneyline_2way' }, ctx).available, false);
});

test('discrepancias entre fuentes: solo misma línea y probabilidades sin margen', () => {
  const mk = (sourceId: string, over: number, under: number, line: number): OddsSourceSnapshot => ({
    sourceId,
    sourceLabel: sourceId,
    fetchedAt: '2026-01-01T00:00:00Z',
    status: 'ok',
    markets: [
      {
        id: `totals:${line}`,
        kind: 'totals',
        label: `Total ${line}`,
        line,
        outcomes: [
          { key: 'over', label: 'Más', decimalOdds: over },
          { key: 'under', label: 'Menos', decimalOdds: under },
        ],
      },
    ],
  });

  // Mismo mercado y línea, probabilidades sin margen muy distintas → discrepancia
  const disc = detectSourceDiscrepancies([mk('a', 1.8, 2.0, 2.5), mk('b', 2.2, 1.65, 2.5)]);
  assert.ok(disc.length > 0);

  // Líneas distintas → no se comparan entre sí
  const none = detectSourceDiscrepancies([mk('a', 1.8, 2.0, 2.5), mk('b', 2.2, 1.65, 3.5)]);
  assert.equal(none.length, 0);

  // Mismo reparto con distinto margen → no es discrepancia
  const sameFair = detectSourceDiscrepancies([mk('a', 1.9, 1.9, 2.5), mk('b', 1.8, 1.8, 2.5)]);
  assert.equal(sameFair.length, 0);
});
