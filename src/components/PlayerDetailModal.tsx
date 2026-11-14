import React, { useMemo, useState } from 'react';
import { X, ArrowLeftRight, TrendingUp, Newspaper, ExternalLink, Clock } from 'lucide-react';
import type {
  AvailabilityStatus,
  MatchRecord,
  PlayerProfile,
  PropStatKey,
  TimeframeSplit,
} from '../types/sports.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';
import { OverUnderLab } from './OverUnderLab.tsx';

interface PlayerDetailModalProps {
  player: PlayerProfile;
  match: MatchRecord;
  teammates: PlayerProfile[];
  allSameSportPlayers: PlayerProfile[];
  onClose: () => void;
  onChangeAvailability: (playerId: string, nextStatus: AvailabilityStatus) => void;
}

const SPLIT_OPTIONS: Array<{ id: TimeframeSplit; label: string }> = [
  { id: 'season', label: 'Temporada' },
  { id: 'last5', label: 'Últ. 5' },
  { id: 'last10', label: 'Últ. 10' },
  { id: 'last15', label: 'Últ. 15' },
  { id: 'home', label: 'Local' },
  { id: 'away', label: 'Visitante' },
  { id: 'h2h', label: 'vs Rival' },
];

export const PlayerDetailModal: React.FC<PlayerDetailModalProps> = ({
  player,
  match,
  teammates,
  allSameSportPlayers,
  onClose,
  onChangeAvailability,
}) => {
  const [timeframe, setTimeframe] = useState<TimeframeSplit>('season');
  const [comparePlayerId, setComparePlayerId] = useState<string>('');
  const [trendStat, setTrendStat] = useState<PropStatKey>(
    player.sport === 'football' ? 'shots' : 'points'
  );

  const currentPlayer =
    teammates.find((t) => t.id === player.id) ?? player;
  const split = currentPlayer.splits[timeframe] ?? currentPlayer.splits.season;

  const comparePlayer = useMemo(
    () =>
      allSameSportPlayers.find(
        (p) => p.id === comparePlayerId && p.id !== currentPlayer.id
      ) ?? null,
    [allSameSportPlayers, comparePlayerId, currentPlayer.id]
  );

  const compareSplit = comparePlayer
    ? comparePlayer.splits[timeframe] ?? comparePlayer.splits.season
    : null;

  const maxLogVal = useMemo(() => {
    const vals = currentPlayer.recentLogs.map((l) => l.stats[trendStat] ?? 0);
    return Math.max(1, ...vals);
  }, [currentPlayer.recentLogs, trendStat]);

  const metricRows =
    currentPlayer.sport === 'football'
      ? [
          { key: 'goals', label: 'Goles / partido', val: split.goals ?? 0, cmp: compareSplit?.goals ?? 0 },
          { key: 'assists', label: 'Asistencias / p', val: split.assists ?? 0, cmp: compareSplit?.assists ?? 0 },
          { key: 'shots', label: 'Tiros totales', val: split.shots ?? 0, cmp: compareSplit?.shots ?? 0 },
          { key: 'shotsOnTarget', label: 'Tiros a puerta', val: split.shotsOnTarget ?? 0, cmp: compareSplit?.shotsOnTarget ?? 0 },
          { key: 'foulsCommitted', label: 'Faltas cometidas', val: split.foulsCommitted ?? 0, cmp: compareSplit?.foulsCommitted ?? 0 },
          { key: 'foulsDrawn', label: 'Faltas recibidas', val: split.foulsDrawn ?? 0, cmp: compareSplit?.foulsDrawn ?? 0 },
          { key: 'yellowCards', label: 'Tarjetas amarillas', val: split.yellowCards ?? 0, cmp: compareSplit?.yellowCards ?? 0 },
          { key: 'passes', label: 'Pases / partido', val: split.passes ?? 0, cmp: compareSplit?.passes ?? 0 },
        ]
      : [
          { key: 'points', label: 'Puntos', val: split.points ?? 0, cmp: compareSplit?.points ?? 0 },
          { key: 'rebounds', label: 'Rebotes', val: split.rebounds ?? 0, cmp: compareSplit?.rebounds ?? 0 },
          { key: 'assists', label: 'Asistencias', val: split.assists ?? 0, cmp: compareSplit?.assists ?? 0 },
          { key: 'threes', label: 'Triples anotados', val: split.threes ?? 0, cmp: compareSplit?.threes ?? 0 },
          { key: 'steals', label: 'Robos', val: split.steals ?? 0, cmp: compareSplit?.steals ?? 0 },
          { key: 'blocks', label: 'Tapones', val: split.blocks ?? 0, cmp: compareSplit?.blocks ?? 0 },
          { key: 'turnovers', label: 'Pérdidas', val: split.turnovers ?? 0, cmp: compareSplit?.turnovers ?? 0 },
        ];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Análisis individual de ${currentPlayer.name}`}
    >
      <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-800 bg-[#080E1C] text-slate-100 shadow-2xl">
        {/* Mobile grab handle */}
        <div className="sm:hidden w-10 h-1.5 bg-slate-700 rounded-full mx-auto mt-3" />

        {/* Sticky Header */}
        <div className="sticky top-0 z-20 bg-[#080E1C]/95 backdrop-blur-md border-b border-slate-800 px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <PlayerAvatar
              name={currentPlayer.name}
              number={currentPlayer.number}
              photoUrl={currentPlayer.photoUrl}
              availability={currentPlayer.availability}
              size="lg"
            />
            <div className="min-w-0">
              <h3 className="text-lg sm:text-xl font-bold text-white truncate">
                {currentPlayer.name}
              </h3>
              <p className="text-xs text-slate-400">
                {currentPlayer.teamName} · {currentPlayer.position} · #{currentPlayer.number} ·{' '}
                <span className="font-mono tabular-nums">
                  {split.minutes.toFixed(1)} min/p · {(split.starterRate * 100).toFixed(0)}% titular
                </span>
              </p>
              {currentPlayer.injuryNote && (
                <p className="text-xs text-amber-300 mt-0.5">{currentPlayer.injuryNote}</p>
              )}
              {currentPlayer.minutesRestriction && (
                <p className="text-xs text-blue-300 mt-0.5 flex items-center gap-1">
                  <Clock className="w-3 h-3 shrink-0" />
                  {currentPlayer.minutesRestriction.note}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ficha de jugador"
            className="w-11 h-11 rounded-xl border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 flex items-center justify-center shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-6 pb-10">
          {/* Controls: Availability Simulator + Timeframe Split */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {SPLIT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setTimeframe(opt.id)}
                  className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    timeframe === opt.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-900 text-slate-300 border border-slate-800 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Estado:</span>
              {currentPlayer.sport === 'nba' ? (
                <select
                  value={currentPlayer.availability}
                  onChange={(e) =>
                    onChangeAvailability(currentPlayer.id, e.target.value as AvailabilityStatus)
                  }
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-medium text-slate-100 cursor-pointer"
                >
                  <option value="confirmed_starter">Titular confirmado</option>
                  <option value="possible_starter">Posible titular</option>
                  <option value="probable">Probable</option>
                  <option value="available">Disponible (rotación)</option>
                  <option value="doubtful">Dudoso (GTD)</option>
                  <option value="out">Descartado (OUT)</option>
                </select>
              ) : (
                <select
                  value={currentPlayer.availability}
                  onChange={(e) =>
                    onChangeAvailability(currentPlayer.id, e.target.value as AvailabilityStatus)
                  }
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-medium text-slate-100 cursor-pointer"
                >
                  <option value="starter">Titular</option>
                  <option value="bench">Suplente</option>
                  <option value="doubtful">Dudoso</option>
                  <option value="out">Baja / Descartado</option>
                  <option value="suspended">Sancionado</option>
                </select>
              )}
            </div>
          </div>

          {currentPlayer.sport === 'nba' && currentPlayer.latestNews && (
            <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-slate-100">
                  <Newspaper className="w-4 h-4 text-blue-400" />
                  <span>Último parte y noticias ({currentPlayer.latestNews.source})</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                      currentPlayer.latestNews.confirmed
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    {currentPlayer.latestNews.confirmed ? 'Oficial / Confirmado' : 'Medio / Rumor'}
                  </span>
                </div>
                <span className="text-slate-400 font-mono tabular-nums">
                  {new Date(currentPlayer.latestNews.publishedAt).toLocaleString('es-ES', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="text-slate-300 leading-relaxed">{currentPlayer.latestNews.summary}</p>
              {currentPlayer.latestNews.url && (
                <a
                  href={currentPlayer.latestNews.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium"
                >
                  Ver fuente original
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {/* Interactive Over/Under Slider & Distribution */}
          <OverUnderLab
            player={currentPlayer}
            match={match}
            timeframe={timeframe}
            teammatesOverride={teammates}
          />

          {/* Player Metrics Grid & Comparator */}
          <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-slate-100">
                Promedios estadísticos ({SPLIT_OPTIONS.find((s) => s.id === timeframe)?.label} ·{' '}
                {split.games} partidos)
              </h4>
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="w-3.5 h-3.5 text-slate-400" />
                <select
                  value={comparePlayerId}
                  onChange={(e) => setComparePlayerId(e.target.value)}
                  aria-label="Comparar con otro jugador"
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs text-slate-200 cursor-pointer max-w-[220px]"
                >
                  <option value="">Comparar con jugador...</option>
                  {allSameSportPlayers
                    .filter((p) => p.id !== currentPlayer.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.shortName} ({p.teamShort})
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {metricRows.map((row) => (
                <div
                  key={row.key}
                  className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 space-y-1"
                >
                  <span className="text-[11px] text-slate-400 block truncate">{row.label}</span>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-bold font-mono tabular-nums text-white">
                      {row.val.toFixed(currentPlayer.sport === 'football' && row.key !== 'passes' ? 2 : 1)}
                    </span>
                    {comparePlayer && (
                      <span className="text-xs font-mono tabular-nums text-blue-400">
                        vs{' '}
                        {row.cmp.toFixed(
                          currentPlayer.sport === 'football' && row.key !== 'passes' ? 2 : 1
                        )}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Game Log Chart */}
          <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-blue-400" />
                <h4 className="text-sm font-semibold text-slate-100">
                  Evolución últimos 5 partidos
                </h4>
              </div>
              <div className="flex items-center gap-1.5">
                {(currentPlayer.sport === 'football'
                  ? ([
                      { k: 'shots', l: 'Tiros' },
                      { k: 'shotsOnTarget', l: 'A puerta' },
                      { k: 'goals', l: 'Goles' },
                      { k: 'passes', l: 'Pases' },
                    ] as const)
                  : ([
                      { k: 'points', l: 'Puntos' },
                      { k: 'rebounds', l: 'Rebotes' },
                      { k: 'assists', l: 'Asist.' },
                      { k: 'threes', l: 'Triples' },
                    ] as const)
                ).map((item) => (
                  <button
                    key={item.k}
                    type="button"
                    onClick={() => setTrendStat(item.k)}
                    className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${
                      trendStat === item.k
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-900 text-slate-400 hover:text-white'
                    }`}
                  >
                    {item.l}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-32 flex items-end gap-3 pt-4">
              {currentPlayer.recentLogs.map((log, i) => {
                const val = log.stats[trendStat] ?? 0;
                const hPct = Math.max(6, (val / maxLogVal) * 100);
                return (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
                    <span className="text-xs font-mono tabular-nums font-semibold text-slate-200 mb-1">
                      {val}
                    </span>
                    <div
                      style={{ height: `${hPct}%` }}
                      className="w-full max-w-[44px] rounded-t bg-blue-500/80"
                    />
                    <span className="text-[11px] font-mono text-slate-400 mt-1.5">
                      {log.isHome ? 'vs' : '@'} {log.opponent}
                    </span>
                    <span className="text-[10px] font-mono tabular-nums text-slate-500">
                      {log.minutes}&apos;
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
