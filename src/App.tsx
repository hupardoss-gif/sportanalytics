import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  ChevronRight,
  History,
  LayoutGrid,
  RefreshCw,
  Search,
  Settings,
  Trophy,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type {
  ApiConfigState,
  AvailabilityStatus,
  LoggedPrediction,
  MatchRecord,
  MatchStatus,
  PlayerProfile,
  SportType,
  StandingEntry,
} from './types/sports.ts';
import { SANDBOX_MATCHES, SANDBOX_STANDINGS, INITIAL_PREDICTION_HISTORY } from './data/sandboxData.ts';
import { computeFootballMatchPrediction } from './engine/footballModel.ts';
import { computeNbaMatchPrediction } from './engine/nbaModel.ts';
import { MatchDetailView } from './components/MatchDetailView.tsx';
import { StandingsView } from './components/StandingsView.tsx';
import { HistoryEvaluationView } from './components/HistoryEvaluationView.tsx';
import { ApiConfigView } from './components/ApiConfigView.tsx';
import { PlayerDetailModal } from './components/PlayerDetailModal.tsx';

type NavSection = 'overview' | 'matches' | 'history' | 'settings';
type DataMode = 'live' | 'offline_sim';

const EMPTY_API_CONFIG: ApiConfigState = {
  football: {
    connected: false,
    provider: 'football-data',
    maskedKey: null,
    lastChecked: null,
    error: null,
  },
  nba: {
    connected: false,
    provider: 'espn-nba',
    maskedKey: null,
    reuseFootballKey: false,
    lastChecked: null,
    error: null,
  },
  security: {
    pinConfigured: false,
    unlocked: false,
    envProtected: false,
  },
};

export default function App() {
  const [section, setSection] = useState<NavSection>('overview');
  const [sport, setSport] = useState<SportType>('football');
  const [dataMode, setDataMode] = useState<DataMode>('offline_sim');
  const [matchStatusFilter, setMatchStatusFilter] = useState<'all' | MatchStatus>('all');
  const [competitionFilter, setCompetitionFilter] = useState<string>('all');
  const [visibleMatchCount, setVisibleMatchCount] = useState<number>(20);
  const [globalSearch, setGlobalSearch] = useState('');

  const [apiConfig, setApiConfig] = useState<ApiConfigState>(EMPTY_API_CONFIG);
  const [liveMatches, setLiveMatches] = useState<MatchRecord[]>([]);
  const [liveStandings, setLiveStandings] = useState<StandingEntry[]>([]);
  const [liveErrors, setLiveErrors] = useState<string[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);

  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [hydratingMatchId, setHydratingMatchId] = useState<string | null>(null);
  const [refreshingNbaNewsId, setRefreshingNbaNewsId] = useState<string | null>(null);
  const [activeModalPlayer, setActiveModalPlayer] = useState<{
    player: PlayerProfile;
    match: MatchRecord;
  } | null>(null);
  const [playerOverrides, setPlayerOverrides] = useState<Record<string, AvailabilityStatus>>({});
  const [historyItems, setHistoryItems] = useState<LoggedPrediction[]>(INITIAL_PREDICTION_HISTORY);
  const [showStandingsInMatches, setShowStandingsInMatches] = useState(false);

  const loadConfigAndLive = useCallback(async (forceRefresh = false) => {
    setLiveLoading(true);
    try {
      const res = await fetch(forceRefresh ? '/api/sports/live?refresh=1' : '/api/sports/live');
      if (res.ok) {
        const data = (await res.json()) as {
          config: ApiConfigState;
          matches: MatchRecord[];
          standings?: StandingEntry[];
          errors: string[];
        };
        setApiConfig(data.config);
        setLiveMatches(data.matches);
        setLiveStandings(data.standings ?? []);
        setLiveErrors(data.errors ?? []);
        if (
          data.config.football.connected ||
          data.config.nba.connected ||
          data.matches.length > 0
        ) {
          setDataMode('live');
        }
      }
    } catch {
      // Keep current state cleanly if server is starting
    } finally {
      setLiveLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const items = (await res.json()) as LoggedPrediction[];
        setHistoryItems(items);
      }
    } catch {
      // Fallback already seeded in state
    }
  }, []);

  useEffect(() => {
    loadConfigAndLive();
    loadHistory();
  }, [loadConfigAndLive, loadHistory]);

  const activeMatches = useMemo(() => {
    return dataMode === 'live' ? liveMatches : SANDBOX_MATCHES;
  }, [dataMode, liveMatches]);

  const activeStandings: StandingEntry[] = useMemo(() => {
    return dataMode === 'live' ? liveStandings : SANDBOX_STANDINGS;
  }, [dataMode, liveStandings]);

  const availableCompetitions = useMemo(() => {
    const set = new Set<string>();
    for (const m of activeMatches) {
      if (m.sport === sport && m.competition) {
        set.add(m.competition);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [activeMatches, sport]);

  useEffect(() => {
    setVisibleMatchCount(20);
  }, [sport, matchStatusFilter, competitionFilter, globalSearch, dataMode]);

  useEffect(() => {
    setCompetitionFilter('all');
  }, [sport]);

  const filteredMatches = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    const statusPriority: Record<MatchStatus, number> = {
      live: 0,
      today: 1,
      upcoming: 2,
      finished: 3,
    };
    return activeMatches
      .filter((m) => {
        if (m.sport !== sport) return false;
        if (matchStatusFilter !== 'all' && m.status !== matchStatusFilter) return false;
        if (competitionFilter !== 'all' && m.competition !== competitionFilter) return false;
        if (!q) return true;
        const teamMatch =
          m.homeTeam.name.toLowerCase().includes(q) ||
          m.awayTeam.name.toLowerCase().includes(q) ||
          m.competition.toLowerCase().includes(q);
        const playerMatch = [...m.homePlayers, ...m.awayPlayers].some((p) =>
          p.name.toLowerCase().includes(q)
        );
        return teamMatch || playerMatch;
      })
      .sort((a, b) => {
        const pDiff = statusPriority[a.status] - statusPriority[b.status];
        if (pDiff !== 0) return pDiff;
        const tA = new Date(a.kickoffIso).getTime();
        const tB = new Date(b.kickoffIso).getTime();
        return a.status === 'finished' ? tB - tA : tA - tB;
      });
  }, [activeMatches, sport, matchStatusFilter, competitionFilter, globalSearch]);

  const selectedMatch = useMemo(
    () => activeMatches.find((m) => m.id === selectedMatchId) ?? null,
    [activeMatches, selectedMatchId]
  );

  const allSameSportPlayers = useMemo(() => {
    const map = new Map<string, PlayerProfile>();
    for (const m of activeMatches) {
      if (m.sport !== sport) continue;
      for (const p of [...m.homePlayers, ...m.awayPlayers]) {
        map.set(p.id, { ...p, availability: playerOverrides[p.id] ?? p.availability });
      }
    }
    return Array.from(map.values());
  }, [activeMatches, sport, playerOverrides]);

  const handleToggleAvailability = (playerId: string, nextStatus: AvailabilityStatus) => {
    setPlayerOverrides((prev) => ({ ...prev, [playerId]: nextStatus }));
  };

  const handleLogPrediction = async (
    pred: Omit<LoggedPrediction, 'id' | 'createdAt' | 'status'>
  ) => {
    try {
      const res = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pred),
      });
      if (res.ok) {
        const updated = (await res.json()) as LoggedPrediction[];
        setHistoryItems(updated);
      }
    } catch {
      // Ignore network hiccup
    }
  };

  const handleResolveHistory = async (
    id: string,
    status: 'won' | 'lost',
    actualValue?: number
  ) => {
    try {
      const res = await fetch(`/api/history/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, actualValue }),
      });
      if (res.ok) {
        const updated = (await res.json()) as LoggedPrediction[];
        setHistoryItems(updated);
      }
    } catch {
      // Ignore
    }
  };

  const handleRefreshNbaNews = useCallback(async (m: MatchRecord) => {
    if (m.sport !== 'nba' || m.isOfflineReference) return;
    setRefreshingNbaNewsId(m.id);
    try {
      const res = await fetch('/api/nba/match/refresh-news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match: m, includeSearchGrounding: true }),
      });
      if (res.ok) {
        const data = (await res.json()) as { match: MatchRecord };
        if (data.match) {
          setLiveMatches((prev) =>
            prev.map((item) => (item.id === data.match.id ? data.match : item))
          );
        }
      }
    } catch {
      // Keep current match data cleanly if refresh fails
    } finally {
      setRefreshingNbaNewsId(null);
    }
  }, []);

  useEffect(() => {
    if (
      !selectedMatch ||
      selectedMatch.sport !== 'nba' ||
      selectedMatch.isOfflineReference ||
      (selectedMatch.status !== 'today' && selectedMatch.status !== 'upcoming')
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void handleRefreshNbaNews(selectedMatch);
    }, 180_000);
    return () => window.clearInterval(timer);
  }, [selectedMatch, handleRefreshNbaNews]);

  const openMatchAnalysis = async (matchId: string) => {
    const m = activeMatches.find((item) => item.id === matchId);
    if (m) setSport(m.sport);
    setSelectedMatchId(matchId);
    setSection('matches');

    if (m && !m.isOfflineReference && m.hydrationStatus !== 'ok') {
      setHydratingMatchId(matchId);
      try {
        const res = await fetch('/api/sports/match/hydrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ match: m }),
        });
        if (res.ok) {
          const data = (await res.json()) as { match: MatchRecord };
          if (data.match) {
            setLiveMatches((prev) =>
              prev.map((item) => (item.id === data.match.id ? data.match : item))
            );
          }
        }
      } catch {
        // Keep base match if hydration fails
      } finally {
        setHydratingMatchId(null);
      }
    } else if (
      m &&
      !m.isOfflineReference &&
      m.sport === 'nba' &&
      (m.status === 'today' || m.status === 'upcoming')
    ) {
      const newsAgeMs = m.nbaNews?.fetchedAt
        ? Date.now() - new Date(m.nbaNews.fetchedAt).getTime()
        : Infinity;
      if (newsAgeMs > 180_000) {
        void handleRefreshNbaNews(m);
      }
    }
  };

  const renderMatchCard = (m: MatchRecord) => {
    const homeOv = m.homePlayers.map((p) => ({
      ...p,
      availability: playerOverrides[p.id] ?? p.availability,
    }));
    const awayOv = m.awayPlayers.map((p) => ({
      ...p,
      availability: playerOverrides[p.id] ?? p.availability,
    }));
    const fbPred =
      m.sport === 'football'
        ? computeFootballMatchPrediction(m, homeOv, awayOv, historyItems)
        : null;
    const nbaPred =
      m.sport === 'nba'
        ? computeNbaMatchPrediction(m, homeOv, awayOv, historyItems)
        : null;

    const statusLabel =
      m.status === 'live'
        ? `En directo · ${m.minuteOrClock ?? 'En juego'}`
        : m.status === 'finished'
        ? 'Finalizado'
        : m.status === 'today'
        ? `Hoy · ${new Date(m.kickoffIso).toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
          })}`
        : new Date(m.kickoffIso).toLocaleString('es-ES', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          });

    return (
      <button
        key={m.id}
        type="button"
        onClick={() => openMatchAnalysis(m.id)}
        className="w-full text-left rounded-xl border border-slate-800 bg-[#0D1526] hover:border-blue-500/50 p-4 sm:p-5 space-y-4 transition-colors cursor-pointer group"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span>
            {m.competition} ·{' '}
            {m.lineupStatus === 'confirmed'
              ? 'Alineación confirmada'
              : m.lineupStatus === 'provisional'
              ? 'Alineación probable'
              : 'Alineación por confirmar'}
            {fbPred
              ? ` · Cob. ${fbPred.dataConfidence}%`
              : nbaPred
                ? ` · Cob. ${nbaPred.dataConfidence}%`
                : ''}
          </span>
          <span
            className={`font-mono tabular-nums font-medium ${
              m.status === 'live' ? 'text-emerald-400' : 'text-slate-300'
            }`}
          >
            {statusLabel}
          </span>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="text-base font-bold text-white truncate group-hover:text-blue-400 transition-colors">
              {m.homeTeam.name}
            </div>
            <div className="text-base font-bold text-slate-200 truncate">
              {m.awayTeam.name}
            </div>
          </div>

          <div className="text-right font-mono tabular-nums shrink-0">
            {m.score ? (
              <div className="text-xl font-bold text-white">
                {m.score.home} - {m.score.away}
              </div>
            ) : fbPred ? (
              <div>
                <span className="text-xs text-slate-400 block">xG Proyectado</span>
                <span className="text-base font-bold text-blue-300">
                  {fbPred.lambdaHome.toFixed(2)} - {fbPred.lambdaAway.toFixed(2)}
                </span>
              </div>
            ) : nbaPred ? (
              <div>
                <span className="text-xs text-slate-400 block">Proyección</span>
                <span className="text-base font-bold text-blue-300">
                  {nbaPred.expectedHomePts.toFixed(0)} - {nbaPred.expectedAwayPts.toFixed(0)}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Probability Visual Bar */}
        {fbPred && (
          <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
            <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-300">
              <span>
                1 ({m.homeTeam.shortName}): {(fbPred.probHome * 100).toFixed(1)}%
              </span>
              <span>X: {(fbPred.probDraw * 100).toFixed(1)}%</span>
              <span>
                2 ({m.awayTeam.shortName}): {(fbPred.probAway * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-2 rounded-full overflow-hidden bg-slate-800 flex">
              <div style={{ width: `${fbPred.probHome * 100}%` }} className="bg-blue-500" />
              <div style={{ width: `${fbPred.probDraw * 100}%` }} className="bg-slate-500" />
              <div style={{ width: `${fbPred.probAway * 100}%` }} className="bg-sky-400" />
            </div>
          </div>
        )}

        {nbaPred && (
          <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
            <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-300">
              <span>
                {m.homeTeam.shortName}: {(nbaPred.probHomeWin * 100).toFixed(1)}%
              </span>
              <span>Total: {nbaPred.expectedTotal.toFixed(1)}</span>
              <span>
                {m.awayTeam.shortName}: {(nbaPred.probAwayWin * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-2 rounded-full overflow-hidden bg-slate-800 flex">
              <div style={{ width: `${nbaPred.probHomeWin * 100}%` }} className="bg-blue-500" />
              <div style={{ width: `${nbaPred.probAwayWin * 100}%` }} className="bg-sky-400" />
            </div>
          </div>
        )}
      </button>
    );
  };

  const renderLiveDisconnectedEmptyState = () => (
    <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center space-y-4">
      <div className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto text-slate-400">
        <WifiOff className="w-5 h-5" />
      </div>
      <div className="max-w-lg mx-auto space-y-1.5">
        <h3 className="text-base font-bold text-white">
          Sin conexión API configurada para {sport === 'football' ? 'Fútbol' : 'NBA'}
        </h3>
        <p className="text-xs text-slate-400 leading-relaxed">
          SportAnalytics AI nunca inventa resultados ni estadísticas reales. Introduce tu clave API en Configuración de APIs para cargar partidos en directo, o utiliza el Simulador Matemático Offline para probar los modelos, el campo interactivo y los deslizadores Over/Under.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => setSection('settings')}
          className="min-h-[44px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white cursor-pointer"
        >
          Ir a Configuración de APIs
        </button>
        <button
          type="button"
          onClick={() => setDataMode('offline_sim')}
          className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-slate-200 cursor-pointer"
        >
          Abrir Simulador Offline
        </button>
      </div>
    </div>
  );

  const isCurrentSportConnected =
    sport === 'football' ? apiConfig.football.connected : apiConfig.nba.connected;

  return (
    <div className="min-h-screen bg-[#070B14] text-slate-100 flex flex-col pb-20 md:pb-10">
      {/* Top Bar — Strict 3-Zone Contract */}
      <header className="sticky top-0 z-40 h-14 bg-[#070B14]/90 backdrop-blur-md border-b border-slate-800/80">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-8">
          {/* Zone 1: Single-element brand wordmark */}
          <button
            type="button"
            onClick={() => {
              setSelectedMatchId(null);
              setSection('overview');
            }}
            className="text-lg font-display font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            SportAnalytics AI
          </button>

          {/* Zone 2: Concise single-line navigation links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
            {(
              [
                { id: 'overview', label: 'Resumen' },
                { id: 'matches', label: 'Partidos' },
                { id: 'history', label: 'Historial' },
              ] as const
            ).map((nav) => (
              <button
                key={nav.id}
                type="button"
                onClick={() => {
                  if (nav.id !== 'matches') setSelectedMatchId(null);
                  setSection(nav.id);
                }}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                  section === nav.id
                    ? 'border-blue-500 text-white'
                    : 'border-transparent hover:text-white hover:border-slate-700'
                }`}
              >
                {nav.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setSection('settings')}
              className="min-h-[38px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Configurar APIs
            </button>
          </div>
        </div>
      </header>

      {/* Workspace Toolbar (below header) */}
      <div className="border-b border-slate-800/70 bg-[#0A101E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
          {/* Sport Switcher */}
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800">
            <button
              type="button"
              onClick={() => {
                setSport('football');
                setSelectedMatchId(null);
              }}
              className={`min-h-[36px] px-3.5 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                sport === 'football'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Fútbol
            </button>
            <button
              type="button"
              onClick={() => {
                setSport('nba');
                setSelectedMatchId(null);
              }}
              className={`min-h-[36px] px-3.5 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                sport === 'nba' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              NBA
            </button>
          </div>

          {/* Global Search */}
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              placeholder="Buscar equipos, jugadores o competiciones..."
              className="w-full min-h-[38px] pl-9 pr-3 rounded-lg border border-slate-800 bg-slate-950/80 text-xs text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Data Mode Toggle (Honest Live API vs Offline Math Simulator) */}
          <div className="flex items-center gap-2">
            {(apiConfig.football.connected || apiConfig.nba.connected) && (
              <button
                type="button"
                onClick={() => loadConfigAndLive(true)}
                disabled={liveLoading}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${liveLoading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Actualizar</span>
              </button>
            )}
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setDataMode('live');
                  setSelectedMatchId(null);
                }}
                className={`min-h-[34px] px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                  dataMode === 'live'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {isCurrentSportConnected ? (
                  <Wifi className="w-3.5 h-3.5 text-emerald-300" />
                ) : (
                  <WifiOff className="w-3.5 h-3.5 text-slate-400" />
                )}
                API en Vivo
              </button>
              <button
                type="button"
                onClick={() => {
                  setDataMode('offline_sim');
                  setSelectedMatchId(null);
                }}
                className={`min-h-[34px] px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                  dataMode === 'offline_sim'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Simulador Offline
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
        {/* Explicit Data Provenance Notice */}
        {dataMode === 'offline_sim' && section !== 'settings' && (
          <div className="rounded-xl border border-slate-800 bg-[#0D1526] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span className="text-slate-300">
              Modo Simulador Offline activo · Escenario de verificación matemática para probar modelos, campo/pista, bajas y deslizadores Over/Under (no son eventos en directo).
            </span>
            <button
              type="button"
              onClick={() => setSection('settings')}
              className="text-blue-400 hover:text-blue-300 font-semibold whitespace-nowrap cursor-pointer"
            >
              Conectar APIs reales →
            </button>
          </div>
        )}

        {liveErrors.length > 0 && dataMode === 'live' && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 px-4 py-3 text-xs text-rose-200">
            {liveErrors.join(' · ')}
          </div>
        )}

        {/* VIEW 1: OVERVIEW */}
        {section === 'overview' && (
          <div className="space-y-8">
            {/* Dual Sport Visual Hero Cards */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
              <div className="relative rounded-2xl overflow-hidden border border-slate-800 min-h-[240px] flex flex-col justify-end p-6">
                <img
                  src="/src/assets/images/stadium_tactical_backdrop_1794611228135.jpg"
                  alt="Estadio de fútbol analizado por SportAnalytics AI"
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#070B14] via-[#070B14]/75 to-transparent" />
                <div className="relative z-10 space-y-3">
                  <div className="text-xs text-slate-300">
                    Fútbol ·{' '}
                    {apiConfig.football.connected
                      ? `Conectado (${apiConfig.football.provider})`
                      : 'API sin configurar'}
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white text-balance">
                    Modelos Dixon-Coles, xG y campo táctico 11v11
                  </h1>
                  <p className="text-xs sm:text-sm text-slate-300 max-w-lg">
                    Alineaciones confirmadas o provisionales, bajas recalculadas al instante y distribuciones Over/Under para tiros, faltas, tarjetas y goles.
                  </p>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSport('football');
                        setSection('matches');
                      }}
                      className="min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-2 cursor-pointer"
                    >
                      Explorar partidos de Fútbol
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="relative rounded-2xl overflow-hidden border border-slate-800 min-h-[240px] flex flex-col justify-end p-6">
                <img
                  src="/src/assets/images/arena_hardwood_backdrop_1794611228592.jpg"
                  alt="Pista NBA analizada por SportAnalytics AI"
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#070B14] via-[#070B14]/75 to-transparent" />
                <div className="relative z-10 space-y-3">
                  <div className="text-xs text-slate-300">
                    NBA ·{' '}
                    {apiConfig.nba.connected
                      ? `Conectado (${apiConfig.nba.provider})`
                      : 'API sin configurar'}
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-white text-balance">
                    Eficiencia por ritmo, rotaciones y pista 5v5
                  </h2>
                  <p className="text-xs sm:text-sm text-slate-300 max-w-lg">
                    Redistribución dinámica de uso y minutos ante ausencias clave, proyecciones de puntos, rebotes, asistencias, triples y PRA.
                  </p>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSport('nba');
                        setSection('matches');
                      }}
                      className="min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-2 cursor-pointer"
                    >
                      Explorar partidos NBA
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Featured Matches for Selected Sport */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">
                  Partidos destacados ({sport === 'football' ? 'Fútbol' : 'NBA'})
                </h2>
                <button
                  type="button"
                  onClick={() => setSection('matches')}
                  className="text-xs font-semibold text-blue-400 hover:text-blue-300 cursor-pointer"
                >
                  Ver calendario completo →
                </button>
              </div>

              {dataMode === 'live' && !isCurrentSportConnected && filteredMatches.length === 0 && !liveLoading ? (
                renderLiveDisconnectedEmptyState()
              ) : filteredMatches.length === 0 ? (
                <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-6 text-center text-xs text-slate-400">
                  {liveLoading
                    ? 'Cargando partidos desde la API configurada...'
                    : 'No se encontraron partidos para los filtros actuales.'}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredMatches.slice(0, 4).map(renderMatchCard)}
                </div>
              )}
            </section>

            {/* Standings Preview */}
            <StandingsView sport={sport} standings={activeStandings} />
          </div>
        )}

        {/* VIEW 2: MATCHES & CALENDAR / DETAIL */}
        {section === 'matches' &&
          (selectedMatch ? (
            <MatchDetailView
              match={selectedMatch}
              historyItems={historyItems}
              playerOverrides={playerOverrides}
              onToggleAvailability={handleToggleAvailability}
              onRefreshNbaNews={handleRefreshNbaNews}
              onSelectPlayer={(player, m) => setActiveModalPlayer({ player, match: m })}
              onLogPrediction={handleLogPrediction}
              onBack={() => setSelectedMatchId(null)}
              hydrating={hydratingMatchId === selectedMatch.id}
              refreshingNbaNews={refreshingNbaNewsId === selectedMatch.id}
            />
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-xl sm:text-2xl font-bold text-white">
                      Calendario y análisis de partidos ({sport === 'football' ? 'Fútbol' : 'NBA'})
                    </h2>
                    <span className="px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 text-[11px] font-mono tabular-nums text-slate-300">
                      {filteredMatches.length} partidos
                    </span>
                  </div>
                  <p className="text-sm text-slate-400 mt-1">
                    Selecciona cualquier encuentro para abrir su resumen, análisis L5/L10/L15, jugadores, alineaciones y H2H.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setShowStandingsInMatches((v) => !v)}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-800 bg-[#0D1526] hover:bg-slate-900 text-xs font-semibold text-slate-200 flex items-center gap-2 cursor-pointer"
                >
                  <Trophy className="w-4 h-4 text-blue-400" />
                  {showStandingsInMatches ? 'Ocultar clasificaciones' : 'Ver clasificaciones'}
                </button>
              </div>

              {/* Status + Competition Filters */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  {(
                    [
                      { id: 'all', label: 'Todos' },
                      { id: 'today', label: 'Hoy' },
                      { id: 'live', label: 'En directo' },
                      { id: 'upcoming', label: 'Próximos días' },
                      { id: 'finished', label: 'Finalizados' },
                    ] as const
                  ).map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setMatchStatusFilter(st.id)}
                      className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                        matchStatusFilter === st.id
                          ? 'bg-blue-600 text-white'
                          : 'bg-[#0D1526] text-slate-300 border border-slate-800 hover:text-white'
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                {availableCompetitions.length > 1 && (
                  <select
                    value={competitionFilter}
                    onChange={(e) => setCompetitionFilter(e.target.value)}
                    aria-label="Filtrar por competición"
                    className="min-h-[38px] px-3 rounded-lg border border-slate-800 bg-[#0D1526] text-xs text-slate-200 cursor-pointer"
                  >
                    <option value="all">Todas las competiciones ({availableCompetitions.length})</option>
                    {availableCompetitions.map((comp) => (
                      <option key={comp} value={comp}>
                        {comp}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {showStandingsInMatches && (
                <StandingsView sport={sport} standings={activeStandings} />
              )}

              {dataMode === 'live' && !isCurrentSportConnected && filteredMatches.length === 0 && !liveLoading ? (
                renderLiveDisconnectedEmptyState()
              ) : filteredMatches.length === 0 ? (
                <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center text-xs text-slate-400">
                  {liveLoading
                    ? 'Consultando calendario en las competiciones disponibles...'
                    : 'No hay partidos que coincidan con los filtros seleccionados.'}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredMatches.slice(0, visibleMatchCount).map(renderMatchCard)}
                  </div>
                  {filteredMatches.length > visibleMatchCount && (
                    <div className="flex justify-center pt-2">
                      <button
                        type="button"
                        onClick={() => setVisibleMatchCount((prev) => prev + 20)}
                        className="min-h-[42px] px-5 py-2 rounded-lg border border-slate-700 bg-[#0D1526] hover:bg-slate-800 text-xs font-semibold text-slate-200 cursor-pointer"
                      >
                        Mostrar más partidos ({filteredMatches.length - visibleMatchCount} restantes)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

        {/* VIEW 3: HISTORY & CALIBRATION */}
        {section === 'history' && (
          <HistoryEvaluationView
            predictions={historyItems}
            onResolve={handleResolveHistory}
          />
        )}

        {/* VIEW 4: API SETTINGS */}
        {section === 'settings' && (
          <ApiConfigView
            config={apiConfig}
            onConfigUpdated={setApiConfig}
            onRefreshLive={loadConfigAndLive}
          />
        )}
      </main>

      {/* Player Individual Analysis Modal + Over/Under Slider */}
      {activeModalPlayer && (
        <PlayerDetailModal
          player={activeModalPlayer.player}
          match={activeModalPlayer.match}
          teammates={(activeModalPlayer.player.teamId === activeModalPlayer.match.homeTeam.id
            ? activeModalPlayer.match.homePlayers
            : activeModalPlayer.match.awayPlayers
          ).map((p) => ({
            ...p,
            availability: playerOverrides[p.id] ?? p.availability,
          }))}
          allSameSportPlayers={allSameSportPlayers}
          onClose={() => setActiveModalPlayer(null)}
          onChangeAvailability={handleToggleAvailability}
        />
      )}

      {/* iPhone Thumb-Zone Fixed Bottom Tab Bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-15 pb-safe bg-[#070B14]/95 backdrop-blur-md border-t border-slate-800 grid grid-cols-4 items-center"
        aria-label="Navegación móvil"
      >
        {(
          [
            { id: 'overview', label: 'Resumen', icon: LayoutGrid },
            { id: 'matches', label: 'Partidos', icon: Calendar },
            { id: 'history', label: 'Historial', icon: History },
            { id: 'settings', label: 'Config.', icon: Settings },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = section === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                if (tab.id !== 'matches') setSelectedMatchId(null);
                setSection(tab.id);
              }}
              className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 cursor-pointer ${
                active ? 'text-blue-400' : 'text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium tracking-tight">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
