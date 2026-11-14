import type { OddsMarketSnapshot, OddsOutcome, OddsSourceSnapshot } from '../src/types/sports.ts';
import { parseAmericanOdds } from '../src/engine/oddsMath.ts';

/**
 * Lectura (sin red) de las cuotas que publica ESPN en sus respuestas de partido.
 * Solo se devuelven cuotas presentes en la respuesta; nunca se inventan ni se estiman.
 */

export type AnyObj = Record<string, unknown>;

const asObj = (v: unknown): AnyObj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {});
const asArr = (v: unknown): AnyObj[] => (Array.isArray(v) ? (v as AnyObj[]) : []);
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/^[ou]/i, '').trim();
    if (/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned);
  }
  return undefined;
}

/** Cuota americana "cruda" (número o texto) → resultado con valor decimal y texto original. */
function buildOutcome(
  key: OddsOutcome['key'],
  label: string,
  rawAmerican: unknown
): OddsOutcome {
  const raw = asStr(rawAmerican);
  return {
    key,
    label,
    decimalOdds: raw === undefined ? null : parseAmericanOdds(raw),
    rawOdds: raw,
  };
}

/** En el formato nuevo de ESPN cada lado trae {open, close, current}; se usa el valor más reciente. */
function latestQuote(side: unknown): AnyObj {
  const s = asObj(side);
  const close = asObj(s.close);
  const current = asObj(s.current);
  const open = asObj(s.open);
  if (Object.keys(close).length > 0) return close;
  if (Object.keys(current).length > 0) return current;
  return open;
}

function hasAnyOdds(outcomes: OddsOutcome[]): boolean {
  return outcomes.some((o) => o.decimalOdds !== null);
}

function buildMarketsFromEspnEntry(
  entry: AnyObj,
  sport: 'football' | 'nba',
  homeName: string,
  awayName: string,
  updatedAt: string
): OddsMarketSnapshot[] {
  const markets: OddsMarketSnapshot[] = [];
  const homeOdds = asObj(entry.homeTeamOdds);
  const awayOdds = asObj(entry.awayTeamOdds);
  const drawOdds = asObj(entry.drawOdds);
  const ml = asObj(entry.moneyline);
  const pointSpread = asObj(entry.pointSpread);
  const total = asObj(entry.total);

  // ── Ganador del partido (1X2 en fútbol, moneyline en NBA) ──
  const mlHome = ml.home !== undefined ? latestQuote(ml.home).odds : homeOdds.moneyLine;
  const mlAway = ml.away !== undefined ? latestQuote(ml.away).odds : awayOdds.moneyLine;
  const mlDraw = ml.draw !== undefined ? latestQuote(ml.draw).odds : drawOdds.moneyLine;

  if (sport === 'football') {
    const outcomes = [
      buildOutcome('home', `Gana ${homeName}`, mlHome),
      buildOutcome('draw', 'Empate', mlDraw),
      buildOutcome('away', `Gana ${awayName}`, mlAway),
    ];
    if (hasAnyOdds(outcomes)) {
      markets.push({
        id: 'match_winner_3way',
        kind: 'match_winner_3way',
        label: 'Resultado final (1X2)',
        outcomes,
        updatedAt,
      });
    }
  } else {
    const outcomes = [
      buildOutcome('home', `Gana ${homeName}`, mlHome),
      buildOutcome('away', `Gana ${awayName}`, mlAway),
    ];
    if (hasAnyOdds(outcomes)) {
      markets.push({
        id: 'moneyline_2way',
        kind: 'moneyline_2way',
        label: 'Ganador del partido (moneyline)',
        outcomes,
        updatedAt,
      });
    }
  }

  // ── Total de goles / puntos (más / menos) ──
  const newOver = latestQuote(total.over);
  const newUnder = latestQuote(total.under);
  const totalLine = asNum(newOver.line) ?? asNum(newUnder.line) ?? asNum(entry.overUnder);
  const overRaw = total.over !== undefined ? newOver.odds : entry.overOdds;
  const underRaw = total.under !== undefined ? newUnder.odds : entry.underOdds;
  if (totalLine !== undefined) {
    const unit = sport === 'football' ? 'goles' : 'puntos';
    const outcomes = [
      buildOutcome('over', `Más de ${totalLine} ${unit}`, overRaw),
      buildOutcome('under', `Menos de ${totalLine} ${unit}`, underRaw),
    ];
    if (hasAnyOdds(outcomes)) {
      markets.push({
        id: `totals:${totalLine}`,
        kind: 'totals',
        label: `Total de ${unit} (línea ${totalLine})`,
        line: totalLine,
        outcomes,
        updatedAt,
      });
    }
  }

  // ── Hándicap (solo NBA; el modelo de fútbol no estima hándicap) ──
  if (sport === 'nba') {
    let homeLine: number | undefined;
    let homeSpreadRaw: unknown;
    let awaySpreadRaw: unknown;

    if (pointSpread.home !== undefined) {
      const h = latestQuote(pointSpread.home);
      const a = latestQuote(pointSpread.away);
      homeLine = asNum(h.line);
      homeSpreadRaw = h.odds;
      awaySpreadRaw = a.odds;
    } else {
      const absLine = asNum(entry.spread);
      if (absLine !== undefined) {
        // La línea de ESPN no indica por sí sola a qué equipo pertenece: se usa la marca de favorito.
        if (homeOdds.favorite === true) homeLine = -Math.abs(absLine);
        else if (awayOdds.favorite === true) homeLine = Math.abs(absLine);
      }
      homeSpreadRaw = homeOdds.spreadOdds;
      awaySpreadRaw = awayOdds.spreadOdds;
    }

    if (homeLine !== undefined) {
      const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);
      const outcomes = [
        buildOutcome('home', `${homeName} ${fmt(homeLine)}`, homeSpreadRaw),
        buildOutcome('away', `${awayName} ${fmt(-homeLine)}`, awaySpreadRaw),
      ];
      if (hasAnyOdds(outcomes)) {
        markets.push({
          id: `spread:${homeLine}`,
          kind: 'spread',
          label: `Hándicap (${homeName} ${fmt(homeLine)})`,
          line: homeLine,
          outcomes,
          updatedAt,
        });
      }
    }
  }

  return markets;
}

function extractEspnOddsEntries(summary: AnyObj): AnyObj[] {
  const headerComp = asObj(asArr(asObj(summary.header).competitions)[0]);
  return [
    ...asArr(summary.pickcenter),
    ...asArr(summary.odds),
    ...asArr(headerComp.odds),
  ];
}

export function parseEspnOddsSummary(
  summary: AnyObj,
  sport: 'football' | 'nba',
  homeName: string,
  awayName: string,
  fetchedAt: string
): OddsSourceSnapshot[] {
  const seen = new Set<string>();
  const out: OddsSourceSnapshot[] = [];

  for (const entry of extractEspnOddsEntries(summary)) {
    const providerName = asStr(asObj(entry.provider).name) ?? 'Proveedor no identificado';
    if (seen.has(providerName)) continue;
    const markets = buildMarketsFromEspnEntry(entry, sport, homeName, awayName, fetchedAt);
    if (markets.length === 0) continue;
    seen.add(providerName);
    out.push({
      sourceId: `espn:${providerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      sourceLabel: `ESPN · ${providerName}`,
      bookmaker: providerName,
      fetchedAt,
      status: 'ok',
      markets,
    });
  }
  return out;
}
