import { GoogleGenAI, Type } from '@google/genai';
import type {
  AvailabilityStatus,
  FootballLineupSnapshot,
  FootballNewsBundle,
  MatchRecord,
  PlayerNewsItem,
  PlayerProfile,
} from '../src/types/sports.ts';
import { fetchWithTimeout } from './httpUtils.ts';
import { normalizeNbaName, parseValidPublishedAt } from './nbaIntelligence.ts';
import { teamsMatch } from './espnAdapters.ts';

type AnyObj = Record<string, unknown>;

const FOOTBALL_NEWS_CACHE = new Map<string, { expiresAt: number; payload: FootballNewsResult }>();
const TEAM_HISTORY_CACHE = new Map<string, { expiresAt: number; payload: EspnSoccerTeamLineupHistory }>();
const LEAGUE_TEAMS_CACHE = new Map<string, { expiresAt: number; teams: Array<{ id: string; name: string; shortName: string }> }>();

export function mapCompetitionToEspnSlug(competition: string): string {
  const c = competition.toLowerCase();
  if (c.includes('champions')) return 'uefa.champions';
  if (c.includes('europa league')) return 'uefa.europa';
  if (c.includes('conference')) return 'uefa.europa.conf';
  if (c.includes('premier')) return 'eng.1';
  if (c.includes('bundesliga')) return 'ger.1';
  if (c.includes('serie a')) return 'ita.1';
  if (c.includes('ligue 1')) return 'fra.1';
  return 'esp.1';
}

export async function resolveEspnSoccerIdsForMatch(
  competition: string,
  homeTeamName: string,
  awayTeamName: string
): Promise<{ slug: string; homeEspnTeamId?: string; awayEspnTeamId?: string }> {
  const slug = mapCompetitionToEspnSlug(competition);
  let teams = LEAGUE_TEAMS_CACHE.get(slug);
  if (!teams || Date.now() >= teams.expiresAt) {
    try {
      const res = await fetchWithTimeout(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams?limit=40`,
        undefined,
        6500
      );
      if (res.ok) {
        const json = (await res.json()) as {
          sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: AnyObj }> }> }>;
        };
        const raw = json.sports?.[0]?.leagues?.[0]?.teams ?? [];
        const parsed = raw
          .map((item) => {
            const t = item.team ?? {};
            return {
              id: String(t.id ?? ''),
              name: String(t.displayName ?? t.name ?? ''),
              shortName: String(t.abbreviation ?? ''),
            };
          })
          .filter((t) => t.id && t.name);
        teams = { expiresAt: Date.now() + 3_600_000, teams: parsed };
        LEAGUE_TEAMS_CACHE.set(slug, teams);
      }
    } catch {
      // ignore gracefully
    }
  }
  const list = teams?.teams ?? [];
  const h = list.find((t) => teamsMatch(t.name, homeTeamName));
  const a = list.find((t) => teamsMatch(t.name, awayTeamName));
  return {
    slug,
    homeEspnTeamId: h?.id,
    awayEspnTeamId: a?.id,
  };
}

export interface FootballNewsResult {
  fetchedAt: string;
  sourcesChecked: string[];
  items: PlayerNewsItem[];
}

export interface FootballGroundingFinding {
  playerName: string;
  teamName: string;
  status: AvailabilityStatus;
  starterConfidence?: number;
  summary: string;
  source: string;
  publishedAt?: string;
  confirmed: boolean;
}

export interface FootballSearchGroundingResult {
  available: boolean;
  used: boolean;
  status: 'active' | 'unconfigured' | 'error';
  message: string;
  citations?: Array<{ title: string; url: string }>;
  homeFormation?: string;
  awayFormation?: string;
  findings?: FootballGroundingFinding[];
  officialLineupDetected?: boolean;
}

export interface EspnSoccerTeamLineupHistory {
  teamId: string;
  teamName: string;
  teamShort: string;
  formation?: string;
  matchesAnalyzed: number;
  sources: string[];
  players: Array<{
    athleteId: string;
    name: string;
    shortName: string;
    number: number;
    posCode: 'G' | 'D' | 'M' | 'F';
    posLabel: string;
    recentStarts: number;
    recentAppearances: number;
    injuryNote?: string;
    availabilityFromTeam?: AvailabilityStatus;
  }>;
}

function decodeHtml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssXmlItems(
  xml: string,
  sourceName: string
): Array<{ title: string; summary: string; link?: string; pubDate?: string; source: string }> {
  const items: Array<{ title: string; summary: string; link?: string; pubDate?: string; source: string }> = [];
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemMatches.slice(0, 35)) {
    const titleMatch = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch = block.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
    const linkMatch = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    const dateMatch = block.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i);
    const title = decodeHtml(titleMatch?.[1] ?? '');
    const summary = decodeHtml(descMatch?.[1] ?? '');
    const link = decodeHtml(linkMatch?.[1] ?? '');
    const pubDate = parseValidPublishedAt(decodeHtml(dateMatch?.[1] ?? ''));
    if (title) {
      items.push({ title, summary, link: link || undefined, pubDate, source: sourceName });
    }
  }
  return items;
}

function inferFootballStatusFromText(text: string): {
  status: AvailabilityStatus | null;
  tag?: string;
  confirmed: boolean;
  confidenceShift: number;
} {
  const lower = text.toLowerCase();
  if (/\b(oficial|confirmad[oa]|once inicial|official lineup|starting xi|confirmed xi|comunicado oficial)\b/.test(lower)) {
    if (/\b(baja|lesionad[oa]|injured|ruled out|descartad[oa]|no viaja|fuera de la convocatoria)\b/.test(lower)) {
      return { status: 'out', tag: 'Baja oficial', confirmed: true, confidenceShift: -85 };
    }
    if (/\b(sancionad[oa]|suspended|roja|acumulaci[oó]n de tarjetas)\b/.test(lower)) {
      return { status: 'suspended', tag: 'Sancionado', confirmed: true, confidenceShift: -90 };
    }
    return { status: 'starter', tag: 'Titular / Convocado', confirmed: true, confidenceShift: 15 };
  }
  if (/\b(ruled out|lesi[oó]n|rotura|esguince|injured|out for|operad[oa]|descartado|baja confirmada)\b/.test(lower)) {
    return { status: 'out', tag: 'Lesión / Baja', confirmed: true, confidenceShift: -75 };
  }
  if (/\b(suspend|sanci[oó]n|red card|acumulaci[oó]n)\b/.test(lower)) {
    return { status: 'suspended', tag: 'Sanción', confirmed: true, confidenceShift: -85 };
  }
  if (/\b(duda|doubt|doubtful|molestias|entre algodones|knock|fitness test|rotaci[oó]n|descanso|suplente probable)\b/.test(lower)) {
    return { status: 'doubtful', tag: 'Duda / Rotación', confirmed: false, confidenceShift: -32 };
  }
  if (/\b(apunta a titular|posible once|probable lineup|predicted xi|vuelve al once|recuperado)\b/.test(lower)) {
    return { status: 'possible_starter', tag: 'Posible titular', confirmed: false, confidenceShift: 12 };
  }
  return { status: null, confirmed: false, confidenceShift: 0 };
}

function mapFootballPosCode(pos?: string): 'G' | 'D' | 'M' | 'F' {
  const p = (pos || '').toUpperCase();
  if (p.includes('GK') || p === 'G' || p.includes('GOAL')) return 'G';
  if (p.includes('D') || p.includes('BACK') || p.includes('CB') || p.includes('LB') || p.includes('RB')) return 'D';
  if (p.includes('F') || p.includes('ST') || p.includes('W') || p.includes('CF') || p.includes('ATT')) return 'F';
  return 'M';
}

function buildGridCoord(idx: number, total: number, posCode: 'G' | 'D' | 'M' | 'F'): { x: number; y: number } {
  if (posCode === 'G' || idx === 0) return { x: 50, y: 90 };
  if (posCode === 'D') {
    const defSlots = [16, 38, 62, 84];
    return { x: defSlots[idx % defSlots.length], y: 72 };
  }
  if (posCode === 'M') {
    const midSlots = [22, 50, 78];
    return { x: midSlots[idx % midSlots.length], y: 47 };
  }
  const fwdSlots = [20, 50, 80];
  return { x: fwdSlots[idx % fwdSlots.length], y: 22 };
}

function buildFootballPlayerFromHistory(
  entry: EspnSoccerTeamLineupHistory['players'][number],
  idx: number,
  isStarter: boolean,
  matchesAnalyzed: number,
  teamId: string,
  teamName: string,
  teamShort: string,
  confirmed: boolean
): PlayerProfile {
  const freq = matchesAnalyzed > 0 ? entry.recentStarts / matchesAnalyzed : isStarter ? 0.72 : 0.2;
  const baseConf = confirmed
    ? 100
    : entry.availabilityFromTeam === 'out' || entry.availabilityFromTeam === 'suspended'
      ? 0
      : entry.availabilityFromTeam === 'doubtful'
        ? Math.round(Math.max(25, Math.min(55, freq * 60)))
        : isStarter
          ? Math.round(Math.max(58, Math.min(94, 52 + freq * 42)))
          : Math.round(Math.max(12, Math.min(44, freq * 45)));

  const posCode = entry.posCode;
  const isFwd = posCode === 'F';
  const isMid = posCode === 'M';

  const availability: AvailabilityStatus =
    entry.availabilityFromTeam ??
    (confirmed
      ? isStarter
        ? 'confirmed_starter'
        : 'bench'
      : isStarter
        ? 'possible_starter'
        : 'bench');

  const roleReason = confirmed
    ? 'Incluido en alineación oficial publicada'
    : entry.injuryNote
      ? entry.injuryNote
      : matchesAnalyzed > 0
        ? `Titular en ${entry.recentStarts} de los últimos ${matchesAnalyzed} partidos analizados`
        : 'Estimado desde plantilla oficial del club';

  return {
    id: `espnsoc-p-${entry.athleteId || `${teamShort}-${idx}`}`,
    sport: 'football',
    name: entry.name,
    shortName: entry.shortName,
    teamId,
    teamName,
    teamShort,
    number: entry.number || idx + 1,
    position: entry.posLabel,
    availability,
    availabilityConfidence: confirmed ? 'confirmed' : 'projected',
    starterConfidence: baseConf,
    roleReason,
    injuryNote: entry.injuryNote,
    isKeyPlayer: isStarter && (isFwd || entry.recentStarts >= Math.max(1, matchesAnalyzed - 1) || idx < 4),
    pitchCoord: isStarter ? buildGridCoord(idx, 11, posCode) : undefined,
    impact: {
      offenseDelta: isFwd ? 0.25 : isMid ? 0.13 : 0.04,
      defenseDelta: posCode === 'G' || posCode === 'D' ? 0.13 : 0.04,
      usageShare: isFwd ? 0.16 : isMid ? 0.1 : 0.03,
      assistShare: isMid ? 0.18 : isFwd ? 0.13 : 0.04,
    },
    splits: {
      season: { games: matchesAnalyzed, minutes: isStarter ? 80 : 25, starterRate: freq, goals: isFwd ? 0.31 : isMid ? 0.12 : 0.04, assists: isMid ? 0.19 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.92 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
      last5: { games: Math.min(5, matchesAnalyzed), minutes: isStarter ? 80 : 25, starterRate: freq, goals: isFwd ? 0.31 : isMid ? 0.12 : 0.04, assists: isMid ? 0.19 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.92 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
      last10: { games: Math.min(10, matchesAnalyzed), minutes: isStarter ? 80 : 25, starterRate: freq, goals: isFwd ? 0.31 : isMid ? 0.12 : 0.04, assists: isMid ? 0.19 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.92 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
      last15: { games: matchesAnalyzed, minutes: isStarter ? 80 : 25, starterRate: freq, goals: isFwd ? 0.31 : isMid ? 0.12 : 0.04, assists: isMid ? 0.19 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.92 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
      home: { games: matchesAnalyzed, minutes: isStarter ? 81 : 25, starterRate: freq, goals: isFwd ? 0.34 : isMid ? 0.13 : 0.04, assists: isMid ? 0.2 : 0.08, shots: isFwd ? 2.3 : isMid ? 1.15 : 0.4, shotsOnTarget: isFwd ? 0.96 : 0.42, foulsCommitted: 0.9, foulsDrawn: 1.15, yellowCards: 0.14, redCards: 0.01, passes: isMid ? 47 : 33 },
      away: { games: matchesAnalyzed, minutes: isStarter ? 79 : 25, starterRate: freq, goals: isFwd ? 0.28 : isMid ? 0.11 : 0.04, assists: isMid ? 0.18 : 0.08, shots: isFwd ? 2.1 : isMid ? 1.05 : 0.4, shotsOnTarget: isFwd ? 0.88 : 0.38, foulsCommitted: 0.95, foulsDrawn: 1.05, yellowCards: 0.16, redCards: 0.01, passes: isMid ? 45 : 31 },
      h2h: { games: 0, minutes: isStarter ? 80 : 25, starterRate: freq, goals: isFwd ? 0.31 : isMid ? 0.12 : 0.04, assists: isMid ? 0.19 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.92 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
    },
    recentLogs: [],
    sampleSizeGames: matchesAnalyzed,
    statsQuality: 'estimated',
    statsOriginNote: matchesAnalyzed > 0
      ? `Frecuencia titular verificada en ${matchesAnalyzed} partidos ESPN; tasas por demarcación`
      : 'Estimación posicional desde plantilla del club',
  };
}

/**
 * Fetches ESPN Soccer team roster + starter frequencies across the last 3 completed matches
 * so probable lineups are available hours prior to official T-60 publication.
 */
export async function fetchEspnSoccerTeamLineupHistory(
  slug: string,
  espnTeamId: string,
  teamNameFallback: string,
  teamShortFallback: string
): Promise<EspnSoccerTeamLineupHistory | null> {
  const cacheKey = `${slug}:${espnTeamId}`;
  const cached = TEAM_HISTORY_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.payload;

  try {
    const [rosterRes, schedRes] = await Promise.all([
      fetchWithTimeout(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${espnTeamId}/roster`,
        undefined,
        7500
      ).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Promise<AnyObj>,
      fetchWithTimeout(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${espnTeamId}/schedule`,
        undefined,
        7500
      ).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Promise<AnyObj>,
    ]);

    const rawAthletes = (rosterRes.athletes as AnyObj[] | undefined) ?? [];
    const recentEvents = ((schedRes.events as AnyObj[] | undefined) ?? [])
      .filter((ev) => {
        const comp = ((ev.competitions as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
        const st = ((comp.status ?? ev.status) as AnyObj | undefined)?.type as AnyObj | undefined;
        return st?.completed === true || String(st?.state ?? '').toLowerCase() === 'post';
      })
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
      .slice(0, 3);

    const recentSummaries = await Promise.all(
      recentEvents.map((ev) =>
        fetchWithTimeout(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${String(ev.id ?? '')}`,
          undefined,
          7500
        )
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<AnyObj>
      )
    );

    const starterCounts = new Map<string, number>();
    const appearanceCounts = new Map<string, number>();
    const athleteMeta = new Map<
      string,
      { name: string; shortName: string; number: number; posCode: 'G' | 'D' | 'M' | 'F'; posLabel: string; injuryNote?: string; availabilityFromTeam?: AvailabilityStatus }
    >();
    let detectedFormation: string | undefined;
    let matchesWithLineups = 0;

    for (const a of rawAthletes) {
      const id = String(a.id ?? '');
      if (!id) continue;
      const posObj = (a.position as AnyObj | undefined) ?? {};
      const posAbbr = String(posObj.abbreviation ?? 'M');
      const posCode = mapFootballPosCode(posAbbr);
      const injuries = (a.injuries as AnyObj[] | undefined) ?? [];
      const injStatus = injuries[0] ? String((injuries[0].status as string | undefined) ?? '') : '';
      let avail: AvailabilityStatus | undefined;
      if (/out|injur/i.test(injStatus)) avail = 'out';
      else if (/susp/i.test(injStatus)) avail = 'suspended';
      else if (/doubt|question/i.test(injStatus)) avail = 'doubtful';

      athleteMeta.set(id, {
        name: String(a.displayName ?? a.fullName ?? 'Jugador'),
        shortName: String(a.shortName ?? a.lastName ?? a.displayName ?? 'Jugador'),
        number: Number(a.jersey) || 0,
        posCode,
        posLabel: String(posObj.displayName ?? posAbbr),
        injuryNote: injStatus || undefined,
        availabilityFromTeam: avail,
      });
    }

    for (const sum of recentSummaries) {
      const rosters = (sum.rosters as AnyObj[] | undefined) ?? [];
      const side = rosters.find((r) => String((r.team as AnyObj | undefined)?.id ?? '') === espnTeamId);
      if (!side) continue;
      const entries = (side.roster as AnyObj[] | undefined) ?? [];
      if (entries.length === 0) continue;
      matchesWithLineups += 1;
      if (!detectedFormation && typeof side.formation === 'string' && side.formation) {
        detectedFormation = side.formation;
      }
      for (const entry of entries) {
        const ath = (entry.athlete as AnyObj | undefined) ?? {};
        const id = String(ath.id ?? '');
        if (!id) continue;
        appearanceCounts.set(id, (appearanceCounts.get(id) ?? 0) + 1);
        if (entry.starter === true) {
          starterCounts.set(id, (starterCounts.get(id) ?? 0) + 1);
        }
        if (!athleteMeta.has(id)) {
          const posObj = (entry.position as AnyObj | undefined) ?? (ath.position as AnyObj | undefined) ?? {};
          const posAbbr = String(posObj.abbreviation ?? 'M');
          athleteMeta.set(id, {
            name: String(ath.displayName ?? ath.fullName ?? 'Jugador'),
            shortName: String(ath.shortName ?? ath.lastName ?? 'Jugador'),
            number: Number(entry.jersey) || 0,
            posCode: mapFootballPosCode(posAbbr),
            posLabel: String(posObj.displayName ?? posAbbr),
          });
        }
      }
    }

    const players: EspnSoccerTeamLineupHistory['players'] = Array.from(athleteMeta.entries())
      .map(([athleteId, meta]) => ({
        athleteId,
        ...meta,
        recentStarts: starterCounts.get(athleteId) ?? 0,
        recentAppearances: appearanceCounts.get(athleteId) ?? 0,
      }))
      .sort((a, b) => {
        if (b.recentStarts !== a.recentStarts) return b.recentStarts - a.recentStarts;
        if (b.recentAppearances !== a.recentAppearances) return b.recentAppearances - a.recentAppearances;
        const order = { G: 0, D: 1, M: 2, F: 3 };
        return order[a.posCode] - order[b.posCode];
      });

    if (players.length === 0) return null;

    const result: EspnSoccerTeamLineupHistory = {
      teamId: espnTeamId,
      teamName: teamNameFallback,
      teamShort: teamShortFallback,
      formation: detectedFormation,
      matchesAnalyzed: matchesWithLineups,
      sources: [
        'ESPN Soccer Plantilla Oficial',
        ...(matchesWithLineups > 0 ? [`Últimos ${matchesWithLineups} onces iniciales ESPN`] : []),
      ],
      players,
    };

    TEAM_HISTORY_CACHE.set(cacheKey, { expiresAt: Date.now() + 600_000, payload: result });
    return result;
  } catch {
    return null;
  }
}

/**
 * Fetches real Football news & injury updates from trusted sports sources:
 * ESPN FC API + RSS feeds from BBC Sport, Sky Sports, Marca, AS.
 */
export async function fetchFootballExternalNews(params: {
  slug?: string;
  homeTeamName: string;
  awayTeamName: string;
  homeShort: string;
  awayShort: string;
  playerNames: string[];
  forceRefresh?: boolean;
}): Promise<FootballNewsResult> {
  const cacheKey = `${params.homeTeamName}::${params.awayTeamName}`;
  const cached = FOOTBALL_NEWS_CACHE.get(cacheKey);
  if (!params.forceRefresh && cached && Date.now() < cached.expiresAt) {
    return cached.payload;
  }

  const fetchedAt = new Date().toISOString();
  const sourcesChecked: string[] = [];
  const rawStories: Array<{ title: string; summary: string; link?: string; pubDate?: string; source: string }> = [];

  const slugToUse = params.slug || 'esp.1';
  const [espnRes, bbcXml, skyXml, marcaXml, asXml] = await Promise.all([
    fetchWithTimeout(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slugToUse}/news?limit=25`, undefined, 6000)
      .then((r) => (r.ok ? r.json() : { articles: [] }))
      .catch(() => ({ articles: [] })) as Promise<{
      articles?: Array<{
        headline?: string;
        description?: string;
        published?: string;
        links?: { web?: { href?: string } };
      }>;
    }>,
    fetchWithTimeout('https://feeds.bbci.co.uk/sport/football/rss.xml', undefined, 6000)
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''),
    fetchWithTimeout('https://www.skysports.com/rss/12040', undefined, 6000)
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''),
    fetchWithTimeout('https://e00-marca.uecdn.es/rss/futbol/primera-division.xml', undefined, 6000)
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''),
    fetchWithTimeout('https://as.com/rss/futbol/primera.xml', undefined, 6000)
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => ''),
  ]);

  if (Array.isArray(espnRes.articles) && espnRes.articles.length > 0) {
    sourcesChecked.push('ESPN FC');
    for (const art of espnRes.articles) {
      if (art.headline) {
        rawStories.push({
          title: art.headline,
          summary: art.description ?? '',
          link: art.links?.web?.href,
          pubDate: parseValidPublishedAt(art.published),
          source: 'ESPN FC',
        });
      }
    }
  }
  if (bbcXml.includes('<item')) {
    sourcesChecked.push('BBC Sport Football');
    rawStories.push(...parseRssXmlItems(bbcXml, 'BBC Sport'));
  }
  if (skyXml.includes('<item')) {
    sourcesChecked.push('Sky Sports Football');
    rawStories.push(...parseRssXmlItems(skyXml, 'Sky Sports'));
  }
  if (marcaXml.includes('<item')) {
    sourcesChecked.push('Marca Fútbol');
    rawStories.push(...parseRssXmlItems(marcaXml, 'Marca'));
  }
  if (asXml.includes('<item')) {
    sourcesChecked.push('AS Fútbol');
    rawStories.push(...parseRssXmlItems(asXml, 'AS'));
  }

  const teamAliases = [
    params.homeTeamName.toLowerCase(),
    params.awayTeamName.toLowerCase(),
    params.homeShort.toLowerCase(),
    params.awayShort.toLowerCase(),
    ...params.homeTeamName.toLowerCase().split(/\s+/).filter((w) => w.length >= 5),
    ...params.awayTeamName.toLowerCase().split(/\s+/).filter((w) => w.length >= 5),
  ];

  const items: PlayerNewsItem[] = [];
  const seenHeadlines = new Set<string>();

  for (const st of rawStories) {
    const combined = `${st.title} ${st.summary}`.toLowerCase();
    const matchedPlayers = params.playerNames.filter((name) => {
      const norm = normalizeNbaName(name);
      const parts = norm.split(' ').filter((w) => w.length >= 4);
      return norm.length >= 5 && (combined.includes(norm) || (parts.length > 0 && combined.includes(parts[parts.length - 1])));
    });
    const mentionsTeam = teamAliases.some((al) => al.length >= 3 && combined.includes(al));
    if (!mentionsTeam && matchedPlayers.length === 0) continue;

    const key = st.title.toLowerCase().slice(0, 65);
    if (seenHeadlines.has(key)) continue;
    seenHeadlines.add(key);

    const inferred = inferFootballStatusFromText(`${st.title} ${st.summary}`);
    items.push({
      id: `fb-news-${items.length}-${Date.now()}`,
      source: st.source,
      publishedAt: st.pubDate,
      headline: st.title,
      summary: st.summary || st.title,
      url: st.link,
      confirmed: inferred.confirmed,
      playerNames: matchedPlayers,
      statusTag: inferred.tag,
    });
  }

  const result: FootballNewsResult = {
    fetchedAt,
    sourcesChecked: sourcesChecked.length > 0 ? sourcesChecked : ['ESPN FC'],
    items: items.slice(0, 14),
  };
  FOOTBALL_NEWS_CACHE.set(cacheKey, { expiresAt: Date.now() + 180_000, payload: result });
  return result;
}

/**
 * Queries Google Search Grounding (via @google/genai gemini-4-hydrogen) prioritizing
 * official club sites, Marca, AS, Mundo Deportivo, SPORT, Relevo, ESPN, BBC Sport, and Sky Sports.
 */
export async function queryGeminiFootballSearchGrounding(
  match: MatchRecord
): Promise<FootballSearchGroundingResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      available: false,
      used: false,
      status: 'unconfigured',
      message:
        'GEMINI_API_KEY no configurada en el servidor. Se emplean únicamente fuentes directas en vivo (ESPN FC, BBC Sport, Sky Sports, Marca/AS RSS y plantilla/onces recientes) sin simular búsqueda Google.',
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const matchDate = new Date(match.kickoffIso).toISOString().slice(0, 10);
    const prompt = `Busca en Google la información más reciente sobre alineaciones probables o confirmadas, convocatorias, lesiones, sanciones, declaraciones de entrenadores y rotaciones para el partido de fútbol:
${match.homeTeam.name} vs ${match.awayTeam.name} (${match.competition}, fecha ${matchDate}).

Prioriza estrictamente:
1. Comunicados y webs oficiales de ${match.homeTeam.name} y ${match.awayTeam.name}.
2. Medios deportivos fiables: Marca, AS, Mundo Deportivo, SPORT, Relevo, ESPN, BBC Sport, Sky Sports.
3. Plataformas especializadas en posibles alineaciones.

Reglas críticas:
- Diferencia explícitamente entre alineación OFICIAL CONFIRMADA (confirmed=true, solo si el club/competición ya publicó el once oficial) y alineación PROBABLE / lesión / duda (confirmed=false).
- No inventes jugadores, noticias ni fechas. Si un dato no aparece publicado con claridad, no lo incluyas.
- Devuelve solo hallazgos concretos por jugador relevante (titulares esperados con dudas, bajas, sancionados, rotaciones o novedades de convocatoria).`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            officialLineupDetected: { type: Type.BOOLEAN },
            homeFormation: { type: Type.STRING },
            awayFormation: { type: Type.STRING },
            findings: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  playerName: { type: Type.STRING },
                  teamName: { type: Type.STRING },
                  status: {
                    type: Type.STRING,
                    enum: ['confirmed_starter', 'possible_starter', 'starter', 'probable', 'bench', 'doubtful', 'out', 'suspended'],
                  },
                  starterConfidence: { type: Type.NUMBER },
                  summary: { type: Type.STRING },
                  source: { type: Type.STRING },
                  publishedAt: { type: Type.STRING },
                  confirmed: { type: Type.BOOLEAN },
                },
                required: ['playerName', 'teamName', 'status', 'summary', 'source', 'confirmed'],
              },
            },
          },
          required: ['officialLineupDetected', 'findings'],
        },
      },
    });

    const rawText = (response.text ?? '{}').trim();
    const parsed = JSON.parse(rawText) as {
      officialLineupDetected?: boolean;
      homeFormation?: string;
      awayFormation?: string;
      findings?: FootballGroundingFinding[];
    };

    const candidates = (response as unknown as {
      candidates?: Array<{
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { title?: string; uri?: string } }>;
        };
      }>;
    }).candidates;

    const citations: Array<{ title: string; url: string }> = [];
    for (const chunk of candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
      if (chunk.web?.uri) {
        citations.push({
          title: chunk.web.title || 'Fuente deportiva web',
          url: chunk.web.uri,
        });
      }
    }

    return {
      available: true,
      used: true,
      status: 'active',
      message: `Google Search Grounding consultado (${parsed.findings?.length ?? 0} novedades contrastadas en medios y clubes).`,
      citations: citations.slice(0, 6),
      homeFormation: parsed.homeFormation || undefined,
      awayFormation: parsed.awayFormation || undefined,
      officialLineupDetected: Boolean(parsed.officialLineupDetected),
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  } catch (err) {
    return {
      available: true,
      used: false,
      status: 'error',
      message: `Error en Google Search Grounding: ${err instanceof Error ? err.message : 'desconocido'}`,
    };
  }
}

/**
 * Selects a balanced 11-player probable XI from roster & recent match starter frequencies,
 * applying press/injury updates and cross-source conflict confidence reductions.
 */
export function selectProbableSideFromHistory(
  history: EspnSoccerTeamLineupHistory,
  teamId: string,
  teamName: string,
  teamShort: string,
  newsItems: PlayerNewsItem[],
  groundingFindings: FootballGroundingFinding[]
): {
  starters: PlayerProfile[];
  subs: PlayerProfile[];
  absences: PlayerProfile[];
  allPlayers: PlayerProfile[];
  discrepancies: string[];
  avgStarterConfidence: number;
} {
  const discrepancies: string[] = [];

  const enriched = history.players.map((entry) => {
    const normEntry = normalizeNbaName(entry.name);
    const relatedNews = newsItems.filter((n) =>
      (n.playerNames ?? []).some((pn) => normalizeNbaName(pn) === normEntry)
    );
    const gFinding = groundingFindings.find(
      (f) =>
        normalizeNbaName(f.playerName) === normEntry ||
        normEntry.includes(normalizeNbaName(f.playerName))
    );

    const freq = history.matchesAnalyzed > 0 ? entry.recentStarts / history.matchesAnalyzed : 0.65;
    let conf = Math.round(52 + freq * 42);
    let availability: AvailabilityStatus = entry.availabilityFromTeam ?? 'possible_starter';
    let injuryNote = entry.injuryNote;
    let roleReason =
      history.matchesAnalyzed > 0
        ? `Titular en ${entry.recentStarts}/${history.matchesAnalyzed} últimos partidos (${history.sources[0]})`
        : 'Base plantilla del club';

    if (availability === 'out' || availability === 'suspended') {
      conf = 0;
    } else if (availability === 'doubtful') {
      conf = Math.min(48, conf);
    }

    if (relatedNews.length > 0) {
      const topNews = relatedNews[0];
      const inferred = inferFootballStatusFromText(`${topNews.headline} ${topNews.summary}`);
      if (inferred.status === 'out' || inferred.status === 'suspended') {
        if (entry.recentStarts >= 2) {
          discrepancies.push(
            `${teamShort}: ${entry.shortName} fue titular reciente (${entry.recentStarts}/${history.matchesAnalyzed}), pero ${topNews.source} reporta baja/sanción.`
          );
        }
        availability = inferred.status;
        conf = 0;
        injuryNote = `${topNews.source}: ${topNews.headline}`;
        roleReason = injuryNote;
      } else if (inferred.status === 'doubtful') {
        if (entry.recentStarts >= 2) {
          discrepancies.push(
            `${teamShort}: ${entry.shortName} es habitual en el once, aunque ${topNews.source} señala duda/rotación.`
          );
        }
        availability = 'doubtful';
        conf = Math.max(28, Math.min(58, conf + inferred.confidenceShift));
        injuryNote = `${topNews.source}: ${topNews.headline}`;
        roleReason = injuryNote;
      }
    }

    if (gFinding) {
      if (gFinding.status === 'out' || gFinding.status === 'suspended') {
        if (entry.recentStarts >= 2 && !discrepancies.some((d) => d.includes(entry.shortName))) {
          discrepancies.push(
            `${teamShort}: ${entry.shortName} aparece en onces recientes, pero ${gFinding.source} lo descarta.`
          );
        }
        availability = gFinding.status;
        conf = 0;
        injuryNote = `${gFinding.source}: ${gFinding.summary}`;
        roleReason = injuryNote;
      } else if (gFinding.status === 'doubtful' || gFinding.status === 'bench') {
        if (entry.recentStarts >= 2 && !discrepancies.some((d) => d.includes(entry.shortName))) {
          discrepancies.push(
            `${teamShort}: fuentes difieren sobre la titularidad de ${entry.shortName} (${gFinding.source}).`
          );
        }
        availability = gFinding.status;
        conf = gFinding.starterConfidence !== undefined ? Math.min(conf, gFinding.starterConfidence) : Math.max(22, conf - 28);
        roleReason = `${gFinding.source}: ${gFinding.summary}`;
      } else if (gFinding.starterConfidence !== undefined) {
        // Average with disagreement penalty if divergence > 25 pts
        const diff = Math.abs(conf - gFinding.starterConfidence);
        if (diff > 25) {
          discrepancies.push(
            `${teamShort}: divergencia entre histórico (${conf}%) y ${gFinding.source} (${gFinding.starterConfidence}%) para ${entry.shortName}.`
          );
          conf = Math.round((conf + gFinding.starterConfidence) / 2 - 8);
        } else {
          conf = Math.round(conf * 0.45 + gFinding.starterConfidence * 0.55);
        }
        roleReason = `${gFinding.source}: ${gFinding.summary}`;
      }
    }

    return { entry, availability, conf: Math.max(0, Math.min(96, conf)), injuryNote, roleReason };
  });

  const activeCandidates = enriched.filter(
    (e) => e.availability !== 'out' && e.availability !== 'suspended'
  );
  const absencesRaw = enriched.filter(
    (e) => e.availability === 'out' || e.availability === 'suspended'
  );

  // Pick 1 GK + up to 10 outfield players sorted by confidence & recentStarts
  const gk = activeCandidates.find((c) => c.entry.posCode === 'G');
  const outfield = activeCandidates
    .filter((c) => c !== gk)
    .sort((a, b) => b.conf - a.conf || b.entry.recentStarts - a.entry.recentStarts);

  const startersRaw = [...(gk ? [gk] : []), ...outfield].slice(0, 11);
  const starterIds = new Set(startersRaw.map((s) => s.entry.athleteId));
  const subsRaw = activeCandidates.filter((c) => !starterIds.has(c.entry.athleteId)).slice(0, 7);

  const starters = startersRaw.map((item, idx) => {
    const p = buildFootballPlayerFromHistory(
      { ...item.entry, availabilityFromTeam: item.availability === 'doubtful' ? 'doubtful' : 'possible_starter', injuryNote: item.injuryNote },
      idx,
      true,
      history.matchesAnalyzed,
      teamId,
      teamName,
      teamShort,
      false
    );
    return {
      ...p,
      starterConfidence: item.conf,
      roleReason: item.roleReason,
    };
  });

  const subs = subsRaw.map((item, idx) => {
    const p = buildFootballPlayerFromHistory(
      { ...item.entry, availabilityFromTeam: 'bench', injuryNote: item.injuryNote },
      idx,
      false,
      history.matchesAnalyzed,
      teamId,
      teamName,
      teamShort,
      false
    );
    return {
      ...p,
      starterConfidence: Math.min(40, item.conf),
      roleReason: item.roleReason,
    };
  });

  const absences = absencesRaw.map((item, idx) => {
    const p = buildFootballPlayerFromHistory(
      { ...item.entry, availabilityFromTeam: item.availability, injuryNote: item.injuryNote },
      idx,
      false,
      history.matchesAnalyzed,
      teamId,
      teamName,
      teamShort,
      false
    );
    return {
      ...p,
      starterConfidence: 0,
      roleReason: item.roleReason,
    };
  });

  const avgStarterConfidence =
    starters.length > 0
      ? Math.round(starters.reduce((acc, s) => acc + (s.starterConfidence ?? 65), 0) / starters.length)
      : 0;

  return {
    starters,
    subs,
    absences,
    allPlayers: [...starters, ...subs, ...absences],
    discrepancies,
    avgStarterConfidence,
  };
}

/**
 * Pure deterministic helper that promotes official published starting XIs into
 * `confirmedLineup` + `lineupStatus: 'confirmed'` while preserving any previously
 * calculated `probableLineup` for side-by-side audit and comparison.
 */
export function promoteOfficialToConfirmedLineup(
  match: MatchRecord,
  officialHomePlayers: PlayerProfile[],
  officialAwayPlayers: PlayerProfile[],
  officialSource: string,
  publishedAt?: string,
  homeFormation?: string,
  awayFormation?: string
): MatchRecord {
  const nowIso = new Date().toISOString();
  const isStarter = (p: PlayerProfile) =>
    p.availability === 'confirmed_starter' || p.availability === 'starter';

  const normalizeConfirmed = (list: PlayerProfile[]): PlayerProfile[] =>
    list.map((p) =>
      isStarter(p)
        ? {
            ...p,
            availability: 'confirmed_starter',
            availabilityConfidence: 'confirmed',
            starterConfidence: 100,
            roleReason: `Titular confirmado (${officialSource})`,
          }
        : {
            ...p,
            availabilityConfidence: 'confirmed',
            starterConfidence: p.availability === 'out' || p.availability === 'suspended' ? 0 : 15,
          }
    );

  const normHome = normalizeConfirmed(officialHomePlayers);
  const normAway = normalizeConfirmed(officialAwayPlayers);

  const confirmedLineup: FootballLineupSnapshot = {
    confirmed: true,
    homeFormation: homeFormation ?? match.homeTeam.formation,
    awayFormation: awayFormation ?? match.awayTeam.formation,
    homeStarters: normHome.filter((p) => p.availability === 'confirmed_starter').slice(0, 11),
    awayStarters: normAway.filter((p) => p.availability === 'confirmed_starter').slice(0, 11),
    homeSubs: normHome.filter((p) => p.availability === 'bench'),
    awaySubs: normAway.filter((p) => p.availability === 'bench'),
    homeAbsences: normHome.filter((p) => p.availability === 'out' || p.availability === 'suspended' || p.availability === 'doubtful'),
    awayAbsences: normAway.filter((p) => p.availability === 'out' || p.availability === 'suspended' || p.availability === 'doubtful'),
    sourcesConsulted: [officialSource],
    officialSource,
    publishedAt: publishedAt ?? nowIso,
    updatedAt: nowIso,
    overallConfidence: 100,
    discrepancyDetected: false,
    notes: [`Once oficial confirmado publicado por ${officialSource}.`],
  };

  return {
    ...match,
    homeTeam: {
      ...match.homeTeam,
      formation: confirmedLineup.homeFormation ?? match.homeTeam.formation,
    },
    awayTeam: {
      ...match.awayTeam,
      formation: confirmedLineup.awayFormation ?? match.awayTeam.formation,
    },
    lineupStatus: 'confirmed',
    homePlayers: normHome,
    awayPlayers: normAway,
    probableLineup: match.probableLineup,
    confirmedLineup,
    updatedAt: nowIso,
  };
}

/**
 * Orchestrates early Football Probable Lineup synthesis (available hours before kickoff)
 * using ESPN match history + trusted press RSS + optional Google Search Grounding.
 */
export async function buildProbableFootballLineups(params: {
  match: MatchRecord;
  slug: string;
  homeEspnTeamId?: string;
  awayEspnTeamId?: string;
  includeSearchGrounding?: boolean;
  forceRefresh?: boolean;
}): Promise<{
  probableLineup?: FootballLineupSnapshot;
  homePlayers: PlayerProfile[];
  awayPlayers: PlayerProfile[];
  homeFormation?: string;
  awayFormation?: string;
  footballNews: FootballNewsBundle;
}> {
  const { match, slug, homeEspnTeamId, awayEspnTeamId, includeSearchGrounding = false, forceRefresh = false } = params;
  const nowIso = new Date().toISOString();

  const [homeHist, awayHist, externalNews, grounding] = await Promise.all([
    homeEspnTeamId
      ? fetchEspnSoccerTeamLineupHistory(slug, homeEspnTeamId, match.homeTeam.name, match.homeTeam.shortName)
      : Promise.resolve(null),
    awayEspnTeamId
      ? fetchEspnSoccerTeamLineupHistory(slug, awayEspnTeamId, match.awayTeam.name, match.awayTeam.shortName)
      : Promise.resolve(null),
    fetchFootballExternalNews({
      slug,
      homeTeamName: match.homeTeam.name,
      awayTeamName: match.awayTeam.name,
      homeShort: match.homeTeam.shortName,
      awayShort: match.awayTeam.shortName,
      playerNames: [
        ...match.homePlayers.map((p) => p.name),
        ...match.awayPlayers.map((p) => p.name),
      ],
      forceRefresh,
    }),
    includeSearchGrounding
      ? queryGeminiFootballSearchGrounding(match)
      : Promise.resolve<FootballSearchGroundingResult>({
          available: Boolean(process.env.GEMINI_API_KEY?.trim()),
          used: false,
          status: process.env.GEMINI_API_KEY?.trim() ? 'active' : 'unconfigured',
          message: process.env.GEMINI_API_KEY?.trim()
            ? 'Google Search Grounding listo. Pulsa «Actualizar alineaciones y noticias» para contrastar en directo clubes oficiales y prensa (Marca, AS, MD, SPORT, Relevo, ESPN, BBC, Sky).'
            : 'GEMINI_API_KEY no configurada en el servidor. Se consultan únicamente históricos recientes ESPN, BBC Sport, Sky Sports y prensa RSS sin simular búsqueda Google.',
        }),
  ]);

  const gFindings = grounding.findings ?? [];
  const mergedNews = [...externalNews.items];
  const sourcesConsulted = Array.from(
    new Set([
      ...(homeHist?.sources ?? []),
      ...(awayHist?.sources ?? []),
      ...externalNews.sourcesChecked,
      ...(grounding.used ? ['Google Search Grounding (Clubes + Marca/AS/MD/SPORT/Relevo/ESPN/BBC/Sky)'] : []),
    ])
  );

  for (const f of gFindings) {
    mergedNews.unshift({
      id: `fb-ground-${normalizeNbaName(f.playerName)}-${Date.now()}`,
      source: f.source || 'Google Search Grounding',
      publishedAt: parseValidPublishedAt(f.publishedAt),
      headline: `${f.playerName} (${f.teamName}) · ${f.status}`,
      summary: f.summary,
      url: grounding.citations?.[0]?.url,
      confirmed: f.confirmed,
      playerNames: [f.playerName],
      statusTag: f.confirmed ? 'Oficial' : 'Alineación probable / Prensa',
    });
  }

  const footballNews: FootballNewsBundle = {
    fetchedAt: nowIso,
    sourcesChecked: sourcesConsulted,
    searchGrounding: {
      available: grounding.available,
      used: grounding.used,
      status: grounding.status,
      message: grounding.message,
      citations: grounding.citations,
    },
    items: mergedNews.slice(0, 18),
  };

  if (!homeHist && !awayHist) {
    return {
      probableLineup: undefined,
      homePlayers: match.homePlayers,
      awayPlayers: match.awayPlayers,
      footballNews,
    };
  }

  const homeSel = homeHist
    ? selectProbableSideFromHistory(
        homeHist,
        match.homeTeam.id,
        match.homeTeam.name,
        match.homeTeam.shortName,
        mergedNews,
        gFindings
      )
    : null;
  const awaySel = awayHist
    ? selectProbableSideFromHistory(
        awayHist,
        match.awayTeam.id,
        match.awayTeam.name,
        match.awayTeam.shortName,
        mergedNews,
        gFindings
      )
    : null;

  const discrepancies = [...(homeSel?.discrepancies ?? []), ...(awaySel?.discrepancies ?? [])];
  const avgConf = Math.round(
    ((homeSel?.avgStarterConfidence ?? 0) + (awaySel?.avgStarterConfidence ?? 0)) /
      (homeSel && awaySel ? 2 : 1)
  );

  const probableLineup: FootballLineupSnapshot = {
    confirmed: false,
    homeFormation: grounding.homeFormation ?? homeHist?.formation ?? match.homeTeam.formation ?? '4-3-3',
    awayFormation: grounding.awayFormation ?? awayHist?.formation ?? match.awayTeam.formation ?? '4-2-3-1',
    homeStarters: homeSel?.starters ?? [],
    awayStarters: awaySel?.starters ?? [],
    homeSubs: homeSel?.subs ?? [],
    awaySubs: awaySel?.subs ?? [],
    homeAbsences: homeSel?.absences ?? [],
    awayAbsences: awaySel?.absences ?? [],
    sourcesConsulted,
    updatedAt: nowIso,
    overallConfidence: discrepancies.length > 0 ? Math.max(35, avgConf - 10) : avgConf,
    discrepancyDetected: discrepancies.length > 0,
    discrepancyNote: discrepancies.length > 0 ? discrepancies.join(' ') : undefined,
    notes: [
      `Alineación probable calculada con onces recientes (${Math.max(homeHist?.matchesAnalyzed ?? 0, awayHist?.matchesAnalyzed ?? 0)} partidos), estado físico y fuentes deportivas consultadas. No es oficial hasta confirmación del club/competición.`,
    ],
  };

  return {
    probableLineup,
    homePlayers: homeSel?.allPlayers ?? match.homePlayers,
    awayPlayers: awaySel?.allPlayers ?? match.awayPlayers,
    homeFormation: probableLineup.homeFormation,
    awayFormation: probableLineup.awayFormation,
    footballNews,
  };
}
