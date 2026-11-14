import type {
  BookmakerOdd,
  MatchRecord,
  MatchStatus,
  PlayerProfile,
  StandingEntry,
  TeamRecentGame,
} from '../src/types/sports.ts';
import {
  fetchEspnNbaCalendarAndStandings,
  fetchEspnSoccerEnrichment,
  hydrateEspnNbaMatch,
  hydrateEspnSoccerMatch,
  mergeRealOddsIntoMatches,
  teamsMatch,
} from './espnAdapters.ts';

function isoDateOffset(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function classifyKickoffStatus(isoDate: string, rawShort?: string): MatchStatus {
  const s = (rawShort || '').toUpperCase();
  if (['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'IN_PLAY', 'PAUSED'].includes(s)) return 'live';
  if (['FT', 'AET', 'PEN', 'FINISHED', 'FINAL'].includes(s)) return 'finished';
  const matchDay = isoDate.slice(0, 10);
  const today = isoDateOffset(0);
  if (matchDay < today) return 'finished';
  if (matchDay === today) return 'today';
  return 'upcoming';
}

function mapFootballGridCoord(grid: string | null | undefined, idx: number, total: number): { x: number; y: number } {
  // API-Football grid comes as "row:col" e.g. "1:1" (GK), "2:1".."2:4" (DEF), "3:1".."3:3" (MID), "4:1".."4:3" (FWD)
  if (grid && grid.includes(':')) {
    const [rStr, cStr] = grid.split(':');
    const row = Math.max(1, Math.min(5, Number(rStr) || 1));
    const col = Math.max(1, Math.min(5, Number(cStr) || 1));
    const yMap: Record<number, number> = { 1: 92, 2: 75, 3: 55, 4: 34, 5: 19 };
    const y = yMap[row] ?? 50;
    const x = row === 1 ? 50 : Math.min(86, Math.max(14, 15 + (col - 1) * 22));
    return { x, y };
  }
  if (idx === 0) return { x: 50, y: 92 };
  if (idx <= 4) return { x: 16 + (idx - 1) * 22, y: 75 };
  if (idx <= 7) return { x: 24 + (idx - 5) * 26, y: 54 };
  return { x: 20 + ((idx - 8) / Math.max(1, total - 8)) * 60, y: 24 };
}

function mapNbaSlotCoord(pos: string, idx: number): { x: number; y: number } {
  const p = (pos || '').toUpperCase();
  if (p.includes('PG') || idx === 0) return { x: 50, y: 63 };
  if (p.includes('SG') || idx === 1) return { x: 78, y: 71 };
  if (p.includes('SF') || idx === 2) return { x: 20, y: 74 };
  if (p.includes('PF') || idx === 3) return { x: 66, y: 84 };
  return { x: 38, y: 87 };
}

const TOP_FOOTBALL_LEAGUE_IDS = new Set([140, 39, 2, 135, 78, 61, 3, 141, 45]);

export async function fetchFootballCalendarAndStandings(
  provider: string,
  apiKey: string
): Promise<{ matches: MatchRecord[]; standings: StandingEntry[] }> {
  const fetchedAt = new Date().toISOString();

  if (provider === 'api-football') {
    const dates = [isoDateOffset(-1), isoDateOffset(0), isoDateOffset(1), isoDateOffset(2)];
    const fixtureResponses = await Promise.all(
      dates.map(async (d) => {
        const res = await fetch(`https://v3.football.api-sports.io/fixtures?date=${d}`, {
          headers: { 'x-apisports-key': apiKey },
        });
        if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
        return (await res.json()) as {
          response?: Array<{
            fixture: { id: number; date: string; venue?: { name?: string }; status: { short: string; elapsed?: number | null } };
            league: { id: number; name: string; season: number; country?: string };
            teams: { home: { id: number; name: string }; away: { id: number; name: string } };
            goals: { home: number | null; away: number | null };
          }>;
        };
      })
    );

    const rawAll = fixtureResponses.flatMap((r) => r.response ?? []);
    // Prioritize top leagues first, then fill up to 40 fixtures
    rawAll.sort((a, b) => {
      const aTop = TOP_FOOTBALL_LEAGUE_IDS.has(a.league.id) ? 0 : 1;
      const bTop = TOP_FOOTBALL_LEAGUE_IDS.has(b.league.id) ? 0 : 1;
      if (aTop !== bTop) return aTop - bTop;
      return a.fixture.date.localeCompare(b.fixture.date);
    });

    const matches: MatchRecord[] = rawAll.slice(0, 120).map((item) => ({
      id: `apifb-${item.fixture.id}`,
      sport: 'football',
      competition: `${item.league.name}`,
      season: String(item.league.season),
      status: classifyKickoffStatus(item.fixture.date, item.fixture.status.short),
      kickoffIso: item.fixture.date,
      minuteOrClock: item.fixture.status.elapsed ? `${item.fixture.status.elapsed}'` : undefined,
      venue: item.fixture.venue?.name ?? 'Estadio oficial',
      homeTeam: {
        id: `apifb-team-${item.teams.home.id}`,
        name: item.teams.home.name,
        shortName: item.teams.home.name.slice(0, 3).toUpperCase(),
        league: item.league.name,
        record: 'API-Football',
        formRecent: [],
        restDays: 4,
      },
      awayTeam: {
        id: `apifb-team-${item.teams.away.id}`,
        name: item.teams.away.name,
        shortName: item.teams.away.name.slice(0, 3).toUpperCase(),
        league: item.league.name,
        record: 'API-Football',
        formRecent: [],
        restDays: 4,
      },
      score:
        item.goals.home !== null && item.goals.away !== null
          ? { home: item.goals.home, away: item.goals.away }
          : undefined,
      lineupStatus: 'provisional',
      homePlayers: [],
      awayPlayers: [],
      h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 2.5, lastMeetings: [] },
      odds: [],
      dataOrigin: 'API-Football (v3.football.api-sports.io)',
      updatedAt: fetchedAt,
      isOfflineReference: false,
    }));

    // Fetch standings for LaLiga (140) and Premier League (39)
    const currentYear = new Date().getMonth() >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const standingsResults = await Promise.all(
      [140, 39].map(async (leagueId) => {
        try {
          const sRes = await fetch(
            `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${currentYear}`,
            { headers: { 'x-apisports-key': apiKey } }
          );
          if (!sRes.ok) return [] as StandingEntry[];
          const sJson = (await sRes.json()) as {
            response?: Array<{
              league?: {
                name: string;
                standings?: Array<
                  Array<{
                    rank: number;
                    team: { id: number; name: string };
                    points: number;
                    goalsDiff: number;
                    form?: string;
                    all: { played: number; win: number; draw: number; lose: number; goals: { for: number; against: number } };
                    home: { win: number; draw: number; lose: number };
                    away: { win: number; draw: number; lose: number };
                  }>
                >;
              };
            }>;
          };
          const lg = sJson.response?.[0]?.league;
          const table = lg?.standings?.[0] ?? [];
          return table.map((row) => ({
            rank: row.rank,
            teamId: `apifb-team-${row.team.id}`,
            teamName: row.team.name,
            teamShort: row.team.name.slice(0, 3).toUpperCase(),
            league: lg?.name ?? `League ${leagueId}`,
            played: row.all.played,
            won: row.all.win,
            drawn: row.all.draw,
            lost: row.all.lose,
            goalsForOrPtsFor: row.all.goals.for,
            goalsAgainstOrPtsAgainst: row.all.goals.against,
            diff: row.goalsDiff,
            pointsOrWinPct: String(row.points),
            form: (row.form ?? '').slice(-5).split('').map((c) => (c === 'W' ? 'W' : c === 'D' ? 'D' : 'L')) as ('W' | 'D' | 'L')[],
            homeRecord: `${row.home.win}-${row.home.draw}-${row.home.lose}`,
            awayRecord: `${row.away.win}-${row.away.draw}-${row.away.lose}`,
          }));
        } catch {
          return [] as StandingEntry[];
        }
      })
    );

    return { matches, standings: standingsResults.flat() };
  }

  if (provider === 'espn-football') {
    return fetchEspnSoccerEnrichment();
  }

  if (provider === 'football-data') {
    const headers = { 'X-Auth-Token': apiKey.trim() };

    interface FdMatchItem {
      id: number;
      utcDate: string;
      status: string;
      competition: { name: string; code?: string };
      homeTeam: { id: number; name: string; tla?: string };
      awayTeam: { id: number; name: string; tla?: string };
      score?: { fullTime?: { home: number | null; away: number | null } };
    }

    // Football-Data v4 restricts /matches date spans to max 10 days per call -> query 2 consecutive windows + ESPN enrichment in parallel
    const [win1Res, win2Res, espnEnrich] = await Promise.all([
      fetch(
        `https://api.football-data.org/v4/matches?dateFrom=${isoDateOffset(-4)}&dateTo=${isoDateOffset(5)}`,
        { headers }
      ),
      fetch(
        `https://api.football-data.org/v4/matches?dateFrom=${isoDateOffset(6)}&dateTo=${isoDateOffset(15)}`,
        { headers }
      ).catch(() => null),
      fetchEspnSoccerEnrichment().catch(() => ({ matches: [] as MatchRecord[], standings: [] as StandingEntry[] })),
    ]);

    if (!win1Res.ok) throw new Error(`Football-Data.org HTTP ${win1Res.status}`);
    const win1Json = (await win1Res.json()) as { matches?: FdMatchItem[] };
    const win2Json =
      win2Res && win2Res.ok ? ((await win2Res.json()) as { matches?: FdMatchItem[] }) : { matches: [] };

    const rawMatchMap = new Map<number, FdMatchItem>();
    for (const m of [...(win1Json.matches ?? []), ...(win2Json.matches ?? [])]) {
      if (m?.id && m.homeTeam?.id && m.homeTeam?.name && m.awayTeam?.id && m.awayTeam?.name) {
        rawMatchMap.set(m.id, m);
      }
    }

    // Pull additional fixtures from top competitions only if rawMatchMap has < 15 matches (conserves 10 req/min bucket)
    if (rawMatchMap.size < 15) {
      const compRangeFrom = isoDateOffset(0);
      const compRangeTo = isoDateOffset(25);
      for (const compCode of ['PD', 'PL', 'CL']) {
        try {
          const cRes = await fetch(
            `https://api.football-data.org/v4/competitions/${compCode}/matches?dateFrom=${compRangeFrom}&dateTo=${compRangeTo}`,
            { headers }
          );
          if (!cRes.ok) continue;
          const cJson = (await cRes.json()) as { matches?: FdMatchItem[] };
          for (const m of (cJson.matches ?? []).slice(0, 20)) {
            if (
              m?.id &&
              m.homeTeam?.id &&
              m.homeTeam?.name &&
              m.awayTeam?.id &&
              m.awayTeam?.name &&
              !rawMatchMap.has(m.id)
            ) {
              rawMatchMap.set(m.id, m);
            }
          }
        } catch {
          // Skip unavailable competition
        }
      }
    }

    // Build team strength & standings from ESPN (0 rate-limit cost), falling back to Football-Data if ESPN returned empty
    const standingsList: StandingEntry[] = [...espnEnrich.standings];
    const teamStandingsListByName: Array<{
      teamName: string;
      record: string;
      ppg: number;
      oppg: number;
      attackStrength: number;
      defenseStrength: number;
      form: ('W' | 'D' | 'L')[];
    }> = espnEnrich.standings.map((r) => {
      const played = Math.max(1, r.played);
      const ppg = r.goalsForOrPtsFor / played;
      const oppg = r.goalsAgainstOrPtsAgainst / played;
      return {
        teamName: r.teamName,
        record: `${r.won}-${r.drawn ?? 0}-${r.lost} · ${r.pointsOrWinPct} pts`,
        ppg,
        oppg,
        attackStrength: Math.max(0.75, Math.min(2.4, ppg * 1.05)),
        defenseStrength: Math.max(0.6, Math.min(1.9, oppg)),
        form: r.form,
      };
    });

    const teamStandingsMap = new Map<
      string,
      {
        record: string;
        ppg: number;
        oppg: number;
        attackStrength: number;
        defenseStrength: number;
        form: ('W' | 'D' | 'L')[];
      }
    >();

    if (standingsList.length === 0) {
      for (const comp of ['PD', 'PL', 'BL1', 'SA', 'FL1']) {
        try {
          const sRes = await fetch(`https://api.football-data.org/v4/competitions/${comp}/standings`, {
            headers,
          });
          if (!sRes.ok) continue;
          const sJson = (await sRes.json()) as {
            competition?: { name: string };
            standings?: Array<{
              type: string;
              table: Array<{
                position: number;
                team: { id: number; name: string; tla?: string };
                playedGames: number;
                won: number;
                draw: number;
                lost: number;
                points: number;
                goalsFor: number;
                goalsAgainst: number;
                goalDifference: number;
                form?: string;
              }>;
            }>;
          };
          const totalTable = sJson.standings?.find((s) => s.type === 'TOTAL')?.table ?? [];
          for (const r of totalTable) {
            const played = Math.max(1, r.playedGames);
            const ppg = r.goalsFor / played;
            const oppg = r.goalsAgainst / played;
            const form = (r.form ?? '')
              .split(',')
              .slice(-5)
              .filter((c) => c === 'W' || c === 'D' || c === 'L') as ('W' | 'D' | 'L')[];
            const teamName = r.team?.name || 'Equipo';
            const teamShort = r.team?.tla || teamName.slice(0, 3).toUpperCase();
            const teamKey = `fd-team-${r.team?.id ?? teamShort}`;

            teamStandingsMap.set(teamKey, {
              record: `${r.won}-${r.draw}-${r.lost} · ${r.points} pts`,
              ppg,
              oppg,
              attackStrength: Math.max(0.75, Math.min(2.4, ppg * 1.05)),
              defenseStrength: Math.max(0.6, Math.min(1.9, oppg)),
              form,
            });

            standingsList.push({
              rank: r.position,
              teamId: teamKey,
              teamName,
              teamShort,
              league: sJson.competition?.name ?? comp,
              played: r.playedGames,
              won: r.won,
              drawn: r.draw,
              lost: r.lost,
              goalsForOrPtsFor: r.goalsFor,
              goalsAgainstOrPtsAgainst: r.goalsAgainst,
              diff: r.goalDifference,
              pointsOrWinPct: String(r.points),
              form,
              homeRecord: '-',
              awayRecord: '-',
            });
          }
        } catch {
          // Ignore unavailable competition on user's Football-Data tier
        }
      }
    }

    const fdMatches: MatchRecord[] = Array.from(rawMatchMap.values())
      .filter((m) => Boolean(m.homeTeam?.id && m.homeTeam?.name && m.awayTeam?.id && m.awayTeam?.name && m.utcDate))
      .sort((a, b) => (a.utcDate ?? '').localeCompare(b.utcDate ?? ''))
      .map((m) => {
        const hId = `fd-team-${m.homeTeam.id}`;
        const aId = `fd-team-${m.awayTeam.id}`;
        const hName = m.homeTeam.name || 'Local';
        const aName = m.awayTeam.name || 'Visitante';
        const compName = m.competition?.name || 'Competición';
        const hSt =
          teamStandingsMap.get(hId) ??
          teamStandingsListByName.find((s) => teamsMatch(s.teamName, hName));
        const aSt =
          teamStandingsMap.get(aId) ??
          teamStandingsListByName.find((s) => teamsMatch(s.teamName, aName));
        return {
          id: `fd-${m.id}`,
          sport: 'football',
          competition: compName,
          season: 'Actual',
          status: classifyKickoffStatus(m.utcDate, m.status),
          kickoffIso: m.utcDate,
          venue: 'Sede oficial',
          homeTeam: {
            id: hId,
            name: hName,
            shortName: m.homeTeam.tla || hName.slice(0, 3).toUpperCase(),
            league: compName,
            record: hSt?.record ?? 'Football-Data.org',
            ppgOrGpg: hSt?.ppg,
            oppgOrGapg: hSt?.oppg,
            attackHome: hSt ? hSt.attackStrength * 1.08 : undefined,
            defenseHome: hSt ? hSt.defenseStrength * 0.92 : undefined,
            formRecent: hSt?.form ?? [],
            restDays: 4,
          },
          awayTeam: {
            id: aId,
            name: aName,
            shortName: m.awayTeam.tla || aName.slice(0, 3).toUpperCase(),
            league: compName,
            record: aSt?.record ?? 'Football-Data.org',
            ppgOrGpg: aSt?.ppg,
            oppgOrGapg: aSt?.oppg,
            attackAway: aSt ? aSt.attackStrength * 0.94 : undefined,
            defenseAway: aSt ? aSt.defenseStrength * 1.06 : undefined,
            formRecent: aSt?.form ?? [],
            restDays: 4,
          },
          score:
            m.score?.fullTime?.home !== null && m.score?.fullTime?.away !== null && m.score?.fullTime
              ? { home: m.score.fullTime.home as number, away: m.score.fullTime.away as number }
              : undefined,
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
          odds: [],
          dataOrigin: 'Football-Data.org v4',
          updatedAt: fetchedAt,
          isOfflineReference: false,
        };
      });

    // Merge DraftKings odds onto Football-Data matches
    const fdWithOdds = mergeRealOddsIntoMatches(fdMatches, espnEnrich.matches);

    // Append ESPN matches from leagues/dates not already in Football-Data (e.g. Europa League, Conference League, or additional fixtures)
    const extraEspnMatches = espnEnrich.matches.filter(
      (em) =>
        !fdWithOdds.some(
          (fm) =>
            teamsMatch(fm.homeTeam.name, em.homeTeam.name) &&
            teamsMatch(fm.awayTeam.name, em.awayTeam.name) &&
            Math.abs(new Date(fm.kickoffIso).getTime() - new Date(em.kickoffIso).getTime()) <= 48 * 3600 * 1000
        )
    );

    return { matches: [...fdWithOdds, ...extraEspnMatches], standings: standingsList };
  }

  if (provider === 'the-odds-api') {
    const leagueKeys = [
      'soccer_spain_la_liga',
      'soccer_epl',
      'soccer_uefa_champs_league',
    ];
    const eventsArrays = await Promise.all(
      leagueKeys.map(async (lk) => {
        try {
          const res = await fetch(
            `https://api.the-odds-api.com/v4/sports/${lk}/odds/?apiKey=${encodeURIComponent(
              apiKey
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

    const matches: MatchRecord[] = eventsArrays.flat().slice(0, 30).map((ev) => {
      const bm = ev.bookmakers[0];
      const odds: BookmakerOdd[] = [];
      const h2h = bm?.markets.find((mk) => mk.key === 'h2h');
      if (h2h && h2h.outcomes.length >= 2) {
        const homeOut = h2h.outcomes.find((o) => o.name === ev.home_team);
        const drawOut = h2h.outcomes.find((o) => o.name === 'Draw');
        const awayOut = h2h.outcomes.find((o) => o.name === ev.away_team);
        if (homeOut && awayOut) {
          odds.push({
            id: `odds-${ev.id}-h2h-home`,
            marketCategory: 'match',
            marketLabel: 'Resultado Final (1X2)',
            selectionLabel: `Victoria ${ev.home_team}`,
            side: 'home',
            decimalOdds: homeOut.price,
            threeWayOdds: drawOut ? [homeOut.price, drawOut.price, awayOut.price] : undefined,
            complementOdds: !drawOut ? awayOut.price : undefined,
            bookmaker: bm.title,
            updatedAt: bm.last_update,
          });
          odds.push({
            id: `odds-${ev.id}-h2h-away`,
            marketCategory: 'match',
            marketLabel: 'Resultado Final (1X2)',
            selectionLabel: `Victoria ${ev.away_team}`,
            side: 'away',
            decimalOdds: awayOut.price,
            threeWayOdds: drawOut ? [homeOut.price, drawOut.price, awayOut.price] : undefined,
            complementOdds: !drawOut ? homeOut.price : undefined,
            bookmaker: bm.title,
            updatedAt: bm.last_update,
          });
        }
      }
      const totals = bm?.markets.find((mk) => mk.key === 'totals');
      if (totals) {
        const over = totals.outcomes.find((o) => o.name === 'Over');
        const under = totals.outcomes.find((o) => o.name === 'Under');
        if (over && under) {
          odds.push({
            id: `odds-${ev.id}-totals-over`,
            marketCategory: 'totals',
            marketLabel: 'Más / Menos Goles',
            selectionLabel: `Más de ${over.point ?? 2.5} goles`,
            line: over.point ?? 2.5,
            side: 'over',
            decimalOdds: over.price,
            complementOdds: under.price,
            bookmaker: bm.title,
            updatedAt: bm.last_update,
          });
        }
      }

      return {
        id: `oddsapi-${ev.id}`,
        sport: 'football',
        competition: ev.sport_title,
        season: 'Actual',
        status: classifyKickoffStatus(ev.commence_time),
        kickoffIso: ev.commence_time,
        venue: 'Cuotas en vivo',
        homeTeam: {
          id: `odds-${ev.home_team}`,
          name: ev.home_team,
          shortName: ev.home_team.slice(0, 3).toUpperCase(),
          league: ev.sport_title,
          record: 'The Odds API',
          formRecent: [],
          restDays: 4,
        },
        awayTeam: {
          id: `odds-${ev.away_team}`,
          name: ev.away_team,
          shortName: ev.away_team.slice(0, 3).toUpperCase(),
          league: ev.sport_title,
          record: 'The Odds API',
          formRecent: [],
          restDays: 4,
        },
        lineupStatus: 'provisional',
        homePlayers: [],
        awayPlayers: [],
        h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 2.5, lastMeetings: [] },
        odds,
        dataOrigin: 'The Odds API v4',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      };
    });

    return { matches, standings: [] };
  }

  return { matches: [], standings: [] };
}

export async function fetchNbaCalendarAndStandings(
  provider: string,
  apiKey: string
): Promise<{ matches: MatchRecord[]; standings: StandingEntry[] }> {
  const fetchedAt = new Date().toISOString();

  if (provider === 'espn-nba') {
    return fetchEspnNbaCalendarAndStandings();
  }

  if (provider === 'balldontlie') {
    const dates = [isoDateOffset(-1), isoDateOffset(0), isoDateOffset(1), isoDateOffset(2)];
    const query = dates.map((d) => `dates[]=${d}`).join('&');
    const res = await fetch(`https://api.balldontlie.io/v1/games?${query}&per_page=40`, {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) throw new Error(`BallDontLie HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<{
        id: number;
        date: string;
        datetime: string;
        status: string;
        period: number;
        home_team: { id: number; full_name: string; abbreviation: string };
        visitor_team: { id: number; full_name: string; abbreviation: string };
        home_team_score: number;
        visitor_team_score: number;
      }>;
    };

    const matches: MatchRecord[] = (json.data ?? []).map((g) => {
      const kickoff = g.datetime || `${g.date}T23:00:00Z`;
      const isFinal = g.status === 'Final';
      const isLive = g.period > 0 && !isFinal;
      return {
        id: `bdl-${g.id}`,
        sport: 'nba',
        competition: 'NBA',
        season: 'Actual',
        status: isFinal ? 'finished' : isLive ? 'live' : classifyKickoffStatus(kickoff),
        kickoffIso: kickoff,
        minuteOrClock: isLive ? g.status : undefined,
        venue: 'NBA Arena',
        homeTeam: {
          id: `bdl-team-${g.home_team.id}`,
          name: g.home_team.full_name,
          shortName: g.home_team.abbreviation,
          league: 'NBA',
          record: 'BallDontLie',
          formRecent: [],
          restDays: 2,
        },
        awayTeam: {
          id: `bdl-team-${g.visitor_team.id}`,
          name: g.visitor_team.full_name,
          shortName: g.visitor_team.abbreviation,
          league: 'NBA',
          record: 'BallDontLie',
          formRecent: [],
          restDays: 2,
        },
        score: isLive || isFinal ? { home: g.home_team_score, away: g.visitor_team_score } : undefined,
        lineupStatus: 'provisional',
        homePlayers: [],
        awayPlayers: [],
        h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 225, lastMeetings: [] },
        odds: [],
        dataOrigin: 'BallDontLie NBA v1',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      };
    });
    return { matches, standings: [] };
  }

  if (provider === 'api-basketball' || provider === 'api-nba') {
    const dates = [isoDateOffset(-1), isoDateOffset(0), isoDateOffset(1), isoDateOffset(2)];
    const responses = await Promise.all(
      dates.map(async (d) => {
        const url =
          provider === 'api-nba'
            ? `https://v2.nba.api-sports.io/games?date=${d}`
            : `https://v1.basketball.api-sports.io/games?league=12&date=${d}`;
        const res = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
        if (!res.ok) throw new Error(`API-Sports NBA HTTP ${res.status}`);
        return (await res.json()) as {
          response?: Array<{
            id: number;
            date: string | { start?: string };
            status: { short?: string | number; long?: string };
            teams: {
              home: { id: number; name: string; code?: string };
              visitors?: { id: number; name: string; code?: string };
              away?: { id: number; name: string; code?: string };
            };
            scores?: {
              home?: { total?: number; points?: number };
              visitors?: { points?: number };
              away?: { total?: number };
            };
          }>;
        };
      })
    );

    const matches: MatchRecord[] = responses
      .flatMap((r) => r.response ?? [])
      .slice(0, 35)
      .map((g) => {
        const away = g.teams.visitors ?? g.teams.away ?? { id: 0, name: 'Visitante', code: 'VIS' };
        const homePts = g.scores?.home?.points ?? g.scores?.home?.total ?? null;
        const awayPts = g.scores?.visitors?.points ?? g.scores?.away?.total ?? null;
        const statusLong = (g.status?.long ?? '').toLowerCase();
        const kickoff = typeof g.date === 'string' ? g.date : g.date?.start ?? fetchedAt;
        const isFinished = statusLong.includes('finish');
        const isLive = statusLong.includes('live') || statusLong.includes('quarter');
        return {
          id: `${provider === 'api-nba' ? 'apinba2' : 'apibsk'}-${g.id}`,
          sport: 'nba',
          competition: 'NBA',
          season: 'Actual',
          status: isFinished ? 'finished' : isLive ? 'live' : classifyKickoffStatus(kickoff),
          kickoffIso: kickoff,
          venue: 'NBA Arena',
          homeTeam: {
            id: `nba-team-${g.teams.home.id}`,
            name: g.teams.home.name,
            shortName: g.teams.home.code ?? g.teams.home.name.slice(0, 3).toUpperCase(),
            league: 'NBA',
            record: 'API-Sports NBA',
            formRecent: [],
            restDays: 2,
          },
          awayTeam: {
            id: `nba-team-${away.id}`,
            name: away.name,
            shortName: away.code ?? away.name.slice(0, 3).toUpperCase(),
            league: 'NBA',
            record: 'API-Sports NBA',
            formRecent: [],
            restDays: 2,
          },
          score: homePts !== null && awayPts !== null ? { home: homePts, away: awayPts } : undefined,
          lineupStatus: 'provisional',
          homePlayers: [],
          awayPlayers: [],
          h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 224, lastMeetings: [] },
          odds: [],
          dataOrigin: provider === 'api-nba' ? 'API-NBA v2 (API-Sports)' : 'API-Basketball v1 (API-Sports)',
          updatedAt: fetchedAt,
          isOfflineReference: false,
        };
      });

    // Attempt NBA Standings
    const standings: StandingEntry[] = [];
    try {
      const seasonYear = new Date().getMonth() >= 9 ? new Date().getFullYear() : new Date().getFullYear() - 1;
      if (provider === 'api-nba') {
        const sRes = await fetch(
          `https://v2.nba.api-sports.io/standings?league=standard&season=${seasonYear}`,
          { headers: { 'x-apisports-key': apiKey } }
        );
        if (sRes.ok) {
          const sJson = (await sRes.json()) as {
            response?: Array<{
              conference: { name: string; rank: number };
              team: { id: number; name: string; code: string };
              win: { home: number; away: number; total: number; percentage: string };
              loss: { home: number; away: number; total: number };
            }>;
          };
          for (const row of sJson.response ?? []) {
            const conf = row.conference?.name?.toLowerCase().includes('east') ? 'Eastern' : 'Western';
            standings.push({
              rank: row.conference?.rank ?? 1,
              teamId: `nba-team-${row.team.id}`,
              teamName: row.team.name,
              teamShort: row.team.code,
              league: 'NBA',
              conference: conf,
              played: row.win.total + row.loss.total,
              won: row.win.total,
              lost: row.loss.total,
              goalsForOrPtsFor: 0,
              goalsAgainstOrPtsAgainst: 0,
              diff: row.win.total - row.loss.total,
              pointsOrWinPct: row.win.percentage,
              form: [],
              homeRecord: `${row.win.home}-${row.loss.home}`,
              awayRecord: `${row.win.away}-${row.loss.away}`,
            });
          }
        }
      }
    } catch {
      // Ignore standings fallback error
    }

    return { matches, standings };
  }

  if (provider === 'the-odds-api') {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${encodeURIComponent(
        apiKey
      )}&regions=eu&markets=h2h,totals`
    );
    if (!res.ok) throw new Error(`The Odds API NBA HTTP ${res.status}`);
    const events = (await res.json()) as Array<{
      id: string;
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

    const matches: MatchRecord[] = events.slice(0, 20).map((ev) => {
      const bm = ev.bookmakers[0];
      const odds: BookmakerOdd[] = [];
      const h2h = bm?.markets.find((mk) => mk.key === 'h2h');
      if (h2h && h2h.outcomes.length >= 2) {
        const homeOut = h2h.outcomes.find((o) => o.name === ev.home_team);
        const awayOut = h2h.outcomes.find((o) => o.name === ev.away_team);
        if (homeOut && awayOut) {
          odds.push({
            id: `odds-${ev.id}-ml-home`,
            marketCategory: 'match',
            marketLabel: 'Ganador del Partido (Moneyline)',
            selectionLabel: ev.home_team,
            side: 'home',
            decimalOdds: homeOut.price,
            complementOdds: awayOut.price,
            bookmaker: bm.title,
            updatedAt: bm.last_update,
          });
          odds.push({
            id: `odds-${ev.id}-ml-away`,
            marketCategory: 'match',
            marketLabel: 'Ganador del Partido (Moneyline)',
            selectionLabel: ev.away_team,
            side: 'away',
            decimalOdds: awayOut.price,
            complementOdds: homeOut.price,
            bookmaker: bm.title,
            updatedAt: bm.last_update,
          });
        }
      }
      return {
        id: `oddsnba-${ev.id}`,
        sport: 'nba',
        competition: 'NBA',
        season: 'Actual',
        status: classifyKickoffStatus(ev.commence_time),
        kickoffIso: ev.commence_time,
        venue: 'NBA Arena',
        homeTeam: {
          id: `odds-${ev.home_team}`,
          name: ev.home_team,
          shortName: ev.home_team.slice(0, 3).toUpperCase(),
          league: 'NBA',
          record: 'The Odds API',
          formRecent: [],
          restDays: 2,
        },
        awayTeam: {
          id: `odds-${ev.away_team}`,
          name: ev.away_team,
          shortName: ev.away_team.slice(0, 3).toUpperCase(),
          league: 'NBA',
          record: 'The Odds API',
          formRecent: [],
          restDays: 2,
        },
        lineupStatus: 'provisional',
        homePlayers: [],
        awayPlayers: [],
        h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 225, lastMeetings: [] },
        odds,
        dataOrigin: 'The Odds API v4 (NBA)',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      };
    });
    return { matches, standings: [] };
  }

  if (provider === 'basketballapi-net') {
    const token = apiKey.trim().replace(/^Bearer\s+/i, '');
    const headers = { Authorization: `Bearer ${token}` };

    type AnyObj = Record<string, unknown>;
    const extractArray = (payload: unknown): AnyObj[] => {
      if (Array.isArray(payload)) return payload as AnyObj[];
      if (payload && typeof payload === 'object') {
        const obj = payload as AnyObj;
        for (const key of ['data', 'games', 'matches', 'fixtures', 'results', 'response', 'items', 'standings']) {
          if (Array.isArray(obj[key])) return obj[key] as AnyObj[];
        }
      }
      return [];
    };

    const endpoints = [
      'https://api.basketballapi.net/v1/results/yesterday',
      `https://api.basketballapi.net/v1/games?date=${isoDateOffset(0)}`,
      `https://api.basketballapi.net/v1/games?date=${isoDateOffset(1)}`,
    ];

    let authError: string | null = null;
    const buckets = await Promise.all(
      endpoints.map(async (url) => {
        try {
          const r = await fetch(url, { headers });
          if (r.status === 401) {
            authError = 'BasketballAPI.net rechazó la clave API (HTTP 401).';
            return [] as AnyObj[];
          }
          // On Free plan, paid endpoints return 403 upgrade_required — skip gracefully
          if (!r.ok) return [] as AnyObj[];
          return extractArray(await r.json());
        } catch {
          return [] as AnyObj[];
        }
      })
    );

    if (authError) throw new Error(authError);

    const rawGames = buckets.flat();
    const seenIds = new Set<string>();
    const matches: MatchRecord[] = [];

    for (const g of rawGames) {
      const idStr = String(g.id ?? g.game_id ?? g.match_id ?? '');
      if (!idStr || seenIds.has(idStr)) continue;
      seenIds.add(idStr);

      const teamsObj = (g.teams && typeof g.teams === 'object' ? g.teams : {}) as AnyObj;
      const homeField = g.home_team ?? g.homeTeam ?? g.home ?? teamsObj.home;
      const awayField = g.away_team ?? g.visitor_team ?? g.awayTeam ?? g.away ?? teamsObj.away ?? teamsObj.visitors;

      const homeRaw = (homeField && typeof homeField === 'object' ? homeField : {}) as AnyObj;
      const awayRaw = (awayField && typeof awayField === 'object' ? awayField : {}) as AnyObj;

      const homeName =
        typeof homeField === 'string'
          ? homeField
          : String(homeRaw.full_name ?? homeRaw.name ?? g.home_team_name ?? 'Local');
      const awayName =
        typeof awayField === 'string'
          ? awayField
          : String(awayRaw.full_name ?? awayRaw.name ?? g.away_team_name ?? 'Visitante');

      const homeShort = String(homeRaw.abbreviation ?? homeRaw.code ?? homeRaw.short_name ?? homeName.slice(0, 3)).toUpperCase();
      const awayShort = String(awayRaw.abbreviation ?? awayRaw.code ?? awayRaw.short_name ?? awayName.slice(0, 3)).toUpperCase();
      const homeId = String(homeRaw.id ?? homeShort);
      const awayId = String(awayRaw.id ?? awayShort);

      const rawDate = String(
        g.datetime ??
          g.utc_date ??
          g.start_time ??
          g.commence_time ??
          g.scheduled ??
          (typeof g.date === 'string' ? g.date : (g.date as AnyObj | undefined)?.start) ??
          fetchedAt
      );
      const kickoffIso = rawDate.length === 10 ? `${rawDate}T22:00:00Z` : rawDate;

      const statusObj = g.status && typeof g.status === 'object' ? (g.status as AnyObj) : null;
      const statusText = String(statusObj?.long ?? statusObj?.short ?? g.status ?? '').toLowerCase();
      const isFinal =
        statusText.includes('final') ||
        statusText.includes('finish') ||
        statusText === 'ft' ||
        statusText === 'ended' ||
        statusText === 'completed';
      const isLive =
        !isFinal &&
        (statusText.includes('live') ||
          statusText.includes('progress') ||
          statusText.includes('q1') ||
          statusText.includes('q2') ||
          statusText.includes('q3') ||
          statusText.includes('q4') ||
          statusText.includes('quarter') ||
          statusText.includes('half') ||
          statusText.includes('ot'));

      const scoresObj = (g.scores && typeof g.scores === 'object' ? g.scores : g.score && typeof g.score === 'object' ? g.score : {}) as AnyObj;
      const scoresHome = (scoresObj.home && typeof scoresObj.home === 'object' ? scoresObj.home : {}) as AnyObj;
      const scoresAway = ((scoresObj.away ?? scoresObj.visitors) && typeof (scoresObj.away ?? scoresObj.visitors) === 'object'
        ? (scoresObj.away ?? scoresObj.visitors)
        : {}) as AnyObj;

      const homeScoreVal =
        g.home_score ??
        g.home_team_score ??
        (typeof scoresObj.home === 'number' ? scoresObj.home : undefined) ??
        scoresHome.total ??
        scoresHome.points;
      const awayScoreVal =
        g.away_score ??
        g.visitor_team_score ??
        (typeof scoresObj.away === 'number' ? scoresObj.away : undefined) ??
        scoresAway.total ??
        scoresAway.points;
      const hasScore =
        homeScoreVal !== undefined &&
        awayScoreVal !== undefined &&
        !Number.isNaN(Number(homeScoreVal)) &&
        !Number.isNaN(Number(awayScoreVal)) &&
        (isLive || isFinal || Number(homeScoreVal) > 0 || Number(awayScoreVal) > 0);

      const leagueObj =
        g.league && typeof g.league === 'object'
          ? (g.league as AnyObj)
          : g.competition && typeof g.competition === 'object'
            ? (g.competition as AnyObj)
            : null;
      const leagueName = String(leagueObj?.name ?? g.competition_name ?? g.league ?? g.competition ?? 'NBA / Baloncesto');

      matches.push({
        id: `bapi-${idStr}`,
        sport: 'nba',
        competition: leagueName,
        season: String(g.season ?? 'Actual'),
        status: isFinal ? 'finished' : isLive ? 'live' : classifyKickoffStatus(kickoffIso),
        kickoffIso,
        minuteOrClock: isLive ? String(statusObj?.short ?? g.clock ?? g.status ?? 'En juego') : undefined,
        venue: String((g.venue as AnyObj | undefined)?.name ?? g.venue ?? g.arena ?? 'Pabellón oficial'),
        homeTeam: {
          id: `bapi-team-${homeId}`,
          name: homeName,
          shortName: homeShort,
          league: leagueName,
          record: 'BasketballAPI.net',
          formRecent: [],
          restDays: 2,
        },
        awayTeam: {
          id: `bapi-team-${awayId}`,
          name: awayName,
          shortName: awayShort,
          league: leagueName,
          record: 'BasketballAPI.net',
          formRecent: [],
          restDays: 2,
        },
        score: hasScore ? { home: Number(homeScoreVal), away: Number(awayScoreVal) } : undefined,
        lineupStatus: 'provisional',
        homePlayers: [],
        awayPlayers: [],
        h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 224, lastMeetings: [] },
        odds: [],
        dataOrigin: 'BasketballAPI.net v1',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      });
    }

    // Prioritize NBA matches first, then other leagues
    matches.sort((a, b) => {
      const aNba = a.competition.toUpperCase().includes('NBA') ? 0 : 1;
      const bNba = b.competition.toUpperCase().includes('NBA') ? 0 : 1;
      if (aNba !== bNba) return aNba - bNba;
      return a.kickoffIso.localeCompare(b.kickoffIso);
    });

    // Attempt Standings from BasketballAPI.net (only if enabled on user's plan)
    const standings: StandingEntry[] = [];
    try {
      const sRes = await fetch('https://api.basketballapi.net/v1/standings', { headers });
      if (sRes.ok) {
        const sRows = extractArray(await sRes.json());
        sRows.forEach((row, idx) => {
          const team = (row.team && typeof row.team === 'object' ? row.team : {}) as AnyObj;
          const tName = String(team.full_name ?? team.name ?? row.team_name ?? `Equipo ${idx + 1}`);
          const tShort = String(team.abbreviation ?? team.code ?? tName.slice(0, 3)).toUpperCase();
          const wins = Number(row.wins ?? row.won ?? (row.win as AnyObj | undefined)?.total ?? 0);
          const losses = Number(row.losses ?? row.lost ?? (row.loss as AnyObj | undefined)?.total ?? 0);
          const confRaw = String(row.conference ?? (row.conference as AnyObj | undefined)?.name ?? '');
          const conf = confRaw.toLowerCase().includes('east')
            ? 'Eastern'
            : confRaw.toLowerCase().includes('west')
              ? 'Western'
              : undefined;
          const pct =
            row.win_percentage ??
            row.pct ??
            (wins + losses > 0 ? (wins / (wins + losses)).toFixed(3) : '.500');

          standings.push({
            rank: Number(row.rank ?? row.position ?? idx + 1),
            teamId: `bapi-team-${String(team.id ?? row.team_id ?? tShort)}`,
            teamName: tName,
            teamShort: tShort,
            league: 'NBA',
            conference: conf,
            played: wins + losses,
            won: wins,
            lost: losses,
            goalsForOrPtsFor: Number(row.points_for ?? row.pts_for ?? 0),
            goalsAgainstOrPtsAgainst: Number(row.points_against ?? row.pts_against ?? 0),
            diff: Number(row.point_differential ?? row.diff ?? wins - losses),
            pointsOrWinPct: String(pct),
            form: [],
            homeRecord: String(row.home_record ?? '-'),
            awayRecord: String(row.away_record ?? '-'),
          });
        });
      }
    } catch {
      // Standings optional if not enabled on plan
    }

    const espnNba = await fetchEspnNbaCalendarAndStandings().catch(() => ({
      matches: [] as MatchRecord[],
      standings: [] as StandingEntry[],
    }));
    const enrichedBapi = mergeRealOddsIntoMatches(matches, espnNba.matches);
    const extraEspnNba = espnNba.matches.filter(
      (em) =>
        !enrichedBapi.some(
          (bm) =>
            teamsMatch(bm.homeTeam.name, em.homeTeam.name) &&
            teamsMatch(bm.awayTeam.name, em.awayTeam.name) &&
            Math.abs(new Date(bm.kickoffIso).getTime() - new Date(em.kickoffIso).getTime()) <= 36 * 3600 * 1000
        )
    );

    return {
      matches: [...enrichedBapi, ...extraEspnNba],
      standings: standings.length > 0 ? standings : espnNba.standings,
    };
  }

  return { matches: [], standings: [] };
}

/**
 * Hydrates full lineups, injuries, H2H, team strength, recent L15 history, and odds for an individual match clicked by the user.
 */
export async function hydrateLiveMatchDetails(
  baseMatch: MatchRecord,
  provider: string,
  apiKey: string
): Promise<MatchRecord> {
  const fetchedAt = new Date().toISOString();

  if (baseMatch.id.startsWith('espn-nba-')) {
    return hydrateEspnNbaMatch(baseMatch);
  }

  if (baseMatch.id.startsWith('espnsoc-')) {
    return hydrateEspnSoccerMatch(baseMatch);
  }

  if (baseMatch.sport === 'football' && provider === 'api-football' && baseMatch.id.startsWith('apifb-')) {
    const fixtureId = baseMatch.id.replace('apifb-', '');
    const homeTeamId = baseMatch.homeTeam.id.replace('apifb-team-', '');
    const awayTeamId = baseMatch.awayTeam.id.replace('apifb-team-', '');

    const [lineupRes, injRes, h2hRes, oddsRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixtureId}`, {
        headers: { 'x-apisports-key': apiKey },
      }).then((r) => r.json()).catch(() => ({ response: [] })),
      fetch(`https://v3.football.api-sports.io/injuries?fixture=${fixtureId}`, {
        headers: { 'x-apisports-key': apiKey },
      }).then((r) => r.json()).catch(() => ({ response: [] })),
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}&last=5`, {
        headers: { 'x-apisports-key': apiKey },
      }).then((r) => r.json()).catch(() => ({ response: [] })),
      fetch(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}`, {
        headers: { 'x-apisports-key': apiKey },
      }).then((r) => r.json()).catch(() => ({ response: [] })),
    ]) as [
      {
        response?: Array<{
          team: { id: number; name: string };
          formation?: string;
          startXI: Array<{ player: { id: number; name: string; number: number; pos: string; grid?: string } }>;
          substitutes: Array<{ player: { id: number; name: string; number: number; pos: string } }>;
        }>;
      },
      {
        response?: Array<{
          team: { id: number };
          player: { id: number; name: string; photo?: string; type?: string; reason?: string };
        }>;
      },
      {
        response?: Array<{
          fixture: { date: string };
          teams: { home: { name: string; winner: boolean | null }; away: { name: string; winner: boolean | null } };
          goals: { home: number | null; away: number | null };
        }>;
      },
      {
        response?: Array<{
          bookmakers?: Array<{
            name: string;
            bets?: Array<{
              id: number;
              name: string;
              values: Array<{ value: string; odd: string }>;
            }>;
          }>;
        }>;
      }
    ];

    const injuries = injRes.response ?? [];
    const buildSidePlayers = (teamIdStr: string, teamName: string, teamShort: string): PlayerProfile[] => {
      const lineup = (lineupRes.response ?? []).find((l) => String(l.team.id) === teamIdStr);
      const sideInj = injuries.filter((i) => String(i.team.id) === teamIdStr);
      const list: PlayerProfile[] = [];

      if (lineup) {
        lineup.startXI.forEach((entry, idx) => {
          const p = entry.player;
          const isForward = p.pos === 'F' || p.pos === 'A';
          const isMid = p.pos === 'M';
          list.push({
            id: `apifb-p-${p.id}`,
            sport: 'football',
            name: p.name,
            shortName: p.name.split(' ').slice(-1)[0] || p.name,
            teamId: `apifb-team-${teamIdStr}`,
            teamName,
            teamShort,
            number: p.number || idx + 1,
            position: p.pos || 'M',
            photoUrl: `https://media.api-sports.io/football/players/${p.id}.png`,
            availability: 'starter',
            isKeyPlayer: isForward || idx === 0,
            pitchCoord: mapFootballGridCoord(p.grid, idx, lineup.startXI.length),
            impact: {
              offenseDelta: isForward ? 0.28 : isMid ? 0.14 : 0.04,
              defenseDelta: p.pos === 'G' || p.pos === 'D' ? 0.14 : 0.04,
              usageShare: isForward ? 0.18 : isMid ? 0.1 : 0.03,
              assistShare: isMid ? 0.2 : isForward ? 0.14 : 0.04,
            },
            splits: {
              season: { games: 15, minutes: 80, starterRate: 0.85, goals: isForward ? 0.35 : isMid ? 0.14 : 0.04, assists: isMid ? 0.22 : 0.1, shots: isForward ? 2.4 : isMid ? 1.2 : 0.4, shotsOnTarget: isForward ? 1.05 : 0.45, foulsCommitted: 1.0, foulsDrawn: 1.2, yellowCards: 0.16, redCards: 0.01, passes: isMid ? 52 : 36 },
              last5: { games: 5, minutes: 82, starterRate: 0.9, goals: isForward ? 0.4 : 0.15, assists: 0.2, shots: isForward ? 2.6 : 1.2, shotsOnTarget: isForward ? 1.1 : 0.5, foulsCommitted: 1.0, foulsDrawn: 1.2, yellowCards: 0.15, redCards: 0.01, passes: 44 },
              last10: { games: 10, minutes: 80, starterRate: 0.85, goals: isForward ? 0.36 : 0.14, assists: 0.18, shots: isForward ? 2.4 : 1.2, shotsOnTarget: isForward ? 1.0 : 0.45, foulsCommitted: 1.0, foulsDrawn: 1.2, yellowCards: 0.16, redCards: 0.01, passes: 42 },
              last15: { games: 15, minutes: 80, starterRate: 0.85, goals: isForward ? 0.35 : 0.14, assists: 0.18, shots: isForward ? 2.4 : 1.2, shotsOnTarget: isForward ? 1.0 : 0.45, foulsCommitted: 1.0, foulsDrawn: 1.2, yellowCards: 0.16, redCards: 0.01, passes: 42 },
              home: { games: 8, minutes: 81, starterRate: 0.88, goals: isForward ? 0.38 : 0.15, assists: 0.2, shots: isForward ? 2.6 : 1.3, shotsOnTarget: isForward ? 1.1 : 0.5, foulsCommitted: 0.9, foulsDrawn: 1.3, yellowCards: 0.14, redCards: 0.01, passes: 45 },
              away: { games: 7, minutes: 79, starterRate: 0.82, goals: isForward ? 0.31 : 0.12, assists: 0.16, shots: isForward ? 2.2 : 1.1, shotsOnTarget: isForward ? 0.95 : 0.4, foulsCommitted: 1.1, foulsDrawn: 1.1, yellowCards: 0.18, redCards: 0.01, passes: 39 },
              h2h: { games: 3, minutes: 80, starterRate: 0.85, goals: isForward ? 0.33 : 0.14, assists: 0.18, shots: isForward ? 2.4 : 1.2, shotsOnTarget: isForward ? 1.0 : 0.45, foulsCommitted: 1.0, foulsDrawn: 1.2, yellowCards: 0.16, redCards: 0.01, passes: 42 },
            },
            recentLogs: [],
            sampleSizeGames: 15,
          });
        });

        lineup.substitutes.slice(0, 7).forEach((entry) => {
          const p = entry.player;
          list.push({
            id: `apifb-p-${p.id}`,
            sport: 'football',
            name: p.name,
            shortName: p.name.split(' ').slice(-1)[0] || p.name,
            teamId: `apifb-team-${teamIdStr}`,
            teamName,
            teamShort,
            number: p.number || 0,
            position: p.pos || 'SUB',
            photoUrl: `https://media.api-sports.io/football/players/${p.id}.png`,
            availability: 'bench',
            isKeyPlayer: false,
            impact: { offenseDelta: 0.08, defenseDelta: 0.04, usageShare: 0.06, assistShare: 0.06 },
            splits: {
              season: { games: 12, minutes: 26, starterRate: 0.2, goals: 0.1, assists: 0.08, shots: 0.8, shotsOnTarget: 0.35, foulsCommitted: 0.7, foulsDrawn: 0.7, yellowCards: 0.12, redCards: 0.01, passes: 18 },
              last5: { games: 5, minutes: 26, starterRate: 0.2, goals: 0.1, assists: 0.08, shots: 0.8, shotsOnTarget: 0.35, foulsCommitted: 0.7, foulsDrawn: 0.7, yellowCards: 0.12, redCards: 0.01, passes: 18 },
              last10: { games: 10, minutes: 26, starterRate: 0.2, goals: 0.1, assists: 0.08, shots: 0.8, shotsOnTarget: 0.35, foulsCommitted: 0.7, foulsDrawn: 0.7, yellowCards: 0.12, redCards: 0.01, passes: 18 },
              last15: { games: 12, minutes: 26, starterRate: 0.2, goals: 0.1, assists: 0.08, shots: 0.8, shotsOnTarget: 0.35, foulsCommitted: 0.7, foulsDrawn: 0.7, yellowCards: 0.12, redCards: 0.01, passes: 18 },
              home: { games: 6, minutes: 27, starterRate: 0.2, goals: 0.11, assists: 0.09, shots: 0.85, shotsOnTarget: 0.38, foulsCommitted: 0.7, foulsDrawn: 0.7, yellowCards: 0.11, redCards: 0.01, passes: 19 },
              away: { games: 6, minutes: 25, starterRate: 0.2, goals: 0.09, assists: 0.07, shots: 0.75, shotsOnTarget: 0.32, foulsCommitted: 0.7, foulsDrawn: 0.7, yellowCards: 0.13, redCards: 0.01, passes: 17 },
              h2h: { games: 2, minutes: 25, starterRate: 0.2, goals: 0.1, assists: 0.08, shots: 0.8, shotsOnTarget: 0.35, foulsCommitted: 0.7, foulsDrawn: 0.7, yellowCards: 0.12, redCards: 0.01, passes: 18 },
            },
            recentLogs: [],
            sampleSizeGames: 12,
          });
        });
      }

      for (const inj of sideInj) {
        if (!list.some((x) => x.id === `apifb-p-${inj.player.id}`)) {
          list.push({
            id: `apifb-p-${inj.player.id}`,
            sport: 'football',
            name: inj.player.name,
            shortName: inj.player.name.split(' ').slice(-1)[0] || inj.player.name,
            teamId: `apifb-team-${teamIdStr}`,
            teamName,
            teamShort,
            number: 0,
            position: 'Baja',
            photoUrl: inj.player.photo,
            availability: inj.player.type?.toLowerCase().includes('question') ? 'doubtful' : 'out',
            injuryNote: inj.player.reason || 'Lesión / Baja reportada',
            isKeyPlayer: true,
            impact: { offenseDelta: 0.18, defenseDelta: 0.09, usageShare: 0.12, assistShare: 0.12 },
            splits: {
              season: { games: 10, minutes: 70, starterRate: 0.7, goals: 0.18, assists: 0.14, shots: 1.5, shotsOnTarget: 0.6, foulsCommitted: 0.9, foulsDrawn: 1.0, yellowCards: 0.15, redCards: 0.01, passes: 35 },
              last5: { games: 5, minutes: 70, starterRate: 0.7, goals: 0.18, assists: 0.14, shots: 1.5, shotsOnTarget: 0.6, foulsCommitted: 0.9, foulsDrawn: 1.0, yellowCards: 0.15, redCards: 0.01, passes: 35 },
              last10: { games: 10, minutes: 70, starterRate: 0.7, goals: 0.18, assists: 0.14, shots: 1.5, shotsOnTarget: 0.6, foulsCommitted: 0.9, foulsDrawn: 1.0, yellowCards: 0.15, redCards: 0.01, passes: 35 },
              last15: { games: 10, minutes: 70, starterRate: 0.7, goals: 0.18, assists: 0.14, shots: 1.5, shotsOnTarget: 0.6, foulsCommitted: 0.9, foulsDrawn: 1.0, yellowCards: 0.15, redCards: 0.01, passes: 35 },
              home: { games: 5, minutes: 70, starterRate: 0.7, goals: 0.18, assists: 0.14, shots: 1.5, shotsOnTarget: 0.6, foulsCommitted: 0.9, foulsDrawn: 1.0, yellowCards: 0.15, redCards: 0.01, passes: 35 },
              away: { games: 5, minutes: 70, starterRate: 0.7, goals: 0.18, assists: 0.14, shots: 1.5, shotsOnTarget: 0.6, foulsCommitted: 0.9, foulsDrawn: 1.0, yellowCards: 0.15, redCards: 0.01, passes: 35 },
              h2h: { games: 2, minutes: 70, starterRate: 0.7, goals: 0.18, assists: 0.14, shots: 1.5, shotsOnTarget: 0.6, foulsCommitted: 0.9, foulsDrawn: 1.0, yellowCards: 0.15, redCards: 0.01, passes: 35 },
            },
            recentLogs: [],
            sampleSizeGames: 10,
          });
        }
      }
      return list;
    };

    const homeLineup = (lineupRes.response ?? []).find((l) => String(l.team.id) === homeTeamId);
    const awayLineup = (lineupRes.response ?? []).find((l) => String(l.team.id) === awayTeamId);
    const homePlayers = buildSidePlayers(homeTeamId, baseMatch.homeTeam.name, baseMatch.homeTeam.shortName);
    const awayPlayers = buildSidePlayers(awayTeamId, baseMatch.awayTeam.name, baseMatch.awayTeam.shortName);

    const h2hMeetings = (h2hRes.response ?? []).map((m) => ({
      date: m.fixture.date.slice(0, 10),
      home: m.teams.home.name,
      away: m.teams.away.name,
      score: `${m.goals.home ?? 0} - ${m.goals.away ?? 0}`,
    }));
    const h2hGoals = (h2hRes.response ?? []).reduce(
      (acc, m) => acc + (m.goals.home ?? 0) + (m.goals.away ?? 0),
      0
    );

    const parsedOdds: BookmakerOdd[] = [];
    const bm = oddsRes.response?.[0]?.bookmakers?.[0];
    if (bm?.bets) {
      const winnerBet = bm.bets.find((b) => b.name === 'Match Winner');
      if (winnerBet && winnerBet.values.length >= 3) {
        const o1 = Number(winnerBet.values.find((v) => v.value === 'Home')?.odd || 0);
        const ox = Number(winnerBet.values.find((v) => v.value === 'Draw')?.odd || 0);
        const o2 = Number(winnerBet.values.find((v) => v.value === 'Away')?.odd || 0);
        if (o1 > 1 && ox > 1 && o2 > 1) {
          parsedOdds.push({
            id: `apifb-odd-1`,
            marketCategory: 'match',
            marketLabel: 'Resultado Final (1X2)',
            selectionLabel: `Victoria ${baseMatch.homeTeam.name}`,
            side: 'home',
            decimalOdds: o1,
            threeWayOdds: [o1, ox, o2],
            bookmaker: bm.name,
            updatedAt: fetchedAt,
          });
          parsedOdds.push({
            id: `apifb-odd-2`,
            marketCategory: 'match',
            marketLabel: 'Resultado Final (1X2)',
            selectionLabel: `Victoria ${baseMatch.awayTeam.name}`,
            side: 'away',
            decimalOdds: o2,
            threeWayOdds: [o1, ox, o2],
            bookmaker: bm.name,
            updatedAt: fetchedAt,
          });
        }
      }
      const ouBet = bm.bets.find((b) => b.name === 'Goals Over/Under');
      if (ouBet) {
        const over25 = ouBet.values.find((v) => v.value === 'Over 2.5');
        const under25 = ouBet.values.find((v) => v.value === 'Under 2.5');
        if (over25 && under25) {
          parsedOdds.push({
            id: `apifb-odd-ou25`,
            marketCategory: 'totals',
            marketLabel: 'Más / Menos Goles',
            selectionLabel: 'Más de 2.5 goles',
            line: 2.5,
            side: 'over',
            decimalOdds: Number(over25.odd),
            complementOdds: Number(under25.odd),
            bookmaker: bm.name,
            updatedAt: fetchedAt,
          });
        }
      }
    }

    return {
      ...baseMatch,
      homeTeam: {
        ...baseMatch.homeTeam,
        formation: homeLineup?.formation ?? baseMatch.homeTeam.formation,
      },
      awayTeam: {
        ...baseMatch.awayTeam,
        formation: awayLineup?.formation ?? baseMatch.awayTeam.formation,
      },
      lineupStatus: homeLineup && awayLineup ? 'confirmed' : 'provisional',
      homePlayers,
      awayPlayers,
      h2hSummary: {
        played: h2hMeetings.length,
        homeWins: (h2hRes.response ?? []).filter(
          (m) =>
            (m.teams.home.name === baseMatch.homeTeam.name && m.teams.home.winner) ||
            (m.teams.away.name === baseMatch.homeTeam.name && m.teams.away.winner)
        ).length,
        draws: (h2hRes.response ?? []).filter((m) => m.teams.home.winner === null && m.teams.away.winner === null).length,
        awayWins: (h2hRes.response ?? []).filter(
          (m) =>
            (m.teams.home.name === baseMatch.awayTeam.name && m.teams.home.winner) ||
            (m.teams.away.name === baseMatch.awayTeam.name && m.teams.away.winner)
        ).length,
        avgTotalPointsOrGoals: h2hMeetings.length ? h2hGoals / h2hMeetings.length : 2.5,
        lastMeetings: h2hMeetings,
      },
      odds: parsedOdds.length > 0 ? parsedOdds : baseMatch.odds,
      updatedAt: fetchedAt,
    };
  }

  if (baseMatch.sport === 'nba' && provider === 'balldontlie' && baseMatch.id.startsWith('bdl-')) {
    const homeTeamId = baseMatch.homeTeam.id.replace('bdl-team-', '');
    const awayTeamId = baseMatch.awayTeam.id.replace('bdl-team-', '');
    const [hPlayersRes, aPlayersRes] = await Promise.all([
      fetch(`https://api.balldontlie.io/v1/players?team_ids[]=${homeTeamId}&per_page=12`, {
        headers: { Authorization: apiKey },
      }).then((r) => r.json()).catch(() => ({ data: [] })),
      fetch(`https://api.balldontlie.io/v1/players?team_ids[]=${awayTeamId}&per_page=12`, {
        headers: { Authorization: apiKey },
      }).then((r) => r.json()).catch(() => ({ data: [] })),
    ]) as [
      { data?: Array<{ id: number; first_name: string; last_name: string; position: string; jersey_number?: string }> },
      { data?: Array<{ id: number; first_name: string; last_name: string; position: string; jersey_number?: string }> }
    ];

    const mapBdlRoster = (
      arr: Array<{ id: number; first_name: string; last_name: string; position: string; jersey_number?: string }>,
      teamId: string,
      teamName: string,
      teamShort: string
    ): PlayerProfile[] =>
      arr.slice(0, 10).map((p, idx) => {
        const isStarter = idx < 5;
        const pos = p.position || (['PG', 'SG', 'SF', 'PF', 'C'][idx % 5]);
        const basePts = isStarter ? 17.5 - idx * 1.4 : 8.5;
        const baseReb = pos.includes('C') || pos.includes('F') ? 7.2 : 4.1;
        const baseAst = pos.includes('G') ? 5.2 : 2.3;
        return {
          id: `bdl-p-${p.id}`,
          sport: 'nba',
          name: `${p.first_name} ${p.last_name}`,
          shortName: `${p.first_name[0]}. ${p.last_name}`,
          teamId,
          teamName,
          teamShort,
          number: Number(p.jersey_number) || idx + 1,
          position: pos,
          availability: isStarter ? 'starter' : 'bench',
          isKeyPlayer: idx < 3,
          pitchCoord: isStarter ? mapNbaSlotCoord(pos, idx) : undefined,
          impact: {
            offenseDelta: isStarter ? 3.2 : 1.1,
            defenseDelta: 1.4,
            usageShare: isStarter ? 0.22 : 0.13,
            assistShare: pos.includes('G') ? 0.25 : 0.12,
          },
          splits: {
            season: { games: 30, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: basePts, rebounds: baseReb, assists: baseAst, threes: pos.includes('G') ? 2.1 : 0.9, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            last5: { games: 5, minutes: isStarter ? 32 : 20, starterRate: isStarter ? 0.95 : 0.2, points: basePts * 1.05, rebounds: baseReb, assists: baseAst, threes: pos.includes('G') ? 2.2 : 1.0, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            last10: { games: 10, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: basePts, rebounds: baseReb, assists: baseAst, threes: pos.includes('G') ? 2.1 : 0.9, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            last15: { games: 15, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: basePts, rebounds: baseReb, assists: baseAst, threes: pos.includes('G') ? 2.1 : 0.9, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            home: { games: 15, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: basePts * 1.04, rebounds: baseReb, assists: baseAst, threes: pos.includes('G') ? 2.2 : 0.9, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            away: { games: 15, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: basePts * 0.96, rebounds: baseReb, assists: baseAst, threes: pos.includes('G') ? 2.0 : 0.9, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            h2h: { games: 2, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: basePts, rebounds: baseReb, assists: baseAst, threes: pos.includes('G') ? 2.1 : 0.9, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
          },
          recentLogs: [],
          sampleSizeGames: 30,
        };
      });

    return {
      ...baseMatch,
      homePlayers: mapBdlRoster(hPlayersRes.data ?? [], baseMatch.homeTeam.id, baseMatch.homeTeam.name, baseMatch.homeTeam.shortName),
      awayPlayers: mapBdlRoster(aPlayersRes.data ?? [], baseMatch.awayTeam.id, baseMatch.awayTeam.name, baseMatch.awayTeam.shortName),
      updatedAt: fetchedAt,
    };
  }

  if (baseMatch.sport === 'football' && provider === 'football-data' && baseMatch.id.startsWith('fd-')) {
    const matchId = baseMatch.id.replace('fd-', '');
    const homeTeamId = baseMatch.homeTeam.id.replace('fd-team-', '');
    const awayTeamId = baseMatch.awayTeam.id.replace('fd-team-', '');
    const headers = { 'X-Auth-Token': apiKey.trim() };

    interface FdPlayer {
      id: number;
      name: string;
      position?: string;
      shirtNumber?: number;
    }
    interface FdMatchDetail {
      venue?: string;
      homeTeam?: { id: number; name: string; formation?: string; lineup?: FdPlayer[]; bench?: FdPlayer[] };
      awayTeam?: { id: number; name: string; formation?: string; lineup?: FdPlayer[]; bench?: FdPlayer[] };
    }
    interface FdH2H {
      matches?: Array<{
        utcDate: string;
        homeTeam: { name: string };
        awayTeam: { name: string };
        score?: { fullTime?: { home: number | null; away: number | null }; winner?: string | null };
      }>;
    }
    interface FdTeamMatches {
      matches?: Array<{
        utcDate: string;
        homeTeam: { id: number; name: string; tla?: string };
        awayTeam: { id: number; name: string; tla?: string };
        score?: { fullTime?: { home: number | null; away: number | null } };
      }>;
    }

    let rateLimited = false;
    const safeFdFetch = async <T>(url: string): Promise<T> => {
      try {
        const r = await fetch(url, { headers });
        if (r.status === 429) {
          rateLimited = true;
          return {} as T;
        }
        return r.ok ? ((await r.json()) as T) : ({} as T);
      } catch {
        return {} as T;
      }
    };

    const [detailRes, h2hRes, homeHistRes, awayHistRes] = await Promise.all([
      safeFdFetch<FdMatchDetail>(`https://api.football-data.org/v4/matches/${matchId}`),
      safeFdFetch<FdH2H>(`https://api.football-data.org/v4/matches/${matchId}/head2head?limit=10`),
      safeFdFetch<FdTeamMatches>(`https://api.football-data.org/v4/teams/${homeTeamId}/matches?status=FINISHED&limit=15`),
      safeFdFetch<FdTeamMatches>(`https://api.football-data.org/v4/teams/${awayTeamId}/matches?status=FINISHED&limit=15`),
    ]);

    const parseFdTeamHistory = (rawMatches: FdTeamMatches['matches'], teamNumId: string) => {
      const sorted = [...(rawMatches ?? [])]
        .filter((m) => m.score?.fullTime?.home !== null && m.score?.fullTime?.away !== null)
        .sort((a, b) => b.utcDate.localeCompare(a.utcDate))
        .slice(0, 15);

      const recentGames: TeamRecentGame[] = [];
      let hw = 0, hd = 0, hl = 0;
      let aw = 0, ad = 0, al = 0;
      let gfSum = 0, gaSum = 0;

      for (const m of sorted) {
        const isHome = String(m.homeTeam.id) === teamNumId;
        const sf = Number(isHome ? m.score?.fullTime?.home ?? 0 : m.score?.fullTime?.away ?? 0);
        const sa = Number(isHome ? m.score?.fullTime?.away ?? 0 : m.score?.fullTime?.home ?? 0);
        const result: 'W' | 'D' | 'L' = sf > sa ? 'W' : sf === sa ? 'D' : 'L';
        gfSum += sf;
        gaSum += sa;
        if (isHome) {
          if (result === 'W') hw += 1;
          else if (result === 'D') hd += 1;
          else hl += 1;
        } else {
          if (result === 'W') aw += 1;
          else if (result === 'D') ad += 1;
          else al += 1;
        }
        recentGames.push({
          date: (m.utcDate ?? '').slice(0, 10),
          opponent: isHome
            ? m.awayTeam?.tla || (m.awayTeam?.name ?? 'VIS').slice(0, 3).toUpperCase()
            : m.homeTeam?.tla || (m.homeTeam?.name ?? 'LOC').slice(0, 3).toUpperCase(),
          isHome,
          scoreFor: sf,
          scoreAgainst: sa,
          result,
        });
      }

      let restDays = 4;
      if (recentGames.length > 0 && recentGames[0].date) {
        const d = Math.round(
          (new Date(baseMatch.kickoffIso.slice(0, 10)).getTime() -
            new Date(recentGames[0].date).getTime()) /
            86400000
        );
        if (Number.isFinite(d) && d >= 0 && d <= 21) restDays = d;
      }

      const n = recentGames.length;
      return {
        recentGames,
        formRecent: recentGames.slice(0, 5).map((g) => g.result).reverse(),
        homeRecord: `${hw}-${hd}-${hl}`,
        awayRecord: `${aw}-${ad}-${al}`,
        ppg: n > 0 ? +(gfSum / n).toFixed(2) : undefined,
        oppg: n > 0 ? +(gaSum / n).toFixed(2) : undefined,
        restDays,
      };
    };

    const hHist = parseFdTeamHistory(homeHistRes.matches, homeTeamId);
    const aHist = parseFdTeamHistory(awayHistRes.matches, awayTeamId);

    const mapFdPosCode = (pos?: string): string => {
      const p = (pos || '').toLowerCase();
      if (p.includes('goal')) return 'G';
      if (p.includes('defen') || p.includes('back')) return 'D';
      if (p.includes('mid')) return 'M';
      if (p.includes('offen') || p.includes('forw') || p.includes('wing') || p.includes('strik')) return 'F';
      return 'M';
    };

    const buildFdPlayers = async (
      teamIdStr: string,
      teamName: string,
      teamShort: string,
      lineup?: FdPlayer[],
      bench?: FdPlayer[]
    ): Promise<{ players: PlayerProfile[]; confirmed: boolean }> => {
      let starters = lineup ?? [];
      let subs = bench ?? [];
      const confirmed = starters.length >= 11;

      if (starters.length === 0) {
        try {
          const tRes = await fetch(`https://api.football-data.org/v4/teams/${teamIdStr}`, { headers });
          if (tRes.ok) {
            const tJson = (await tRes.json()) as { squad?: FdPlayer[] };
            const squad = tJson.squad ?? [];
            const gks = squad.filter((s) => mapFdPosCode(s.position) === 'G');
            const defs = squad.filter((s) => mapFdPosCode(s.position) === 'D');
            const mids = squad.filter((s) => mapFdPosCode(s.position) === 'M');
            const fwds = squad.filter((s) => mapFdPosCode(s.position) === 'F');
            const ordered = [
              ...gks.slice(0, 1),
              ...defs.slice(0, 4),
              ...mids.slice(0, 3),
              ...fwds.slice(0, 3),
            ];
            const pickedIds = new Set(ordered.map((x) => x.id));
            starters = ordered.slice(0, 11);
            subs = squad.filter((s) => !pickedIds.has(s.id)).slice(0, 7);
          }
        } catch {
          // Keep empty if team squad fails
        }
      }

      const toProfile = (p: FdPlayer, idx: number, isStarter: boolean): PlayerProfile => {
        const pos = mapFdPosCode(p.position);
        const isForward = pos === 'F';
        const isMid = pos === 'M';
        return {
          id: `fd-p-${p.id}`,
          sport: 'football',
          name: p.name,
          shortName: p.name.split(' ').slice(-1)[0] || p.name,
          teamId: `fd-team-${teamIdStr}`,
          teamName,
          teamShort,
          number: p.shirtNumber || idx + 1,
          position: p.position || pos,
          availability: isStarter ? 'starter' : 'bench',
          isKeyPlayer: isStarter && (isForward || idx < 4),
          pitchCoord: isStarter ? mapFootballGridCoord(null, idx, starters.length || 11) : undefined,
          impact: {
            offenseDelta: isForward ? 0.25 : isMid ? 0.13 : 0.04,
            defenseDelta: pos === 'G' || pos === 'D' ? 0.13 : 0.04,
            usageShare: isForward ? 0.17 : isMid ? 0.1 : 0.03,
            assistShare: isMid ? 0.19 : isForward ? 0.14 : 0.04,
          },
          splits: {
            season: { games: isStarter ? 14 : 10, minutes: isStarter ? 78 : 26, starterRate: isStarter ? 0.84 : 0.2, goals: isForward ? 0.32 : isMid ? 0.13 : 0.04, assists: isMid ? 0.2 : 0.09, shots: isForward ? 2.3 : isMid ? 1.15 : 0.4, shotsOnTarget: isForward ? 0.95 : 0.42, foulsCommitted: 0.95, foulsDrawn: 1.15, yellowCards: 0.16, redCards: 0.01, passes: isMid ? 48 : 34 },
            last5: { games: 5, minutes: isStarter ? 80 : 28, starterRate: isStarter ? 0.88 : 0.2, goals: isForward ? 0.35 : 0.14, assists: 0.18, shots: isForward ? 2.4 : 1.1, shotsOnTarget: isForward ? 1.0 : 0.45, foulsCommitted: 0.95, foulsDrawn: 1.15, yellowCards: 0.15, redCards: 0.01, passes: 42 },
            last10: { games: 10, minutes: isStarter ? 78 : 26, starterRate: isStarter ? 0.84 : 0.2, goals: isForward ? 0.32 : 0.13, assists: 0.16, shots: isForward ? 2.3 : 1.1, shotsOnTarget: isForward ? 0.95 : 0.42, foulsCommitted: 0.95, foulsDrawn: 1.15, yellowCards: 0.16, redCards: 0.01, passes: 40 },
            last15: { games: 14, minutes: isStarter ? 78 : 26, starterRate: isStarter ? 0.84 : 0.2, goals: isForward ? 0.32 : 0.13, assists: 0.16, shots: isForward ? 2.3 : 1.1, shotsOnTarget: isForward ? 0.95 : 0.42, foulsCommitted: 0.95, foulsDrawn: 1.15, yellowCards: 0.16, redCards: 0.01, passes: 40 },
            home: { games: 7, minutes: isStarter ? 80 : 27, starterRate: isStarter ? 0.86 : 0.2, goals: isForward ? 0.36 : 0.14, assists: 0.18, shots: isForward ? 2.5 : 1.2, shotsOnTarget: isForward ? 1.05 : 0.45, foulsCommitted: 0.9, foulsDrawn: 1.25, yellowCards: 0.14, redCards: 0.01, passes: 43 },
            away: { games: 7, minutes: isStarter ? 76 : 25, starterRate: isStarter ? 0.82 : 0.2, goals: isForward ? 0.28 : 0.11, assists: 0.14, shots: isForward ? 2.1 : 1.0, shotsOnTarget: isForward ? 0.85 : 0.38, foulsCommitted: 1.0, foulsDrawn: 1.05, yellowCards: 0.18, redCards: 0.01, passes: 37 },
            h2h: { games: 3, minutes: isStarter ? 78 : 26, starterRate: isStarter ? 0.84 : 0.2, goals: isForward ? 0.3 : 0.13, assists: 0.16, shots: isForward ? 2.3 : 1.1, shotsOnTarget: isForward ? 0.95 : 0.42, foulsCommitted: 0.95, foulsDrawn: 1.15, yellowCards: 0.16, redCards: 0.01, passes: 40 },
          },
          recentLogs: [],
          sampleSizeGames: 14,
        };
      };

      return {
        confirmed,
        players: [
          ...starters.map((p, i) => toProfile(p, i, true)),
          ...subs.map((p, i) => toProfile(p, i, false)),
        ],
      };
    };

    const [homeRes, awayRes] = await Promise.all([
      buildFdPlayers(homeTeamId, baseMatch.homeTeam.name, baseMatch.homeTeam.shortName, detailRes.homeTeam?.lineup, detailRes.homeTeam?.bench),
      buildFdPlayers(awayTeamId, baseMatch.awayTeam.name, baseMatch.awayTeam.shortName, detailRes.awayTeam?.lineup, detailRes.awayTeam?.bench),
    ]);

    const h2hMeetings = (h2hRes.matches ?? []).map((m) => ({
      date: (m.utcDate ?? '').slice(0, 10),
      home: m.homeTeam?.name ?? 'Local',
      away: m.awayTeam?.name ?? 'Visitante',
      score: `${m.score?.fullTime?.home ?? 0} - ${m.score?.fullTime?.away ?? 0}`,
    }));
    const h2hGoals = (h2hRes.matches ?? []).reduce(
      (acc, m) => acc + (m.score?.fullTime?.home ?? 0) + (m.score?.fullTime?.away ?? 0),
      0
    );

    const teamStats = [
      {
        label: 'Goles a favor / partido (L15)',
        homeValue: hHist.ppg !== undefined ? hHist.ppg.toFixed(2) : '-',
        awayValue: aHist.ppg !== undefined ? aHist.ppg.toFixed(2) : '-',
      },
      {
        label: 'Goles encajados / partido (L15)',
        homeValue: hHist.oppg !== undefined ? hHist.oppg.toFixed(2) : '-',
        awayValue: aHist.oppg !== undefined ? aHist.oppg.toFixed(2) : '-',
      },
      {
        label: 'Balance en casa (V-E-D)',
        homeValue: hHist.homeRecord,
        awayValue: aHist.homeRecord,
      },
      {
        label: 'Balance como visitante (V-E-D)',
        homeValue: hHist.awayRecord,
        awayValue: aHist.awayRecord,
      },
      {
        label: 'Racha últimos 5',
        homeValue: hHist.formRecent.join(' ') || '-',
        awayValue: aHist.formRecent.join(' ') || '-',
      },
    ];

    const hasConfirmed = homeRes.confirmed && awayRes.confirmed;
    const hasAnyPlayers = homeRes.players.length > 0 && awayRes.players.length > 0;

    return {
      ...baseMatch,
      venue: detailRes.venue || baseMatch.venue,
      homeTeam: {
        ...baseMatch.homeTeam,
        formation: detailRes.homeTeam?.formation || baseMatch.homeTeam.formation || '4-3-3',
        recentGames: hHist.recentGames,
        formRecent: hHist.formRecent.length > 0 ? hHist.formRecent : baseMatch.homeTeam.formRecent,
        homeRecord: hHist.homeRecord,
        awayRecord: hHist.awayRecord,
        ppgOrGpg: hHist.ppg ?? baseMatch.homeTeam.ppgOrGpg,
        oppgOrGapg: hHist.oppg ?? baseMatch.homeTeam.oppgOrGapg,
        restDays: hHist.restDays,
      },
      awayTeam: {
        ...baseMatch.awayTeam,
        formation: detailRes.awayTeam?.formation || baseMatch.awayTeam.formation || '4-3-3',
        recentGames: aHist.recentGames,
        formRecent: aHist.formRecent.length > 0 ? aHist.formRecent : baseMatch.awayTeam.formRecent,
        homeRecord: aHist.homeRecord,
        awayRecord: aHist.awayRecord,
        ppgOrGpg: aHist.ppg ?? baseMatch.awayTeam.ppgOrGpg,
        oppgOrGapg: aHist.oppg ?? baseMatch.awayTeam.oppgOrGapg,
        restDays: aHist.restDays,
      },
      lineupStatus: hasConfirmed ? 'confirmed' : hasAnyPlayers ? 'provisional' : 'unknown',
      homePlayers: homeRes.players,
      awayPlayers: awayRes.players,
      teamStats,
      h2hSummary: {
        played: h2hMeetings.length,
        homeWins: (h2hRes.matches ?? []).filter(
          (m) =>
            (m.homeTeam.name === baseMatch.homeTeam.name && m.score?.winner === 'HOME_TEAM') ||
            (m.awayTeam.name === baseMatch.homeTeam.name && m.score?.winner === 'AWAY_TEAM')
        ).length,
        draws: (h2hRes.matches ?? []).filter((m) => m.score?.winner === 'DRAW').length,
        awayWins: (h2hRes.matches ?? []).filter(
          (m) =>
            (m.homeTeam.name === baseMatch.awayTeam.name && m.score?.winner === 'HOME_TEAM') ||
            (m.awayTeam.name === baseMatch.awayTeam.name && m.score?.winner === 'AWAY_TEAM')
        ).length,
        avgTotalPointsOrGoals: h2hMeetings.length ? h2hGoals / h2hMeetings.length : 2.5,
        lastMeetings: h2hMeetings,
      },
      hydrationStatus: hasAnyPlayers ? 'ok' : rateLimited ? 'query_error' : 'partial',
      hydrationNote: hasConfirmed
        ? 'Once inicial oficial confirmado + historial reciente L15 y H2H cargados.'
        : hasAnyPlayers
          ? 'Once probable generado desde la plantilla oficial y últimos 15 partidos (la alineación definitiva se confirma ~60 min antes del inicio).'
          : rateLimited
            ? 'Football-Data.org devolvió HTTP 429 (límite de 10 peticiones/minuto del plan gratuito). Espera ~45 s y vuelve a abrir este partido.'
            : 'Football-Data.org todavía no devolvió jugadores para este encuentro (convocatoria pendiente).',
      updatedAt: fetchedAt,
    };
  }

  if (baseMatch.sport === 'nba' && provider === 'basketballapi-net' && baseMatch.id.startsWith('bapi-')) {
    const gameId = baseMatch.id.replace('bapi-', '');
    const homeTeamId = baseMatch.homeTeam.id.replace('bapi-team-', '');
    const awayTeamId = baseMatch.awayTeam.id.replace('bapi-team-', '');
    const token = apiKey.trim().replace(/^Bearer\s+/i, '');
    const headers = { Authorization: `Bearer ${token}` };

    type AnyObj = Record<string, unknown>;
    const extractList = (payload: unknown): AnyObj[] => {
      if (Array.isArray(payload)) return payload as AnyObj[];
      if (payload && typeof payload === 'object') {
        const o = payload as AnyObj;
        for (const k of ['data', 'players', 'roster', 'response', 'results']) {
          if (Array.isArray(o[k])) return o[k] as AnyObj[];
        }
      }
      return [];
    };

    let statusErrorCode: number | null = null;
    const [gameRes, homeRosterRes, awayRosterRes] = await Promise.all([
      fetch(`https://api.basketballapi.net/v1/games/${gameId}`, { headers })
        .then(async (r) => {
          if (r.status === 401 || r.status === 403) statusErrorCode = r.status;
          return r.ok ? r.json() : {};
        })
        .catch(() => ({})) as Promise<AnyObj>,
      fetch(`https://api.basketballapi.net/v1/players?team_id=${homeTeamId}`, { headers })
        .then((r) => {
          if (r.status === 401 || r.status === 403) statusErrorCode = r.status;
          return r.ok ? r.json() : {};
        })
        .catch(() => ({})),
      fetch(`https://api.basketballapi.net/v1/players?team_id=${awayTeamId}`, { headers })
        .then((r) => {
          if (r.status === 401 || r.status === 403) statusErrorCode = r.status;
          return r.ok ? r.json() : {};
        })
        .catch(() => ({})),
    ]);

    const mapBapiPlayers = (
      rawList: AnyObj[],
      teamId: string,
      teamName: string,
      teamShort: string
    ): PlayerProfile[] =>
      rawList.slice(0, 12).map((p, idx) => {
        const fullName = String(
          p.full_name ?? p.name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
        ) || `Jugador ${idx + 1}`;
        const pos = String(p.position ?? ['PG', 'SG', 'SF', 'PF', 'C'][idx % 5]);
        const statusStr = String(p.injury_status ?? p.status ?? '').toLowerCase();
        const isOut = statusStr.includes('out') || statusStr.includes('inj');
        const isDoubtful = statusStr.includes('doubt') || statusStr.includes('quest') || statusStr.includes('day');
        const isStarter = !isOut && idx < 5;

        const avgPts = Number(p.ppg ?? p.points_per_game ?? (isStarter ? 17.5 - idx * 1.4 : 8.2));
        const avgReb = Number(p.rpg ?? p.rebounds_per_game ?? (pos.includes('C') || pos.includes('F') ? 7.1 : 4.0));
        const avgAst = Number(p.apg ?? p.assists_per_game ?? (pos.includes('G') ? 5.1 : 2.2));
        const avg3pm = Number(p.fg3m ?? (pos.includes('G') ? 2.1 : 0.9));

        return {
          id: `bapi-p-${String(p.id ?? `${teamShort}-${idx}`)}`,
          sport: 'nba',
          name: fullName,
          shortName: fullName.includes(' ') ? `${fullName[0]}. ${fullName.split(' ').slice(-1)[0]}` : fullName,
          teamId,
          teamName,
          teamShort,
          number: Number(p.jersey_number ?? p.number ?? idx + 1),
          position: pos,
          photoUrl: typeof p.photo_url === 'string' ? p.photo_url : typeof p.image === 'string' ? p.image : undefined,
          availability: isOut ? 'out' : isDoubtful ? 'doubtful' : isStarter ? 'starter' : 'bench',
          injuryNote: isOut || isDoubtful ? String(p.injury_note ?? p.injury_status ?? 'Reporte de disponibilidad') : undefined,
          isKeyPlayer: idx < 3,
          pitchCoord: isStarter ? mapNbaSlotCoord(pos, idx) : undefined,
          impact: {
            offenseDelta: isStarter ? 3.2 : 1.1,
            defenseDelta: 1.4,
            usageShare: isStarter ? 0.22 : 0.13,
            assistShare: pos.includes('G') ? 0.25 : 0.12,
          },
          splits: {
            season: { games: 30, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: avgPts, rebounds: avgReb, assists: avgAst, threes: avg3pm, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            last5: { games: 5, minutes: isStarter ? 32 : 20, starterRate: isStarter ? 0.95 : 0.2, points: avgPts * 1.04, rebounds: avgReb, assists: avgAst, threes: avg3pm, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            last10: { games: 10, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: avgPts, rebounds: avgReb, assists: avgAst, threes: avg3pm, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            last15: { games: 15, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: avgPts, rebounds: avgReb, assists: avgAst, threes: avg3pm, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            home: { games: 15, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: avgPts * 1.04, rebounds: avgReb, assists: avgAst, threes: avg3pm, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            away: { games: 15, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: avgPts * 0.96, rebounds: avgReb, assists: avgAst, threes: avg3pm, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
            h2h: { games: 2, minutes: isStarter ? 31 : 19, starterRate: isStarter ? 0.9 : 0.15, points: avgPts, rebounds: avgReb, assists: avgAst, threes: avg3pm, steals: 0.9, blocks: 0.6, turnovers: 1.8 },
          },
          recentLogs: [],
          sampleSizeGames: 30,
        };
      });

    const gameData = (gameRes.data && typeof gameRes.data === 'object' ? gameRes.data : gameRes) as AnyObj;
    const boxHome = extractList(gameData.home_players ?? (gameData.box_score as AnyObj | undefined)?.home);
    const boxAway = extractList(gameData.away_players ?? (gameData.box_score as AnyObj | undefined)?.away);
    const homeRaw = boxHome.length > 0 ? boxHome : extractList(homeRosterRes);
    const awayRaw = boxAway.length > 0 ? boxAway : extractList(awayRosterRes);
    const hp = mapBapiPlayers(homeRaw, baseMatch.homeTeam.id, baseMatch.homeTeam.name, baseMatch.homeTeam.shortName);
    const ap = mapBapiPlayers(awayRaw, baseMatch.awayTeam.id, baseMatch.awayTeam.name, baseMatch.awayTeam.shortName);

    if (hp.length > 0 && ap.length > 0) {
      return {
        ...baseMatch,
        lineupStatus: boxHome.length >= 5 && boxAway.length >= 5 ? 'confirmed' : 'provisional',
        homePlayers: hp,
        awayPlayers: ap,
        hydrationStatus: 'ok',
        hydrationNote: 'Plantilla y rotación cargadas desde BasketballAPI.net.',
        updatedAt: fetchedAt,
      };
    }
    // If BasketballAPI.net returns 403/empty, transparently enrich via official ESPN NBA + injury feeds below
  }

  if (baseMatch.sport === 'nba') {
    try {
      const espnNba = await fetchEspnNbaCalendarAndStandings();
      const baseTime = new Date(baseMatch.kickoffIso).getTime();
      const matchedEspn = espnNba.matches.find((em) => {
        const tDiff = Math.abs(new Date(em.kickoffIso).getTime() - baseTime);
        return (
          tDiff <= 48 * 3600_000 &&
          teamsMatch(em.homeTeam.name, baseMatch.homeTeam.name) &&
          teamsMatch(em.awayTeam.name, baseMatch.awayTeam.name)
        );
      });
      if (matchedEspn) {
        const hydratedEspn = await hydrateEspnNbaMatch(matchedEspn);
        return {
          ...hydratedEspn,
          id: baseMatch.id,
          competition: baseMatch.competition || hydratedEspn.competition,
          score: baseMatch.score ?? hydratedEspn.score,
          odds: baseMatch.odds.length > 0 ? baseMatch.odds : hydratedEspn.odds,
          dataOrigin: `${baseMatch.dataOrigin} + ESPN NBA / Parte Oficial`,
        };
      }
    } catch {
      // Keep baseMatch gracefully if ESPN lookup fails
    }
  }

  return baseMatch;
}
