import type {
  FootballPredictionResult,
  NbaPredictionResult,
  OddsMarketKind,
  OddsMarketSnapshot,
  OddsOutcome,
  OddsOutcomeKey,
  OddsSourceSnapshot,
  SportType,
} from '../types/sports.ts';
import { normalCdf } from './distributionMath.ts';

/**
 * Cálculos de cuotas y probabilidades.
 * Finalidad exclusivamente estadística e informativa.
 *
 * Convenciones:
 *  - Todas las probabilidades de este módulo se expresan en PORCENTAJE (0–100).
 *  - Las cuotas son decimales (> 1). Las cuotas americanas se convierten con `americanToDecimal`.
 *  - Nunca se mezclan resultados de mercados distintos (ni líneas distintas del mismo mercado).
 */

// ───────────── Conversión de cuotas ─────────────

/** Cuota americana (+150, -110…) → decimal. Devuelve null si el valor no es válido. */
export function americanToDecimal(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return decimal > 1 ? decimal : null;
}

/**
 * Interpreta el texto/número de cuota americana que publica una fuente.
 * Acepta "-110", "+150", 150, "EVEN"/"EV" (= +100). Cualquier otra cosa → null.
 */
export function parseAmericanOdds(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return americanToDecimal(raw);
  if (typeof raw !== 'string') return null;
  const txt = raw.trim().toUpperCase();
  if (!txt) return null;
  if (txt === 'EVEN' || txt === 'EV' || txt === 'PK') return 2;
  if (!/^[+-]?\d+(\.\d+)?$/.test(txt)) return null;
  return americanToDecimal(Number(txt));
}

// ───────────── Probabilidad implícita, margen y probabilidad sin margen ─────────────

/** Probabilidad implícita (%) = 1 / cuota decimal × 100. */
export function impliedProbabilityPct(decimalOdds: number | null | undefined): number | null {
  if (decimalOdds === null || decimalOdds === undefined) return null;
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  return (1 / decimalOdds) * 100;
}

export interface OutcomeAnalysis {
  key: OddsOutcomeKey;
  label: string;
  decimalOdds: number | null;
  /** 1 / cuota × 100 */
  impliedPct: number | null;
  /** Probabilidad normalizada para que todos los resultados sumen 100 % (solo si el mercado está completo). */
  fairPct: number | null;
  /** 1 / probabilidad sin margen (cuota "justa" equivalente). */
  fairOdds: number | null;
}

export interface MarketAnalysis {
  /** true si TODOS los resultados del mercado tienen una cuota válida. */
  complete: boolean;
  outcomes: OutcomeAnalysis[];
  /** Suma de las probabilidades implícitas (solo si el mercado está completo). */
  sumImpliedPct: number | null;
  /** Margen de la casa = suma de implícitas − 100 (solo si el mercado está completo). */
  marginPct: number | null;
  warnings: string[];
}

export function analyzeMarketOutcomes(outcomes: OddsOutcome[]): MarketAnalysis {
  const warnings: string[] = [];
  const implied = outcomes.map((o) => impliedProbabilityPct(o.decimalOdds));
  const complete = outcomes.length >= 2 && implied.every((p) => p !== null);

  if (!complete) {
    return {
      complete: false,
      outcomes: outcomes.map((o, i) => ({
        key: o.key,
        label: o.label,
        decimalOdds: o.decimalOdds,
        impliedPct: implied[i],
        fairPct: null,
        fairOdds: null,
      })),
      sumImpliedPct: null,
      marginPct: null,
      warnings: ['Mercado incompleto: faltan cuotas de algún resultado, no se calcula margen ni probabilidad sin margen.'],
    };
  }

  const sum = (implied as number[]).reduce((a, b) => a + b, 0);
  const margin = sum - 100;
  if (margin < -0.5) {
    warnings.push(
      `Margen negativo (${margin.toFixed(2)} %): puede deberse a cuotas desfasadas o a un dato erróneo de la fuente.`
    );
  }

  return {
    complete: true,
    outcomes: outcomes.map((o, i) => {
      const fair = ((implied[i] as number) / sum) * 100;
      return {
        key: o.key,
        label: o.label,
        decimalOdds: o.decimalOdds,
        impliedPct: implied[i],
        fairPct: fair,
        fairOdds: fair > 0 ? 100 / fair : null,
      };
    }),
    sumImpliedPct: sum,
    marginPct: margin,
    warnings,
  };
}

// ───────────── Comparación modelo vs. referencia ─────────────

export interface ProbabilityDifference {
  /** modelo − referencia, en puntos porcentuales. */
  diffPp: number;
  /** (modelo − referencia) / referencia × 100. null si la referencia es 0. */
  relativePct: number | null;
}

export function compareProbabilities(modelPct: number, referencePct: number): ProbabilityDifference | null {
  if (!Number.isFinite(modelPct) || !Number.isFinite(referencePct)) return null;
  return {
    diffPp: modelPct - referencePct,
    relativePct: referencePct > 0 ? ((modelPct - referencePct) / referencePct) * 100 : null,
  };
}

// ───────────── Probabilidades del modelo de SportAnalytics AI por mercado ─────────────

export interface ModelOddsContext {
  sport: SportType;
  football?: FootballPredictionResult | null;
  nba?: NbaPredictionResult | null;
}

export interface ModelMarketProbabilities {
  available: boolean;
  /** Probabilidades del modelo (%) para cada resultado del mercado. */
  probabilitiesPct: Partial<Record<OddsOutcomeKey, number>>;
  /** Motivo cuando no está disponible, o nota metodológica cuando sí lo está. */
  note?: string;
}

const FOOTBALL_MODEL_TOTAL_LINES = [1.5, 2.5, 3.5] as const;

function unavailable(note: string): ModelMarketProbabilities {
  return { available: false, probabilitiesPct: {}, note };
}

function isHalfLine(line: number): boolean {
  return Number.isFinite(line) && Math.abs(line * 2 - Math.round(line * 2)) < 1e-9 && Math.abs(line % 1) > 1e-9;
}

export function modelProbabilitiesForMarket(
  market: Pick<OddsMarketSnapshot, 'kind' | 'line'>,
  ctx: ModelOddsContext
): ModelMarketProbabilities {
  const { kind, line } = market;

  if (ctx.sport === 'football') {
    const pred = ctx.football;
    if (!pred) return unavailable('El modelo de fútbol no está disponible para este partido.');

    if (kind === 'match_winner_3way') {
      return {
        available: true,
        probabilitiesPct: {
          home: pred.probHome * 100,
          draw: pred.probDraw * 100,
          away: pred.probAway * 100,
        },
        note: 'Distribución de goles (Poisson) con calibración histórica si hay datos suficientes.',
      };
    }
    if (kind === 'totals') {
      if (line === undefined) return unavailable('Línea del mercado de goles no indicada por la fuente.');
      const overByLine: Record<number, number> = { 1.5: pred.over15, 2.5: pred.over25, 3.5: pred.over35 };
      const over = overByLine[line];
      if (over === undefined) {
        return unavailable(
          `El modelo solo estima las líneas ${FOOTBALL_MODEL_TOTAL_LINES.join(', ')}; la línea ${line} no se compara.`
        );
      }
      return {
        available: true,
        probabilitiesPct: { over: over * 100, under: 100 - over * 100 },
        note: 'Se obtiene de la matriz de marcadores del modelo (Más de X.5 y su complementario).',
      };
    }
    if (kind === 'btts') {
      return {
        available: true,
        probabilitiesPct: { yes: pred.bttsYes * 100, no: 100 - pred.bttsYes * 100 },
        note: 'Ambos equipos marcan según la matriz de marcadores del modelo.',
      };
    }
    return unavailable('El modelo de fútbol no estima este tipo de mercado.');
  }

  const pred = ctx.nba;
  if (!pred) return unavailable('El modelo de NBA no está disponible para este partido.');

  if (kind === 'moneyline_2way') {
    return {
      available: true,
      probabilitiesPct: { home: pred.probHomeWin * 100, away: pred.probAwayWin * 100 },
      note: 'Probabilidad de victoria del modelo (sin empate posible en NBA).',
    };
  }
  if (kind === 'totals') {
    if (line === undefined) return unavailable('Línea de puntos totales no indicada por la fuente.');
    if (!isHalfLine(line)) {
      return unavailable(`La línea ${line} es entera: existe la posibilidad de "push" y no es comparable de forma directa.`);
    }
    const under = normalCdf(line, pred.expectedTotal, pred.totalStdDev) * 100;
    return {
      available: true,
      probabilitiesPct: { over: 100 - under, under },
      note: `Distribución normal con media ${pred.expectedTotal.toFixed(1)} y desviación ${pred.totalStdDev.toFixed(1)} puntos.`,
    };
  }
  if (kind === 'spread') {
    if (line === undefined) return unavailable('Hándicap no indicado por la fuente.');
    if (!isHalfLine(line)) {
      return unavailable(`El hándicap ${line} es entero: existe la posibilidad de "push" y no es comparable de forma directa.`);
    }
    // line = hándicap del local (p. ej. −3.5). El local cubre si margen + línea > 0.
    const homeCovers = (1 - normalCdf(-line, pred.expectedSpreadHome, pred.spreadStdDev)) * 100;
    return {
      available: true,
      probabilitiesPct: { home: homeCovers, away: 100 - homeCovers },
      note: `Margen esperado del local ${pred.expectedSpreadHome.toFixed(1)} puntos con desviación ${pred.spreadStdDev.toFixed(1)}.`,
    };
  }
  return unavailable('El modelo de NBA no estima este tipo de mercado.');
}

// ───────────── Comparación entre fuentes ─────────────

export interface CrossSourceDiscrepancy {
  marketId: string;
  marketLabel: string;
  outcomeKey: OddsOutcomeKey;
  outcomeLabel: string;
  /** Probabilidad sin margen (%) por fuente. */
  bySource: Array<{ sourceId: string; sourceLabel: string; fairPct: number }>;
  spreadPp: number;
}

/** Umbral (puntos porcentuales) a partir del cual se señala una discrepancia entre fuentes. */
export const SOURCE_DISCREPANCY_THRESHOLD_PP = 2;

/**
 * Compara, mercado a mercado y SOLO con la misma línea, las probabilidades sin margen de las fuentes.
 * Se usan probabilidades sin margen para no confundir un margen distinto con una discrepancia real.
 */
export function detectSourceDiscrepancies(
  sources: OddsSourceSnapshot[],
  thresholdPp = SOURCE_DISCREPANCY_THRESHOLD_PP
): CrossSourceDiscrepancy[] {
  const byMarket = new Map<
    string,
    Array<{ source: OddsSourceSnapshot; market: OddsMarketSnapshot; fair: Map<OddsOutcomeKey, number> }>
  >();

  for (const source of sources) {
    for (const market of source.markets) {
      const analysis = analyzeMarketOutcomes(market.outcomes);
      if (!analysis.complete) continue;
      const fair = new Map<OddsOutcomeKey, number>();
      for (const o of analysis.outcomes) if (o.fairPct !== null) fair.set(o.key, o.fairPct);
      const list = byMarket.get(market.id) ?? [];
      list.push({ source, market, fair });
      byMarket.set(market.id, list);
    }
  }

  const result: CrossSourceDiscrepancy[] = [];
  for (const [marketId, entries] of byMarket) {
    if (entries.length < 2) continue;
    const keys = entries[0].market.outcomes.map((o) => o.key);
    for (const key of keys) {
      const values = entries
        .map((e) => ({
          sourceId: e.source.sourceId,
          sourceLabel: e.source.sourceLabel,
          fairPct: e.fair.get(key),
        }))
        .filter((v): v is { sourceId: string; sourceLabel: string; fairPct: number } => v.fairPct !== undefined);
      if (values.length < 2) continue;
      const max = Math.max(...values.map((v) => v.fairPct));
      const min = Math.min(...values.map((v) => v.fairPct));
      if (max - min >= thresholdPp) {
        result.push({
          marketId,
          marketLabel: entries[0].market.label,
          outcomeKey: key,
          outcomeLabel: entries[0].market.outcomes.find((o) => o.key === key)?.label ?? key,
          bySource: values,
          spreadPp: max - min,
        });
      }
    }
  }
  return result;
}

// ───────────── Qué datos sustentan la estimación del modelo ─────────────

export interface ModelBasisInput {
  homeName: string;
  awayName: string;
  homePlayedGames?: number;
  awayPlayedGames?: number;
  homeRecentGames?: number;
  awayRecentGames?: number;
  h2hPlayed: number;
}

/** Líneas descriptivas, construidas SOLO con campos que el modelo y el partido realmente aportan. */
export function describeModelBasis(
  input: ModelBasisInput,
  ctx: ModelOddsContext
): string[] {
  const lines: string[] = [];
  const pred = ctx.sport === 'football' ? ctx.football : ctx.nba;
  if (!pred) return ['El modelo no pudo calcularse para este partido.'];

  if (ctx.sport === 'football' && ctx.football) {
    const f = ctx.football;
    lines.push(
      `Goles esperados (Poisson): ${input.homeName} ${f.lambdaHome.toFixed(2)} · ${input.awayName} ${f.lambdaAway.toFixed(2)} (total ${f.expectedGoalsTotal.toFixed(2)}).`
    );
  }
  if (ctx.sport === 'nba' && ctx.nba) {
    const n = ctx.nba;
    lines.push(
      `Puntos esperados: ${input.homeName} ${n.expectedHomePts.toFixed(1)} · ${input.awayName} ${n.expectedAwayPts.toFixed(1)} (ritmo ${n.expectedPace.toFixed(1)} posesiones).`
    );
  }

  const samples: string[] = [];
  if (input.homePlayedGames) samples.push(`${input.homeName}: ${input.homePlayedGames} partidos de temporada`);
  if (input.awayPlayedGames) samples.push(`${input.awayName}: ${input.awayPlayedGames} partidos de temporada`);
  if (input.homeRecentGames) samples.push(`${input.homeRecentGames} últimos partidos de ${input.homeName}`);
  if (input.awayRecentGames) samples.push(`${input.awayRecentGames} últimos partidos de ${input.awayName}`);
  if (input.h2hPlayed > 0) samples.push(`${input.h2hPlayed} enfrentamientos directos`);
  lines.push(
    samples.length > 0
      ? `Muestra utilizada: ${samples.join(' · ')}.`
      : 'No hay muestra de partidos suficiente en las fuentes activas; la estimación se apoya en valores de referencia generales.'
  );

  if (pred.absenceImpactSummary.length > 0) {
    lines.push(`Ajustes por bajas/ausencias: ${pred.absenceImpactSummary.slice(0, 3).join(' | ')}.`);
  }

  lines.push(
    `Calidad de datos: ${pred.dataQuality === 'verified' ? 'verificados' : pred.dataQuality === 'estimated' ? 'estimación parcial' : 'insuficientes'} · cobertura ${pred.dataConfidence} %.`
  );
  lines.push(
    pred.calibrationApplied
      ? `Calibración histórica aplicada${pred.calibrationNote ? `: ${pred.calibrationNote}` : '.'}`
      : 'Sin calibración histórica aplicada (muestra de predicciones resueltas insuficiente).'
  );
  for (const w of pred.modelWarnings.slice(0, 3)) lines.push(`Aviso del modelo: ${w}`);
  return lines;
}

// ───────────── Utilidades de presentación ─────────────

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'No disponible';
  return `${value.toFixed(digits)} %`;
}

export function formatSignedPp(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'No disponible';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)} pp`;
}

export function formatSignedPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'No disponible';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)} %`;
}

export function formatOdds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'No disponible';
  return value.toFixed(2);
}

