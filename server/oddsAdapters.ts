import type {
  MatchOddsResponse,
  MatchRecord,
  OddsOutcome,
  OddsSourceSnapshot,
} from '../src/types/sports.ts';
import { parseEspnOddsSummary } from './oddsParsers.ts';
import {
  fetchEspnNbaCalendarAndStandings,
  fetchEspnSoccerEnrichment,
  teamsMatch,
} from './espnAdapters.ts';
import { fetchWithTimeout } from './httpUtils.ts';

/**
 * Cuotas de referencia por partido.
 *
 * Reglas:
 *  - Solo se devuelven cuotas que la fuente publica realmente. Nunca se inventan ni se estiman aquí.
 *  - Cada fuente (y cada casa que ESPN reenvía) se devuelve por separado, sin fusionar.
 *  - Si una fuente no publica cuotas, se devuelve con estado `no_odds` y un mensaje claro.
 */

type AnyObj = Record<string, unknown>;

const asObj = (v: unknown): AnyObj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {});
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

// ───────────── Resolución del evento ESPN equivalente al partido ─────────────

interface EspnTarget {
  sport: 'football' | 'nba';
  slug?: string;
  eventId: string;
}

function targetFromEspnId(match: MatchRecord, id: string): EspnTarget | null {
  if (match.sport === 'nba' && id.startsWith('espn-nba-')) {
    return { sport: 'nba', eventId: id.replace('espn-nba-', '') };
  }
  if (match.sport === 'football' && id.startsWith('espnsoc-')) {
    const rest = id.replace('espnsoc-', '');
    const lastDash = rest.lastIndexOf('-');
    if (lastDash <= 0) return null;
    return { sport: 'football', slug: rest.slice(0, lastDash), eventId: rest.slice(lastDash + 1) };
  }
  return null;
}

async function resolveEspnTarget(match: MatchRecord): Promise<EspnTarget | null> {
  const candidates = [
    match.id,
    match.sourceIds?.['espn-nba'],
    match.sourceIds?.['espn-football'],
  ].filter((x): x is string => Boolean(x));
  for (const id of candidates) {
    const t = targetFromEspnId(match, id);
    if (t) return t;
  }

  // El partido viene de otra fuente: se enlaza por fecha (±36 h) y nombres de equipo.
  const baseTs = new Date(match.kickoffIso).getTime();
  const pool =
    match.sport === 'football'
      ? (await fetchEspnSoccerEnrichment()).matches
      : (await fetchEspnNbaCalendarAndStandings()).matches;
  const found = pool.find(
    (em) =>
      Math.abs(new Date(em.kickoffIso).getTime() - baseTs) <= 36 * 3600_000 &&
      teamsMatch(em.homeTeam.name, match.homeTeam.name) &&
      teamsMatch(em.awayTeam.name, match.awayTeam.name)
  );
  return found ? targetFromEspnId(match, found.id) : null;
}

async function fetchEspnSource(match: MatchRecord, fetchedAt: string): Promise<OddsSourceSnapshot[]> {
  const base: OddsSourceSnapshot = {
    sourceId: 'espn',
    sourceLabel: 'ESPN',
    fetchedAt,
    status: 'unavailable',
    markets: [],
  };

  try {
    const target = await resolveEspnTarget(match);
    if (!target) {
      return [{ ...base, message: 'No se encontró este partido en ESPN, por lo que no hay cuotas de esta fuente.' }];
    }
    const url =
      target.sport === 'nba'
        ? `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${target.eventId}`
        : `https://site.api.espn.com/apis/site/v2/sports/soccer/${target.slug}/summary?event=${target.eventId}`;
    const res = await fetchWithTimeout(url, undefined, 9000);
    if (!res.ok) {
      return [{ ...base, status: 'error', message: `ESPN respondió HTTP ${res.status} al consultar el partido.` }];
    }
    const summary = (await res.json()) as AnyObj;
    const sources = parseEspnOddsSummary(
      summary,
      match.sport === 'nba' ? 'nba' : 'football',
      match.homeTeam.shortName || match.homeTeam.name,
      match.awayTeam.shortName || match.awayTeam.name,
      fetchedAt
    );
    if (sources.length === 0) {
      return [
        {
          ...base,
          status: 'no_odds',
          message: 'ESPN no publica cuotas para este partido (suelen aparecer pocos días antes del inicio).',
        },
      ];
    }
    return sources;
  } catch (err) {
    return [
      {
        ...base,
        status: 'error',
        message: `No se pudo consultar ESPN: ${err instanceof Error ? err.message : 'error de red desconocido'}.`,
      },
    ];
  }
}

// ───────────── Football-Data.org (cuotas opcionales de su paquete Odds) ─────────────

async function fetchFootballDataSource(
  match: MatchRecord,
  apiKey: string,
  fetchedAt: string
): Promise<OddsSourceSnapshot | null> {
  const sourceMatchId = match.sourceIds?.['football-data'] ?? (match.id.startsWith('fd-') ? match.id : undefined);
  if (!sourceMatchId) return null;

  const base: OddsSourceSnapshot = {
    sourceId: 'football-data',
    sourceLabel: 'Football-Data.org v4',
    fetchedAt,
    status: 'unavailable',
    markets: [],
  };

  try {
    const res = await fetchWithTimeout(
      `https://api.football-data.org/v4/matches/${sourceMatchId.replace('fd-', '')}`,
      { headers: { 'X-Auth-Token': apiKey.trim() } },
      9000
    );
    if (!res.ok) {
      return { ...base, status: 'error', message: `Football-Data.org respondió HTTP ${res.status}.` };
    }
    const json = (await res.json()) as AnyObj;
    const odds = asObj(json.odds);
    const home = asNum(odds.homeWin);
    const draw = asNum(odds.draw);
    const away = asNum(odds.awayWin);

    if (home === undefined && draw === undefined && away === undefined) {
      const providerMsg = asStr(odds.msg);
      return {
        ...base,
        status: 'no_odds',
        message: providerMsg
          ? `Football-Data.org indica que las cuotas no están activadas en tu cuenta: ${providerMsg}`
          : 'Football-Data.org no devuelve cuotas para este partido con tu plan actual.',
      };
    }

    const dec = (n: number | undefined): number | null => (n !== undefined && n > 1 ? n : null);
    const outcomes: OddsOutcome[] = [
      { key: 'home', label: `Gana ${match.homeTeam.shortName || match.homeTeam.name}`, decimalOdds: dec(home), rawOdds: home?.toString() },
      { key: 'draw', label: 'Empate', decimalOdds: dec(draw), rawOdds: draw?.toString() },
      { key: 'away', label: `Gana ${match.awayTeam.shortName || match.awayTeam.name}`, decimalOdds: dec(away), rawOdds: away?.toString() },
    ];
    return {
      ...base,
      status: 'ok',
      markets: [
        {
          id: 'match_winner_3way',
          kind: 'match_winner_3way',
          label: 'Resultado final (1X2)',
          outcomes,
          updatedAt: asStr(json.lastUpdated) ?? fetchedAt,
        },
      ],
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      message: `No se pudo consultar Football-Data.org: ${err instanceof Error ? err.message : 'error de red desconocido'}.`,
    };
  }
}

// ───────────── Punto de entrada ─────────────

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; payload: MatchOddsResponse }>();

export async function fetchMatchOdds(
  match: MatchRecord,
  options: { footballDataKey?: string; forceRefresh?: boolean } = {}
): Promise<MatchOddsResponse> {
  const cacheKey = `${match.sport}:${match.id}:${options.footballDataKey ? 'fd' : 'nofd'}`;
  const cached = cache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() < cached.expiresAt) return cached.payload;

  const fetchedAt = new Date().toISOString();
  const tasks: Array<Promise<OddsSourceSnapshot[]>> = [fetchEspnSource(match, fetchedAt)];

  if (match.sport === 'football' && options.footballDataKey) {
    tasks.push(
      fetchFootballDataSource(match, options.footballDataKey, fetchedAt).then((s) => (s ? [s] : []))
    );
  }

  const settled = await Promise.all(tasks);
  const payload: MatchOddsResponse = {
    matchId: match.id,
    sport: match.sport,
    fetchedAt,
    sources: settled.flat(),
  };
  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
  return payload;
}
