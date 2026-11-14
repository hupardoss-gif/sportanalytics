import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEspnOddsSummary } from '../server/oddsParsers.ts';
import { analyzeMarketOutcomes } from '../src/engine/oddsMath.ts';

/**
 * Fixtures SINTÉTICOS con la forma documentada de la respuesta de ESPN (pickcenter / odds).
 * No son cuotas reales: sirven solo para verificar la lectura y las conversiones.
 */

const FETCHED_AT = '2026-01-01T12:00:00.000Z';

test('NBA (formato clásico pickcenter): moneyline, total y hándicap por separado', () => {
  const summary = {
    pickcenter: [
      {
        provider: { name: 'Casa A' },
        details: 'LOC -3.5',
        spread: -3.5,
        overUnder: 224.5,
        overOdds: -110,
        underOdds: -110,
        homeTeamOdds: { favorite: true, moneyLine: -170, spreadOdds: -108 },
        awayTeamOdds: { favorite: false, moneyLine: 145, spreadOdds: -112 },
      },
    ],
  };
  const sources = parseEspnOddsSummary(summary, 'nba', 'LOC', 'VIS', FETCHED_AT);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].bookmaker, 'Casa A');
  const kinds = sources[0].markets.map((m) => m.id).sort();
  assert.deepEqual(kinds, ['moneyline_2way', 'spread:-3.5', 'totals:224.5']);

  const ml = sources[0].markets.find((m) => m.kind === 'moneyline_2way')!;
  const mlAnalysis = analyzeMarketOutcomes(ml.outcomes);
  assert.equal(mlAnalysis.complete, true);
  assert.ok(Math.abs(mlAnalysis.outcomes.reduce((s, o) => s + o.fairPct!, 0) - 100) < 1e-9);
  assert.ok(mlAnalysis.marginPct! > 0 && mlAnalysis.marginPct! < 10);

  // El hándicap del local es negativo porque es el favorito
  const spread = sources[0].markets.find((m) => m.kind === 'spread')!;
  assert.equal(spread.line, -3.5);
});

test('NBA: si el visitante es el favorito, el hándicap del local es positivo', () => {
  const summary = {
    pickcenter: [
      {
        provider: { name: 'Casa B' },
        spread: -2.5,
        homeTeamOdds: { favorite: false, spreadOdds: -110 },
        awayTeamOdds: { favorite: true, spreadOdds: -110 },
      },
    ],
  };
  const [s] = parseEspnOddsSummary(summary, 'nba', 'LOC', 'VIS', FETCHED_AT);
  assert.equal(s.markets[0].line, 2.5);
});

test('NBA: si no se sabe quién es el favorito, el hándicap NO se inventa', () => {
  const summary = {
    pickcenter: [
      {
        provider: { name: 'Casa C' },
        spread: -2.5,
        homeTeamOdds: { spreadOdds: -110 },
        awayTeamOdds: { spreadOdds: -110 },
        homeTeamOdds_ml: undefined,
      },
    ],
  };
  const sources = parseEspnOddsSummary(summary, 'nba', 'LOC', 'VIS', FETCHED_AT);
  assert.equal(sources.length, 0);
});

test('Fútbol: 1X2 completo con tres cuotas y total con más/menos', () => {
  const summary = {
    pickcenter: [
      {
        provider: { name: 'Casa D' },
        overUnder: 2.5,
        overOdds: -120,
        underOdds: 100,
        homeTeamOdds: { moneyLine: 120 },
        awayTeamOdds: { moneyLine: 240 },
        drawOdds: { moneyLine: 230 },
      },
    ],
  };
  const [s] = parseEspnOddsSummary(summary, 'football', 'LOC', 'VIS', FETCHED_AT);
  const x = s.markets.find((m) => m.kind === 'match_winner_3way')!;
  assert.deepEqual(
    x.outcomes.map((o) => o.key),
    ['home', 'draw', 'away']
  );
  assert.ok(Math.abs(x.outcomes[0].decimalOdds! - 2.2) < 1e-9);
  assert.ok(Math.abs(x.outcomes[1].decimalOdds! - 3.3) < 1e-9);
  const t = s.markets.find((m) => m.kind === 'totals')!;
  assert.equal(t.line, 2.5);
  assert.ok(Math.abs(t.outcomes[1].decimalOdds! - 2) < 1e-9);
});

test('Fútbol: mercado con una cuota ausente queda incompleto (sin margen calculable)', () => {
  const summary = {
    pickcenter: [
      {
        provider: { name: 'Casa E' },
        homeTeamOdds: { moneyLine: 120 },
        awayTeamOdds: { moneyLine: 240 },
      },
    ],
  };
  const [s] = parseEspnOddsSummary(summary, 'football', 'LOC', 'VIS', FETCHED_AT);
  const a = analyzeMarketOutcomes(s.markets[0].outcomes);
  assert.equal(a.complete, false);
  assert.equal(a.marginPct, null);
});

test('Formato nuevo (moneyline/pointSpread/total con open-close) y varias casas separadas', () => {
  const summary = {
    odds: [
      {
        provider: { name: 'Casa F' },
        moneyline: {
          home: { close: { odds: '-150' } },
          away: { close: { odds: '+130' } },
        },
        pointSpread: {
          home: { close: { line: '-3.5', odds: '-110' } },
          away: { close: { line: '+3.5', odds: '-110' } },
        },
        total: {
          over: { close: { line: 'o225.5', odds: '-105' } },
          under: { close: { line: 'u225.5', odds: '-115' } },
        },
      },
      {
        provider: { name: 'Casa G' },
        homeTeamOdds: { moneyLine: -160 },
        awayTeamOdds: { moneyLine: 140 },
      },
      // Misma casa repetida: no debe duplicarse
      {
        provider: { name: 'Casa G' },
        homeTeamOdds: { moneyLine: -999 },
        awayTeamOdds: { moneyLine: 999 },
      },
    ],
  };
  const sources = parseEspnOddsSummary(summary, 'nba', 'LOC', 'VIS', FETCHED_AT);
  assert.equal(sources.length, 2);
  assert.deepEqual(
    sources.map((s) => s.bookmaker),
    ['Casa F', 'Casa G']
  );
  const f = sources[0];
  assert.deepEqual(f.markets.map((m) => m.id).sort(), ['moneyline_2way', 'spread:-3.5', 'totals:225.5']);
  const total = f.markets.find((m) => m.kind === 'totals')!;
  assert.equal(total.line, 225.5);
});

test('Sin cuotas en la respuesta: no se devuelve ninguna fuente (nada inventado)', () => {
  assert.deepEqual(parseEspnOddsSummary({}, 'football', 'LOC', 'VIS', FETCHED_AT), []);
  assert.deepEqual(parseEspnOddsSummary({ pickcenter: [{ provider: { name: 'X' } }] }, 'nba', 'L', 'V', FETCHED_AT), []);
});
