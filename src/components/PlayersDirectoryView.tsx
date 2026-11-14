import React, { useMemo, useState } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import type {
  AvailabilityStatus,
  MatchRecord,
  PlayerProfile,
  SportType,
} from '../types/sports.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';

interface PlayersDirectoryViewProps {
  matches: MatchRecord[];
  sport: SportType;
  playerOverrides: Record<string, AvailabilityStatus>;
  onSelectPlayer: (player: PlayerProfile, match: MatchRecord) => void;
}

export const PlayersDirectoryView: React.FC<PlayersDirectoryViewProps> = ({
  matches,
  sport,
  playerOverrides,
  onSelectPlayer,
}) => {
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState<string>('all');

  const playerEntries = useMemo(() => {
    const entries: Array<{ player: PlayerProfile; match: MatchRecord }> = [];
    const seen = new Set<string>();
    for (const m of matches) {
      if (m.sport !== sport) continue;
      for (const p of [...m.homePlayers, ...m.awayPlayers]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        entries.push({
          player: { ...p, availability: playerOverrides[p.id] ?? p.availability },
          match: m,
        });
      }
    }
    return entries;
  }, [matches, sport, playerOverrides]);

  const teams = useMemo(
    () => Array.from(new Set(playerEntries.map((e) => e.player.teamName))),
    [playerEntries]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return playerEntries.filter(({ player }) => {
      if (teamFilter !== 'all' && player.teamName !== teamFilter) return false;
      if (!q) return true;
      return (
        player.name.toLowerCase().includes(q) ||
        player.teamName.toLowerCase().includes(q) ||
        player.position.toLowerCase().includes(q)
      );
    });
  }, [playerEntries, query, teamFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white">
            Análisis individual de jugadores ({sport === 'football' ? 'Fútbol' : 'NBA'})
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Selecciona cualquier jugador para abrir su ficha completa, comparador, splits L5/L10/L15 y simulador Over/Under.
          </p>
        </div>
      </div>

      {/* Search & Team Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar jugador, equipo o posición..."
            className="w-full min-h-[44px] pl-10 pr-4 rounded-xl border border-slate-800 bg-[#0D1526] text-sm text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          aria-label="Filtrar por equipo"
          className="min-h-[44px] px-3.5 rounded-xl border border-slate-800 bg-[#0D1526] text-sm text-slate-200 cursor-pointer"
        >
          <option value="all">Todos los equipos</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-200">
            No hay jugadores cargados para este filtro
          </p>
          <p className="text-xs text-slate-400">
            Cambia la búsqueda o activa el Simulador Offline / conecta una API en Configuración.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(({ player, match }) => {
            const s = player.splits.season;
            return (
              <button
                key={player.id}
                type="button"
                onClick={() => onSelectPlayer(player, match)}
                className="text-left rounded-xl border border-slate-800 bg-[#0D1526] hover:border-blue-500/50 p-4 space-y-3 transition-colors cursor-pointer group"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <PlayerAvatar
                      name={player.name}
                      number={player.number}
                      photoUrl={player.photoUrl}
                      availability={player.availability}
                      size="md"
                    />
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold text-white truncate group-hover:text-blue-400 transition-colors">
                        {player.name}
                      </h3>
                      <p className="text-xs text-slate-400 truncate">
                        {player.teamShort} · {player.position} ·{' '}
                        <span
                          className={
                            player.availability === 'out' || player.availability === 'suspended'
                              ? 'text-rose-400'
                              : player.availability === 'doubtful' || player.availability === 'probable'
                                ? 'text-amber-400'
                                : player.availability === 'available' || player.availability === 'bench'
                                  ? 'text-slate-300'
                                  : 'text-emerald-400'
                          }
                        >
                          {player.availability === 'out'
                            ? 'Descartado'
                            : player.availability === 'suspended'
                              ? 'Sancionado'
                              : player.availability === 'doubtful'
                                ? 'Dudoso'
                                : player.availability === 'probable'
                                  ? 'Probable'
                                  : player.availability === 'confirmed_starter'
                                    ? 'Titular confirmado'
                                    : player.availability === 'possible_starter'
                                      ? 'Posible titular'
                                      : player.availability === 'available'
                                        ? 'Disponible'
                                        : player.availability === 'bench'
                                          ? 'Suplente'
                                          : 'Titular'}
                        </span>
                      </p>
                    </div>
                  </div>
                  <SlidersHorizontal className="w-4 h-4 text-slate-500 group-hover:text-blue-400 shrink-0" />
                </div>

                {sport === 'football' ? (
                  <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-800/80 text-xs font-mono tabular-nums">
                    <div>
                      <span className="text-slate-500 block text-[10px]">Goles</span>
                      <span className="font-semibold text-white">{(s.goals ?? 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px]">Asist.</span>
                      <span className="font-semibold text-white">{(s.assists ?? 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px]">Tiros</span>
                      <span className="font-semibold text-blue-300">{(s.shots ?? 0).toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px]">A puerta</span>
                      <span className="font-semibold text-slate-200">
                        {(s.shotsOnTarget ?? 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-800/80 text-xs font-mono tabular-nums">
                    <div>
                      <span className="text-slate-500 block text-[10px]">PTS</span>
                      <span className="font-semibold text-white">{(s.points ?? 0).toFixed(1)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px]">REB</span>
                      <span className="font-semibold text-white">{(s.rebounds ?? 0).toFixed(1)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px]">AST</span>
                      <span className="font-semibold text-blue-300">{(s.assists ?? 0).toFixed(1)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-[10px]">3PM</span>
                      <span className="font-semibold text-slate-200">{(s.threes ?? 0).toFixed(1)}</span>
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
