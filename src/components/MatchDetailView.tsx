import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookmarkPlus,
  Check,
  AlertCircle,
  BarChart3,
  Users,
  History,
  LayoutDashboard,
  Loader2,
  Info,
  ShieldCheck,
  AlertTriangle,
  Target,
  Minus,
  Plus,
  Percent,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  AvailabilityStatus,
  DataReliability,
  LoggedPrediction,
  MatchRecord,
  PlayerProfile,
  TeamRecentGame,
} from '../types/sports.ts';
import {
  buildFootballMatchExplanation,
  computeFootballMatchPrediction,
} from '../engine/footballModel.ts';
import {
  buildNbaMatchExplanation,
  computeNbaMatchPrediction,
} from '../engine/nbaModel.ts';
import { evaluateMatchStatOverUnder } from '../engine/distributionMath.ts';
import { TacticalPitch } from './TacticalPitch.tsx';
import { BasketballCourt } from './BasketballCourt.tsx';
import { AiExplanationBox, type AiExplanationPayload } from './AiExplanationBox.tsx';
import { OddsProbabilityPanel } from './OddsProbabilityPanel.tsx';

interface MatchDetailViewProps {
  match: MatchRecord;
  historyItems?: LoggedPrediction[];
  hydrating?: boolean;
  refreshingNbaNews?: boolean;
  refreshingFootballLineups?: boolean;
  playerOverrides: Record<string, AvailabilityStatus>;
  onToggleAvailability: (playerId: string, nextStatus: AvailabilityStatus) => void;
  onRefreshNbaNews?: (match: MatchRecord) => Promise<void>;
  onRefreshFootballLineups?: (match: MatchRecord) => Promise<void>;
  onSelectPlayer: (player: PlayerProfile, match: MatchRecord) => void;
  onLogPrediction: (pred: Omit<LoggedPrediction, 'id' | 'createdAt' | 'status'>) => Promise<void>;
  onBack: () => void;
}

type DetailTab = 'summary' | 'expected' | 'teams' | 'tactical' | 'h2h' | 'odds';

function summarizeGames(games: TeamRecentGame[]) {
  const n = games.length;
  if (n === 0) {
    return {
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      avgFor: 0,
      avgAgainst: 0,
      homeSummary: 'Sin datos',
      awaySummary: 'Sin datos',
    };
  }
  let w = 0, d = 0, l = 0;
  let gf = 0, ga = 0;
  let hw = 0, hd = 0, hl = 0;
  let aw = 0, ad = 0, al = 0;
  for (const g of games) {
    gf += g.scoreFor;
    ga += g.scoreAgainst;
    if (g.result === 'W') w += 1;
    else if (g.result === 'D') d += 1;
    else l += 1;
    if (g.isHome) {
      if (g.result === 'W') hw += 1;
      else if (g.result === 'D') hd += 1;
      else hl += 1;
    } else {
      if (g.result === 'W') aw += 1;
      else if (g.result === 'D') ad += 1;
      else al += 1;
    }
  }
  return {
    played: n,
    wins: w,
    draws: d,
    losses: l,
    avgFor: gf / n,
    avgAgainst: ga / n,
    homeSummary: `${hw}-${hd}-${hl}`,
    awaySummary: `${aw}-${ad}-${al}`,
  };
}

function renderDataQualityBadge(quality: DataReliability, dataConfidence: number) {
  const cls =
    quality === 'verified'
      ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-300'
      : quality === 'estimated'
        ? 'border-amber-500/35 bg-amber-950/25 text-amber-300'
        : 'border-rose-500/35 bg-rose-950/25 text-rose-300';
  const label =
    quality === 'verified'
      ? 'Datos verificados'
      : quality === 'estimated'
        ? 'Estimación parcial'
        : 'Sin datos suficientes';

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded border text-[11px] font-semibold ${cls}`}>
      <ShieldCheck className="w-3.5 h-3.5" />
      {label} · Cobertura {dataConfidence}%
    </span>
  );
}

export const MatchDetailView: React.FC<MatchDetailViewProps> = ({
  match,
  historyItems = [],
  hydrating = false,
  refreshingNbaNews = false,
  refreshingFootballLineups = false,
  playerOverrides,
  onToggleAvailability,
  onRefreshNbaNews,
  onRefreshFootballLineups,
  onSelectPlayer,
  onLogPrediction,
  onBack,
}) => {
  const [tab, setTab] = useState<DetailTab>('summary');
  const [teamWindow, setTeamWindow] = useState<5 | 10 | 15>(5);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiData, setAiData] = useState<AiExplanationPayload | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const [matchStatLines, setMatchStatLines] = useState<Record<string, number>>({});

  useEffect(() => {
    setMatchStatLines({});
    setAiData(null);
  }, [match.id]);

  const effectiveHomePlayers = useMemo(
    () =>
      match.homePlayers.map((p) => ({
        ...p,
        availability: playerOverrides[p.id] ?? p.availability,
      })),
    [match.homePlayers, playerOverrides]
  );

  const effectiveAwayPlayers = useMemo(
    () =>
      match.awayPlayers.map((p) => ({
        ...p,
        availability: playerOverrides[p.id] ?? p.availability,
      })),
    [match.awayPlayers, playerOverrides]
  );

  const footballPred = useMemo(
    () =>
      match.sport === 'football'
        ? computeFootballMatchPrediction(
            match,
            effectiveHomePlayers,
            effectiveAwayPlayers,
            historyItems
          )
        : null,
    [match, effectiveHomePlayers, effectiveAwayPlayers, historyItems]
  );

  const nbaPred = useMemo(
    () =>
      match.sport === 'nba'
        ? computeNbaMatchPrediction(
            match,
            effectiveHomePlayers,
            effectiveAwayPlayers,
            historyItems
          )
        : null,
    [match, effectiveHomePlayers, effectiveAwayPlayers, historyItems]
  );

  const narrative = useMemo(() => {
    if (match.sport === 'football' && footballPred) {
      return buildFootballMatchExplanation(match, footballPred);
    }
    if (match.sport === 'nba' && nbaPred) {
      return buildNbaMatchExplanation(match, nbaPred, effectiveHomePlayers, effectiveAwayPlayers);
    }
    return null;
  }, [match, footballPred, nbaPred, effectiveHomePlayers, effectiveAwayPlayers]);

  const handleExplainAi = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const payload =
        match.sport === 'football'
          ? {
              match: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
              competition: match.competition,
              lineupStatus: match.lineupStatus,
              modelOutputs: footballPred,
            }
          : {
              match: `${match.homeTeam.name} vs ${match.awayTeam.name}`,
              competition: match.competition,
              lineupStatus: match.lineupStatus,
              modelOutputs: nbaPred,
            };

      const res = await fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextType: 'match', payload }),
      });
      const json = (await res.json()) as AiExplanationPayload & { error?: string };
      if (!res.ok) throw new Error(json.error || 'Error generando explicación IA');
      setAiData(json);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Error consultando IA');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSaveMainPrediction = async () => {
    const matchLabel = `${match.homeTeam.shortName} vs ${match.awayTeam.shortName}`;
    if (match.sport === 'football' && footballPred) {
      const favoriteIsHome = footballPred.probHome >= footballPred.probAway;
      await onLogPrediction({
        sport: 'football',
        competition: match.competition,
        matchId: match.id,
        matchLabel,
        market: 'Resultado Final (1X2)',
        selection: favoriteIsHome
          ? `Victoria ${match.homeTeam.shortName}`
          : `Victoria ${match.awayTeam.shortName}`,
        predictedProb: Math.max(footballPred.probHome, footballPred.probAway),
        rawPredictedProb: Math.max(footballPred.rawProbHome, footballPred.rawProbAway),
        predictedValue: +(footballPred.lambdaHome + footballPred.lambdaAway).toFixed(2),
      });
    } else if (match.sport === 'nba' && nbaPred) {
      const favoriteIsHome = nbaPred.probHomeWin >= nbaPred.probAwayWin;
      await onLogPrediction({
        sport: 'nba',
        competition: match.competition,
        matchId: match.id,
        matchLabel,
        market: 'Ganador (Moneyline)',
        selection: favoriteIsHome ? match.homeTeam.name : match.awayTeam.name,
        predictedProb: Math.max(nbaPred.probHomeWin, nbaPred.probAwayWin),
        rawPredictedProb: Math.max(nbaPred.rawProbHomeWin, nbaPred.rawProbAwayWin),
        predictedValue: +nbaPred.expectedSpreadHome.toFixed(1),
      });
    }
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2500);
  };

  const absencesList =
    match.sport === 'football'
      ? footballPred?.absenceImpactSummary ?? []
      : nbaPred?.absenceImpactSummary ?? [];

  const modelWarnings =
    match.sport === 'football'
      ? footballPred?.modelWarnings ?? []
      : nbaPred?.modelWarnings ?? [];

  const statusText =
    match.status === 'live'
      ? `En directo · ${match.minuteOrClock ?? 'En juego'}`
      : match.status === 'finished'
        ? 'Finalizado'
        : match.status === 'today'
          ? 'Hoy'
          : 'Próximo encuentro';

  const lineupText =
    match.lineupStatus === 'confirmed'
      ? 'Alineación confirmada'
      : match.lineupStatus === 'provisional'
        ? 'Alineación probable'
        : 'Alineación no confirmada';

  const homeGamesSlice = (match.homeTeam.recentGames ?? []).slice(0, teamWindow);
  const awayGamesSlice = (match.awayTeam.recentGames ?? []).slice(0, teamWindow);
  const homeSliceStats = summarizeGames(homeGamesSlice);
  const awaySliceStats = summarizeGames(awayGamesSlice);

  return (
    <div className="space-y-6">
      {/* Top Match Navigation & Metadata */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-2 cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Volver a partidos
        </button>

        <div className="flex items-center gap-2">
          {hydrating && (
            <span className="text-xs text-blue-300 flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-blue-500/30 bg-blue-950/30">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Actualizando datos en vivo...
            </span>
          )}
          <button
            type="button"
            onClick={handleSaveMainPrediction}
            className="min-h-[40px] px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-slate-100 flex items-center gap-2 cursor-pointer"
          >
            {savedToast ? (
              <>
                <Check className="w-4 h-4 text-emerald-400" />
                Guardada en historial
              </>
            ) : (
              <>
                <BookmarkPlus className="w-4 h-4 text-blue-400" />
                Registrar predicción
              </>
            )}
          </button>
        </div>
      </div>

      {/* Match Scoreboard / Projection Banner */}
      <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span>
            {match.competition} · {match.venue} ·{' '}
            {new Date(match.kickoffIso).toLocaleString('es-ES', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · <strong className="text-slate-200">{statusText}</strong> · {lineupText}
          </span>
          <span>
            Fuente: {match.dataOrigin} · Actualizado{' '}
            {new Date(match.updatedAt).toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>

        {match.sourceDiscrepancies && match.sourceDiscrepancies.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Diferencias detectadas al contrastar fuentes:</span>{' '}
              {match.sourceDiscrepancies.join(' · ')}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 items-center gap-6">
          <div>
            <p className="text-xs text-slate-400">Local · {match.homeTeam.record}</p>
            <h2 className="text-xl sm:text-2xl font-bold text-white mt-0.5">
              {match.homeTeam.name}
            </h2>
            <p className="text-xs font-mono tabular-nums text-slate-400 mt-1">
              Descanso: {match.homeTeam.restDays} días
              {match.homeTeam.isBackToBack ? ' · Back-to-Back' : ''}
            </p>
          </div>

          <div className="flex flex-col items-start md:items-center justify-center">
            {match.score ? (
              <div className="text-center">
                <span className="text-3xl sm:text-4xl font-bold font-mono tabular-nums text-white">
                  {match.score.home} - {match.score.away}
                </span>
                <span className="block text-xs text-emerald-400 mt-1">
                  {match.minuteOrClock ?? match.score.periods ?? statusText}
                </span>
              </div>
            ) : match.sport === 'football' && footballPred ? (
              <div className="text-left md:text-center">
                <span className="text-xs text-slate-400 block">Goles esperados (xG)</span>
                <span className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-blue-300">
                  {footballPred.lambdaHome.toFixed(2)} — {footballPred.lambdaAway.toFixed(2)}
                </span>
                <span className="block text-xs font-mono tabular-nums text-slate-300 mt-1">
                  1: {(footballPred.probHome * 100).toFixed(1)}% · X:{' '}
                  {(footballPred.probDraw * 100).toFixed(1)}% · 2:{' '}
                  {(footballPred.probAway * 100).toFixed(1)}%
                </span>
              </div>
            ) : nbaPred ? (
              <div className="text-left md:text-center">
                <span className="text-xs text-slate-400 block">Marcador esperado</span>
                <span className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-blue-300">
                  {nbaPred.expectedHomePts.toFixed(1)} — {nbaPred.expectedAwayPts.toFixed(1)}
                </span>
                <span className="block text-xs font-mono tabular-nums text-slate-300 mt-1">
                  Local {(nbaPred.probHomeWin * 100).toFixed(1)}% · Visitante{' '}
                  {(nbaPred.probAwayWin * 100).toFixed(1)}%
                </span>
              </div>
            ) : null}
          </div>

          <div className="md:text-right">
            <p className="text-xs text-slate-400">Visitante · {match.awayTeam.record}</p>
            <h2 className="text-xl sm:text-2xl font-bold text-white mt-0.5">
              {match.awayTeam.name}
            </h2>
            <p className="text-xs font-mono tabular-nums text-slate-400 mt-1">
              Descanso: {match.awayTeam.restDays} días
              {match.awayTeam.isBackToBack ? ' · Back-to-Back' : ''}
            </p>
          </div>
        </div>

        {/* Absence Impact Alert Strip */}
        {absencesList.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-200 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <span className="font-semibold block">
                Recálculo activo por bajas / disponibilidad modificada:
              </span>
              {absencesList.map((note, idx) => (
                <span key={idx} className="block text-amber-100/90">
                  · {note}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Model Warnings Strip */}
        {modelWarnings.length > 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3.5 py-2.5 text-xs text-slate-300 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {modelWarnings.map((w, idx) => (
                <span key={idx} className="block">
                  · {w}
                </span>
              ))}
            </div>
          </div>
        )}

        {match.provenance && (match.provenance.isStale || match.provenance.status === 'error') && (
          <div className="rounded-lg border border-amber-500/35 bg-amber-950/25 px-3.5 py-2 text-xs text-amber-200 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>
              Estado de fuente ({match.provenance.source}): {match.provenance.errorMessage ?? `datos con ${match.provenance.staleAgeMinutes} min de antigüedad`} · Tipo: {match.provenance.dataType}.
            </span>
          </div>
        )}

        {match.hydrationNote && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3.5 py-2 text-xs text-slate-300 flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>{match.hydrationNote}</span>
          </div>
        )}
      </section>

      {/* Sub-Navigation Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {(
          [
            { id: 'summary', label: 'A. Resumen y Predicción', icon: LayoutDashboard },
            { id: 'expected', label: 'B. Qué se espera del partido', icon: Target },
            { id: 'teams', label: 'C. Análisis de Equipos', icon: BarChart3 },
            {
              id: 'tactical',
              label: match.sport === 'football' ? 'D. Jugadores y Alineaciones' : 'D. Jugadores y Rotación',
              icon: Users,
            },
            { id: 'h2h', label: 'E. Historial H2H', icon: History },
            { id: 'odds', label: 'F. Cuotas y Probabilidades', icon: Percent },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`min-h-[42px] px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-2 transition-colors cursor-pointer ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#0D1526] text-slate-300 border border-slate-800 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {/* SECTION A: RESUMEN Y PREDICCIÓN */}
      {tab === 'summary' && (
        <div className="space-y-6">
          {match.sport === 'football' && footballPred && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-white">
                    Probabilidades y modelo Dixon-Coles
                  </h3>
                  {renderDataQualityBadge(footballPred.dataQuality, footballPred.dataConfidence)}
                </div>

                <div className="space-y-3">
                  {[
                    { label: `Victoria ${match.homeTeam.shortName}`, val: footballPred.probHome, color: 'bg-blue-500' },
                    { label: 'Empate', val: footballPred.probDraw, color: 'bg-slate-500' },
                    { label: `Victoria ${match.awayTeam.shortName}`, val: footballPred.probAway, color: 'bg-sky-400' },
                  ].map((r) => (
                    <div key={r.label} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-300">{r.label}</span>
                        <span className="font-mono tabular-nums font-semibold text-white">
                          {(r.val * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
                        <div style={{ width: `${r.val * 100}%` }} className={`h-full ${r.color}`} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-800 text-xs">
                  <div>
                    <span className="text-slate-400 block">Más de 1.5 goles</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {(footballPred.over15 * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Más de 2.5 goles</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {(footballPred.over25 * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Más de 3.5 goles</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {(footballPred.over35 * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Ambos marcan (Sí)</span>
                    <span className="text-base font-bold font-mono tabular-nums text-emerald-400">
                      {(footballPred.bttsYes * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Córners esperados</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {(() => {
                        const c = footballPred.expectedStats.find((s) => s.key === 'corners');
                        return c && c.reliability !== 'unavailable' && c.pointEstimate !== null
                          ? c.pointEstimate.toFixed(1)
                          : 'N/D';
                      })()}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Tarjetas esperadas</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {(() => {
                        const yc = footballPred.expectedStats.find((s) => s.key === 'yellow_cards');
                        return yc && yc.reliability !== 'unavailable' && yc.pointEstimate !== null
                          ? yc.pointEstimate.toFixed(1)
                          : 'N/D';
                      })()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-white">
                    Resultados exactos más probables
                  </h3>
                  <span
                    className={`px-2 py-0.5 rounded border text-[11px] font-medium ${
                      footballPred.calibrationApplied
                        ? 'border-blue-500/35 bg-blue-950/30 text-blue-300'
                        : 'border-slate-700 bg-slate-900 text-slate-400'
                    }`}
                  >
                    {footballPred.calibrationApplied ? 'Calibrado empíricamente' : 'Modelo base (sin ajuste)'}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {footballPred.exactScores.map((sc) => (
                    <div
                      key={`${sc.home}-${sc.away}`}
                      className="p-3 rounded-lg border border-slate-800 bg-slate-950/60 text-center"
                    >
                      <span className="text-lg font-bold font-mono tabular-nums text-white block">
                        {sc.home} - {sc.away}
                      </span>
                      <span className="text-xs font-mono tabular-nums text-blue-400">
                        {(sc.probability * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-slate-400 space-y-1">
                  <p>
                    Cobertura de datos: <strong className="text-slate-200">{footballPred.dataConfidence}%</strong> (mide la disponibilidad de métricas reales, independiente de la probabilidad del favorito).
                  </p>
                  {footballPred.calibrationNote && (
                    <p className="text-blue-300">{footballPred.calibrationNote}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {match.sport === 'nba' && nbaPred && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-white">
                    Modelo de Eficiencia Ajustada por Ritmo (NBA)
                  </h3>
                  {renderDataQualityBadge(nbaPred.dataQuality, nbaPred.dataConfidence)}
                </div>

                <div className="space-y-3">
                  {[
                    { label: `Victoria ${match.homeTeam.name}`, val: nbaPred.probHomeWin, color: 'bg-blue-500' },
                    { label: `Victoria ${match.awayTeam.name}`, val: nbaPred.probAwayWin, color: 'bg-sky-400' },
                  ].map((r) => (
                    <div key={r.label} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-300">{r.label}</span>
                        <span className="font-mono tabular-nums font-semibold text-white">
                          {(r.val * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
                        <div style={{ width: `${r.val * 100}%` }} className={`h-full ${r.color}`} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-800 text-xs">
                  <div>
                    <span className="text-slate-400 block">Diferencia esperada</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {nbaPred.expectedSpreadHome >= 0 ? '+' : ''}
                      {nbaPred.expectedSpreadHome.toFixed(1)} {match.homeTeam.shortName}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Total puntos esperado</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {nbaPred.expectedTotal.toFixed(1)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Ritmo (posesiones)</span>
                    <span className="text-base font-bold font-mono tabular-nums text-blue-300">
                      {(() => {
                        const p = nbaPred.expectedStats.find((s) => s.key === 'pace');
                        return p && p.reliability !== 'unavailable' && p.pointEstimate !== null
                          ? p.pointEstimate.toFixed(1)
                          : 'N/D';
                      })()}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Desv. Est. Margen</span>
                    <span className="text-base font-bold font-mono tabular-nums text-slate-200">
                      ±{nbaPred.spreadStdDev.toFixed(1)} pts
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Cobertura de datos</span>
                    <span className="text-base font-bold font-mono tabular-nums text-slate-200">
                      {nbaPred.dataConfidence}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Calibración</span>
                    <span className="text-xs font-semibold text-slate-200">
                      {nbaPred.calibrationApplied ? 'Empírica activa' : 'Modelo base'}
                    </span>
                  </div>
                </div>
                {nbaPred.calibrationNote && (
                  <p className="text-xs text-blue-300">{nbaPred.calibrationNote}</p>
                )}
              </div>

              <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-3">
                <h3 className="text-base font-semibold text-white">
                  Proyección individual de jugadores clave
                </h3>
                <p className="text-xs text-slate-400">
                  Pulsa cualquier jugador para abrir su ficha completa y deslizador Over/Under sin salir del partido.
                </p>
                {[...effectiveHomePlayers, ...effectiveAwayPlayers].length === 0 ? (
                  <p className="text-xs text-slate-400 pt-2">
                    Las rotaciones de jugadores se cargan en la pestaña Jugadores y Rotación.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-800/70">
                    {[...effectiveHomePlayers, ...effectiveAwayPlayers]
                      .filter((p) => p.isKeyPlayer)
                      .slice(0, 6)
                      .map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => onSelectPlayer(p, match)}
                          className="w-full py-2.5 flex items-center justify-between text-left hover:bg-slate-900/50 px-2 rounded cursor-pointer text-xs"
                        >
                          <div>
                            <span className="font-semibold text-slate-100">{p.name}</span>
                            <span className="text-slate-400 ml-2">
                              {p.teamShort} ·{' '}
                              {p.availability === 'out' || p.availability === 'suspended'
                                ? 'Descartado'
                                : p.availability === 'doubtful'
                                  ? 'Dudoso (GTD)'
                                  : p.availability === 'probable'
                                    ? 'Probable'
                                    : p.availability === 'confirmed_starter'
                                      ? 'Titular conf.'
                                      : p.availability === 'possible_starter'
                                        ? 'Posible tit.'
                                        : 'Disponible'}
                            </span>
                          </div>
                          <span className="font-mono tabular-nums text-blue-400">
                            {p.statsQuality === 'unavailable' || p.splits.season.points === undefined
                              ? 'Stats ind. N/D'
                              : `${p.splits.season.points.toFixed(1)} PTS · ${(p.splits.season.rebounds ?? 0).toFixed(1)} REB · ${(p.splits.season.assists ?? 0).toFixed(1)} AST`}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Main Team Stats Comparison Table */}
          {match.teamStats && match.teamStats.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-[#0D1526] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between text-xs font-semibold text-slate-300">
                <span>{match.homeTeam.name}</span>
                <span className="text-slate-400">Estadísticas comparadas</span>
                <span>{match.awayTeam.name}</span>
              </div>
              <div className="divide-y divide-slate-800/70">
                {match.teamStats.map((row) => (
                  <div
                    key={row.label}
                    className="px-5 py-3 grid grid-cols-3 items-center text-xs"
                  >
                    <span className="font-mono tabular-nums font-bold text-blue-300">
                      {row.homeValue}
                    </span>
                    <span className="text-center text-slate-400">{row.label}</span>
                    <span className="text-right font-mono tabular-nums font-bold text-sky-300">
                      {row.awayValue}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {narrative && (
            <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-base font-semibold text-white">
                    Por qué el modelo estima este escenario
                  </h3>
                  <p className="text-xs text-blue-300 mt-0.5">{narrative.headline}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setTab('expected')}
                  className="text-xs font-semibold text-blue-400 hover:text-blue-300 cursor-pointer"
                >
                  Ver «Qué se espera del partido» →
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 p-3.5 space-y-2">
                  <span className="font-semibold text-blue-300 block">
                    Factores a favor de {match.homeTeam.shortName}
                  </span>
                  <p className="text-slate-400 font-mono text-[11px]">{narrative.homeStrengthsWeaknesses}</p>
                  <ul className="space-y-1 text-slate-300">
                    {narrative.homeFavoringFactors.map((f, i) => (
                      <li key={i}>· {f}</li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 p-3.5 space-y-2">
                  <span className="font-semibold text-sky-300 block">
                    Factores a favor de {match.awayTeam.shortName}
                  </span>
                  <p className="text-slate-400 font-mono text-[11px]">{narrative.awayStrengthsWeaknesses}</p>
                  <ul className="space-y-1 text-slate-300">
                    {narrative.awayFavoringFactors.map((f, i) => (
                      <li key={i}>· {f}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="space-y-1">
                  <span className="font-semibold text-slate-200 block">Emparejamientos tácticos</span>
                  {narrative.tacticalMatchups.map((t, i) => (
                    <p key={i} className="text-slate-400 leading-relaxed">· {t}</p>
                  ))}
                </div>
                <div className="space-y-1">
                  <span className="font-semibold text-slate-200 block">Impacto de bajas y dudas</span>
                  {narrative.keyAbsencesImpact.map((b, i) => (
                    <p key={i} className="text-slate-400 leading-relaxed">· {b}</p>
                  ))}
                  <p className="text-slate-400 leading-relaxed pt-1">{narrative.h2hAssessment}</p>
                </div>
                <div className="space-y-1">
                  <span className="font-semibold text-amber-300 block">Incertidumbres y límites</span>
                  {narrative.uncertaintiesAndLimits.map((u, i) => (
                    <p key={i} className="text-slate-400 leading-relaxed">· {u}</p>
                  ))}
                </div>
              </div>
            </section>
          )}

          <AiExplanationBox
            title="Explicación Cuantitativa con IA"
            loading={aiLoading}
            error={aiError}
            explanation={aiData}
            onTrigger={handleExplainAi}
            buttonLabel="Explicar predicción con IA"
          />
        </div>
      )}

      {/* SECTION B: QUÉ SE ESPERA DEL PARTIDO */}
      {tab === 'expected' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-white">
                Qué se espera del partido (Estimación puntual e intervalo 80%)
              </h3>
              {(footballPred || nbaPred) &&
                renderDataQualityBadge(
                  (footballPred?.dataQuality ?? nbaPred?.dataQuality)!,
                  (footballPred?.dataConfidence ?? nbaPred?.dataConfidence)!
                )}
            </div>
            <p className="text-xs text-slate-400">
              Cada métrica diferencia si procede de estadísticas reales verificadas o de una estimación matemática derivada cuando el proveedor no publica ese dato específico.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(footballPred?.expectedStats ?? nbaPred?.expectedStats ?? []).map((item) => {
              const evalOu = evaluateMatchStatOverUnder(item, matchStatLines[item.key]);
              const isUnavailable =
                item.reliability === 'unavailable' || item.pointEstimate === null || !evalOu.available;

              const setLineForMarket = (nextVal: number) => {
                if (!evalOu.available) return;
                const clamped = Math.max(
                  evalOu.minLine,
                  Math.min(evalOu.maxLine, +(Math.round(nextVal / evalOu.step) * evalOu.step).toFixed(2))
                );
                setMatchStatLines((prev) => ({ ...prev, [item.key]: clamped }));
              };

              return (
                <div
                  key={item.key}
                  className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 space-y-3 flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-medium text-slate-200">{item.label}</span>
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-semibold shrink-0 ${
                          item.reliability === 'verified'
                            ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-300'
                            : item.reliability === 'estimated'
                              ? 'border-amber-500/35 bg-amber-950/25 text-amber-300'
                              : 'border-rose-500/35 bg-rose-950/25 text-rose-300'
                        }`}
                      >
                        {item.reliability === 'verified'
                          ? 'Verificado'
                          : item.reliability === 'estimated'
                            ? 'Estimación'
                            : 'No disponible'}
                      </span>
                    </div>

                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-2xl font-bold font-mono tabular-nums text-white">
                        {item.pointEstimate !== null ? item.pointEstimate : 'N/D'}
                        {item.pointEstimate !== null && item.unit ? (
                          <span className="text-xs font-normal text-slate-400 ml-1">{item.unit}</span>
                        ) : null}
                      </span>
                      {item.intervalLow !== null && item.intervalHigh !== null && (
                        <span className="text-xs font-mono tabular-nums text-blue-300">
                          80%: [{item.intervalLow} – {item.intervalHigh}]
                        </span>
                      )}
                    </div>

                    {item.note && <p className="text-[11px] text-slate-400">{item.note}</p>}
                  </div>

                  {isUnavailable ? (
                    <div className="pt-2 border-t border-slate-800/80 text-[11px] text-slate-400">
                      Sin datos base suficientes para simular líneas Over / Under en este mercado.
                    </div>
                  ) : (
                    <div className="pt-3 border-t border-slate-800/80 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
                          <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" />
                          <span>Línea:</span>
                          <span className="font-mono tabular-nums font-bold text-white text-sm">
                            {evalOu.line.toFixed(evalOu.step >= 1 ? 1 : 1)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setLineForMarket(evalOu.line - evalOu.step)}
                            aria-label={`Reducir línea de ${item.label}`}
                            className="w-8 h-8 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setLineForMarket(evalOu.line + evalOu.step)}
                            aria-label={`Aumentar línea de ${item.label}`}
                            className="w-8 h-8 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <input
                        type="range"
                        min={evalOu.minLine}
                        max={evalOu.maxLine}
                        step={evalOu.step}
                        value={evalOu.line}
                        onChange={(e) => setLineForMarket(parseFloat(e.target.value))}
                        aria-label={`Deslizador Over/Under para ${item.label}`}
                        className="analytics-slider"
                      />

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-semibold text-emerald-400 font-mono tabular-nums">
                            Supera (&gt; {evalOu.line}): {evalOu.probOver.toFixed(1)}%
                          </span>
                          <span className="font-semibold text-slate-300 font-mono tabular-nums">
                            Debajo: {evalOu.probUnder.toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-2.5 w-full rounded-full overflow-hidden bg-slate-800 flex">
                          <div
                            style={{ width: `${evalOu.probOver}%` }}
                            className="bg-emerald-500 transition-all duration-150"
                          />
                          <div
                            style={{ width: `${evalOu.probUnder}%` }}
                            className="bg-slate-600 transition-all duration-150"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500">
                          Estimación de probabilidad del modelo (
                          {item.distributionSpec?.kind === 'poisson'
                            ? 'Poisson'
                            : item.distributionSpec?.kind === 'negbin'
                              ? 'Binomial Negativa'
                              : 'Normal'}
                          )
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {match.sport === 'football' && footballPred && (
            <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
              <div>
                <span className="text-slate-400 block">Ambos marcan (BTTS Sí)</span>
                <span className="text-lg font-bold font-mono tabular-nums text-emerald-400">
                  {(footballPred.bttsYes * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Over 1.5 / 2.5 / 3.5 goles</span>
                <span className="text-sm font-bold font-mono tabular-nums text-white">
                  {(footballPred.over15 * 100).toFixed(0)}% / {(footballPred.over25 * 100).toFixed(0)}% /{' '}
                  {(footballPred.over35 * 100).toFixed(0)}%
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Marcador más probable</span>
                <span className="text-lg font-bold font-mono tabular-nums text-blue-300">
                  {footballPred.exactScores[0]
                    ? `${footballPred.exactScores[0].home}-${footballPred.exactScores[0].away} (${(footballPred.exactScores[0].probability * 100).toFixed(1)}%)`
                    : '-'}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Tarjetas ({match.homeTeam.shortName} / {match.awayTeam.shortName})</span>
                <span className="text-sm font-bold font-mono tabular-nums text-white">
                  {footballPred.expectedStats.find((s) => s.key === 'yellow_cards')?.reliability === 'unavailable'
                    ? 'N/D'
                    : `${footballPred.expectedCardsHome.toFixed(1)} / ${footballPred.expectedCardsAway.toFixed(1)}`}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION B: ANÁLISIS DE EQUIPOS (L5 / L10 / L15 + LOCAL VS VISITANTE) */}
      {tab === 'teams' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#0D1526] p-4">
            <div>
              <h3 className="text-base font-semibold text-white">
                Rendimiento reciente, ataque/defensa y splits Local vs Visitante
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Cambia la ventana temporal para inspeccionar los últimos 5, 10 o 15 partidos reales de cada equipo.
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800">
              {([5, 10, 15] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setTeamWindow(w)}
                  className={`min-h-[36px] px-3 py-1 rounded-md text-xs font-semibold cursor-pointer ${
                    teamWindow === w
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Últimos {w}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[
              {
                sideLabel: 'Local',
                team: match.homeTeam,
                games: homeGamesSlice,
                stats: homeSliceStats,
              },
              {
                sideLabel: 'Visitante',
                team: match.awayTeam,
                games: awayGamesSlice,
                stats: awaySliceStats,
              },
            ].map((block) => (
              <div
                key={block.team.id}
                className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4"
              >
                <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
                  <div>
                    <span className="text-xs text-slate-400">{block.sideLabel}</span>
                    <h4 className="text-lg font-bold text-white">{block.team.name}</h4>
                  </div>
                  <div className="text-right text-xs font-mono tabular-nums">
                    <span className="text-slate-400 block">Balance global</span>
                    <span className="font-bold text-slate-100">{block.team.record}</span>
                  </div>
                </div>

                {/* Window Summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <span className="text-slate-400 block">
                      Balance (L{block.stats.played || teamWindow})
                    </span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {block.stats.played > 0
                        ? match.sport === 'football'
                          ? `${block.stats.wins}V-${block.stats.draws}E-${block.stats.losses}D`
                          : `${block.stats.wins}V-${block.stats.losses}D`
                        : 'Sin historial'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">
                      {match.sport === 'football' ? 'Goles favor / p.' : 'Puntos favor / p.'}
                    </span>
                    <span className="text-base font-bold font-mono tabular-nums text-emerald-400">
                      {block.stats.played > 0
                        ? block.stats.avgFor.toFixed(1)
                        : block.team.ppgOrGpg !== undefined
                          ? block.team.ppgOrGpg.toFixed(1)
                          : '-'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">
                      {match.sport === 'football' ? 'Goles contra / p.' : 'Puntos contra / p.'}
                    </span>
                    <span className="text-base font-bold font-mono tabular-nums text-rose-300">
                      {block.stats.played > 0
                        ? block.stats.avgAgainst.toFixed(1)
                        : block.team.oppgOrGapg !== undefined
                          ? block.team.oppgOrGapg.toFixed(1)
                          : '-'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Split Casa / Fuera</span>
                    <span className="text-xs font-mono tabular-nums text-blue-300 font-semibold">
                      C: {block.team.homeRecord ?? block.stats.homeSummary}
                      <br />
                      F: {block.team.awayRecord ?? block.stats.awaySummary}
                    </span>
                  </div>
                </div>

                {/* Recent Games List */}
                {block.games.length === 0 ? (
                  <p className="text-xs text-slate-400 pt-2 border-t border-slate-800">
                    No hay historial reciente de partidos publicado por la fuente actual para este equipo.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-800/70 pt-2 border-t border-slate-800 text-xs">
                    {block.games.map((g, idx) => (
                      <div key={idx} className="py-2 flex items-center justify-between gap-2">
                        <span className="text-slate-400 font-mono tabular-nums w-24 shrink-0">
                          {g.date}
                        </span>
                        <span className="text-slate-200 truncate">
                          {g.isHome ? 'vs' : '@'} {g.opponent}
                        </span>
                        <div className="flex items-center gap-2 font-mono tabular-nums shrink-0">
                          <span className="font-bold text-white">
                            {g.scoreFor} - {g.scoreAgainst}
                          </span>
                          <span
                            className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold ${
                              g.result === 'W'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : g.result === 'D'
                                  ? 'bg-slate-600/30 text-slate-300'
                                  : 'bg-rose-500/20 text-rose-400'
                            }`}
                          >
                            {g.result}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {match.sport === 'nba' && (
            <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-3 text-xs">
              <h4 className="text-sm font-semibold text-white">
                Eficiencia avanzada NBA (ORtg, DRtg, Pace) y duelos tácticos
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[match.homeTeam, match.awayTeam].map((tm) => (
                  <div key={tm.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-1.5">
                    <span className="font-semibold text-slate-100 block">{tm.name}</span>
                    <div className="grid grid-cols-3 gap-2 font-mono tabular-nums">
                      <div>
                        <span className="text-slate-500 block text-[10px]">ORtg</span>
                        <span className="text-blue-300 font-bold">{tm.offRating ? tm.offRating.toFixed(1) : 'N/D'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block text-[10px]">DRtg</span>
                        <span className="text-sky-300 font-bold">{tm.defRating ? tm.defRating.toFixed(1) : 'N/D'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block text-[10px]">Pace</span>
                        <span className="text-white font-bold">{tm.pace ? tm.pace.toFixed(1) : 'N/D'}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {narrative && narrative.tacticalMatchups.length > 0 && (
                <div className="space-y-1 pt-1 text-slate-300">
                  {narrative.tacticalMatchups.map((line, i) => (
                    <p key={i}>· {line}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SECTION D: JUGADORES Y ALINEACIONES */}
      {tab === 'tactical' &&
        (match.sport === 'football' ? (
          <TacticalPitch
            match={match}
            homePlayers={effectiveHomePlayers}
            awayPlayers={effectiveAwayPlayers}
            refreshingLineups={refreshingFootballLineups}
            onRefreshFootballLineups={
              onRefreshFootballLineups ? () => void onRefreshFootballLineups(match) : undefined
            }
            onSelectPlayer={(p) => onSelectPlayer(p, match)}
            onToggleAvailability={onToggleAvailability}
          />
        ) : (
          <BasketballCourt
            match={match}
            homePlayers={effectiveHomePlayers}
            awayPlayers={effectiveAwayPlayers}
            refreshingNews={refreshingNbaNews}
            onRefreshNbaNews={onRefreshNbaNews ? () => void onRefreshNbaNews(match) : undefined}
            onSelectPlayer={(p) => onSelectPlayer(p, match)}
            onToggleAvailability={onToggleAvailability}
          />
        ))}

      {/* SECTION E: HISTORIAL H2H */}
      {tab === 'h2h' && (
        <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
          <h3 className="text-base font-semibold text-white">
            Enfrentamientos directos (H2H) y balance histórico
          </h3>
          {match.h2hSummary.played < 4 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                Muestra H2H reducida ({match.h2hSummary.played} duelo{match.h2hSummary.played === 1 ? '' : 's'}). Con menos de 4 enfrentamientos directos recientes el modelo restringe su peso para no sobreinterpretar rachas puntuales.
              </span>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-slate-400 block">Partidos H2H</span>
              <span className="text-lg font-bold font-mono tabular-nums text-white">
                {match.h2hSummary.played}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">Victorias {match.homeTeam.shortName}</span>
              <span className="text-lg font-bold font-mono tabular-nums text-blue-400">
                {match.h2hSummary.homeWins}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">Victorias {match.awayTeam.shortName}</span>
              <span className="text-lg font-bold font-mono tabular-nums text-sky-300">
                {match.h2hSummary.awayWins}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">
                Media {match.sport === 'football' ? 'goles' : 'puntos'}
              </span>
              <span className="text-lg font-bold font-mono tabular-nums text-white">
                {match.h2hSummary.avgTotalPointsOrGoals.toFixed(1)}
              </span>
            </div>
          </div>

          {match.h2hSummary.lastMeetings.length === 0 ? (
            <p className="text-xs text-slate-400 pt-2 border-t border-slate-800">
              No hay enfrentamientos directos recientes registrados por el proveedor para esta temporada/serie.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70 pt-2 border-t border-slate-800 text-xs">
              {match.h2hSummary.lastMeetings.map((m, idx) => (
                <div key={idx} className="py-2.5 flex items-center justify-between gap-2">
                  <span className="text-slate-400 font-mono tabular-nums">{m.date}</span>
                  <span className="text-slate-200 font-medium">
                    {m.home} vs {m.away}
                  </span>
                  <span className="font-mono tabular-nums font-bold text-white">{m.score}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SECTION F: CUOTAS DE REFERENCIA Y PROBABILIDADES */}
      {tab === 'odds' && (
        <OddsProbabilityPanel match={match} footballPred={footballPred} nbaPred={nbaPred} />
      )}
    </div>
  );
};
