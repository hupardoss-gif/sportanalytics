import type {
  AvailabilityStatus,
  BookmakerOdd,
  MatchRecord,
  MatchStatus,
  PlayerGameLogEntry,
  PlayerProfile,
  StandingEntry,
  StatSplitValues,
  TeamRecentGame,
  TimeframeSplit,
} from '../src/types/sports.ts';
import {
  applyNewsAndInjuriesToNbaPlayers,
  detectMinutesRestriction,
  fetchNbaExternalNews,
  fetchOfficialNbaInjuriesFeed,
  normalizeNbaName,
  type ParsedInjuryRecord,
} from './nbaIntelligence.ts';

type AnyObj = Record<string, unknown>;

function isoDateOffset(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function yyyymmddOffset(days: number): string {
  return isoDateOffset(days).replace(/-/g, '');
}

export function americanToDecimal(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  if (s === 'EVEN' || s === 'EV') return 2.0;
  const n = Number(s.replace('+', ''));
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 0) return +(1 + n / 100).toFixed(3);
  return +(1 + 100 / Math.abs(n)).toFixed(3);
}

export function normalizeTeamKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|cd|ud|sd|rc|rcd|ac|as|sc|club|deportivo|baloncesto|basketball)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function teamsMatch(a: string, b: string): boolean {
  const na = normalizeTeamKey(a);
  const nb = normalizeTeamKey(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const tokA = na.split(' ').filter((t) => t.length >= 3);
  const tokB = nb.split(' ').filter((t) => t.length >= 3);
  if (tokA.length === 0 || tokB.length === 0) return false;
  const shared = tokA.filter((t) => tokB.includes(t));
  return shared.length >= 1 && (shared[0].length >= 5 || shared.length >= 2);
}

function mapEspnFootballStatus(ev: AnyObj): { status: MatchStatus; clock?: string } {
  const comp = ((ev.competitions as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
  const st = ((comp.status ?? ev.status) as AnyObj | undefined) ?? {};
  const typeObj = (st.type as AnyObj | undefined) ?? {};
  const state = String(typeObj.state ?? '').toLowerCase();
  if (state === 'in') {
    return { status: 'live', clock: String(st.displayClock ?? typeObj.shortDetail ?? 'En directo') };
  }
  if (state === 'post' || typeObj.completed === true) {
    return { status: 'finished' };
  }
  const day = String(ev.date ?? '').slice(0, 10);
  const today = isoDateOffset(0);
  if (day < today) return { status: 'finished' };
  if (day === today) return { status: 'today' };
  return { status: 'upcoming' };
}

function parseEspnOddsArray(
  oddsArr: unknown,
  matchId: string,
  sport: 'football' | 'nba',
  homeName: string,
  awayName: string,
  updatedAt: string
): BookmakerOdd[] {
  if (!Array.isArray(oddsArr) || oddsArr.length === 0) return [];
  const primary = (oddsArr[0] ?? {}) as AnyObj;
  const provider = (primary.provider as AnyObj | undefined) ?? {};
  const bookmaker = String(provider.displayName ?? provider.name ?? 'DraftKings (ESPN)');
  const parsed: BookmakerOdd[] = [];

  const ml = (primary.moneyline as AnyObj | undefined) ?? {};
  const homeMl = americanToDecimal(
    (ml.home as AnyObj | undefined)?.close && ((ml.home as AnyObj).close as AnyObj).odds
      ? ((ml.home as AnyObj).close as AnyObj).odds
      : (primary.homeTeamOdds as AnyObj | undefined)?.moneyLine
  );
  const awayMl = americanToDecimal(
    (ml.away as AnyObj | undefined)?.close && ((ml.away as AnyObj).close as AnyObj).odds
      ? ((ml.away as AnyObj).close as AnyObj).odds
      : (primary.awayTeamOdds as AnyObj | undefined)?.moneyLine
  );
  const drawMl = americanToDecimal(
    (ml.draw as AnyObj | undefined)?.close && ((ml.draw as AnyObj).close as AnyObj).odds
      ? ((ml.draw as AnyObj).close as AnyObj).odds
      : (primary.drawOdds as AnyObj | undefined)?.moneyLine
  );

  if (sport === 'football' && homeMl && drawMl && awayMl) {
    const threeWay: [number, number, number] = [homeMl, drawMl, awayMl];
    parsed.push({
      id: `${matchId}-espn-1x2-home`,
      marketCategory: 'match',
      marketLabel: 'Resultado Final (1X2)',
      selectionLabel: `Victoria ${homeName}`,
      side: 'home',
      decimalOdds: homeMl,
      threeWayOdds: threeWay,
      bookmaker,
      updatedAt,
    });
    parsed.push({
      id: `${matchId}-espn-1x2-draw`,
      marketCategory: 'match',
      marketLabel: 'Resultado Final (1X2)',
      selectionLabel: 'Empate',
      side: 'draw',
      decimalOdds: drawMl,
      threeWayOdds: threeWay,
      bookmaker,
      updatedAt,
    });
    parsed.push({
      id: `${matchId}-espn-1x2-away`,
      marketCategory: 'match',
      marketLabel: 'Resultado Final (1X2)',
      selectionLabel: `Victoria ${awayName}`,
      side: 'away',
      decimalOdds: awayMl,
      threeWayOdds: threeWay,
      bookmaker,
      updatedAt,
    });
  } else if (sport === 'nba' && homeMl && awayMl) {
    parsed.push({
      id: `${matchId}-espn-ml-home`,
      marketCategory: 'match',
      marketLabel: 'Ganador del Partido (Moneyline)',
      selectionLabel: homeName,
      side: 'home',
      decimalOdds: homeMl,
      complementOdds: awayMl,
      bookmaker,
      updatedAt,
    });
    parsed.push({
      id: `${matchId}-espn-ml-away`,
      marketCategory: 'match',
      marketLabel: 'Ganador del Partido (Moneyline)',
      selectionLabel: awayName,
      side: 'away',
      decimalOdds: awayMl,
      complementOdds: homeMl,
      bookmaker,
      updatedAt,
    });
  }

  // Over / Under Total (football goals OR NBA total points)
  const totalObj = (primary.total as AnyObj | undefined) ?? {};
  const overClose = ((totalObj.over as AnyObj | undefined)?.close as AnyObj | undefined) ?? {};
  const underClose = ((totalObj.under as AnyObj | undefined)?.close as AnyObj | undefined) ?? {};
  const overOdds = americanToDecimal(overClose.odds ?? primary.overOdds);
  const underOdds = americanToDecimal(underClose.odds ?? primary.underOdds);
  const rawLineStr = String(overClose.line ?? primary.overUnder ?? '');
  const lineNum = Number(rawLineStr.replace(/[^0-9.]/g, ''));

  if (overOdds && underOdds && Number.isFinite(lineNum) && lineNum > 0) {
    parsed.push({
      id: `${matchId}-espn-ou-over`,
      marketCategory: 'totals',
      marketLabel: sport === 'football' ? 'Más / Menos Goles' : 'Total Puntos (O/U)',
      selectionLabel:
        sport === 'football' ? `Más de ${lineNum} goles` : `Más de ${lineNum} puntos`,
      line: lineNum,
      side: 'over',
      decimalOdds: overOdds,
      complementOdds: underOdds,
      bookmaker,
      updatedAt,
    });
    parsed.push({
      id: `${matchId}-espn-ou-under`,
      marketCategory: 'totals',
      marketLabel: sport === 'football' ? 'Más / Menos Goles' : 'Total Puntos (O/U)',
      selectionLabel:
        sport === 'football' ? `Menos de ${lineNum} goles` : `Menos de ${lineNum} puntos`,
      line: lineNum,
      side: 'under',
      decimalOdds: underOdds,
      complementOdds: overOdds,
      bookmaker,
      updatedAt,
    });
  }

  return parsed;
}

export const ESPN_SOCCER_LEAGUES: Array<{ slug: string; name: string }> = [
  { slug: 'esp.1', name: 'LaLiga (España)' },
  { slug: 'eng.1', name: 'Premier League' },
  { slug: 'ger.1', name: 'Bundesliga' },
  { slug: 'ita.1', name: 'Serie A' },
  { slug: 'fra.1', name: 'Ligue 1' },
  { slug: 'uefa.champions', name: 'UEFA Champions League' },
  { slug: 'uefa.europa', name: 'UEFA Europa League' },
  { slug: 'uefa.europa.conf', name: 'UEFA Conference League' },
  { slug: 'uefa.nations', name: 'UEFA Nations League' },
];

export async function fetchEspnSoccerEnrichment(): Promise<{
  matches: MatchRecord[];
  standings: StandingEntry[];
}> {
  const fetchedAt = new Date().toISOString();
  const matches: MatchRecord[] = [];
  const seen = new Set<string>();
  const todayStr = isoDateOffset(0);
  const maxStr = isoDateOffset(12);

  const ingestScoreboardJson = (lg: { slug: string; name: string }, json: { events?: AnyObj[] }) => {
    for (const ev of json.events ?? []) {
      const evId = String(ev.id ?? '');
      if (!evId || seen.has(evId)) continue;
      seen.add(evId);

      const comp = ((ev.competitions as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
      const competitors = (comp.competitors as AnyObj[] | undefined) ?? [];
      const homeC = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
      const awayC = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];
      if (!homeC || !awayC) continue;

      const homeTeam = (homeC.team as AnyObj | undefined) ?? {};
      const awayTeam = (awayC.team as AnyObj | undefined) ?? {};
      const homeName = String(homeTeam.displayName ?? homeTeam.name ?? 'Local');
      const awayName = String(awayTeam.displayName ?? awayTeam.name ?? 'Visitante');
      const { status, clock } = mapEspnFootballStatus(ev);

      const hScore = homeC.score !== undefined ? Number(homeC.score) : NaN;
      const aScore = awayC.score !== undefined ? Number(awayC.score) : NaN;
      const hasScore =
        (status === 'live' || status === 'finished') &&
        Number.isFinite(hScore) &&
        Number.isFinite(aScore);

      const odds = parseEspnOddsArray(
        comp.odds,
        `espnsoc-${lg.slug}-${evId}`,
        'football',
        homeName,
        awayName,
        fetchedAt
      );

      const homeForm = String(homeC.form ?? '')
        .slice(-5)
        .split('')
        .filter((c) => c === 'W' || c === 'D' || c === 'L') as ('W' | 'D' | 'L')[];
      const awayForm = String(awayC.form ?? '')
        .slice(-5)
        .split('')
        .filter((c) => c === 'W' || c === 'D' || c === 'L') as ('W' | 'D' | 'L')[];

      matches.push({
        id: `espnsoc-${lg.slug}-${evId}`,
        sport: 'football',
        competition: lg.name,
        season: 'Actual',
        status,
        kickoffIso: String(ev.date ?? fetchedAt),
        minuteOrClock: clock,
        venue: String((comp.venue as AnyObj | undefined)?.fullName ?? 'Estadio oficial'),
        homeTeam: {
          id: `espnsoc-team-${String(homeTeam.id ?? homeName)}`,
          name: homeName,
          shortName: String(homeTeam.abbreviation ?? homeName.slice(0, 3)).toUpperCase(),
          league: lg.name,
          record: String((homeC.records as AnyObj[] | undefined)?.[0]?.summary ?? 'Oficial'),
          formRecent: homeForm,
          restDays: 4,
        },
        awayTeam: {
          id: `espnsoc-team-${String(awayTeam.id ?? awayName)}`,
          name: awayName,
          shortName: String(awayTeam.abbreviation ?? awayName.slice(0, 3)).toUpperCase(),
          league: lg.name,
          record: String((awayC.records as AnyObj[] | undefined)?.[0]?.summary ?? 'Oficial'),
          formRecent: awayForm,
          restDays: 4,
        },
        score: hasScore ? { home: hScore, away: aScore } : undefined,
        lineupStatus: 'unknown',
        homePlayers: [],
        awayPlayers: [],
        h2hSummary: {
          played: 0,
          homeWins: 0,
          draws: 0,
          awayWins: 0,
          avgTotalPointsOrGoals: 2.5,
          lastMeetings: [],
        },
        odds,
        dataOrigin: 'ESPN Soccer + DraftKings',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      });
    }
  };

  await Promise.all(
    ESPN_SOCCER_LEAGUES.map(async (lg) => {
      try {
        const res = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg.slug}/scoreboard`
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          events?: AnyObj[];
          leagues?: Array<{ calendar?: string[] }>;
        };
        ingestScoreboardJson(lg, json);

        // Fetch up to 4 upcoming matchday dates from this league's calendar within the next 12 days
        const upcomingDates = Array.from(
          new Set(
            (json.leagues?.[0]?.calendar ?? [])
              .map((d) => String(d).slice(0, 10))
              .filter((d) => d >= todayStr && d <= maxStr)
          )
        ).slice(0, 4);

        if (upcomingDates.length > 0) {
          await Promise.all(
            upcomingDates.map(async (isoDay) => {
              try {
                const dParam = isoDay.replace(/-/g, '');
                const dRes = await fetch(
                  `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg.slug}/scoreboard?dates=${dParam}`
                );
                if (!dRes.ok) return;
                const dJson = (await dRes.json()) as { events?: AnyObj[] };
                ingestScoreboardJson(lg, dJson);
              } catch {
                // Skip single calendar date hiccup
              }
            })
          );
        }
      } catch {
        // Ignore single-league network hiccup
      }
    })
  );

  // Fetch ESPN Standings for top 5 European leagues (0 Football-Data rate-limit cost)
  const standings: StandingEntry[] = [];
  const standingLeagues = ESPN_SOCCER_LEAGUES.slice(0, 5);
  await Promise.all(
    standingLeagues.map(async (lg) => {
      try {
        const res = await fetch(
          `https://site.api.espn.com/apis/v2/sports/soccer/${lg.slug}/standings`
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          children?: Array<{
            standings?: {
              entries?: Array<{
                team?: AnyObj;
                stats?: Array<{ name?: string; value?: number; displayValue?: string }>;
              }>;
            };
          }>;
        };
        const entries = json.children?.[0]?.standings?.entries ?? [];
        const statVal = (
          stats: Array<{ name?: string; value?: number; displayValue?: string }>,
          key: string
        ) => stats.find((s) => s.name === key)?.value ?? 0;

        entries.forEach((entry, idx) => {
          const team = entry.team ?? {};
          const stats = entry.stats ?? [];
          const teamName = String(team.displayName ?? team.name ?? 'Equipo');
          const teamShort = String(team.abbreviation ?? teamName.slice(0, 3)).toUpperCase();
          const rank = Math.round(statVal(stats, 'rank')) || idx + 1;
          const played = Math.round(statVal(stats, 'gamesPlayed'));
          const won = Math.round(statVal(stats, 'wins'));
          const drawn = Math.round(statVal(stats, 'ties'));
          const lost = Math.round(statVal(stats, 'losses'));
          const gf = Math.round(statVal(stats, 'pointsFor'));
          const ga = Math.round(statVal(stats, 'pointsAgainst'));
          const pts = Math.round(statVal(stats, 'points'));

          standings.push({
            rank,
            teamId: `espnsoc-team-${String(team.id ?? teamShort)}`,
            teamName,
            teamShort,
            league: lg.name,
            played,
            won,
            drawn,
            lost,
            goalsForOrPtsFor: gf,
            goalsAgainstOrPtsAgainst: ga,
            diff: gf - ga,
            pointsOrWinPct: String(pts),
            form: [],
            homeRecord: '-',
            awayRecord: '-',
          });
        });
      } catch {
        // Ignore single standing failure
      }
    })
  );

  return { matches, standings };
}

export async function fetchEspnNbaCalendarAndStandings(): Promise<{
  matches: MatchRecord[];
  standings: StandingEntry[];
}> {
  const fetchedAt = new Date().toISOString();

  // Fetch NBA Standings first so every team gets real W-L, PPG, OPPG & Off/Def strengths
  const standings: StandingEntry[] = [];
  const teamMetaMap = new Map<
    string,
    {
      record: string;
      homeRecord: string;
      awayRecord: string;
      ppg: number;
      oppg: number;
      offRating: number;
      defRating: number;
    }
  >();

  try {
    const stRes = await fetch(
      'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings'
    );
    if (stRes.ok) {
      const stJson = (await stRes.json()) as { children?: AnyObj[] };
      for (const confNode of stJson.children ?? []) {
        const confName = String(confNode.name ?? '');
        const conf: 'Eastern' | 'Western' = confName.toLowerCase().includes('east')
          ? 'Eastern'
          : 'Western';
        const entries =
          ((confNode.standings as AnyObj | undefined)?.entries as AnyObj[] | undefined) ?? [];
        entries.forEach((entry, idx) => {
          const team = (entry.team as AnyObj | undefined) ?? {};
          const teamId = String(team.id ?? '');
          const statsArr = (entry.stats as AnyObj[] | undefined) ?? [];
          const getStatVal = (names: string[]): number => {
            const found = statsArr.find((s) => names.includes(String(s.name ?? '')));
            return found && found.value !== undefined ? Number(found.value) : 0;
          };
          const getStatDisp = (names: string[]): string => {
            const found = statsArr.find((s) => names.includes(String(s.name ?? '')));
            return found?.displayValue ? String(found.displayValue) : '-';
          };

          const wins = getStatVal(['wins']);
          const losses = getStatVal(['losses']);
          const played = Math.max(1, wins + losses);
          const ppg = getStatVal(['avgPointsFor', 'pointsFor']) / (getStatVal(['avgPointsFor']) > 0 ? 1 : played);
          const oppg = getStatVal(['avgPointsAgainst', 'pointsAgainst']) / (getStatVal(['avgPointsAgainst']) > 0 ? 1 : played);
          const avgPpg = getStatVal(['avgPointsFor']) || (ppg > 50 ? ppg : 114.5);
          const avgOppg = getStatVal(['avgPointsAgainst']) || (oppg > 50 ? oppg : 114.5);
          const pct = getStatDisp(['winPercent']) || (wins / played).toFixed(3);
          const homeRec = getStatDisp(['Home', 'home']);
          const awayRec = getStatDisp(['Road', 'away']);

          // Convert PPG/OPPG against league average (~114.5) into pace-adjusted ratings
          const offRating = Math.max(103, Math.min(125, avgPpg * (114.5 / 114.0)));
          const defRating = Math.max(103, Math.min(125, avgOppg * (114.5 / 114.0)));

          if (teamId) {
            teamMetaMap.set(teamId, {
              record: `${wins}-${losses}`,
              homeRecord: homeRec,
              awayRecord: awayRec,
              ppg: avgPpg,
              oppg: avgOppg,
              offRating,
              defRating,
            });
          }

          standings.push({
            rank: getStatVal(['playoffSeed', 'seed']) || idx + 1,
            teamId: `espn-nba-team-${teamId}`,
            teamName: String(team.displayName ?? team.name ?? 'NBA Team'),
            teamShort: String(team.abbreviation ?? 'NBA'),
            league: 'NBA',
            conference: conf,
            played: wins + losses,
            won: wins,
            lost: losses,
            goalsForOrPtsFor: Math.round(avgPpg * 10) / 10,
            goalsAgainstOrPtsAgainst: Math.round(avgOppg * 10) / 10,
            diff: Math.round((avgPpg - avgOppg) * 10) / 10,
            pointsOrWinPct: pct,
            form: [],
            homeRecord: homeRec,
            awayRecord: awayRec,
          });
        });
      }
    }
  } catch {
    // Continue even if standings call hiccups
  }

  // Fetch 16 days around today (-2 .. +13) so recent, today, live, and upcoming 2 weeks load
  const dateOffsets = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const dayBuckets = await Promise.all(
    dateOffsets.map(async (off) => {
      try {
        const res = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmddOffset(off)}`
        );
        if (!res.ok) return [] as AnyObj[];
        const json = (await res.json()) as { events?: AnyObj[] };
        return json.events ?? [];
      } catch {
        return [] as AnyObj[];
      }
    })
  );

  const seenEvents = new Set<string>();
  const matches: MatchRecord[] = [];

  for (const ev of dayBuckets.flat()) {
    const evId = String(ev.id ?? '');
    if (!evId || seenEvents.has(evId)) continue;
    seenEvents.add(evId);

    const comp = ((ev.competitions as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
    const competitors = (comp.competitors as AnyObj[] | undefined) ?? [];
    const homeC = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
    const awayC = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];
    if (!homeC || !awayC) continue;

    const hTeam = (homeC.team as AnyObj | undefined) ?? {};
    const aTeam = (awayC.team as AnyObj | undefined) ?? {};
    const homeId = String(hTeam.id ?? '');
    const awayId = String(aTeam.id ?? '');
    const homeName = String(hTeam.displayName ?? hTeam.name ?? 'Local NBA');
    const awayName = String(aTeam.displayName ?? aTeam.name ?? 'Visitante NBA');

    const st = ((comp.status ?? ev.status) as AnyObj | undefined) ?? {};
    const stType = (st.type as AnyObj | undefined) ?? {};
    const state = String(stType.state ?? '').toLowerCase();
    const kickoffIso = String(ev.date ?? fetchedAt);
    let status: MatchStatus = 'upcoming';
    if (state === 'in') status = 'live';
    else if (state === 'post' || stType.completed === true) status = 'finished';
    else {
      const day = kickoffIso.slice(0, 10);
      const today = isoDateOffset(0);
      if (day < today) status = 'finished';
      else if (day === today) status = 'today';
    }

    const hScore = homeC.score !== undefined ? Number(homeC.score) : NaN;
    const aScore = awayC.score !== undefined ? Number(awayC.score) : NaN;
    const hasScore =
      (status === 'live' || status === 'finished') &&
      Number.isFinite(hScore) &&
      Number.isFinite(aScore);

    const hMeta = teamMetaMap.get(homeId);
    const aMeta = teamMetaMap.get(awayId);
    const hRec = String(((homeC.records as AnyObj[] | undefined)?.[0]?.summary ?? hMeta?.record ?? 'NBA'));
    const aRec = String(((awayC.records as AnyObj[] | undefined)?.[0]?.summary ?? aMeta?.record ?? 'NBA'));

    const odds = parseEspnOddsArray(
      comp.odds,
      `espn-nba-${evId}`,
      'nba',
      homeName,
      awayName,
      fetchedAt
    );

    matches.push({
      id: `espn-nba-${evId}`,
      sport: 'nba',
      competition: 'NBA',
      season: '2025-26 / Actual',
      status,
      kickoffIso,
      minuteOrClock:
        status === 'live'
          ? `Q${String(st.period ?? '')} · ${String(st.displayClock ?? '')}`
          : undefined,
      venue: String(((comp.venue as AnyObj | undefined)?.fullName ?? 'NBA Arena')),
      homeTeam: {
        id: `espn-nba-team-${homeId}`,
        name: homeName,
        shortName: String(hTeam.abbreviation ?? homeName.slice(0, 3)).toUpperCase(),
        league: 'NBA',
        record: hRec,
        homeRecord: hMeta?.homeRecord,
        awayRecord: hMeta?.awayRecord,
        ppgOrGpg: hMeta?.ppg,
        oppgOrGapg: hMeta?.oppg,
        offRating: hMeta?.offRating,
        defRating: hMeta?.defRating,
        pace: 99.5,
        formRecent: [],
        restDays: 2,
      },
      awayTeam: {
        id: `espn-nba-team-${awayId}`,
        name: awayName,
        shortName: String(aTeam.abbreviation ?? awayName.slice(0, 3)).toUpperCase(),
        league: 'NBA',
        record: aRec,
        homeRecord: aMeta?.homeRecord,
        awayRecord: aMeta?.awayRecord,
        ppgOrGpg: aMeta?.ppg,
        oppgOrGapg: aMeta?.oppg,
        offRating: aMeta?.offRating,
        defRating: aMeta?.defRating,
        pace: 99.5,
        formRecent: [],
        restDays: 2,
      },
      score: hasScore ? { home: hScore, away: aScore } : undefined,
      lineupStatus: status === 'live' || status === 'finished' ? 'confirmed' : 'provisional',
      homePlayers: [],
      awayPlayers: [],
      h2hSummary: {
        played: 0,
        homeWins: 0,
        draws: 0,
        awayWins: 0,
        avgTotalPointsOrGoals: 224,
        lastMeetings: [],
      },
      odds,
      dataOrigin: 'ESPN NBA Oficial + DraftKings',
      updatedAt: fetchedAt,
      isOfflineReference: false,
    });
  }

  return { matches, standings };
}

function mapNbaSlotCoord(pos: string, idx: number): { x: number; y: number } {
  const p = (pos || '').toUpperCase();
  if (p.includes('PG') || idx === 0) return { x: 50, y: 63 };
  if (p.includes('SG') || idx === 1) return { x: 78, y: 71 };
  if (p.includes('SF') || idx === 2) return { x: 20, y: 74 };
  if (p.includes('PF') || idx === 3) return { x: 66, y: 84 };
  return { x: 38, y: 87 };
}

function mapFootballGridCoord(idx: number, total: number, posCode: string): { x: number; y: number } {
  if (posCode === 'G' || idx === 0) return { x: 50, y: 92 };
  if (posCode === 'D' || idx <= 4) {
    const col = Math.min(3, Math.max(0, idx - 1));
    return { x: 16 + col * 22, y: 75 };
  }
  if (posCode === 'M' || idx <= 7) {
    const col = Math.min(2, Math.max(0, idx - 5));
    return { x: 24 + col * 26, y: 54 };
  }
  return { x: 20 + ((idx - 8) / Math.max(1, total - 8)) * 60, y: 24 };
}

function emptyNbaSplit(): StatSplitValues {
  return {
    games: 0,
    minutes: 0,
    starterRate: 0,
    points: 0,
    rebounds: 0,
    assists: 0,
    threes: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
  };
}

function avgStatsFromEntries(
  entries: Array<{
    isHome: boolean;
    opponentId: string;
    minutes: number;
    points: number;
    rebounds: number;
    assists: number;
    threes: number;
    steals: number;
    blocks: number;
    turnovers: number;
  }>,
  starterRate: number
): StatSplitValues {
  if (entries.length === 0) return emptyNbaSplit();
  const n = entries.length;
  const sum = entries.reduce(
    (acc, e) => ({
      minutes: acc.minutes + e.minutes,
      points: acc.points + e.points,
      rebounds: acc.rebounds + e.rebounds,
      assists: acc.assists + e.assists,
      threes: acc.threes + e.threes,
      steals: acc.steals + e.steals,
      blocks: acc.blocks + e.blocks,
      turnovers: acc.turnovers + e.turnovers,
    }),
    { minutes: 0, points: 0, rebounds: 0, assists: 0, threes: 0, steals: 0, blocks: 0, turnovers: 0 }
  );
  return {
    games: n,
    minutes: +(sum.minutes / n).toFixed(1),
    starterRate,
    points: +(sum.points / n).toFixed(1),
    rebounds: +(sum.rebounds / n).toFixed(1),
    assists: +(sum.assists / n).toFixed(1),
    threes: +(sum.threes / n).toFixed(1),
    steals: +(sum.steals / n).toFixed(1),
    blocks: +(sum.blocks / n).toFixed(1),
    turnovers: +(sum.turnovers / n).toFixed(1),
  };
}

async function fetchEspnNbaAthleteGamelog(
  athleteId: string,
  oppEspnId: string,
  starterRate: number
): Promise<{
  splits: Record<TimeframeSplit, StatSplitValues>;
  recentLogs: PlayerGameLogEntry[];
  sampleSizeGames: number;
} | null> {
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${athleteId}/gamelog`
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      names?: string[];
      labels?: string[];
      events?: Record<string, AnyObj>;
      seasonTypes?: Array<{
        categories?: Array<{
          events?: Array<{ eventId: string; stats: string[] }>;
          totals?: string[];
        }>;
      }>;
    };

    const labels = (json.labels ?? json.names ?? []).map((s) => s.toUpperCase());
    const idxOf = (cands: string[]) => labels.findIndex((l) => cands.includes(l));
    const iMin = idxOf(['MIN']);
    const i3pt = idxOf(['3PT', '3PM']);
    const iReb = idxOf(['REB']);
    const iAst = idxOf(['AST']);
    const iBlk = idxOf(['BLK']);
    const iStl = idxOf(['STL']);
    const iTo = idxOf(['TO']);
    const iPts = idxOf(['PTS']);

    const parseMade = (val: string | undefined): number => {
      if (!val) return 0;
      const part = val.includes('-') ? val.split('-')[0] : val;
      const n = Number(part);
      return Number.isFinite(n) ? n : 0;
    };

    const rawEvents = json.seasonTypes?.[0]?.categories?.[0]?.events ?? [];
    const evMeta = json.events ?? {};

    const parsedGames = rawEvents.map((row) => {
      const s = row.stats ?? [];
      const meta = evMeta[row.eventId] ?? {};
      const opp = (meta.opponent as AnyObj | undefined) ?? {};
      return {
        eventId: row.eventId,
        date: String(meta.gameDate ?? '').slice(0, 10),
        opponent: String(opp.abbreviation ?? 'NBA'),
        opponentId: String(opp.id ?? ''),
        isHome: String(meta.atVs ?? '') === 'vs',
        minutes: Number(s[iMin]) || 0,
        points: Number(s[iPts]) || 0,
        rebounds: Number(s[iReb]) || 0,
        assists: Number(s[iAst]) || 0,
        threes: parseMade(s[i3pt]),
        steals: Number(s[iStl]) || 0,
        blocks: Number(s[iBlk]) || 0,
        turnovers: Number(s[iTo]) || 0,
      };
    });

    if (parsedGames.length === 0) return null;

    const seasonSplit = avgStatsFromEntries(parsedGames, starterRate);
    const l5 = avgStatsFromEntries(parsedGames.slice(0, 5), starterRate);
    const l10 = avgStatsFromEntries(parsedGames.slice(0, 10), starterRate);
    const l15 = avgStatsFromEntries(parsedGames.slice(0, 15), starterRate);
    const homeArr = parsedGames.filter((g) => g.isHome);
    const awayArr = parsedGames.filter((g) => !g.isHome);
    const h2hArr = parsedGames.filter((g) => g.opponentId === oppEspnId);

    const recentLogs: PlayerGameLogEntry[] = parsedGames.slice(0, 5).map((g) => ({
      date: g.date,
      opponent: g.opponent,
      isHome: g.isHome,
      minutes: g.minutes,
      stats: {
        points: g.points,
        rebounds: g.rebounds,
        assists: g.assists,
        threes: g.threes,
        steals: g.steals,
        blocks: g.blocks,
        turnovers: g.turnovers,
      },
    }));

    return {
      splits: {
        season: seasonSplit,
        last5: l5,
        last10: l10,
        last15: l15,
        home: homeArr.length ? avgStatsFromEntries(homeArr, starterRate) : seasonSplit,
        away: awayArr.length ? avgStatsFromEntries(awayArr, starterRate) : seasonSplit,
        h2h: h2hArr.length ? avgStatsFromEntries(h2hArr, starterRate) : seasonSplit,
      },
      recentLogs,
      sampleSizeGames: parsedGames.length,
    };
  } catch {
    return null;
  }
}

export async function hydrateEspnNbaMatch(baseMatch: MatchRecord): Promise<MatchRecord> {
  const fetchedAt = new Date().toISOString();
  const eventId = baseMatch.id.replace('espn-nba-', '');
  const homeTeamId = baseMatch.homeTeam.id.replace('espn-nba-team-', '');
  const awayTeamId = baseMatch.awayTeam.id.replace('espn-nba-team-', '');

  try {
    const [sumRes, homeRosterRes, awayRosterRes, homeSchedRes, awaySchedRes, homeStatRes, awayStatRes] =
      await Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null) as Promise<AnyObj | null>,
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${homeTeamId}/roster`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<AnyObj>,
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${awayTeamId}/roster`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<AnyObj>,
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${homeTeamId}/schedule`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<AnyObj>,
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${awayTeamId}/schedule`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<AnyObj>,
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${homeTeamId}/statistics`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<AnyObj>,
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${awayTeamId}/statistics`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<AnyObj>,
      ]);

    const parseTeamSchedule = (
      schedJson: AnyObj,
      espnTeamId: string
    ): {
      recentGames: TeamRecentGame[];
      formRecent: ('W' | 'D' | 'L')[];
      restDays: number;
      isBackToBack: boolean;
      lastCompletedEventId?: string;
    } => {
      const events = (schedJson.events as AnyObj[] | undefined) ?? [];
      const completed = events.filter((e) => {
        const comp = ((e.competitions as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
        const st = ((comp.status as AnyObj | undefined)?.type as AnyObj | undefined) ?? {};
        return st.completed === true && String(e.id) !== eventId;
      });
      const last15 = completed.slice(-15).reverse();
      const recentGames: TeamRecentGame[] = [];
      for (const e of last15) {
        const comp = ((e.competitions as AnyObj[] | undefined)?.[0] ?? {}) as AnyObj;
        const competitors = (comp.competitors as AnyObj[] | undefined) ?? [];
        const own = competitors.find((c) => String((c.team as AnyObj | undefined)?.id) === espnTeamId);
        const opp = competitors.find((c) => String((c.team as AnyObj | undefined)?.id) !== espnTeamId);
        if (!own || !opp) continue;
        const sf = Number((own.score as AnyObj | undefined)?.value ?? own.score ?? 0);
        const sa = Number((opp.score as AnyObj | undefined)?.value ?? opp.score ?? 0);
        recentGames.push({
          date: String(e.date ?? '').slice(0, 10),
          opponent: String((opp.team as AnyObj | undefined)?.abbreviation ?? 'OPP'),
          isHome: own.homeAway === 'home',
          scoreFor: sf,
          scoreAgainst: sa,
          result: sf >= sa ? 'W' : 'L',
        });
      }

      let restDays = 2;
      let isBackToBack = false;
      if (recentGames.length > 0 && recentGames[0].date) {
        const diffDays = Math.round(
          (new Date(baseMatch.kickoffIso.slice(0, 10)).getTime() -
            new Date(recentGames[0].date).getTime()) /
            86400000
        );
        if (Number.isFinite(diffDays) && diffDays >= 0 && diffDays <= 14) {
          restDays = diffDays;
          isBackToBack = diffDays <= 1;
        }
      }

      return {
        recentGames,
        formRecent: recentGames.slice(0, 5).map((g) => g.result).reverse(),
        restDays,
        isBackToBack,
        lastCompletedEventId: last15[0] ? String(last15[0].id) : undefined,
      };
    };

    const homeSched = parseTeamSchedule(homeSchedRes, homeTeamId);
    const awaySched = parseTeamSchedule(awaySchedRes, awayTeamId);

    // Fetch last completed game summaries if current game has no boxscore yet, to extract real starting 5
    const hasCurrentBoxscore =
      Array.isArray((sumRes?.boxscore as AnyObj | undefined)?.players) &&
      ((sumRes?.boxscore as AnyObj).players as unknown[]).length >= 2;

    const [homeLastBox, awayLastBox] = !hasCurrentBoxscore
      ? await Promise.all([
          homeSched.lastCompletedEventId
            ? fetch(
                `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${homeSched.lastCompletedEventId}`
              )
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null) as Promise<AnyObj | null>
            : Promise.resolve(null),
          awaySched.lastCompletedEventId
            ? fetch(
                `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${awaySched.lastCompletedEventId}`
              )
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null) as Promise<AnyObj | null>
            : Promise.resolve(null),
        ])
      : [sumRes, sumRes];

    const extractStarterIdsFromSummary = (
      summary: AnyObj | null,
      espnTeamId: string
    ): { starterIds: Set<string>; activeRotationIds: string[] } => {
      const starterIds = new Set<string>();
      const activeRotationIds: string[] = [];
      const playerGroups = ((summary?.boxscore as AnyObj | undefined)?.players as AnyObj[] | undefined) ?? [];
      const teamGroup = playerGroups.find(
        (g) => String((g.team as AnyObj | undefined)?.id) === espnTeamId
      );
      const athletes = ((teamGroup?.statistics as AnyObj[] | undefined)?.[0]?.athletes as AnyObj[] | undefined) ?? [];
      for (const row of athletes) {
        const aid = String((row.athlete as AnyObj | undefined)?.id ?? '');
        if (!aid) continue;
        if (row.starter === true) starterIds.add(aid);
        if (row.didNotPlay !== true) activeRotationIds.push(aid);
      }
      return { starterIds, activeRotationIds };
    };

    const homeBoxMeta = extractStarterIdsFromSummary(
      hasCurrentBoxscore ? sumRes : homeLastBox,
      homeTeamId
    );
    const awayBoxMeta = extractStarterIdsFromSummary(
      hasCurrentBoxscore ? sumRes : awayLastBox,
      awayTeamId
    );

    // Query official league-wide NBA injury feed in parallel/cached
    const officialInjFeed = await fetchOfficialNbaInjuriesFeed();
    const matchOfficialInjuries: ParsedInjuryRecord[] = [
      ...(officialInjFeed.byTeamId.get(homeTeamId) ?? []),
      ...(officialInjFeed.byTeamId.get(awayTeamId) ?? []),
    ];

    // Map injuries from tonight's summary + roster medical notes + official injury report
    const injuryMap = new Map<
      string,
      {
        status: AvailabilityStatus;
        note: string;
        confirmed: boolean;
        minutesRestriction?: { maxMinutes?: number; note: string };
      }
    >();

    const registerInjByNameOrId = (
      id: string,
      name: string,
      entry: {
        status: AvailabilityStatus;
        note: string;
        confirmed: boolean;
        minutesRestriction?: { maxMinutes?: number; note: string };
      }
    ) => {
      if (id) injuryMap.set(`id:${id}`, entry);
      if (name) injuryMap.set(`name:${normalizeNbaName(name)}`, entry);
    };

    for (const injRec of matchOfficialInjuries) {
      registerInjByNameOrId(injRec.athleteId, injRec.playerName, {
        status: injRec.status,
        note: injRec.summary,
        confirmed: injRec.confirmed,
        minutesRestriction: injRec.minutesRestriction,
      });
    }

    for (const teamInj of (sumRes?.injuries as AnyObj[] | undefined) ?? []) {
      for (const inj of (teamInj.injuries as AnyObj[] | undefined) ?? []) {
        const ath = (inj.athlete as AnyObj | undefined) ?? {};
        const aid = String(ath.id ?? '');
        const aName = String(ath.displayName ?? ath.fullName ?? '');
        const stRaw = String(inj.status ?? (inj.type as AnyObj | undefined)?.description ?? '').toLowerCase();
        const details = (inj.details as AnyObj | undefined) ?? {};
        const note = [inj.status, details.location, details.detail, inj.shortComment].filter(Boolean).join(' · ');
        const mapped: AvailabilityStatus =
          stRaw.includes('out') || stRaw.includes('suspen')
            ? 'out'
            : stRaw.includes('prob')
              ? 'probable'
              : stRaw.includes('doubt') || stRaw.includes('quest') || stRaw.includes('day')
                ? 'doubtful'
                : 'available';
        if (aid || aName) {
          const existing = (aid && injuryMap.get(`id:${aid}`)) || (aName && injuryMap.get(`name:${normalizeNbaName(aName)}`));
          if (!existing) {
            registerInjByNameOrId(aid, aName, {
              status: mapped,
              note: note || String(inj.status ?? 'Reporte médico'),
              confirmed: true,
              minutesRestriction: detectMinutesRestriction(note),
            });
          }
        }
      }
    }

    for (const rosterSide of [homeRosterRes, awayRosterRes]) {
      for (const ath of (rosterSide.athletes as AnyObj[] | undefined) ?? []) {
        const injuries = (ath.injuries as AnyObj[] | undefined) ?? [];
        if (injuries.length === 0) continue;
        const inj = injuries[0];
        const aid = String(ath.id ?? '');
        const aName = String(ath.fullName ?? ath.displayName ?? '');
        const stRaw = String(inj.status ?? '').toLowerCase();
        const shortC = String(inj.shortComment ?? inj.longComment ?? '');
        const mapped: AvailabilityStatus =
          stRaw.includes('out') || stRaw.includes('suspen')
            ? 'out'
            : stRaw.includes('prob')
              ? 'probable'
              : stRaw.includes('doubt') || stRaw.includes('quest') || stRaw.includes('day')
                ? 'doubtful'
                : 'available';
        const existing = (aid && injuryMap.get(`id:${aid}`)) || (aName && injuryMap.get(`name:${normalizeNbaName(aName)}`));
        if (!existing) {
          registerInjByNameOrId(aid, aName, {
            status: mapped,
            note: shortC || String(inj.status ?? 'Parte médico'),
            confirmed: true,
            minutesRestriction: detectMinutesRestriction(shortC),
          });
        }
      }
    }

    const findInj = (id: string, name: string) =>
      injuryMap.get(`id:${id}`) ?? injuryMap.get(`name:${normalizeNbaName(name)}`);

    const buildNbaSidePlayers = async (
      rosterJson: AnyObj,
      espnTeamId: string,
      oppEspnId: string,
      teamId: string,
      teamName: string,
      teamShort: string,
      boxMeta: { starterIds: Set<string>; activeRotationIds: string[] }
    ): Promise<PlayerProfile[]> => {
      const rawAthletes = (rosterJson.athletes as AnyObj[] | undefined) ?? [];
      if (rawAthletes.length === 0) return [];

      // Order: recent starters first, then recent active rotation, then rest of roster
      const rankScore = (a: AnyObj): number => {
        const id = String(a.id ?? '');
        const name = String(a.fullName ?? a.displayName ?? '');
        const inj = findInj(id, name);
        if (boxMeta.starterIds.has(id) && inj?.status !== 'out') return 0;
        const rotIdx = boxMeta.activeRotationIds.indexOf(id);
        if (rotIdx >= 0) return 1 + rotIdx;
        if (inj?.status === 'out') return 50;
        return 30;
      };
      const sorted = [...rawAthletes].sort((a, b) => rankScore(a) - rankScore(b));
      const selected = sorted.slice(0, 11);

      // Count healthy starters so we assign 5 starters (confirmed_starter if official boxscore locked, else possible_starter)
      let starterAssigned = 0;
      const starterStatus: AvailabilityStatus = hasCurrentBoxscore
        ? 'confirmed_starter'
        : 'possible_starter';

      const candidateMeta = selected.map((a, idx) => {
        const id = String(a.id ?? '');
        const name = String(a.fullName ?? a.displayName ?? '');
        const inj = findInj(id, name);
        const wasStarter = boxMeta.starterIds.has(id);
        let availability: AvailabilityStatus = 'available';
        if (inj?.status === 'out') {
          availability = 'out';
        } else if (inj?.status === 'doubtful') {
          availability = 'doubtful';
          if (wasStarter && starterAssigned < 5) starterAssigned += 1;
        } else if (inj?.status === 'probable') {
          availability = 'probable';
          if (wasStarter && starterAssigned < 5) starterAssigned += 1;
        } else if ((wasStarter || boxMeta.starterIds.size === 0) && starterAssigned < 5) {
          availability = starterStatus;
          starterAssigned += 1;
        }
        return { a, id, idx, inj, availability };
      });

      // Promote top healthy available players to projected starter if a starter is OUT
      for (const item of candidateMeta) {
        if (starterAssigned >= 5) break;
        if (item.availability === 'available') {
          item.availability = starterStatus;
          starterAssigned += 1;
        }
      }

      const logs = await Promise.all(
        candidateMeta.map((item) =>
          fetchEspnNbaAthleteGamelog(
            item.id,
            oppEspnId,
            item.availability === 'confirmed_starter' ||
              item.availability === 'possible_starter'
              ? 0.92
              : 0.18
          )
        )
      );

      return candidateMeta.map((item, idx) => {
        const a = item.a;
        const pos = String((a.position as AnyObj | undefined)?.abbreviation ?? ['PG', 'SG', 'SF', 'PF', 'C'][idx % 5]);
        const name = String(a.fullName ?? a.displayName ?? `Jugador ${idx + 1}`);
        const headshot = (a.headshot as AnyObj | undefined)?.href;
        const gl = logs[idx];
        const isStarterAvail =
          item.availability === 'confirmed_starter' ||
          item.availability === 'possible_starter';

        const fallbackSplit: StatSplitValues = {
          games: 0,
          minutes: isStarterAvail ? 28 : 16,
          starterRate: isStarterAvail ? 0.85 : 0.15,
          points: 0,
          rebounds: 0,
          assists: 0,
          threes: 0,
          steals: 0,
          blocks: 0,
          turnovers: 0,
        };

        const splits = gl?.splits ?? {
          season: fallbackSplit,
          last5: fallbackSplit,
          last10: fallbackSplit,
          last15: fallbackSplit,
          home: fallbackSplit,
          away: fallbackSplit,
          h2h: fallbackSplit,
        };

        const pts = splits.season.points ?? 0;
        const ast = splits.season.assists ?? 0;
        const isStarterSlot = isStarterAvail || item.availability === 'doubtful' || item.availability === 'probable';

        return {
          id: `espn-nba-p-${item.id}`,
          sport: 'nba',
          name,
          shortName: String(a.shortName ?? name),
          teamId,
          teamName,
          teamShort,
          number: Number(a.jersey) || idx + 1,
          position: pos,
          photoUrl: typeof headshot === 'string' ? headshot : undefined,
          availability: item.availability,
          availabilityConfidence: item.inj?.confirmed
            ? 'confirmed'
            : hasCurrentBoxscore
              ? 'confirmed'
              : 'projected',
          injuryNote: item.inj?.note,
          minutesRestriction: item.inj?.minutesRestriction,
          isKeyPlayer: pts >= 12 || ast >= 4.5 || idx < 3,
          pitchCoord: isStarterSlot ? mapNbaSlotCoord(pos, idx) : undefined,
          impact: {
            offenseDelta: Math.max(1.2, Math.min(7.5, pts * 0.24)),
            defenseDelta: pos.includes('C') || pos.includes('F') ? 2.1 : 1.3,
            usageShare: Math.max(0.1, Math.min(0.34, (pts + ast * 1.4) / 115)),
            assistShare: Math.max(0.08, Math.min(0.42, ast / 25)),
          },
          splits,
          recentLogs: gl?.recentLogs ?? [],
          sampleSizeGames: gl?.sampleSizeGames ?? 0,
        };
      });
    };

    const [rawHomePlayers, rawAwayPlayers] = await Promise.all([
      buildNbaSidePlayers(
        homeRosterRes,
        homeTeamId,
        awayTeamId,
        baseMatch.homeTeam.id,
        baseMatch.homeTeam.name,
        baseMatch.homeTeam.shortName,
        homeBoxMeta
      ),
      buildNbaSidePlayers(
        awayRosterRes,
        awayTeamId,
        homeTeamId,
        baseMatch.awayTeam.id,
        baseMatch.awayTeam.name,
        baseMatch.awayTeam.shortName,
        awayBoxMeta
      ),
    ]);

    const externalNews = await fetchNbaExternalNews({
      homeEspnId: homeTeamId,
      awayEspnId: awayTeamId,
      homeTeamName: baseMatch.homeTeam.name,
      awayTeamName: baseMatch.awayTeam.name,
      homeShort: baseMatch.homeTeam.shortName,
      awayShort: baseMatch.awayTeam.shortName,
      playerNames: [...rawHomePlayers, ...rawAwayPlayers].map((p) => p.name),
      injuriesForMatch: matchOfficialInjuries,
    });

    const homePlayers = applyNewsAndInjuriesToNbaPlayers(
      rawHomePlayers,
      officialInjFeed.byTeamId.get(homeTeamId) ?? [],
      externalNews.items,
      hasCurrentBoxscore
    );
    const awayPlayers = applyNewsAndInjuriesToNbaPlayers(
      rawAwayPlayers,
      officialInjFeed.byTeamId.get(awayTeamId) ?? [],
      externalNews.items,
      hasCurrentBoxscore
    );

    // Parse real H2H from seasonseries or recent mutual games
    const seriesEvents: Array<{ date: string; home: string; away: string; score: string }> = [];
    let hWins = 0;
    let aWins = 0;
    let totalPts = 0;

    for (const series of (sumRes?.seasonseries as AnyObj[] | undefined) ?? []) {
      for (const se of (series.events as AnyObj[] | undefined) ?? []) {
        const stName = String(((se.statusType as AnyObj | undefined)?.name ?? se.status ?? '')).toLowerCase();
        if (!stName.includes('final') && stName !== 'post') continue;
        const comps = (se.competitors as AnyObj[] | undefined) ?? [];
        const c0 = comps.find((c) => c.homeAway === 'home') ?? comps[0];
        const c1 = comps.find((c) => c.homeAway === 'away') ?? comps[1];
        if (!c0 || !c1) continue;
        const s0 = Number(c0.score ?? 0);
        const s1 = Number(c1.score ?? 0);
        const t0 = String((c0.team as AnyObj | undefined)?.abbreviation ?? 'LOC');
        const t1 = String((c1.team as AnyObj | undefined)?.abbreviation ?? 'VIS');
        seriesEvents.push({
          date: String(se.date ?? '').slice(0, 10),
          home: t0,
          away: t1,
          score: `${s0} - ${s1}`,
        });
        totalPts += s0 + s1;
        const hWinner = s0 > s1 ? String((c0.team as AnyObj | undefined)?.id) : String((c1.team as AnyObj | undefined)?.id);
        if (hWinner === homeTeamId) hWins += 1;
        else aWins += 1;
      }
    }

    // Extract team statistics comparison
    const extractTeamStat = (statJson: AnyObj, statName: string): string => {
      const cats = ((statJson.results as AnyObj | undefined)?.stats as AnyObj | undefined)?.categories as AnyObj[] | undefined;
      for (const c of cats ?? []) {
        const found = ((c.stats as AnyObj[] | undefined) ?? []).find((s) => s.name === statName);
        if (found?.displayValue) return String(found.displayValue);
      }
      return '-';
    };

    const teamStats = [
      {
        label: 'Balance general',
        homeValue: baseMatch.homeTeam.record,
        awayValue: baseMatch.awayTeam.record,
      },
      {
        label: 'Local / Visitante',
        homeValue: baseMatch.homeTeam.homeRecord ?? '-',
        awayValue: baseMatch.awayTeam.awayRecord ?? '-',
      },
      {
        label: 'Puntos por partido',
        homeValue: baseMatch.homeTeam.ppgOrGpg ? baseMatch.homeTeam.ppgOrGpg.toFixed(1) : '-',
        awayValue: baseMatch.awayTeam.ppgOrGpg ? baseMatch.awayTeam.ppgOrGpg.toFixed(1) : '-',
      },
      {
        label: 'Puntos encajados',
        homeValue: baseMatch.homeTeam.oppgOrGapg ? baseMatch.homeTeam.oppgOrGapg.toFixed(1) : '-',
        awayValue: baseMatch.awayTeam.oppgOrGapg ? baseMatch.awayTeam.oppgOrGapg.toFixed(1) : '-',
      },
      {
        label: '% Triples (3P%)',
        homeValue: extractTeamStat(homeStatRes, 'threePointPct'),
        awayValue: extractTeamStat(awayStatRes, 'threePointPct'),
      },
      {
        label: 'Rebotes / partido',
        homeValue: extractTeamStat(homeStatRes, 'avgRebounds'),
        awayValue: extractTeamStat(awayStatRes, 'avgRebounds'),
      },
    ];

    const mergedOdds =
      baseMatch.odds.length > 0
        ? baseMatch.odds
        : parseEspnOddsArray(
            sumRes?.pickcenter ?? sumRes?.odds,
            baseMatch.id,
            'nba',
            baseMatch.homeTeam.name,
            baseMatch.awayTeam.name,
            fetchedAt
          );

    return {
      ...baseMatch,
      homeTeam: {
        ...baseMatch.homeTeam,
        formRecent: homeSched.formRecent,
        recentGames: homeSched.recentGames,
        restDays: homeSched.restDays,
        isBackToBack: homeSched.isBackToBack,
      },
      awayTeam: {
        ...baseMatch.awayTeam,
        formRecent: awaySched.formRecent,
        recentGames: awaySched.recentGames,
        restDays: awaySched.restDays,
        isBackToBack: awaySched.isBackToBack,
      },
      lineupStatus: hasCurrentBoxscore ? 'confirmed' : homePlayers.length >= 5 ? 'provisional' : 'unknown',
      homePlayers,
      awayPlayers,
      teamStats,
      h2hSummary: {
        played: seriesEvents.length,
        homeWins: hWins,
        draws: 0,
        awayWins: aWins,
        avgTotalPointsOrGoals: seriesEvents.length ? totalPts / seriesEvents.length : 224,
        lastMeetings: seriesEvents,
      },
      odds: mergedOdds,
      nbaNews: {
        fetchedAt,
        sourcesChecked: externalNews.sourcesChecked,
        searchGrounding: {
          available: Boolean(process.env.GEMINI_API_KEY?.trim()),
          used: false,
          status: process.env.GEMINI_API_KEY?.trim() ? 'active' : 'unconfigured',
          message: process.env.GEMINI_API_KEY?.trim()
            ? 'Google Search Grounding listo. Pulsa «Actualizar noticias y parte médico» para consultar fuentes web en directo.'
            : 'GEMINI_API_KEY no configurada en el servidor (Settings > Secrets). Se muestran únicamente los partes oficiales NBA y noticias en vivo (ESPN, RotoWire, Yahoo Sports y CBS Sports).',
        },
        items: externalNews.items,
      },
      hydrationStatus: homePlayers.length > 0 ? 'ok' : 'not_published',
      hydrationNote: hasCurrentBoxscore
        ? 'Quintetos titulares confirmados, parte médico oficial y noticias actualizadas.'
        : 'Posibles titulares proyectados según rotaciones recientes + parte oficial de lesiones y noticias externas (los titulares definitivos se confirman ~30 min antes del inicio).',
      updatedAt: fetchedAt,
    };
  } catch (err) {
    return {
      ...baseMatch,
      hydrationStatus: 'network_error',
      hydrationNote: `Error consultando los datos NBA en vivo: ${err instanceof Error ? err.message : 'Fallo de red'}`,
      updatedAt: fetchedAt,
    };
  }
}

export async function hydrateEspnSoccerMatch(baseMatch: MatchRecord): Promise<MatchRecord> {
  const fetchedAt = new Date().toISOString();
  // id format: espnsoc-{slug}-{eventId}
  const rest = baseMatch.id.replace('espnsoc-', '');
  const lastDash = rest.lastIndexOf('-');
  const slug = rest.slice(0, lastDash);
  const eventId = rest.slice(lastDash + 1);

  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${eventId}`
    );
    if (!res.ok) {
      return {
        ...baseMatch,
        hydrationStatus: 'query_error',
        hydrationNote: `El proveedor ESPN Soccer devolvió HTTP ${res.status} al consultar el detalle del partido.`,
      };
    }
    const sum = (await res.json()) as AnyObj;
    const rosters = (sum.rosters as AnyObj[] | undefined) ?? [];

    const parseRoster = (
      sideIdx: number,
      teamId: string,
      teamName: string,
      teamShort: string
    ): { players: PlayerProfile[]; formation?: string; confirmed: boolean } => {
      const r = rosters[sideIdx];
      if (!r) return { players: [], confirmed: false };
      const rawPlayers = (r.roster as AnyObj[] | undefined) ?? [];
      const startersCount = rawPlayers.filter((p) => p.starter === true).length;
      const confirmed = startersCount >= 11;

      const mapped: PlayerProfile[] = rawPlayers.slice(0, 18).map((entry, idx) => {
        const ath = (entry.athlete as AnyObj | undefined) ?? {};
        const posObj = (entry.position as AnyObj | undefined) ?? (ath.position as AnyObj | undefined) ?? {};
        const posAbbr = String(posObj.abbreviation ?? 'M').toUpperCase();
        const posCode = posAbbr.includes('G') ? 'G' : posAbbr.includes('D') ? 'D' : posAbbr.includes('F') || posAbbr.includes('ST') ? 'F' : 'M';
        const isStarter = entry.starter === true || (startersCount === 0 && idx < 11);
        const isFwd = posCode === 'F';
        const isMid = posCode === 'M';

        return {
          id: `espnsoc-p-${String(ath.id ?? `${teamShort}-${idx}`)}`,
          sport: 'football',
          name: String(ath.displayName ?? ath.fullName ?? `Jugador ${idx + 1}`),
          shortName: String(ath.shortName ?? ath.lastName ?? `J.${idx + 1}`),
          teamId,
          teamName,
          teamShort,
          number: Number(entry.jersey) || idx + 1,
          position: String(posObj.displayName ?? posAbbr),
          availability: isStarter ? 'starter' : 'bench',
          isKeyPlayer: isStarter && (isFwd || idx < 4),
          pitchCoord: isStarter ? mapFootballGridCoord(idx, 11, posCode) : undefined,
          impact: {
            offenseDelta: isFwd ? 0.25 : isMid ? 0.13 : 0.04,
            defenseDelta: posCode === 'G' || posCode === 'D' ? 0.13 : 0.04,
            usageShare: isFwd ? 0.17 : isMid ? 0.1 : 0.03,
            assistShare: isMid ? 0.19 : isFwd ? 0.14 : 0.04,
          },
          splits: {
            season: { games: 10, minutes: isStarter ? 78 : 25, starterRate: isStarter ? 0.85 : 0.2, goals: isFwd ? 0.3 : isMid ? 0.12 : 0.04, assists: isMid ? 0.18 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.9 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
            last5: { games: 5, minutes: isStarter ? 78 : 25, starterRate: isStarter ? 0.85 : 0.2, goals: isFwd ? 0.3 : isMid ? 0.12 : 0.04, assists: isMid ? 0.18 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.9 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
            last10: { games: 10, minutes: isStarter ? 78 : 25, starterRate: isStarter ? 0.85 : 0.2, goals: isFwd ? 0.3 : isMid ? 0.12 : 0.04, assists: isMid ? 0.18 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.9 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
            last15: { games: 10, minutes: isStarter ? 78 : 25, starterRate: isStarter ? 0.85 : 0.2, goals: isFwd ? 0.3 : isMid ? 0.12 : 0.04, assists: isMid ? 0.18 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.9 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
            home: { games: 5, minutes: isStarter ? 78 : 25, starterRate: isStarter ? 0.85 : 0.2, goals: isFwd ? 0.32 : isMid ? 0.13 : 0.04, assists: isMid ? 0.19 : 0.08, shots: isFwd ? 2.3 : isMid ? 1.15 : 0.4, shotsOnTarget: isFwd ? 0.95 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
            away: { games: 5, minutes: isStarter ? 78 : 25, starterRate: isStarter ? 0.85 : 0.2, goals: isFwd ? 0.28 : isMid ? 0.11 : 0.04, assists: isMid ? 0.17 : 0.08, shots: isFwd ? 2.1 : isMid ? 1.05 : 0.4, shotsOnTarget: isFwd ? 0.85 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
            h2h: { games: 2, minutes: isStarter ? 78 : 25, starterRate: isStarter ? 0.85 : 0.2, goals: isFwd ? 0.3 : isMid ? 0.12 : 0.04, assists: isMid ? 0.18 : 0.08, shots: isFwd ? 2.2 : isMid ? 1.1 : 0.4, shotsOnTarget: isFwd ? 0.9 : 0.4, foulsCommitted: 0.9, foulsDrawn: 1.1, yellowCards: 0.15, redCards: 0.01, passes: isMid ? 46 : 32 },
          },
          recentLogs: [],
          sampleSizeGames: 10,
        };
      });

      return {
        players: mapped,
        formation: typeof r.formation === 'string' ? r.formation : undefined,
        confirmed,
      };
    };

    const homeR = parseRoster(0, baseMatch.homeTeam.id, baseMatch.homeTeam.name, baseMatch.homeTeam.shortName);
    const awayR = parseRoster(1, baseMatch.awayTeam.id, baseMatch.awayTeam.name, baseMatch.awayTeam.shortName);

    const h2hMeetings: Array<{ date: string; home: string; away: string; score: string }> = [];
    let hWins = 0;
    let draws = 0;
    let aWins = 0;
    let totalGoals = 0;

    for (const hg of (sum.headToHeadGames as AnyObj[] | undefined) ?? []) {
      for (const ev of (hg.events as AnyObj[] | undefined) ?? []) {
        const hName = String(ev.homeTeamName ?? baseMatch.homeTeam.shortName);
        const aName = String(ev.awayTeamName ?? baseMatch.awayTeam.shortName);
        const scoreStr = String(ev.score ?? '');
        const parts = scoreStr.split('-').map((x) => Number(x.trim()));
        if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
          totalGoals += parts[0] + parts[1];
          const homeIsCurrent = teamsMatch(hName, baseMatch.homeTeam.name);
          if (parts[0] === parts[1]) {
            draws += 1;
          } else if (parts[0] > parts[1]) {
            if (homeIsCurrent) hWins += 1;
            else aWins += 1;
          } else {
            if (homeIsCurrent) aWins += 1;
            else hWins += 1;
          }
        }
        h2hMeetings.push({
          date: String(ev.gameDate ?? '').slice(0, 10),
          home: hName,
          away: aName,
          score: scoreStr || '0 - 0',
        });
      }
    }

    const mergedOdds =
      baseMatch.odds.length > 0
        ? baseMatch.odds
        : parseEspnOddsArray(
            sum.pickcenter ?? sum.odds,
            baseMatch.id,
            'football',
            baseMatch.homeTeam.name,
            baseMatch.awayTeam.name,
            fetchedAt
          );

    return {
      ...baseMatch,
      homeTeam: { ...baseMatch.homeTeam, formation: homeR.formation ?? baseMatch.homeTeam.formation },
      awayTeam: { ...baseMatch.awayTeam, formation: awayR.formation ?? baseMatch.awayTeam.formation },
      lineupStatus: homeR.confirmed && awayR.confirmed ? 'confirmed' : homeR.players.length > 0 ? 'provisional' : 'unknown',
      homePlayers: homeR.players,
      awayPlayers: awayR.players,
      odds: mergedOdds,
      h2hSummary: {
        played: h2hMeetings.length,
        homeWins: hWins,
        draws,
        awayWins: aWins,
        avgTotalPointsOrGoals: h2hMeetings.length > 0 ? totalGoals / h2hMeetings.length : 2.5,
        lastMeetings: h2hMeetings.slice(0, 6),
      },
      hydrationStatus: homeR.players.length > 0 ? 'ok' : 'not_published',
      hydrationNote:
        homeR.players.length > 0
          ? homeR.confirmed
            ? 'Alineaciones oficiales confirmadas por el proveedor.'
            : 'Plantilla / once probable disponible previo a confirmación oficial.'
          : 'Alineación todavía no publicada por la competición (suele confirmarse ~60 min antes del inicio).',
      updatedAt: fetchedAt,
    };
  } catch (err) {
    return {
      ...baseMatch,
      hydrationStatus: 'network_error',
      hydrationNote: `Error de red al consultar detalle: ${err instanceof Error ? err.message : 'desconocido'}`,
      updatedAt: fetchedAt,
    };
  }
}

/**
 * Fetches real odds from The Odds API (when configured) and merges them cleanly onto existing Football & NBA matches.
 */
export async function fetchTheOddsApiForSport(
  sport: 'football' | 'nba',
  apiKey: string
): Promise<MatchRecord[]> {
  const fetchedAt = new Date().toISOString();
  const keys =
    sport === 'football'
      ? [
          'soccer_spain_la_liga',
          'soccer_epl',
          'soccer_germany_bundesliga',
          'soccer_italy_serie_a',
          'soccer_france_ligue_one',
          'soccer_uefa_champs_league',
          'soccer_uefa_europa_league',
        ]
      : ['basketball_nba'];

  const results = await Promise.all(
    keys.map(async (sk) => {
      try {
        const res = await fetch(
          `https://api.the-odds-api.com/v4/sports/${sk}/odds/?apiKey=${encodeURIComponent(
            apiKey.trim()
          )}&regions=eu&markets=h2h,totals`
        );
        if (!res.ok) return [];
        return (await res.json()) as Array<{
          id: string;
          sport_title: string;
          commence_time: string;
          home_team: string;
          away_team: string;
          bookmakers: Array<{
            title: string;
            last_update: string;
            markets: Array<{
              key: string;
              outcomes: Array<{ name: string; price: number; point?: number }>;
            }>;
          }>;
        }>;
      } catch {
        return [];
      }
    })
  );

  const out: MatchRecord[] = [];
  for (const ev of results.flat()) {
    const bm = ev.bookmakers?.[0];
    if (!bm) continue;
    const odds: BookmakerOdd[] = [];
    const h2h = bm.markets?.find((m) => m.key === 'h2h');
    if (h2h && h2h.outcomes.length >= 2) {
      const homeO = h2h.outcomes.find((o) => o.name === ev.home_team);
      const drawO = h2h.outcomes.find((o) => o.name === 'Draw');
      const awayO = h2h.outcomes.find((o) => o.name === ev.away_team);
      if (homeO && awayO) {
        const threeWay: [number, number, number] | undefined = drawO
          ? [homeO.price, drawO.price, awayO.price]
          : undefined;
        odds.push({
          id: `oddsapi-${ev.id}-h2h-home`,
          marketCategory: 'match',
          marketLabel: sport === 'football' ? 'Resultado Final (1X2)' : 'Ganador (Moneyline)',
          selectionLabel: `Victoria ${ev.home_team}`,
          side: 'home',
          decimalOdds: homeO.price,
          threeWayOdds: threeWay,
          complementOdds: !drawO ? awayO.price : undefined,
          bookmaker: bm.title,
          updatedAt: bm.last_update || fetchedAt,
        });
        if (drawO) {
          odds.push({
            id: `oddsapi-${ev.id}-h2h-draw`,
            marketCategory: 'match',
            marketLabel: 'Resultado Final (1X2)',
            selectionLabel: 'Empate',
            side: 'draw',
            decimalOdds: drawO.price,
            threeWayOdds: threeWay,
            bookmaker: bm.title,
            updatedAt: bm.last_update || fetchedAt,
          });
        }
        odds.push({
          id: `oddsapi-${ev.id}-h2h-away`,
          marketCategory: 'match',
          marketLabel: sport === 'football' ? 'Resultado Final (1X2)' : 'Ganador (Moneyline)',
          selectionLabel: `Victoria ${ev.away_team}`,
          side: 'away',
          decimalOdds: awayO.price,
          threeWayOdds: threeWay,
          complementOdds: !drawO ? homeO.price : undefined,
          bookmaker: bm.title,
          updatedAt: bm.last_update || fetchedAt,
        });
      }
    }

    const totals = bm.markets?.find((m) => m.key === 'totals');
    if (totals) {
      const overO = totals.outcomes.find((o) => o.name === 'Over');
      const underO = totals.outcomes.find((o) => o.name === 'Under');
      if (overO && underO) {
        odds.push({
          id: `oddsapi-${ev.id}-totals-over`,
          marketCategory: 'totals',
          marketLabel: sport === 'football' ? 'Más / Menos Goles' : 'Total Puntos',
          selectionLabel: `Más de ${overO.point ?? 2.5}`,
          line: overO.point ?? 2.5,
          side: 'over',
          decimalOdds: overO.price,
          complementOdds: underO.price,
          bookmaker: bm.title,
          updatedAt: bm.last_update || fetchedAt,
        });
        odds.push({
          id: `oddsapi-${ev.id}-totals-under`,
          marketCategory: 'totals',
          marketLabel: sport === 'football' ? 'Más / Menos Goles' : 'Total Puntos',
          selectionLabel: `Menos de ${underO.point ?? 2.5}`,
          line: underO.point ?? 2.5,
          side: 'under',
          decimalOdds: underO.price,
          complementOdds: overO.price,
          bookmaker: bm.title,
          updatedAt: bm.last_update || fetchedAt,
        });
      }
    }

    out.push({
      id: `oddsapi-${ev.id}`,
      sport,
      competition: ev.sport_title,
      season: 'Actual',
      status: ev.commence_time.slice(0, 10) === isoDateOffset(0) ? 'today' : 'upcoming',
      kickoffIso: ev.commence_time,
      venue: 'Cuotas de mercado',
      homeTeam: {
        id: `odds-${ev.home_team}`,
        name: ev.home_team,
        shortName: ev.home_team.slice(0, 3).toUpperCase(),
        league: ev.sport_title,
        record: 'The Odds API',
        formRecent: [],
        restDays: sport === 'football' ? 4 : 2,
      },
      awayTeam: {
        id: `odds-${ev.away_team}`,
        name: ev.away_team,
        shortName: ev.away_team.slice(0, 3).toUpperCase(),
        league: ev.sport_title,
        record: 'The Odds API',
        formRecent: [],
        restDays: sport === 'football' ? 4 : 2,
      },
      lineupStatus: 'unknown',
      homePlayers: [],
      awayPlayers: [],
      h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: sport === 'football' ? 2.5 : 224, lastMeetings: [] },
      odds,
      dataOrigin: 'The Odds API v4',
      updatedAt: fetchedAt,
      isOfflineReference: false,
    });
  }
  return out;
}

/**
 * Merges real odds from secondary feeds (The Odds API or ESPN/DraftKings) into calendar matches.
 */
export function mergeRealOddsIntoMatches(
  primaryMatches: MatchRecord[],
  oddsSources: MatchRecord[]
): MatchRecord[] {
  if (oddsSources.length === 0) return primaryMatches;
  return primaryMatches.map((m) => {
    if (m.odds.length > 0) return m;
    const matched = oddsSources.find(
      (s) =>
        s.sport === m.sport &&
        s.odds.length > 0 &&
        teamsMatch(m.homeTeam.name, s.homeTeam.name) &&
        teamsMatch(m.awayTeam.name, s.awayTeam.name) &&
        Math.abs(new Date(m.kickoffIso).getTime() - new Date(s.kickoffIso).getTime()) <= 48 * 3600 * 1000
    );
    if (!matched) return m;
    return {
      ...m,
      odds: matched.odds,
      homeTeam: {
        ...m.homeTeam,
        formRecent: m.homeTeam.formRecent.length > 0 ? m.homeTeam.formRecent : matched.homeTeam.formRecent,
      },
      awayTeam: {
        ...m.awayTeam,
        formRecent: m.awayTeam.formRecent.length > 0 ? m.awayTeam.formRecent : matched.awayTeam.formRecent,
      },
    };
  });
}
