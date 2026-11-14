import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  CheckCircle2,
  Clock,
  RefreshCw,
  Newspaper,
  ExternalLink,
  Search,
  AlertTriangle,
} from 'lucide-react';
import type { AvailabilityStatus, MatchRecord, PlayerProfile } from '../types/sports.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';

interface TacticalPitchProps {
  match: MatchRecord;
  homePlayers: PlayerProfile[];
  awayPlayers: PlayerProfile[];
  refreshingLineups?: boolean;
  onRefreshFootballLineups?: () => void;
  onSelectPlayer: (player: PlayerProfile) => void;
  onToggleAvailability: (playerId: string, nextStatus: AvailabilityStatus) => void;
}

function isFootballStarterCandidate(p: PlayerProfile): boolean {
  return (
    p.availability === 'confirmed_starter' ||
    p.availability === 'possible_starter' ||
    p.availability === 'starter' ||
    p.availability === 'probable' ||
    p.availability === 'doubtful'
  );
}

export const TacticalPitch: React.FC<TacticalPitchProps> = ({
  match,
  homePlayers,
  awayPlayers,
  refreshingLineups = false,
  onRefreshFootballLineups,
  onSelectPlayer,
  onToggleAvailability,
}) => {
  const hasConfirmed =
    Boolean(match.confirmedLineup?.confirmed) || match.lineupStatus === 'confirmed';
  const [lineupMode, setLineupMode] = useState<'probable' | 'confirmed'>(
    hasConfirmed ? 'confirmed' : 'probable'
  );

  useEffect(() => {
    if (hasConfirmed) {
      setLineupMode('confirmed');
    }
  }, [hasConfirmed, match.id]);

  const [showBench, setShowBench] = useState(() =>
    [...homePlayers, ...awayPlayers].some(
      (p) => p.availability === 'out' || p.availability === 'doubtful' || p.availability === 'suspended'
    )
  );

  const overrideMap = new Map<string, AvailabilityStatus>();
  for (const p of [...homePlayers, ...awayPlayers]) {
    overrideMap.set(p.id, p.availability);
  }
  const applyOv = (list: PlayerProfile[]) =>
    list.map((p) => ({ ...p, availability: overrideMap.get(p.id) ?? p.availability }));

  const activeSnapshot =
    lineupMode === 'confirmed' ? match.confirmedLineup : match.probableLineup;

  const homeSourceList =
    lineupMode === 'confirmed'
      ? match.confirmedLineup?.homeStarters
        ? applyOv(match.confirmedLineup.homeStarters)
        : hasConfirmed
          ? homePlayers
          : []
      : match.probableLineup?.homeStarters
        ? applyOv(match.probableLineup.homeStarters)
        : homePlayers;

  const awaySourceList =
    lineupMode === 'confirmed'
      ? match.confirmedLineup?.awayStarters
        ? applyOv(match.confirmedLineup.awayStarters)
        : hasConfirmed
          ? awayPlayers
          : []
      : match.probableLineup?.awayStarters
        ? applyOv(match.probableLineup.awayStarters)
        : awayPlayers;

  const homeStarters = homeSourceList.filter(isFootballStarterCandidate).slice(0, 11);
  const awayStarters = awaySourceList.filter(isFootballStarterCandidate).slice(0, 11);

  const homeSubsAndOut = homePlayers.filter((p) => !homeStarters.some((s) => s.id === p.id));
  const awaySubsAndOut = awayPlayers.filter((p) => !awayStarters.some((s) => s.id === p.id));

  // Position mapping onto horizontal pitch (Home left 0..48%, Away right 52..100%)
  const mapToPitch = (p: PlayerProfile, isHome: boolean) => {
    const px = p.pitchCoord?.x ?? 50;
    const py = p.pitchCoord?.y ?? 50;
    if (isHome) {
      const leftPct = 5 + ((100 - py) / 100) * 44;
      const topPct = px;
      return { leftPct, topPct };
    }
    const leftPct = 95 - ((100 - py) / 100) * 44;
    const topPct = 100 - px;
    return { leftPct, topPct };
  };

  if (homePlayers.length === 0 && awayPlayers.length === 0 && !match.probableLineup && !match.confirmedLineup) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-6 text-center space-y-3">
        <p className="text-sm font-semibold text-slate-200">
          {match.hydrationStatus === 'provider_unavailable'
            ? 'Proveedor no disponible para alineaciones de este partido'
            : match.hydrationStatus === 'network_error' || match.hydrationStatus === 'query_error'
              ? 'No se pudieron consultar las alineaciones'
              : 'Alineaciones todavía no cargadas'}
        </p>
        <p className="text-xs text-slate-400 max-w-xl mx-auto leading-relaxed">
          {match.hydrationNote ??
            'Puedes consultar la última alineación probable y noticias previas de medios o esperar a que se publique el once oficial.'}
        </p>
        {onRefreshFootballLineups && !match.isOfflineReference && (
          <button
            type="button"
            onClick={onRefreshFootballLineups}
            disabled={refreshingLineups}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingLineups ? 'animate-spin' : ''}`} />
            {refreshingLineups ? 'Consultando alineaciones...' : 'Consultar alineación probable y noticias'}
          </button>
        )}
      </div>
    );
  }

  const fbNews = match.footballNews;

  return (
    <div className="space-y-4">
      {/* Probable vs Confirmed Switcher & Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800">
            <button
              type="button"
              onClick={() => setLineupMode('probable')}
              className={`min-h-[32px] px-3 py-1 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                lineupMode === 'probable'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Alineación Probable
            </button>
            <button
              type="button"
              onClick={() => setLineupMode('confirmed')}
              className={`min-h-[32px] px-3 py-1 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                lineupMode === 'confirmed'
                  ? hasConfirmed
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-700 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Alineación Confirmada
            </button>
          </div>

          {lineupMode === 'confirmed' && hasConfirmed ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              Once oficial publicado
            </span>
          ) : lineupMode === 'probable' ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-400">
              <Clock className="w-4 h-4" />
              Proyección previa ({activeSnapshot?.overallConfidence ?? 72}% conf.)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-300">
              <Clock className="w-4 h-4" />
              Once oficial aún no publicado
            </span>
          )}

          <span className="text-slate-500">·</span>
          <span className="text-slate-300">
            {match.homeTeam.shortName} ({activeSnapshot?.homeFormation ?? match.homeTeam.formation ?? '4-3-3'}) vs{' '}
            {match.awayTeam.shortName} ({activeSnapshot?.awayFormation ?? match.awayTeam.formation ?? '4-2-3-1'})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {onRefreshFootballLineups && !match.isOfflineReference && (
            <button
              type="button"
              onClick={onRefreshFootballLineups}
              disabled={refreshingLineups}
              className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingLineups ? 'animate-spin' : ''}`} />
              {refreshingLineups ? 'Actualizando...' : 'Actualizar alineaciones y noticias'}
            </button>
          )}
        </div>
      </div>

      {/* Lineup Provenance & Discrepancy Alert */}
      {activeSnapshot && (
        <div className="rounded-lg border border-slate-800 bg-[#0D1526] px-3.5 py-2.5 text-xs space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300">
            <span>
              {activeSnapshot.confirmed
                ? `Fuente oficial: ${activeSnapshot.officialSource ?? activeSnapshot.sourcesConsulted.join(', ')}`
                : `Fuentes consultadas: ${activeSnapshot.sourcesConsulted.join(', ')}`}
            </span>
            <span className="font-mono tabular-nums text-slate-400">
              Actualizado:{' '}
              {new Date(activeSnapshot.publishedAt ?? activeSnapshot.updatedAt).toLocaleString('es-ES', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          {activeSnapshot.discrepancyDetected && activeSnapshot.discrepancyNote && (
            <div className="flex items-start gap-2 text-amber-300 pt-1">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{activeSnapshot.discrepancyNote}</span>
            </div>
          )}
        </div>
      )}

      {/* Confirmed Not Yet Published Honest Placeholder */}
      {lineupMode === 'confirmed' && !hasConfirmed ? (
        <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-6 text-center space-y-2">
          <p className="text-sm font-semibold text-white">
            Alineación oficial confirmada aún no publicada
          </p>
          <p className="text-xs text-slate-400 max-w-xl mx-auto leading-relaxed">
            Los clubes suelen publicar el once titular oficial entre 60 y 75 minutos antes del inicio. SportAnalytics AI nunca etiqueta una estimación como alineación confirmada. Cambia a la pestaña «Alineación Probable» para consultar la proyección actual con porcentajes de titularidad.
          </p>
          <button
            type="button"
            onClick={() => setLineupMode('probable')}
            className="min-h-[38px] px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white cursor-pointer"
          >
            Ver Alineación Probable
          </button>
        </div>
      ) : (
        /* Top-Down Interactive Football Pitch */
        <div className="relative w-full aspect-[16/10] min-h-[340px] sm:min-h-[430px] rounded-xl overflow-hidden border border-emerald-500/25 bg-[#09201A]">
          <svg
            viewBox="0 0 1000 625"
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full pointer-events-none"
            aria-hidden="true"
          >
            {Array.from({ length: 10 }).map((_, idx) => (
              <rect
                key={idx}
                x={idx * 100}
                y={0}
                width={100}
                height={625}
                fill={idx % 2 === 0 ? 'rgba(16, 185, 129, 0.04)' : 'rgba(6, 78, 59, 0.14)'}
              />
            ))}
            <rect
              x="24"
              y="24"
              width="952"
              height="577"
              fill="none"
              stroke="rgba(226, 232, 240, 0.28)"
              strokeWidth="2.5"
            />
            <line
              x1="500"
              y1="24"
              x2="500"
              y2="601"
              stroke="rgba(226, 232, 240, 0.28)"
              strokeWidth="2.5"
            />
            <circle
              cx="500"
              cy="312.5"
              r="74"
              fill="none"
              stroke="rgba(226, 232, 240, 0.28)"
              strokeWidth="2.5"
            />
            <circle cx="500" cy="312.5" r="4" fill="rgba(226, 232, 240, 0.45)" />
            <rect
              x="24"
              y="148"
              width="136"
              height="329"
              fill="none"
              stroke="rgba(226, 232, 240, 0.28)"
              strokeWidth="2.5"
            />
            <rect
              x="24"
              y="224"
              width="48"
              height="177"
              fill="none"
              stroke="rgba(226, 232, 240, 0.24)"
              strokeWidth="2"
            />
            <rect
              x="840"
              y="148"
              width="136"
              height="329"
              fill="none"
              stroke="rgba(226, 232, 240, 0.28)"
              strokeWidth="2.5"
            />
            <rect
              x="928"
              y="224"
              width="48"
              height="177"
              fill="none"
              stroke="rgba(226, 232, 240, 0.24)"
              strokeWidth="2"
            />
          </svg>

          {/* Home Starters */}
          {homeStarters.map((p) => {
            const { leftPct, topPct } = mapToPitch(p, true);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectPlayer(p)}
                style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5 group cursor-pointer focus-visible:outline-none z-10 min-w-[44px] min-h-[44px] justify-center"
              >
                <div className="transition-transform duration-150 group-hover:scale-110">
                  <PlayerAvatar
                    name={p.name}
                    number={p.number}
                    photoUrl={p.photoUrl}
                    availability={p.availability}
                    size="sm"
                    accent="blue"
                  />
                </div>
                <span className="px-1.5 py-0.5 rounded bg-slate-950/85 text-[10px] sm:text-[11px] font-medium text-slate-100 whitespace-nowrap max-w-[90px] truncate border border-slate-800/80">
                  {p.shortName}
                  {lineupMode === 'probable' && p.starterConfidence !== undefined && (
                    <span className="text-sky-300 font-mono ml-1">{p.starterConfidence}%</span>
                  )}
                </span>
              </button>
            );
          })}

          {/* Away Starters */}
          {awayStarters.map((p) => {
            const { leftPct, topPct } = mapToPitch(p, false);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectPlayer(p)}
                style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5 group cursor-pointer focus-visible:outline-none z-10 min-w-[44px] min-h-[44px] justify-center"
              >
                <div className="transition-transform duration-150 group-hover:scale-110">
                  <PlayerAvatar
                    name={p.name}
                    number={p.number}
                    photoUrl={p.photoUrl}
                    availability={p.availability}
                    size="sm"
                    accent="slate"
                  />
                </div>
                <span className="px-1.5 py-0.5 rounded bg-slate-950/85 text-[10px] sm:text-[11px] font-medium text-slate-200 whitespace-nowrap max-w-[90px] truncate border border-slate-700/80">
                  {p.shortName}
                  {lineupMode === 'probable' && p.starterConfidence !== undefined && (
                    <span className="text-sky-300 font-mono ml-1">{p.starterConfidence}%</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Press, Official Club Releases & Google Search Grounding */}
      {fbNews && (
        <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 font-semibold text-white">
              <Newspaper className="w-4 h-4 text-blue-400" />
              <span>Noticias de convocatoria, prensa deportiva y búsqueda en Google</span>
            </div>
            <span className="text-[11px] font-mono tabular-nums text-slate-400">
              Consultado:{' '}
              {new Date(fbNews.fetchedAt).toLocaleTimeString('es-ES', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>

          <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
            <span>Fuentes: {fbNews.sourcesChecked.join(', ')}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <Search className="w-3 h-3 text-blue-400" />
              Google Search:{' '}
              {fbNews.searchGrounding.status === 'active'
                ? 'Activo con citas reales'
                : fbNews.searchGrounding.status === 'unconfigured'
                  ? 'No configurado (añade GEMINI_API_KEY en entorno)'
                  : 'Error consultando Google'}
            </span>
          </div>

          {fbNews.items.length === 0 ? (
            <p className="text-xs text-slate-400">
              No se detectaron titulares específicos de lesiones o convocatorias para este partido en las últimas horas.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {fbNews.items.slice(0, 6).map((item) => (
                <div key={item.id} className="py-2.5 space-y-1 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${
                          item.confirmed
                            ? 'border-emerald-500/35 bg-emerald-950/30 text-emerald-300'
                            : 'border-amber-500/35 bg-amber-950/30 text-amber-300'
                        }`}
                      >
                        {item.confirmed ? 'Confirmado' : 'Prensa / Probable'}
                      </span>
                      <span className="font-semibold text-slate-200">{item.source}</span>
                    </div>
                    {item.publishedAt && (
                      <span className="text-[11px] font-mono tabular-nums text-slate-400">
                        {new Date(item.publishedAt).toLocaleString('es-ES', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  <p className="font-medium text-slate-100">{item.headline}</p>
                  {item.summary && <p className="text-slate-400 leading-relaxed">{item.summary}</p>}
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 text-[11px]"
                    >
                      Leer fuente <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Expandable Bench, Injuries & Quick Availability Simulation */}
      <div className="rounded-xl border border-slate-800 bg-[#0D1526] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowBench((v) => !v)}
          className="w-full min-h-[48px] px-4 py-3 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold text-slate-100">
              Convocatoria completa, suplentes, bajas y simulador de disponibilidad
            </span>
          </div>
          {showBench ? (
            <ChevronUp className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </button>

        {showBench && (
          <div className="p-4 border-t border-slate-800 space-y-4">
            {[...homePlayers, ...awayPlayers].some((p) => p.statsQuality === 'estimated') && (
              <p className="text-[11px] text-amber-200/90 rounded-lg border border-amber-500/25 bg-amber-950/20 px-3 py-2">
                Nota de datos: cuando el proveedor no publica logs individuales completos por encuentro, las métricas base por jugador reflejan estimaciones posicionales marcadas en su ficha.
              </p>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {[
                { title: match.homeTeam.name, all: homePlayers, subs: homeSubsAndOut },
                { title: match.awayTeam.name, all: awayPlayers, subs: awaySubsAndOut },
              ].map((side) => (
                <div key={side.title} className="space-y-3">
                  <h5 className="text-xs font-semibold text-slate-400">{side.title}</h5>
                  <div className="divide-y divide-slate-800/70">
                    {side.all.map((p) => (
                      <div
                        key={p.id}
                        className="py-2.5 flex items-center justify-between gap-2 text-xs"
                      >
                        <button
                          type="button"
                          onClick={() => onSelectPlayer(p)}
                          className="flex items-center gap-2.5 text-left hover:text-blue-400 transition-colors min-h-[40px] cursor-pointer min-w-0"
                        >
                          <span className="font-mono tabular-nums text-slate-500 w-5">
                            #{p.number}
                          </span>
                          <div className="min-w-0">
                            <span className="font-medium text-slate-100 block truncate">
                              {p.name}
                              {p.starterConfidence !== undefined && (
                                <span className="ml-1.5 text-[10px] font-mono text-sky-300">
                                  ({p.starterConfidence}% tit.)
                                </span>
                              )}
                            </span>
                            <span className="text-[11px] text-slate-400 block truncate">
                              {p.position}
                              {p.roleReason ? ` · ${p.roleReason}` : ''}
                              {p.injuryNote ? ` · ${p.injuryNote}` : ''}
                            </span>
                          </div>
                        </button>

                        <select
                          value={
                            p.availability === 'confirmed_starter' ||
                            p.availability === 'possible_starter'
                              ? 'starter'
                              : p.availability
                          }
                          aria-label={`Disponibilidad de ${p.name}`}
                          onChange={(e) =>
                            onToggleAvailability(p.id, e.target.value as AvailabilityStatus)
                          }
                          className={`min-h-[36px] px-2.5 py-1 rounded-lg border text-xs font-medium bg-slate-900 cursor-pointer ${
                            p.availability === 'out' || p.availability === 'suspended'
                              ? 'border-rose-500/40 text-rose-300'
                              : p.availability === 'doubtful'
                                ? 'border-amber-500/40 text-amber-300'
                                : p.availability === 'bench'
                                  ? 'border-slate-700 text-slate-300'
                                  : 'border-emerald-500/40 text-emerald-300'
                          }`}
                        >
                          <option value="starter">Titular</option>
                          <option value="bench">Suplente</option>
                          <option value="doubtful">Dudoso</option>
                          <option value="out">Baja (Lesión)</option>
                          <option value="suspended">Sancionado</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

