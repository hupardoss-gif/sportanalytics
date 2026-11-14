import React, { useState } from 'react';
import { ChevronDown, ChevronUp, ShieldAlert, CheckCircle2, Clock } from 'lucide-react';
import type { AvailabilityStatus, MatchRecord, PlayerProfile } from '../types/sports.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';

interface TacticalPitchProps {
  match: MatchRecord;
  homePlayers: PlayerProfile[];
  awayPlayers: PlayerProfile[];
  onSelectPlayer: (player: PlayerProfile) => void;
  onToggleAvailability: (playerId: string, nextStatus: AvailabilityStatus) => void;
}

export const TacticalPitch: React.FC<TacticalPitchProps> = ({
  match,
  homePlayers,
  awayPlayers,
  onSelectPlayer,
  onToggleAvailability,
}) => {
  const [showBench, setShowBench] = useState(() =>
    [...homePlayers, ...awayPlayers].some(
      (p) => p.availability === 'out' || p.availability === 'doubtful' || p.availability === 'suspended'
    )
  );

  const homeStarters = homePlayers
    .filter((p) => p.availability === 'starter' || p.availability === 'doubtful')
    .slice(0, 11);
  const awayStarters = awayPlayers
    .filter((p) => p.availability === 'starter' || p.availability === 'doubtful')
    .slice(0, 11);

  const homeSubsAndOut = homePlayers.filter((p) => !homeStarters.some((s) => s.id === p.id));
  const awaySubsAndOut = awayPlayers.filter((p) => !awayStarters.some((s) => s.id === p.id));

  // Position mapping onto horizontal pitch (Home left 0..48%, Away right 52..100%)
  // Player's own pitchCoord has y=92 (GK) -> y=20 (ST), x=18 (left) -> x=82 (right)
  const mapToPitch = (p: PlayerProfile, isHome: boolean) => {
    const px = p.pitchCoord?.x ?? 50;
    const py = p.pitchCoord?.y ?? 50;
    if (isHome) {
      // GK (y=92) near left edge (~6%), ST (y=20) near midfield (~44%)
      const leftPct = 5 + ((100 - py) / 100) * 44;
      const topPct = px;
      return { leftPct, topPct };
    }
    // Away attacks left: GK near right edge (~95%), ST near midfield (~56%)
    const leftPct = 95 - ((100 - py) / 100) * 44;
    const topPct = 100 - px;
    return { leftPct, topPct };
  };

  if (homePlayers.length === 0 && awayPlayers.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-6 text-center space-y-2">
        <p className="text-sm font-semibold text-slate-200">
          {match.hydrationStatus === 'provider_unavailable'
            ? 'Proveedor no disponible para alineaciones de este partido'
            : match.hydrationStatus === 'network_error' || match.hydrationStatus === 'query_error'
              ? 'No se pudieron consultar las alineaciones'
              : 'Alineaciones todavía no publicadas'}
        </p>
        <p className="text-xs text-slate-400 max-w-xl mx-auto leading-relaxed">
          {match.hydrationNote ??
            'Cuando la competición o el proveedor publique la convocatoria oficial (aprox. 60 min antes del inicio), el campo táctico mostrará automáticamente los 11 titulares y suplentes.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Lineup Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          {match.lineupStatus === 'confirmed' ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              Alineaciones confirmadas
            </span>
          ) : match.lineupStatus === 'provisional' ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-400">
              <Clock className="w-4 h-4" />
              Alineaciones probables / plantilla oficial
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-300">
              <Clock className="w-4 h-4" />
              Alineación no confirmada
            </span>
          )}
          <span className="text-slate-500">·</span>
          <span className="text-slate-300">
            {match.homeTeam.shortName} ({match.homeTeam.formation ?? '4-3-3'}) vs{' '}
            {match.awayTeam.shortName} ({match.awayTeam.formation ?? '4-2-3-1'})
          </span>
        </div>
        <span className="text-slate-400">Pulsa cualquier jugador para abrir su análisis y deslizador</span>
      </div>

      {/* Top-Down Interactive Football Pitch */}
      <div className="relative w-full aspect-[16/10] min-h-[340px] sm:min-h-[430px] rounded-xl overflow-hidden border border-emerald-500/25 bg-[#09201A]">
        {/* Architectural SVG Pitch Lines */}
        <svg
          viewBox="0 0 1000 625"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full pointer-events-none"
          aria-hidden="true"
        >
          {/* Subtle alternating turf bands */}
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
          {/* Outer boundary */}
          <rect
            x="24"
            y="24"
            width="952"
            height="577"
            fill="none"
            stroke="rgba(226, 232, 240, 0.28)"
            strokeWidth="2.5"
          />
          {/* Halfway line & Center circle */}
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
          {/* Left penalty area */}
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
          {/* Right penalty area */}
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
              <span className="px-1.5 py-0.5 rounded bg-slate-950/85 text-[10px] sm:text-[11px] font-medium text-slate-100 whitespace-nowrap max-w-[82px] truncate border border-slate-800/80">
                {p.shortName}
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
              <span className="px-1.5 py-0.5 rounded bg-slate-950/85 text-[10px] sm:text-[11px] font-medium text-slate-200 whitespace-nowrap max-w-[82px] truncate border border-slate-700/80">
                {p.shortName}
              </span>
            </button>
          );
        })}
      </div>

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
              Suplentes, bajas y simulador de disponibilidad
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
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {p.position}
                            {p.injuryNote ? ` · ${p.injuryNote}` : ''}
                          </span>
                        </div>
                      </button>

                      <select
                        value={p.availability}
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
