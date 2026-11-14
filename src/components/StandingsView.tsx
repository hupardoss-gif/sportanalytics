import React, { useState } from 'react';
import type { SportType, StandingEntry } from '../types/sports.ts';

interface StandingsViewProps {
  sport: SportType;
  standings: StandingEntry[];
}

export const StandingsView: React.FC<StandingsViewProps> = ({ sport, standings }) => {
  const leagues = Array.from(
    new Set(
      standings
        .filter((s) => (sport === 'nba' ? s.league === 'NBA' : s.league !== 'NBA'))
        .map((s) => (s.conference ? `NBA · Conferencia ${s.conference}` : s.league))
    )
  );

  const [selectedGroup, setSelectedGroup] = useState<string>(leagues[0] ?? '');
  const activeGroup = leagues.includes(selectedGroup) ? selectedGroup : leagues[0] ?? '';

  const rows = standings
    .filter((s) => {
      const label = s.conference ? `NBA · Conferencia ${s.conference}` : s.league;
      return label === activeGroup;
    })
    .sort((a, b) => a.rank - b.rank);

  if (leagues.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-6 text-center space-y-2">
        <p className="text-sm font-semibold text-slate-200">
          Sin clasificaciones disponibles para este modo
        </p>
        <p className="text-xs text-slate-400">
          Conecta una API de {sport === 'football' ? 'Fútbol' : 'NBA'} o activa el Simulador Offline para inspeccionar tablas de posiciones.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-[#0D1526] overflow-hidden">
      <div className="px-4 sm:px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-white">Clasificaciones</h3>
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {leagues.map((lg) => (
            <button
              key={lg}
              type="button"
              onClick={() => setSelectedGroup(lg)}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                activeGroup === lg
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-900 text-slate-300 border border-slate-800 hover:text-white'
              }`}
            >
              {lg}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="py-3 px-4 font-medium w-10">#</th>
              <th className="py-3 px-3 font-medium">Equipo</th>
              <th className="py-3 px-3 font-medium text-right">PJ</th>
              <th className="py-3 px-3 font-medium text-right">G</th>
              {sport === 'football' && <th className="py-3 px-3 font-medium text-right">E</th>}
              <th className="py-3 px-3 font-medium text-right">P</th>
              <th className="py-3 px-3 font-medium text-right">
                {sport === 'football' ? 'GF:GC' : 'PF:PC'}
              </th>
              <th className="py-3 px-3 font-medium text-right">Dif</th>
              <th className="py-3 px-3 font-medium text-right">Local</th>
              <th className="py-3 px-3 font-medium text-right">Visit.</th>
              <th className="py-3 px-3 font-medium text-right">Racha</th>
              <th className="py-3 px-4 font-medium text-right">
                {sport === 'football' ? 'PTS' : '%V'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {rows.map((r) => (
              <tr key={`${r.league}-${r.teamId}`} className="hover:bg-slate-900/50">
                <td className="py-3 px-4 font-mono tabular-nums text-slate-400">{r.rank}</td>
                <td className="py-3 px-3 font-semibold text-slate-100 whitespace-nowrap">
                  {r.teamName}
                </td>
                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300">
                  {r.played}
                </td>
                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-200">
                  {r.won}
                </td>
                {sport === 'football' && (
                  <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-400">
                    {r.drawn ?? 0}
                  </td>
                )}
                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-400">
                  {r.lost}
                </td>
                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300 whitespace-nowrap">
                  {r.goalsForOrPtsFor}:{r.goalsAgainstOrPtsAgainst}
                </td>
                <td
                  className={`py-3 px-3 text-right font-mono tabular-nums ${
                    r.diff >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {r.diff > 0 ? `+${r.diff}` : r.diff}
                </td>
                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-400 whitespace-nowrap">
                  {r.homeRecord}
                </td>
                <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-400 whitespace-nowrap">
                  {r.awayRecord}
                </td>
                <td className="py-3 px-3 text-right font-mono whitespace-nowrap">
                  {r.form.map((f, idx) => (
                    <span
                      key={idx}
                      className={`inline-block w-4 text-center font-semibold ${
                        f === 'W'
                          ? 'text-emerald-400'
                          : f === 'D'
                          ? 'text-amber-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {f === 'W' ? 'G' : f === 'D' ? 'E' : 'P'}
                    </span>
                  ))}
                </td>
                <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-white">
                  {r.pointsOrWinPct}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
