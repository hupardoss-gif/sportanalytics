import type {
  MatchRecord,
  MatchStatus,
  PlayerProfile,
  StandingEntry,
  TeamRecentGame,
} from '../src/types/sports.ts';
import { fetchWithTimeout } from './httpUtils.ts';
import {
  fetchEspnNbaCalendarAndStandings,
  fetchEspnSoccerEnrichment,
  hydrateEspnNbaMatch,
  hydrateEspnSoccerMatch,
  teamsMatch,
} from './espnAdapters.ts';
import {
  buildProbableFootballLineups,
  promoteOfficialToConfirmedLineup,
  resolveEspnSoccerIdsForMatch,
} from './footballIntelligence.ts';

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

export interface FetchAdapterOptions {
  includeEspnFallback?: boolean;
}

export async function fetchFootballCalendarAndStandings(
  provider: string,
  apiKey: string,
  options: FetchAdapterOptions = {}
): Promise<{ matches: MatchRecord[]; standings: StandingEntry[] }> {
  const fetchedAt = new Date().toISOString();
  const includeEspnFallback = options.includeEspnFallback !== false;

  if (provider === 'api-football') {
    const dates = [isoDateOffset(-1), isoDateOffset(0), isoDateOffset(1), isoDateOffset(2)];
    const fixtureResponses = await Promise.all(
      dates.map(async (d) => {
        const res = await fetchWithTimeout(
          `https://v3.football.api-sports.io/fixtures?date=${d}`,
          { headers: { 'x-apisports-key': apiKey } },
          10000
        );
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
    rawAll.sort((a, b) => {
      const aTop = TOP_FOOTBALL_LEAGUE_IDS.has(a.league.id) ? 0 : 1;
      const bTop = TOP_FOOTBALL_LEAGUE_IDS.has(b.league.id) ? 0 : 1;
      if (aTop !== bTop) return aTop - bTop;
      return a.fixture.date.localeCompare(b.fixture.date);
    });

    const currentYear = new Date().getMonth() >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const standingsResults = await Promise.all(
      [140, 39].map(async (leagueId) => {
        try {
          const sRes = await fetchWithTimeout(
            `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${currentYear}`,
            { headers: { 'x-apisports-key': apiKey } },
            9000
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

    const standings = standingsResults.flat();
    const teamMetrics = new Map<string, StandingEntry>();
    for (const st of standings) teamMetrics.set(st.teamId, st);

    const matches: MatchRecord[] = rawAll.slice(0, 120).map((item) => {
      const hId = `apifb-team-${item.teams.home.id}`;
      const aId = `apifb-team-${item.teams.away.id}`;
      const hSt = teamMetrics.get(hId);
      const aSt = teamMetrics.get(aId);
      const hPpg = hSt && hSt.played > 0 ? +(hSt.goalsForOrPtsFor / hSt.played).toFixed(2) : undefined;
      const hOppg = hSt && hSt.played > 0 ? +(hSt.goalsAgainstOrPtsAgainst / hSt.played).toFixed(2) : undefined;
      const aPpg = aSt && aSt.played > 0 ? +(aSt.goalsForOrPtsFor / aSt.played).toFixed(2) : undefined;
      const aOppg = aSt && aSt.played > 0 ? +(aSt.goalsAgainstOrPtsAgainst / aSt.played).toFixed(2) : undefined;

      return {
        id: `apifb-${item.fixture.id}`,
        sport: 'football',
        competition: `${item.league.name}`,
        season: String(item.league.season),
        status: classifyKickoffStatus(item.fixture.date, item.fixture.status.short),
        kickoffIso: item.fixture.date,
        minuteOrClock: item.fixture.status.elapsed ? `${item.fixture.status.elapsed}'` : undefined,
        venue: item.fixture.venue?.name ?? 'Estadio oficial',
        homeTeam: {
          id: hId,
          name: item.teams.home.name,
          shortName: item.teams.home.name.slice(0, 3).toUpperCase(),
          league: item.league.name,
          record: hSt ? `${hSt.won}-${hSt.drawn ?? 0}-${hSt.lost} · ${hSt.pointsOrWinPct} pts` : 'API-Football',
          playedGames: hSt?.played,
          ppgOrGpg: hPpg,
          oppgOrGapg: hOppg,
          attackHome: hPpg !== undefined ? hPpg * 1.08 : undefined,
          defenseHome: hOppg !== undefined ? hOppg * 0.92 : undefined,
          formRecent: hSt?.form ?? [],
          restDays: 4,
        },
        awayTeam: {
          id: aId,
          name: item.teams.away.name,
          shortName: item.teams.away.name.slice(0, 3).toUpperCase(),
          league: item.league.name,
          record: aSt ? `${aSt.won}-${aSt.drawn ?? 0}-${aSt.lost} · ${aSt.pointsOrWinPct} pts` : 'API-Football',
          playedGames: aSt?.played,
          ppgOrGpg: aPpg,
          oppgOrGapg: aOppg,
          attackAway: aPpg !== undefined ? aPpg * 0.94 : undefined,
          defenseAway: aOppg !== undefined ? aOppg * 1.06 : undefined,
          formRecent: aSt?.form ?? [],
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
        teamStatsQuality: hSt && aSt ? 'verified' : hSt || aSt ? 'estimated' : 'unavailable',
        dataOrigin: 'API-Football (v3.football.api-sports.io)',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      };
    });

    return { matches, standings };
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

    const [win1Res, win2Res, espnEnrich] = await Promise.all([
      fetchWithTimeout(
        `https://api.football-data.org/v4/matches?dateFrom=${isoDateOffset(-4)}&dateTo=${isoDateOffset(5)}`,
        { headers },
        10000
      ),
      fetchWithTimeout(
        `https://api.football-data.org/v4/matches?dateFrom=${isoDateOffset(6)}&dateTo=${isoDateOffset(15)}`,
        { headers },
        10000
      ).catch(() => null),
      includeEspnFallback
        ? fetchEspnSoccerEnrichment().catch(() => ({ matches: [] as MatchRecord[], standings: [] as StandingEntry[] }))
        : Promise.resolve({ matches: [] as MatchRecord[], standings: [] as StandingEntry[] }),
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

    if (rawMatchMap.size < 15) {
      const compRangeFrom = isoDateOffset(0);
      const compRangeTo = isoDateOffset(25);
      for (const compCode of ['PD', 'PL', 'CL']) {
        try {
          const cRes = await fetchWithTimeout(
            `https://api.football-data.org/v4/competitions/${compCode}/matches?dateFrom=${compRangeFrom}&dateTo=${compRangeTo}`,
            { headers },
            9000
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

    const standingsList: StandingEntry[] = [...espnEnrich.standings];
    const teamStandingsListByName: Array<{
      teamName: string;
      played: number;
      record: string;
      ppg: number;
      oppg: number;
      attackStrength: number;
      defenseStrength: number;
      form: ('W' | 'D' | 'L')[];
    }> = espnEnrich.standings
      .filter((r) => r.played > 0)
      .map((r) => {
        const played = Math.max(1, r.played);
        const ppg = r.goalsForOrPtsFor / played;
        const oppg = r.goalsAgainstOrPtsAgainst / played;
        return {
          teamName: r.teamName,
          played: r.played,
          record: `${r.won}-${r.drawn ?? 0}-${r.lost} · ${r.pointsOrWinPct} pts`,
          ppg,
          oppg,
          attackStrength: Math.max(0.65, Math.min(2.6, ppg)),
          defenseStrength: Math.max(0.55, Math.min(2.1, oppg)),
          form: r.form,
        };
      });

    const teamStandingsMap = new Map<
      string,
      {
        played: number;
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
          const sRes = await fetchWithTimeout(
            `https://api.football-data.org/v4/competitions/${comp}/standings`,
            { headers },
            9000
          );
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
              played: r.playedGames,
              record: `${r.won}-${r.draw}-${r.lost} · ${r.points} pts`,
              ppg,
              oppg,
              attackStrength: Math.max(0.65, Math.min(2.6, ppg)),
              defenseStrength: Math.max(0.55, Math.min(2.1, oppg)),
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

        // Propagate ESPN recent form when matching team exists in ESPN schedule
        const matchingEspn = espnEnrich.matches.find(
          (em) =>
            teamsMatch(em.homeTeam.name, hName) &&
            teamsMatch(em.awayTeam.name, aName) &&
            Math.abs(new Date(em.kickoffIso).getTime() - new Date(m.utcDate).getTime()) <= 36 * 3600 * 1000
        );

        const homeForm =
          hSt?.form && hSt.form.length > 0
            ? hSt.form
            : matchingEspn?.homeTeam.formRecent ?? [];
        const awayForm =
          aSt?.form && aSt.form.length > 0
            ? aSt.form
            : matchingEspn?.awayTeam.formRecent ?? [];

        return {
          id: `fd-${m.id}`,
          sport: 'football',
          competition: compName,
          season: 'Actual',
          status: classifyKickoffStatus(m.utcDate, m.status),
          kickoffIso: m.utcDate,
          venue: matchingEspn?.venue ?? 'Sede oficial',
          homeTeam: {
            id: hId,
            name: hName,
            shortName: m.homeTeam.tla || hName.slice(0, 3).toUpperCase(),
            league: compName,
            record: hSt?.record ?? 'Football-Data.org',
            playedGames: hSt?.played,
            ppgOrGpg: hSt?.ppg,
            oppgOrGapg: hSt?.oppg,
            attackHome: hSt ? hSt.attackStrength * 1.08 : undefined,
            defenseHome: hSt ? hSt.defenseStrength * 0.92 : undefined,
            formRecent: homeForm,
            restDays: 4,
          },
          awayTeam: {
            id: aId,
            name: aName,
            shortName: m.awayTeam.tla || aName.slice(0, 3).toUpperCase(),
            league: compName,
            record: aSt?.record ?? 'Football-Data.org',
            playedGames: aSt?.played,
            ppgOrGpg: aSt?.ppg,
            oppgOrGapg: aSt?.oppg,
            attackAway: aSt ? aSt.attackStrength * 0.94 : undefined,
            defenseAway: aSt ? aSt.defenseStrength * 1.06 : undefined,
            formRecent: awayForm,
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
          teamStatsQuality: hSt && aSt ? 'verified' : hSt || aSt ? 'estimated' : 'unavailable',
          dataOrigin: 'Football-Data.org v4',
          updatedAt: fetchedAt,
          isOfflineReference: false,
        };
      });

    const extraEspnMatches = includeEspnFallback
      ? espnEnrich.matches.filter(
          (em) =>
            !fdMatches.some(
              (fm) =>
                teamsMatch(fm.homeTeam.name, em.homeTeam.name) &&
                teamsMatch(fm.awayTeam.name, em.awayTeam.name) &&
                Math.abs(new Date(fm.kickoffIso).getTime() - new Date(em.kickoffIso).getTime()) <= 36 * 3600 * 1000
            )
        )
      : [];

    return { matches: [...fdMatches, ...extraEspnMatches], standings: standingsList };
  }

  return { matches: [], standings: [] };
}

export async function fetchNbaCalendarAndStandings(
  provider: string,
  apiKey: string,
  options: FetchAdapterOptions = {}
): Promise<{ matches: MatchRecord[]; standings: StandingEntry[] }> {
  const fetchedAt = new Date().toISOString();
  const includeEspnFallback = options.includeEspnFallback !== false;

  if (provider === 'espn-nba') {
    return fetchEspnNbaCalendarAndStandings();
  }

  if (provider === 'balldontlie') {
    const dates = [isoDateOffset(-1), isoDateOffset(0), isoDateOffset(1), isoDateOffset(2)];
    const query = dates.map((d) => `dates[]=${d}`).join('&');
    const [res, espnNba] = await Promise.all([
      fetchWithTimeout(`https://api.balldontlie.io/v1/games?${query}&per_page=40`, {
        headers: { Authorization: apiKey },
      }, 10000),
      includeEspnFallback
        ? fetchEspnNbaCalendarAndStandings().catch(() => ({ matches: [] as MatchRecord[], standings: [] as StandingEntry[] }))
        : Promise.resolve({ matches: [] as MatchRecord[], standings: [] as StandingEntry[] }),
    ]);
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
      const matchingEspn = espnNba.matches.find(
        (em) =>
          teamsMatch(em.homeTeam.name, g.home_team.full_name) &&
          teamsMatch(em.awayTeam.name, g.visitor_team.full_name) &&
          Math.abs(new Date(em.kickoffIso).getTime() - new Date(kickoff).getTime()) <= 36 * 3600 * 1000
      );

      return {
        id: `bdl-${g.id}`,
        sport: 'nba',
        competition: 'NBA',
        season: 'Actual',
        status: isFinal ? 'finished' : isLive ? 'live' : classifyKickoffStatus(kickoff),
        kickoffIso: kickoff,
        minuteOrClock: isLive ? g.status : undefined,
        venue: matchingEspn?.venue ?? 'NBA Arena',
        homeTeam: {
          id: `bdl-team-${g.home_team.id}`,
          name: g.home_team.full_name,
          shortName: g.home_team.abbreviation,
          league: 'NBA',
          record: matchingEspn?.homeTeam.record ?? 'BallDontLie',
          playedGames: matchingEspn?.homeTeam.playedGames,
          ppgOrGpg: matchingEspn?.homeTeam.ppgOrGpg,
          oppgOrGapg: matchingEspn?.homeTeam.oppgOrGapg,
          offRating: matchingEspn?.homeTeam.offRating,
          defRating: matchingEspn?.homeTeam.defRating,
          pace: matchingEspn?.homeTeam.pace,
          formRecent: matchingEspn?.homeTeam.formRecent ?? [],
          restDays: matchingEspn?.homeTeam.restDays ?? 2,
        },
        awayTeam: {
          id: `bdl-team-${g.visitor_team.id}`,
          name: g.visitor_team.full_name,
          shortName: g.visitor_team.abbreviation,
          league: 'NBA',
          record: matchingEspn?.awayTeam.record ?? 'BallDontLie',
          playedGames: matchingEspn?.awayTeam.playedGames,
          ppgOrGpg: matchingEspn?.awayTeam.ppgOrGpg,
          oppgOrGapg: matchingEspn?.awayTeam.oppgOrGapg,
          offRating: matchingEspn?.awayTeam.offRating,
          defRating: matchingEspn?.awayTeam.defRating,
          pace: matchingEspn?.awayTeam.pace,
          formRecent: matchingEspn?.awayTeam.formRecent ?? [],
          restDays: matchingEspn?.awayTeam.restDays ?? 2,
        },
        score: isLive || isFinal ? { home: g.home_team_score, away: g.visitor_team_score } : undefined,
        lineupStatus: 'provisional',
        homePlayers: [],
        awayPlayers: [],
        h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 225, lastMeetings: [] },
        odds: [],
        teamStatsQuality: matchingEspn?.teamStatsQuality ?? 'unavailable',
        dataOrigin: 'BallDontLie NBA v1',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      };
    });
    return { matches, standings: espnNba.standings };
  }

  if (provider === 'api-basketball' || provider === 'api-nba') {
    const dates = [isoDateOffset(-1), isoDateOffset(0), isoDateOffset(1), isoDateOffset(2)];
    const [responses, espnNba] = await Promise.all([
      Promise.all(
        dates.map(async (d) => {
          const url =
            provider === 'api-nba'
              ? `https://v2.nba.api-sports.io/games?date=${d}`
              : `https://v1.basketball.api-sports.io/games?league=12&date=${d}`;
          const res = await fetchWithTimeout(url, { headers: { 'x-apisports-key': apiKey } }, 10000);
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
      ),
      includeEspnFallback
        ? fetchEspnNbaCalendarAndStandings().catch(() => ({ matches: [] as MatchRecord[], standings: [] as StandingEntry[] }))
        : Promise.resolve({ matches: [] as MatchRecord[], standings: [] as StandingEntry[] }),
    ]);

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
        const matchingEspn = espnNba.matches.find(
          (em) =>
            teamsMatch(em.homeTeam.name, g.teams.home.name) &&
            teamsMatch(em.awayTeam.name, away.name) &&
            Math.abs(new Date(em.kickoffIso).getTime() - new Date(kickoff).getTime()) <= 36 * 3600 * 1000
        );

        return {
          id: `${provider === 'api-nba' ? 'apinba2' : 'apibsk'}-${g.id}`,
          sport: 'nba',
          competition: 'NBA',
          season: 'Actual',
          status: isFinished ? 'finished' : isLive ? 'live' : classifyKickoffStatus(kickoff),
          kickoffIso: kickoff,
          venue: matchingEspn?.venue ?? 'NBA Arena',
          homeTeam: {
            id: `nba-team-${g.teams.home.id}`,
            name: g.teams.home.name,
            shortName: g.teams.home.code ?? g.teams.home.name.slice(0, 3).toUpperCase(),
            league: 'NBA',
            record: matchingEspn?.homeTeam.record ?? 'API-Sports NBA',
            playedGames: matchingEspn?.homeTeam.playedGames,
            ppgOrGpg: matchingEspn?.homeTeam.ppgOrGpg,
            oppgOrGapg: matchingEspn?.homeTeam.oppgOrGapg,
            offRating: matchingEspn?.homeTeam.offRating,
            defRating: matchingEspn?.homeTeam.defRating,
            pace: matchingEspn?.homeTeam.pace,
            formRecent: matchingEspn?.homeTeam.formRecent ?? [],
            restDays: matchingEspn?.homeTeam.restDays ?? 2,
          },
          awayTeam: {
            id: `nba-team-${away.id}`,
            name: away.name,
            shortName: away.code ?? away.name.slice(0, 3).toUpperCase(),
            league: 'NBA',
            record: matchingEspn?.awayTeam.record ?? 'API-Sports NBA',
            playedGames: matchingEspn?.awayTeam.playedGames,
            ppgOrGpg: matchingEspn?.awayTeam.ppgOrGpg,
            oppgOrGapg: matchingEspn?.awayTeam.oppgOrGapg,
            offRating: matchingEspn?.awayTeam.offRating,
            defRating: matchingEspn?.awayTeam.defRating,
            pace: matchingEspn?.awayTeam.pace,
            formRecent: matchingEspn?.awayTeam.formRecent ?? [],
            restDays: matchingEspn?.awayTeam.restDays ?? 2,
          },
          score: homePts !== null && awayPts !== null ? { home: homePts, away: awayPts } : undefined,
          lineupStatus: 'provisional',
          homePlayers: [],
          awayPlayers: [],
          h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 224, lastMeetings: [] },
          odds: [],
          teamStatsQuality: matchingEspn?.teamStatsQuality ?? 'unavailable',
          dataOrigin: provider === 'api-nba' ? 'API-NBA v2 (API-Sports)' : 'API-Basketball v1 (API-Sports)',
          updatedAt: fetchedAt,
          isOfflineReference: false,
        };
      });

    const standings: StandingEntry[] = [];
    try {
      const seasonYear = new Date().getMonth() >= 9 ? new Date().getFullYear() : new Date().getFullYear() - 1;
      if (provider === 'api-nba') {
        const sRes = await fetchWithTimeout(
          `https://v2.nba.api-sports.io/standings?league=standard&season=${seasonYear}`,
          { headers: { 'x-apisports-key': apiKey } },
          9000
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

    return { matches, standings: standings.length > 0 ? standings : espnNba.standings };
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
          const r = await fetchWithTimeout(url, { headers }, 9000);
          if (r.status === 401) {
            authError = 'BasketballAPI.net rechazó la clave API (HTTP 401).';
            return [] as AnyObj[];
          }
          if (!r.ok) return [] as AnyObj[];
          return extractArray(await r.json());
        } catch {
          return [] as AnyObj[];
        }
      })
    );

    if (authError) throw new Error(authError);

    const espnNba = includeEspnFallback
      ? await fetchEspnNbaCalendarAndStandings().catch(() => ({
          matches: [] as MatchRecord[],
          standings: [] as StandingEntry[],
        }))
      : { matches: [] as MatchRecord[], standings: [] as StandingEntry[] };

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

      const matchingEspn = espnNba.matches.find(
        (em) =>
          teamsMatch(em.homeTeam.name, homeName) &&
          teamsMatch(em.awayTeam.name, awayName) &&
          Math.abs(new Date(em.kickoffIso).getTime() - new Date(kickoffIso).getTime()) <= 36 * 3600 * 1000
      );

      matches.push({
        id: `bapi-${idStr}`,
        sport: 'nba',
        competition: leagueName,
        season: String(g.season ?? 'Actual'),
        status: isFinal ? 'finished' : isLive ? 'live' : classifyKickoffStatus(kickoffIso),
        kickoffIso,
        minuteOrClock: isLive ? String(statusObj?.short ?? g.clock ?? g.status ?? 'En juego') : undefined,
        venue: String((g.venue as AnyObj | undefined)?.name ?? g.venue ?? g.arena ?? matchingEspn?.venue ?? 'Pabellón oficial'),
        homeTeam: {
          id: `bapi-team-${homeId}`,
          name: homeName,
          shortName: homeShort,
          league: leagueName,
          record: matchingEspn?.homeTeam.record ?? 'BasketballAPI.net',
          playedGames: matchingEspn?.homeTeam.playedGames,
          ppgOrGpg: matchingEspn?.homeTeam.ppgOrGpg,
          oppgOrGapg: matchingEspn?.homeTeam.oppgOrGapg,
          offRating: matchingEspn?.homeTeam.offRating,
          defRating: matchingEspn?.homeTeam.defRating,
          pace: matchingEspn?.homeTeam.pace,
          formRecent: matchingEspn?.homeTeam.formRecent ?? [],
          restDays: matchingEspn?.homeTeam.restDays ?? 2,
        },
        awayTeam: {
          id: `bapi-team-${awayId}`,
          name: awayName,
          shortName: awayShort,
          league: leagueName,
          record: matchingEspn?.awayTeam.record ?? 'BasketballAPI.net',
          playedGames: matchingEspn?.awayTeam.playedGames,
          ppgOrGpg: matchingEspn?.awayTeam.ppgOrGpg,
          oppgOrGapg: matchingEspn?.awayTeam.oppgOrGapg,
          offRating: matchingEspn?.awayTeam.offRating,
          defRating: matchingEspn?.awayTeam.defRating,
          pace: matchingEspn?.awayTeam.pace,
          formRecent: matchingEspn?.awayTeam.formRecent ?? [],
          restDays: matchingEspn?.awayTeam.restDays ?? 2,
        },
        score: hasScore ? { home: Number(homeScoreVal), away: Number(awayScoreVal) } : undefined,
        lineupStatus: 'provisional',
        homePlayers: [],
        awayPlayers: [],
        h2hSummary: { played: 0, homeWins: 0, draws: 0, awayWins: 0, avgTotalPointsOrGoals: 224, lastMeetings: [] },
        odds: [],
        teamStatsQuality: matchingEspn?.teamStatsQuality ?? 'unavailable',
        dataOrigin: 'BasketballAPI.net v1',
        updatedAt: fetchedAt,
        isOfflineReference: false,
      });
    }

    matches.sort((a, b) => {
      const aNba = a.competition.toUpperCase().includes('NBA') ? 0 : 1;
      const bNba = b.competition.toUpperCase().includes('NBA') ? 0 : 1;
      if (aNba !== bNba) return aNba - bNba;
      return a.kickoffIso.localeCompare(b.kickoffIso);
    });

    const standings: StandingEntry[] = [];
    try {
      const sRes = await fetchWithTimeout('https://api.basketballapi.net/v1/standings', { headers }, 8000);
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

    const extraEspnNba = includeEspnFallback
      ? espnNba.matches.filter(
          (em) =>
            !matches.some(
              (bm) =>
                teamsMatch(bm.homeTeam.name, em.homeTeam.name) &&
                teamsMatch(bm.awayTeam.name, em.awayTeam.name) &&
                Math.abs(new Date(bm.kickoffIso).getTime() - new Date(em.kickoffIso).getTime()) <= 36 * 3600 * 1000
            )
        )
      : [];

    return {
      matches: [...matches, ...extraEspnNba],
      standings: standings.length > 0 ? standings : espnNba.standings,
    };
  }

  return { matches: [], standings: [] };
}

/**
 * Hydrates full lineups, injuries, H2H, team strength, and recent L15 history for an individual match.
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

    const [lineupRes, injRes, h2hRes] = await Promise.all([
      fetchWithTimeout(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixtureId}`, {
        headers: { 'x-apisports-key': apiKey },
      }, 9000).then((r) => (r.ok ? r.json() : { response: [] })).catch(() => ({ response: [] })),
      fetchWithTimeout(`https://v3.football.api-sports.io/injuries?fixture=${fixtureId}`, {
        headers: { 'x-apisports-key': apiKey },
      }, 9000).then((r) => (r.ok ? r.json() : { response: [] })).catch(() => ({ response: [] })),
      fetchWithTimeout(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}&last=5`, {
        headers: { 'x-apisports-key': apiKey },
      }, 9000).then((r) => (r.ok ? r.json() : { response: [] })).catch(() => ({ response: [] })),
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
            availabilityConfidence: 'confirmed',
            isKeyPlayer: isForward || idx === 0,
            pitchCoord: mapFootballGridCoord(p.grid, idx, lineup.startXI.length),
            impact: {
              offenseDelta: isForward ? 0.26 : isMid ? 0.13 : 0.04,
              defenseDelta: p.pos === 'G' || p.pos === 'D' ? 0.13 : 0.04,
              usageShare: isForward ? 0.17 : isMid ? 0.1 : 0.03,
              assistShare: isMid ? 0.19 : isForward ? 0.14 : 0.04,
            },
            splits: {
              season: { games: 0, minutes: 0, starterRate: 0.85 },
              last5: { games: 0, minutes: 0, starterRate: 0.85 },
              last10: { games: 0, minutes: 0, starterRate: 0.85 },
              last15: { games: 0, minutes: 0, starterRate: 0.85 },
              home: { games: 0, minutes: 0, starterRate: 0.85 },
              away: { games: 0, minutes: 0, starterRate: 0.85 },
              h2h: { games: 0, minutes: 0, starterRate: 0.85 },
            },
            recentLogs: [],
            sampleSizeGames: 0,
            statsQuality: 'unavailable',
            statsOriginNote: 'Alineación API-Football; estadísticas individuales reales no disponibles en esta fuente',
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
            availabilityConfidence: 'confirmed',
            isKeyPlayer: false,
            impact: { offenseDelta: 0.08, defenseDelta: 0.04, usageShare: 0.06, assistShare: 0.06 },
            splits: {
              season: { games: 0, minutes: 0, starterRate: 0.2 },
              last5: { games: 0, minutes: 0, starterRate: 0.2 },
              last10: { games: 0, minutes: 0, starterRate: 0.2 },
              last15: { games: 0, minutes: 0, starterRate: 0.2 },
              home: { games: 0, minutes: 0, starterRate: 0.2 },
              away: { games: 0, minutes: 0, starterRate: 0.2 },
              h2h: { games: 0, minutes: 0, starterRate: 0.2 },
            },
            recentLogs: [],
            sampleSizeGames: 0,
            statsQuality: 'unavailable',
            statsOriginNote: 'Suplente API-Football; estadísticas individuales reales no disponibles en esta fuente',
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
            availabilityConfidence: 'confirmed',
            injuryNote: inj.player.reason || 'Lesión / Baja reportada',
            isKeyPlayer: true,
            impact: { offenseDelta: 0.18, defenseDelta: 0.09, usageShare: 0.12, assistShare: 0.12 },
            splits: {
              season: { games: 0, minutes: 0, starterRate: 0 },
              last5: { games: 0, minutes: 0, starterRate: 0 },
              last10: { games: 0, minutes: 0, starterRate: 0 },
              last15: { games: 0, minutes: 0, starterRate: 0 },
              home: { games: 0, minutes: 0, starterRate: 0 },
              away: { games: 0, minutes: 0, starterRate: 0 },
              h2h: { games: 0, minutes: 0, starterRate: 0 },
            },
            recentLogs: [],
            sampleSizeGames: 0,
            statsQuality: 'unavailable',
            statsOriginNote: 'Parte médico oficial API-Football; sin estadísticas individuales',
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

    const baseHydrated: MatchRecord = {
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
      odds: [],
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
      updatedAt: fetchedAt,
    };

    if (homeLineup && awayLineup) {
      const confirmed = promoteOfficialToConfirmedLineup(
        baseHydrated,
        homePlayers,
        awayPlayers,
        'API-Football Oficial',
        fetchedAt,
        homeLineup.formation,
        awayLineup.formation
      );
      return {
        ...confirmed,
        hydrationStatus: 'ok',
        hydrationNote: 'Once inicial oficial confirmado por API-Football.',
        provenance: {
          source: 'API-Football Oficial',
          fetchedAt,
          status: 'ok',
          isStale: false,
          staleAgeMinutes: 0,
          dataType: 'real',
        },
      };
    }

    const espnIds = await resolveEspnSoccerIdsForMatch(
      baseMatch.competition,
      baseMatch.homeTeam.name,
      baseMatch.awayTeam.name
    );
    const probBundle = await buildProbableFootballLineups({
      match: baseHydrated,
      slug: espnIds.slug,
      homeEspnTeamId: espnIds.homeEspnTeamId,
      awayEspnTeamId: espnIds.awayEspnTeamId,
    });
    const probHome = probBundle.homePlayers.length >= 11 ? probBundle.homePlayers : homePlayers;
    const probAway = probBundle.awayPlayers.length >= 11 ? probBundle.awayPlayers : awayPlayers;
    return {
      ...baseHydrated,
      homePlayers: probHome,
      awayPlayers: probAway,
      lineupStatus: probHome.length > 0 && probAway.length > 0 ? 'provisional' : 'unknown',
      probableLineup: probBundle.probableLineup,
      footballNews: probBundle.footballNews,
      hydrationStatus: probHome.length > 0 ? 'ok' : 'not_published',
      hydrationNote: probBundle.probableLineup
        ? 'Alineación probable calculada con últimos partidos + noticias deportivas previas.'
        : 'Alineación oficial pendiente de publicación.',
      provenance: {
        source: `API-Football + ${probBundle.footballNews.sourcesChecked.slice(0, 2).join(', ')}`,
        fetchedAt,
        status: probHome.length > 0 ? 'ok' : 'partial',
        isStale: false,
        staleAgeMinutes: 0,
        dataType: probHome.length > 0 ? 'estimated' : 'unavailable',
      },
    };
  }

  if (baseMatch.sport === 'nba' && provider === 'balldontlie' && baseMatch.id.startsWith('bdl-')) {
    const homeTeamId = baseMatch.homeTeam.id.replace('bdl-team-', '');
    const awayTeamId = baseMatch.awayTeam.id.replace('bdl-team-', '');
    const [hPlayersRes, aPlayersRes] = await Promise.all([
      fetchWithTimeout(`https://api.balldontlie.io/v1/players?team_ids[]=${homeTeamId}&per_page=12`, {
        headers: { Authorization: apiKey },
      }, 9000).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
      fetchWithTimeout(`https://api.balldontlie.io/v1/players?team_ids[]=${awayTeamId}&per_page=12`, {
        headers: { Authorization: apiKey },
      }, 9000).then((r) => (r.ok ? r.json() : { data: [] })).catch(() => ({ data: [] })),
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
          availability: isStarter ? 'possible_starter' : 'available',
          availabilityConfidence: 'projected',
          isKeyPlayer: idx < 3,
          pitchCoord: isStarter ? mapNbaSlotCoord(pos, idx) : undefined,
          impact: {
            offenseDelta: isStarter ? 3.0 : 1.1,
            defenseDelta: 1.4,
            usageShare: isStarter ? 0.21 : 0.13,
            assistShare: pos.includes('G') ? 0.24 : 0.12,
          },
          splits: {
            season: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
            last5: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
            last10: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
            last15: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
            home: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
            away: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
            h2h: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
          },
          recentLogs: [],
          sampleSizeGames: 0,
          statsQuality: 'unavailable',
          statsOriginNote: 'Plantilla BallDontLie (estadísticas individuales reales no disponibles en esta fuente)',
        };
      });

    return {
      ...baseMatch,
      homePlayers: mapBdlRoster(hPlayersRes.data ?? [], baseMatch.homeTeam.id, baseMatch.homeTeam.name, baseMatch.homeTeam.shortName),
      awayPlayers: mapBdlRoster(aPlayersRes.data ?? [], baseMatch.awayTeam.id, baseMatch.awayTeam.name, baseMatch.awayTeam.shortName),
      odds: [],
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
        const r = await fetchWithTimeout(url, { headers }, 9000);
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
        played: n,
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
          const tRes = await fetchWithTimeout(
            `https://api.football-data.org/v4/teams/${teamIdStr}`,
            { headers },
            9000
          );
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
          } else if (tRes.status === 429) {
            rateLimited = true;
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
          availability: isStarter ? (confirmed ? 'confirmed_starter' : 'possible_starter') : 'bench',
          availabilityConfidence: confirmed ? 'confirmed' : 'projected',
          isKeyPlayer: isStarter && (isForward || idx < 4),
          pitchCoord: isStarter ? mapFootballGridCoord(null, idx, starters.length || 11) : undefined,
          impact: {
            offenseDelta: isForward ? 0.24 : isMid ? 0.13 : 0.04,
            defenseDelta: pos === 'G' || pos === 'D' ? 0.13 : 0.04,
            usageShare: isForward ? 0.17 : isMid ? 0.1 : 0.03,
            assistShare: isMid ? 0.18 : isForward ? 0.13 : 0.04,
          },
          splits: {
            season: { games: 0, minutes: 0, starterRate: isStarter ? 0.84 : 0.2 },
            last5: { games: 0, minutes: 0, starterRate: isStarter ? 0.84 : 0.2 },
            last10: { games: 0, minutes: 0, starterRate: isStarter ? 0.84 : 0.2 },
            last15: { games: 0, minutes: 0, starterRate: isStarter ? 0.84 : 0.2 },
            home: { games: 0, minutes: 0, starterRate: isStarter ? 0.84 : 0.2 },
            away: { games: 0, minutes: 0, starterRate: isStarter ? 0.84 : 0.2 },
            h2h: { games: 0, minutes: 0, starterRate: isStarter ? 0.84 : 0.2 },
          },
          recentLogs: [],
          sampleSizeGames: 0,
          statsQuality: 'unavailable',
          statsOriginNote: 'Plantilla oficial Football-Data.org; estadísticas individuales reales no disponibles en esta fuente',
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
    let fdHydrated: MatchRecord = {
      ...baseMatch,
      venue: detailRes.venue || baseMatch.venue,
      homeTeam: {
        ...baseMatch.homeTeam,
        formation: detailRes.homeTeam?.formation || baseMatch.homeTeam.formation || '4-3-3',
        playedGames: baseMatch.homeTeam.playedGames ?? (hHist.played > 0 ? hHist.played : undefined),
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
        playedGames: baseMatch.awayTeam.playedGames ?? (aHist.played > 0 ? aHist.played : undefined),
        recentGames: aHist.recentGames,
        formRecent: aHist.formRecent.length > 0 ? aHist.formRecent : baseMatch.awayTeam.formRecent,
        homeRecord: aHist.homeRecord,
        awayRecord: aHist.awayRecord,
        ppgOrGpg: aHist.ppg ?? baseMatch.awayTeam.ppgOrGpg,
        oppgOrGapg: aHist.oppg ?? baseMatch.awayTeam.oppgOrGapg,
        restDays: aHist.restDays,
      },
      teamStats,
      teamStatsQuality:
        (hHist.ppg !== undefined || baseMatch.homeTeam.ppgOrGpg !== undefined) &&
        (aHist.ppg !== undefined || baseMatch.awayTeam.ppgOrGpg !== undefined)
          ? 'verified'
          : 'estimated',
      odds: [],
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
      updatedAt: fetchedAt,
    };

    if (hasConfirmed) {
      fdHydrated = promoteOfficialToConfirmedLineup(
        fdHydrated,
        homeRes.players,
        awayRes.players,
        'Football-Data.org Oficial',
        fetchedAt,
        detailRes.homeTeam?.formation,
        detailRes.awayTeam?.formation
      );
      return {
        ...fdHydrated,
        hydrationStatus: 'ok',
        hydrationNote: 'Once inicial oficial confirmado + historial reciente L15 y H2H cargados.',
        provenance: {
          source: 'Football-Data.org Oficial',
          fetchedAt,
          status: 'ok',
          isStale: false,
          staleAgeMinutes: 0,
          dataType: 'real',
        },
      };
    }

    const espnIds = await resolveEspnSoccerIdsForMatch(
      baseMatch.competition,
      baseMatch.homeTeam.name,
      baseMatch.awayTeam.name
    );
    const probBundle = await buildProbableFootballLineups({
      match: {
        ...fdHydrated,
        homePlayers: homeRes.players,
        awayPlayers: awayRes.players,
      },
      slug: espnIds.slug,
      homeEspnTeamId: espnIds.homeEspnTeamId,
      awayEspnTeamId: espnIds.awayEspnTeamId,
    });

    const finalHome = probBundle.homePlayers.length >= 11 ? probBundle.homePlayers : homeRes.players;
    const finalAway = probBundle.awayPlayers.length >= 11 ? probBundle.awayPlayers : awayRes.players;
    const hasAnyPlayers = finalHome.length > 0 && finalAway.length > 0;

    return {
      ...fdHydrated,
      homeTeam: {
        ...fdHydrated.homeTeam,
        formation: probBundle.homeFormation ?? fdHydrated.homeTeam.formation,
      },
      awayTeam: {
        ...fdHydrated.awayTeam,
        formation: probBundle.awayFormation ?? fdHydrated.awayTeam.formation,
      },
      lineupStatus: hasAnyPlayers ? 'provisional' : 'unknown',
      homePlayers: finalHome,
      awayPlayers: finalAway,
      probableLineup: probBundle.probableLineup,
      footballNews: probBundle.footballNews,
      hydrationStatus: hasAnyPlayers ? 'ok' : rateLimited ? 'query_error' : 'partial',
      hydrationNote: hasAnyPlayers
        ? 'Once probable calculado desde últimos partidos + plantilla oficial y fuentes deportivas (se actualizará automáticamente al publicarse el once oficial).'
        : rateLimited
          ? 'Football-Data.org devolvió HTTP 429 (límite de 10 peticiones/minuto del plan gratuito). Espera ~45 s y vuelve a abrir este partido.'
          : 'Football-Data.org todavía no devolvió jugadores para este encuentro (convocatoria pendiente).',
      provenance: {
        source: `Football-Data.org + ${probBundle.footballNews.sourcesChecked.slice(0, 2).join(', ')}`,
        fetchedAt,
        status: rateLimited ? 'error' : hasAnyPlayers ? 'ok' : 'partial',
        isStale: rateLimited,
        staleAgeMinutes: 0,
        dataType: hasAnyPlayers ? 'estimated' : 'unavailable',
        errorMessage: rateLimited ? 'HTTP 429 Football-Data.org (rate limit)' : undefined,
      },
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

    const [gameRes, homeRosterRes, awayRosterRes] = await Promise.all([
      fetchWithTimeout(`https://api.basketballapi.net/v1/games/${gameId}`, { headers }, 8000)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})) as Promise<AnyObj>,
      fetchWithTimeout(`https://api.basketballapi.net/v1/players?team_id=${homeTeamId}`, { headers }, 8000)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
      fetchWithTimeout(`https://api.basketballapi.net/v1/players?team_id=${awayTeamId}`, { headers }, 8000)
        .then((r) => (r.ok ? r.json() : {}))
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

        const rawPts = p.ppg ?? p.points_per_game;
        const rawReb = p.rpg ?? p.rebounds_per_game;
        const rawAst = p.apg ?? p.assists_per_game;
        const raw3pm = p.fg3m;
        const hasRealAvg = rawPts !== undefined && Number.isFinite(Number(rawPts));
        const realSplit = hasRealAvg
          ? {
              games: 0,
              minutes: isStarter ? 30 : 19,
              starterRate: isStarter ? 0.85 : 0.15,
              points: Number(rawPts),
              ...(rawReb !== undefined && Number.isFinite(Number(rawReb)) ? { rebounds: Number(rawReb) } : {}),
              ...(rawAst !== undefined && Number.isFinite(Number(rawAst)) ? { assists: Number(rawAst) } : {}),
              ...(raw3pm !== undefined && Number.isFinite(Number(raw3pm)) ? { threes: Number(raw3pm) } : {}),
            }
          : {
              games: 0,
              minutes: 0,
              starterRate: isStarter ? 0.85 : 0.15,
            };

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
          availability: isOut ? 'out' : isDoubtful ? 'doubtful' : isStarter ? 'possible_starter' : 'available',
          availabilityConfidence: isOut || isDoubtful ? 'confirmed' : 'projected',
          injuryNote: isOut || isDoubtful ? String(p.injury_note ?? p.injury_status ?? 'Reporte de disponibilidad') : undefined,
          isKeyPlayer: idx < 3,
          pitchCoord: isStarter ? mapNbaSlotCoord(pos, idx) : undefined,
          impact: {
            offenseDelta: isStarter ? 3.0 : 1.1,
            defenseDelta: 1.4,
            usageShare: isStarter ? 0.21 : 0.13,
            assistShare: pos.includes('G') ? 0.24 : 0.12,
          },
          splits: {
            season: realSplit,
            last5: realSplit,
            last10: realSplit,
            last15: realSplit,
            home: realSplit,
            away: realSplit,
            h2h: { games: 0, minutes: 0, starterRate: isStarter ? 0.85 : 0.15 },
          },
          recentLogs: [],
          sampleSizeGames: 0,
          statsQuality: hasRealAvg ? 'estimated' : 'unavailable',
          statsOriginNote: hasRealAvg
            ? 'Promedios globales BasketballAPI.net (sin desglose partido a partido)'
            : 'Estadísticas individuales reales no disponibles en esta fuente',
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
        odds: [],
        hydrationStatus: 'ok',
        hydrationNote: 'Plantilla y rotación cargadas desde BasketballAPI.net.',
        updatedAt: fetchedAt,
      };
    }
  }

  if (baseMatch.sport === 'nba') {
    try {
      const espnNba = await fetchEspnNbaCalendarAndStandings();
      const baseTime = new Date(baseMatch.kickoffIso).getTime();
      const matchedEspn = espnNba.matches.find((em) => {
        const tDiff = Math.abs(new Date(em.kickoffIso).getTime() - baseTime);
        return (
          tDiff <= 36 * 3600_000 &&
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
          odds: [],
          dataOrigin: `${baseMatch.dataOrigin} + ESPN NBA / Parte Oficial`,
        };
      }
    } catch {
      // Keep baseMatch gracefully if ESPN lookup fails
    }
  }

  return baseMatch;
}

const GENERIC_VENUES = new Set([
  'sede oficial',
  'estadio oficial',
  'pabellón oficial',
  'nba arena',
  'estadio',
  '',
]);

const GENERIC_RECORDS = new Set([
  'football-data.org',
  'api-football',
  'basketballapi.net',
  'balldontlie',
  'api-sports nba',
  '',
]);

function isBetterVenue(candidate: string | undefined, current: string | undefined): boolean {
  const c = (candidate ?? '').trim();
  const cur = (current ?? '').trim();
  if (!c) return false;
  if (GENERIC_VENUES.has(c.toLowerCase())) return false;
  if (!cur || GENERIC_VENUES.has(cur.toLowerCase())) return true;
  return c.length > cur.length && cur === 'Sede oficial';
}

function isBetterRecord(candidate: string | undefined, current: string | undefined): boolean {
  const c = (candidate ?? '').trim();
  const cur = (current ?? '').trim();
  if (!c || GENERIC_RECORDS.has(c.toLowerCase())) return false;
  if (!cur || GENERIC_RECORDS.has(cur.toLowerCase())) return true;
  return false;
}

function qualityRank(q: MatchRecord['teamStatsQuality']): number {
  if (q === 'verified') return 3;
  if (q === 'estimated') return 2;
  return 1;
}

function mergeTeamInfo(primary: MatchRecord['homeTeam'], secondary: MatchRecord['homeTeam']): MatchRecord['homeTeam'] {
  return {
    ...primary,
    shortName:
      primary.shortName && primary.shortName.length >= 2 && primary.shortName !== 'LOC' && primary.shortName !== 'VIS'
        ? primary.shortName
        : secondary.shortName,
    formation: primary.formation ?? secondary.formation,
    record: isBetterRecord(secondary.record, primary.record) ? secondary.record : primary.record,
    homeRecord: primary.homeRecord && primary.homeRecord !== '-' ? primary.homeRecord : secondary.homeRecord,
    awayRecord: primary.awayRecord && primary.awayRecord !== '-' ? primary.awayRecord : secondary.awayRecord,
    playedGames: primary.playedGames ?? secondary.playedGames,
    ppgOrGpg: primary.ppgOrGpg ?? secondary.ppgOrGpg,
    oppgOrGapg: primary.oppgOrGapg ?? secondary.oppgOrGapg,
    formRecent: primary.formRecent.length > 0 ? primary.formRecent : secondary.formRecent,
    recentGames:
      (primary.recentGames?.length ?? 0) >= (secondary.recentGames?.length ?? 0)
        ? primary.recentGames
        : secondary.recentGames,
    restDays: primary.restDays !== 4 && primary.restDays !== 2 ? primary.restDays : secondary.restDays ?? primary.restDays,
    isBackToBack: primary.isBackToBack ?? secondary.isBackToBack,
    attackHome: primary.attackHome ?? secondary.attackHome,
    attackAway: primary.attackAway ?? secondary.attackAway,
    defenseHome: primary.defenseHome ?? secondary.defenseHome,
    defenseAway: primary.defenseAway ?? secondary.defenseAway,
    avgCorners: primary.avgCorners ?? secondary.avgCorners,
    avgYellowCards: primary.avgYellowCards ?? secondary.avgYellowCards,
    avgShots: primary.avgShots ?? secondary.avgShots,
    avgShotsOnTarget: primary.avgShotsOnTarget ?? secondary.avgShotsOnTarget,
    offRating: primary.offRating ?? secondary.offRating,
    defRating: primary.defRating ?? secondary.defRating,
    pace: primary.pace ?? secondary.pace,
    homeCourtBoost: primary.homeCourtBoost ?? secondary.homeCourtBoost,
    avgRebounds: primary.avgRebounds ?? secondary.avgRebounds,
    avgAssists: primary.avgAssists ?? secondary.avgAssists,
  };
}

export interface MultiSourceMatchBatch {
  provider: string;
  label: string;
  matches: MatchRecord[];
}

/**
 * Merges and cross-checks equivalent matches across multiple simultaneously active providers.
 * Preserves per-provider sourceIds so match hydration can query ALL connected sources in parallel,
 * enriches missing metrics across sources, and flags genuine score/status/time discrepancies.
 */
export function mergeMatchesAcrossSources(batches: MultiSourceMatchBatch[]): MatchRecord[] {
  const canonical: MatchRecord[] = [];

  for (const batch of batches) {
    for (const rawMatch of batch.matches) {
      const incoming: MatchRecord = {
        ...rawMatch,
        sourceIds: {
          ...(rawMatch.sourceIds ?? {}),
          [batch.provider]: rawMatch.id,
        },
        verifiedSources: Array.from(
          new Set([...(rawMatch.verifiedSources ?? [batch.label || rawMatch.dataOrigin])])
        ),
      };

      const incomingTs = new Date(incoming.kickoffIso).getTime();
      const existingIdx = canonical.findIndex((existing) => {
        if (existing.sport !== incoming.sport) return false;
        const existingTs = new Date(existing.kickoffIso).getTime();
        const timeDiff = Math.abs(existingTs - incomingTs);
        if (!Number.isFinite(timeDiff) || timeDiff > 36 * 3600_000) return false;
        return (
          teamsMatch(existing.homeTeam.name, incoming.homeTeam.name) &&
          teamsMatch(existing.awayTeam.name, incoming.awayTeam.name)
        );
      });

      if (existingIdx === -1) {
        canonical.push(incoming);
        continue;
      }

      const current = canonical[existingIdx];
      const discrepancies = [...(current.sourceDiscrepancies ?? [])];

      if (
        current.score &&
        incoming.score &&
        (current.score.home !== incoming.score.home || current.score.away !== incoming.score.away)
      ) {
        discrepancies.push(
          `Marcador distinto: ${current.verifiedSources?.[0] ?? current.dataOrigin} (${current.score.home}-${current.score.away}) vs ${batch.label} (${incoming.score.home}-${incoming.score.away})`
        );
      }

      if (
        current.status !== incoming.status &&
        ((current.status === 'finished' && incoming.status !== 'finished') ||
          (incoming.status === 'finished' && current.status !== 'finished'))
      ) {
        discrepancies.push(
          `Estado distinto: ${current.verifiedSources?.[0] ?? current.dataOrigin} (${current.status}) vs ${batch.label} (${incoming.status})`
        );
      }

      const kickoffDiffMin = Math.round(
        Math.abs(new Date(current.kickoffIso).getTime() - incomingTs) / 60_000
      );
      if (Number.isFinite(kickoffDiffMin) && kickoffDiffMin > 20 && kickoffDiffMin <= 24 * 60) {
        discrepancies.push(`Diferencia horaria entre fuentes (${kickoffDiffMin} min)`);
      }

      const mergedSources = Array.from(
        new Set([
          ...(current.verifiedSources ?? [current.dataOrigin]),
          ...(incoming.verifiedSources ?? [batch.label]),
        ])
      );

      const resolvedStatus: MatchStatus =
        current.status === 'live' || incoming.status === 'live'
          ? 'live'
          : current.status === 'finished' || incoming.status === 'finished'
            ? 'finished'
            : current.status;

      const resolvedLineupStatus =
        current.lineupStatus === 'confirmed' || incoming.lineupStatus === 'confirmed'
          ? 'confirmed'
          : current.lineupStatus === 'provisional' || incoming.lineupStatus === 'provisional'
            ? 'provisional'
            : 'unknown';

      const mergedQuality =
        qualityRank(incoming.teamStatsQuality) > qualityRank(current.teamStatsQuality)
          ? incoming.teamStatsQuality
          : current.teamStatsQuality;

      canonical[existingIdx] = {
        ...current,
        status: resolvedStatus,
        minuteOrClock: current.minuteOrClock ?? incoming.minuteOrClock,
        venue: isBetterVenue(incoming.venue, current.venue) ? incoming.venue : current.venue,
        score: current.score ?? incoming.score,
        lineupStatus: resolvedLineupStatus,
        homeTeam: mergeTeamInfo(current.homeTeam, incoming.homeTeam),
        awayTeam: mergeTeamInfo(current.awayTeam, incoming.awayTeam),
        teamStats:
          current.teamStats && current.teamStats.length > 0 ? current.teamStats : incoming.teamStats,
        teamStatsQuality: mergedQuality,
        h2hSummary:
          current.h2hSummary.played >= incoming.h2hSummary.played
            ? current.h2hSummary
            : incoming.h2hSummary,
        sourceIds: {
          ...(current.sourceIds ?? {}),
          ...(incoming.sourceIds ?? {}),
        },
        verifiedSources: mergedSources,
        sourceDiscrepancies: discrepancies.length > 0 ? Array.from(new Set(discrepancies)) : undefined,
        dataOrigin:
          mergedSources.length > 1
            ? `${mergedSources.join(' + ')} (verificado ${mergedSources.length} fuentes)`
            : mergedSources[0] ?? current.dataOrigin,
        updatedAt:
          incoming.updatedAt > current.updatedAt ? incoming.updatedAt : current.updatedAt,
      };
    }
  }

  return canonical;
}

export function mergeStandingsAcrossSources(batches: StandingEntry[][]): StandingEntry[] {
  const byKey = new Map<string, StandingEntry>();

  for (const list of batches) {
    for (const row of list) {
      const leagueKey = (row.league || 'league').toLowerCase().trim();
      let matchedKey: string | null = null;
      for (const [k, existing] of byKey.entries()) {
        if (existing.league.toLowerCase().trim() !== leagueKey) continue;
        if (
          (row.conference && existing.conference && row.conference !== existing.conference)
        ) {
          continue;
        }
        if (teamsMatch(existing.teamName, row.teamName)) {
          matchedKey = k;
          break;
        }
      }

      if (!matchedKey) {
        const key = `${leagueKey}:${row.conference ?? ''}:${row.teamName.toLowerCase()}`;
        byKey.set(key, row);
      } else {
        const cur = byKey.get(matchedKey)!;
        const curRichness =
          (cur.played > 0 ? 2 : 0) +
          (cur.form.length > 0 ? 1 : 0) +
          (cur.homeRecord !== '-' ? 1 : 0) +
          (cur.goalsForOrPtsFor > 0 ? 1 : 0);
        const rowRichness =
          (row.played > 0 ? 2 : 0) +
          (row.form.length > 0 ? 1 : 0) +
          (row.homeRecord !== '-' ? 1 : 0) +
          (row.goalsForOrPtsFor > 0 ? 1 : 0);

        const winner = rowRichness > curRichness ? row : cur;
        const loser = winner === cur ? row : cur;
        byKey.set(matchedKey, {
          ...winner,
          form: winner.form.length > 0 ? winner.form : loser.form,
          homeRecord: winner.homeRecord !== '-' ? winner.homeRecord : loser.homeRecord,
          awayRecord: winner.awayRecord !== '-' ? winner.awayRecord : loser.awayRecord,
          goalsForOrPtsFor: winner.goalsForOrPtsFor || loser.goalsForOrPtsFor,
          goalsAgainstOrPtsAgainst: winner.goalsAgainstOrPtsAgainst || loser.goalsAgainstOrPtsAgainst,
        });
      }
    }
  }

  return Array.from(byKey.values());
}

function normalizePlayerLookupName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function enrichPlayerListFromSecondary(
  primary: PlayerProfile[],
  secondary: PlayerProfile[]
): PlayerProfile[] {
  if (primary.length === 0) return secondary;
  if (secondary.length === 0) return primary;

  const secByName = new Map<string, PlayerProfile>();
  for (const sp of secondary) {
    secByName.set(normalizePlayerLookupName(sp.name), sp);
  }

  return primary.map((p) => {
    const match = secByName.get(normalizePlayerLookupName(p.name));
    if (!match) return p;

    const pHasRealStats =
      p.statsQuality === 'verified' ||
      (p.statsQuality === 'estimated' && p.sampleSizeGames > 0);
    const secHasRealStats =
      match.statsQuality === 'verified' ||
      (match.statsQuality === 'estimated' && match.sampleSizeGames > 0);

    const betterSplits = !pHasRealStats && secHasRealStats ? match.splits : p.splits;
    const betterLogs = p.recentLogs.length >= match.recentLogs.length ? p.recentLogs : match.recentLogs;
    const betterQuality = !pHasRealStats && secHasRealStats ? match.statsQuality : p.statsQuality;
    const betterOrigin =
      !pHasRealStats && secHasRealStats ? match.statsOriginNote : p.statsOriginNote;

    // Cross-verify injury / confirmed out flags across sources
    const secConfirmedAbsence =
      match.availabilityConfidence === 'confirmed' &&
      (match.availability === 'out' || match.availability === 'suspended' || match.availability === 'doubtful');
    const keepConfirmedStarter =
      p.availability === 'confirmed_starter' && p.availabilityConfidence === 'confirmed';

    const mergedAvailability =
      !keepConfirmedStarter && secConfirmedAbsence && p.availability !== 'out'
        ? match.availability
        : p.availability;

    return {
      ...p,
      photoUrl: p.photoUrl ?? match.photoUrl,
      availability: mergedAvailability,
      availabilityConfidence:
        !keepConfirmedStarter && secConfirmedAbsence
          ? match.availabilityConfidence
          : p.availabilityConfidence,
      injuryNote: p.injuryNote ?? match.injuryNote,
      minutesRestriction: p.minutesRestriction ?? match.minutesRestriction,
      latestNews: p.latestNews ?? match.latestNews,
      splits: betterSplits,
      recentLogs: betterLogs,
      sampleSizeGames: Math.max(p.sampleSizeGames, match.sampleSizeGames),
      statsQuality: betterQuality,
      statsOriginNote: betterOrigin,
      lastLogDate: p.lastLogDate ?? match.lastLogDate,
      dataFreshness: p.dataFreshness ?? match.dataFreshness,
    };
  });
}

/**
 * Combines multiple hydrated MatchRecord results for the same fixture obtained from
 * concurrently running providers (e.g. football-data + espn-football, or basketballapi-net + espn-nba).
 */
export function mergeHydratedMatchDetails(
  baseMatch: MatchRecord,
  variants: Array<{ provider: string; label: string; match: MatchRecord }>
): MatchRecord {
  if (variants.length === 0) return baseMatch;

  // Prefer confirmed lineup, then most hydrated players / verified team stats
  const ranked = [...variants].sort((a, b) => {
    const scoreVariant = (m: MatchRecord): number => {
      let s = 0;
      if (m.hydrationStatus === 'ok') s += 40;
      if (m.lineupStatus === 'confirmed') s += 35;
      else if (m.lineupStatus === 'provisional') s += 15;
      if (m.homePlayers.length > 0 && m.awayPlayers.length > 0) s += 20;
      if (m.homePlayers.some((p) => p.statsQuality === 'verified' || p.sampleSizeGames > 0)) s += 25;
      if ((m.homeTeam.recentGames?.length ?? 0) > 0) s += 15;
      if (m.h2hSummary.played > 0) s += 10;
      return s;
    };
    return scoreVariant(b.match) - scoreVariant(a.match);
  });

  let merged = { ...ranked[0].match };
  const discrepancies = new Set<string>(baseMatch.sourceDiscrepancies ?? []);
  const allSources = new Set<string>(baseMatch.verifiedSources ?? []);
  const mergedSourceIds: Record<string, string> = { ...(baseMatch.sourceIds ?? {}) };

  for (const v of variants) {
    mergedSourceIds[v.provider] = v.match.sourceIds?.[v.provider] ?? v.match.id;
    allSources.add(v.label);
    for (const d of v.match.sourceDiscrepancies ?? []) discrepancies.add(d);
  }

  for (let i = 1; i < ranked.length; i++) {
    const sec = ranked[i].match;
    if (
      merged.score &&
      sec.score &&
      (merged.score.home !== sec.score.home || merged.score.away !== sec.score.away)
    ) {
      discrepancies.add(
        `Marcador distinto al contrastar fuentes (${merged.score.home}-${merged.score.away} vs ${sec.score.home}-${sec.score.away})`
      );
    }

    merged = {
      ...merged,
      venue: isBetterVenue(sec.venue, merged.venue) ? sec.venue : merged.venue,
      score: merged.score ?? sec.score,
      homeTeam: mergeTeamInfo(merged.homeTeam, sec.homeTeam),
      awayTeam: mergeTeamInfo(merged.awayTeam, sec.awayTeam),
      homePlayers: enrichPlayerListFromSecondary(merged.homePlayers, sec.homePlayers),
      awayPlayers: enrichPlayerListFromSecondary(merged.awayPlayers, sec.awayPlayers),
      probableLineup: merged.probableLineup ?? sec.probableLineup,
      confirmedLineup: merged.confirmedLineup ?? sec.confirmedLineup,
      h2hSummary: merged.h2hSummary.played >= sec.h2hSummary.played ? merged.h2hSummary : sec.h2hSummary,
      teamStats:
        merged.teamStats && merged.teamStats.length > 0 ? merged.teamStats : sec.teamStats,
      teamStatsQuality:
        qualityRank(sec.teamStatsQuality) > qualityRank(merged.teamStatsQuality)
          ? sec.teamStatsQuality
          : merged.teamStatsQuality,
      footballNews: merged.footballNews ?? sec.footballNews,
      nbaNews: merged.nbaNews ?? sec.nbaNews,
    };
  }

  const verifiedList = Array.from(allSources).filter(Boolean);
  const nowIso = new Date().toISOString();
  const originLabel =
    verifiedList.length > 1
      ? `${verifiedList.join(' + ')} (contrastado ${verifiedList.length} fuentes)`
      : verifiedList[0] ?? merged.dataOrigin;

  return {
    ...merged,
    id: baseMatch.id,
    sourceIds: mergedSourceIds,
    verifiedSources: verifiedList,
    sourceDiscrepancies: discrepancies.size > 0 ? Array.from(discrepancies) : undefined,
    dataOrigin: originLabel,
    updatedAt: nowIso,
    provenance: {
      source: originLabel,
      fetchedAt: nowIso,
      status: merged.hydrationStatus === 'ok' ? 'ok' : merged.provenance?.status ?? 'partial',
      isStale: Boolean(merged.provenance?.isStale),
      staleAgeMinutes: 0,
      dataType: merged.provenance?.dataType ?? (merged.teamStatsQuality === 'verified' ? 'real' : 'estimated'),
      errorMessage: merged.provenance?.errorMessage,
    },
  };
}
