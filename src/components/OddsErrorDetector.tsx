import React, { useMemo, useState } from 'react';
import { AlertTriangle, Brain, Loader2 } from 'lucide-react';
import type {
  AvailabilityStatus,
  MatchRecord,
  OddsDiscrepancyItem,
  SportType,
} from '../types/sports.ts';
import { evaluateMatchOddsDiscrepancies } from '../engine/oddsEngine.ts';
import type { AiExplanationPayload } from './AiExplanationBox.tsx';

interface OddsErrorDetectorProps {
  matches: MatchRecord[];
  playerOverrides: Record<string, AvailabilityStatus>;
  onOpenMatch: (matchId: string) => void;
}

export const OddsErrorDetector: React.FC<OddsErrorDetectorProps> = ({
  matches,
  playerOverrides,
  onOpenMatch,
}) => {
  const [sportFilter, setSportFilter] = useState<'all' | SportType>('all');
  const [categoryFilter, setCategoryFilter] = useState<
    'all' | 'match' | 'totals' | 'btts' | 'player_prop'
  >('all');
  const [minEdge, setMinEdge] = useState<number>(0);
  const [directionFilter, setDirectionFilter] = useState<'all' | 'positive' | 'negative'>('all');
  const [sortBy, setSortBy] = useState<'abs_edge' | 'edge_desc' | 'quality'>('abs_edge');
  const [explainingId, setExplainingId] = useState<string | null>(null);
  const [explanations, setExplanations] = useState<Record<string, AiExplanationPayload>>({});
  const [aiError, setAiError] = useState<string | null>(null);

  const hasPublishedOddsForSport = useMemo(() => {
    return matches.some(
      (m) => (sportFilter === 'all' || m.sport === sportFilter) && (m.odds?.length ?? 0) > 0
    );
  }, [matches, sportFilter]);

  const allDiscrepancies = useMemo(() => {
    const list: OddsDiscrepancyItem[] = [];
    for (const m of matches) {
      const homeOv = m.homePlayers.map((p) => ({
        ...p,
        availability: playerOverrides[p.id] ?? p.availability,
      }));
      const awayOv = m.awayPlayers.map((p) => ({
        ...p,
        availability: playerOverrides[p.id] ?? p.availability,
      }));
      list.push(...evaluateMatchOddsDiscrepancies(m, homeOv, awayOv));
    }
    return list
      .filter((item) => (sportFilter === 'all' ? true : item.sport === sportFilter))
      .filter((item) =>
        categoryFilter === 'all' ? true : item.marketCategory === categoryFilter
      )
      .filter((item) => {
        if (directionFilter === 'positive') return item.edgePct > 0;
        if (directionFilter === 'negative') return item.edgePct < 0;
        return true;
      })
      .filter((item) => Math.abs(item.edgePct) >= minEdge)
      .sort((a, b) => {
        if (sortBy === 'quality') {
          if (b.dataQualityScore !== a.dataQualityScore) {
            return b.dataQualityScore - a.dataQualityScore;
          }
          return Math.abs(b.edgePct) - Math.abs(a.edgePct);
        }
        if (sortBy === 'edge_desc') {
          return b.edgePct - a.edgePct;
        }
        const diff = Math.abs(b.edgePct) - Math.abs(a.edgePct);
        return Math.abs(diff) > 0.05 ? diff : b.dataQualityScore - a.dataQualityScore;
      });
  }, [matches, playerOverrides, sportFilter, categoryFilter, directionFilter, minEdge, sortBy]);

  const handleExplainItem = async (item: OddsDiscrepancyItem) => {
    setExplainingId(item.id);
    setAiError(null);
    try {
      const res = await fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contextType: 'odds_discrepancy',
          payload: item,
        }),
      });
      const json = (await res.json()) as AiExplanationPayload & { error?: string };
      if (!res.ok) throw new Error(json.error || 'Error analizando discrepancia');
      setExplanations((prev) => ({ ...prev, [item.id]: json }));
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Error consultando IA');
    } finally {
      setExplainingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white">ERRORES DE CUOTA</h2>
          <p className="text-sm text-slate-400 mt-1">
            Comparación matemática entre probabilidades de SportAnalytics AI y probabilidades implícitas ajustadas sin margen de la casa.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0D1526] border border-slate-800">
          {(
            [
              { id: 'all', label: 'Todos' },
              { id: 'football', label: 'Fútbol' },
              { id: 'nba', label: 'NBA' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSportFilter(f.id)}
              className={`min-h-[36px] px-3 py-1 rounded-md text-xs font-medium cursor-pointer ${
                sportFilter === f.id
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
          aria-label="Filtrar por tipo de mercado"
          className="min-h-[42px] px-3 rounded-lg border border-slate-800 bg-[#0D1526] text-xs text-slate-200 cursor-pointer"
        >
          <option value="all">Todos los mercados</option>
          <option value="match">Ganador / 1X2</option>
          <option value="totals">Más / Menos goles</option>
          <option value="btts">Ambos equipos marcan</option>
          <option value="player_prop">Mercados de jugador</option>
        </select>

        <select
          value={directionFilter}
          onChange={(e) => setDirectionFilter(e.target.value as typeof directionFilter)}
          aria-label="Filtrar signo de discrepancia"
          className="min-h-[42px] px-3 rounded-lg border border-slate-800 bg-[#0D1526] text-xs text-slate-200 cursor-pointer"
        >
          <option value="all">Positivas y negativas</option>
          <option value="positive">Solo positivas (&gt; 0%)</option>
          <option value="negative">Solo negativas (&lt; 0%)</option>
        </select>

        <select
          value={minEdge}
          onChange={(e) => setMinEdge(Number(e.target.value))}
          aria-label="Filtrar por magnitud mínima"
          className="min-h-[42px] px-3 rounded-lg border border-slate-800 bg-[#0D1526] text-xs text-slate-200 cursor-pointer"
        >
          <option value={0}>Magnitud |Δ| ≥ 0%</option>
          <option value={2}>Magnitud |Δ| ≥ 2%</option>
          <option value={5}>Magnitud |Δ| ≥ 5%</option>
        </select>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          aria-label="Ordenar discrepancias"
          className="min-h-[42px] px-3 rounded-lg border border-slate-800 bg-[#0D1526] text-xs text-slate-200 cursor-pointer"
        >
          <option value="abs_edge">Orden: Mayor magnitud |Δ|</option>
          <option value="edge_desc">Orden: Mayor diferencia (+)</option>
          <option value="quality">Orden: Calidad de datos</option>
        </select>
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#0D1526] px-4 py-3 text-xs text-slate-300 flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <span>
          Las discrepancias positivas y negativas son comparaciones matemáticas sujetas a incertidumbre y nunca garantizan beneficios ni constituyen recomendaciones para apostar.
        </span>
      </div>

      {aiError && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-200">
          {aiError}
        </div>
      )}

      {allDiscrepancies.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-200">
            {hasPublishedOddsForSport
              ? 'Sin discrepancias que cumplan los filtros actuales'
              : 'No se han podido obtener cuotas reales de mercado para los partidos cargados'}
          </p>
          <p className="text-xs text-slate-400">
            {hasPublishedOddsForSport
              ? 'Ajusta el umbral mínimo, el signo o el tipo de mercado para revisar todas las comparaciones disponibles.'
              : 'Las fuentes activas no han publicado todavía líneas de mercado para estos encuentros, o puedes añadir The Odds API en Configuración de APIs.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {allDiscrepancies.map((item) => {
            const aiExp = explanations[item.id];
            return (
              <article
                key={item.id}
                className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <button
                      type="button"
                      onClick={() => onOpenMatch(item.matchId)}
                      className="text-xs text-blue-400 hover:underline font-medium cursor-pointer text-left"
                    >
                      {item.matchLabel} · {item.competition}
                    </button>
                    <h3 className="text-base font-bold text-white mt-0.5">
                      {item.selectionLabel}
                    </h3>
                    <p className="text-xs text-slate-400">
                      {item.marketLabel}
                      {item.line !== undefined ? ` · Línea ${item.line}` : ''} · {item.bookmaker}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                      Inicio:{' '}
                      {new Date(item.kickoffIso).toLocaleString('es-ES', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · Actualizado:{' '}
                      {new Date(item.updatedAt).toLocaleTimeString('es-ES', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-xs text-slate-400 block">Diferencia</span>
                    <span
                      className={`text-xl font-bold font-mono tabular-nums ${
                        item.edgePct >= 4
                          ? 'text-emerald-400'
                          : item.edgePct > 0
                          ? 'text-blue-400'
                          : item.edgePct <= -4
                          ? 'text-rose-400'
                          : item.edgePct < 0
                          ? 'text-amber-300'
                          : 'text-slate-300'
                      }`}
                    >
                      {item.edgePct >= 0 ? `+${item.edgePct.toFixed(1)}%` : `${item.edgePct.toFixed(1)}%`}
                    </span>
                  </div>
                </div>

                {/* Quantitative Comparison Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-800/80 text-xs">
                  <div>
                    <span className="text-slate-400 block">Cuota disponible</span>
                    <span className="text-base font-bold font-mono tabular-nums text-white">
                      {item.availableOdds.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Prob. modelo</span>
                    <span className="text-base font-bold font-mono tabular-nums text-emerald-400">
                      {(item.modelProbability * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Implícita (sin vig)</span>
                    <span className="text-base font-bold font-mono tabular-nums text-slate-200">
                      {(item.fairImpliedProbability * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Cuota justa est.</span>
                    <span className="text-base font-bold font-mono tabular-nums text-blue-300">
                      {item.modelFairOdds.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-800/80 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400 font-mono tabular-nums">
                    <span>
                      Calidad datos: {item.dataQualityScore}% · Incertidumbre: ±
                      {item.uncertaintyBandPct}%
                    </span>
                    <span>Margen casa: {item.bookmakerMarginPct.toFixed(1)}%</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    <span className="font-semibold text-slate-100">Motivo principal: </span>
                    {item.mainReason}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-[11px] font-mono tabular-nums text-slate-500">
                    EV teórico: {item.expectedValuePct >= 0 ? '+' : ''}
                    {item.expectedValuePct.toFixed(1)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => handleExplainItem(item)}
                    disabled={explainingId === item.id}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                  >
                    {explainingId === item.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Brain className="w-3.5 h-3.5 text-blue-400" />
                    )}
                    Explicar con IA
                  </button>
                </div>

                {aiExp && (
                  <div className="pt-3 border-t border-slate-800 space-y-2 text-xs text-slate-300">
                    <p className="text-slate-200">{aiExp.summary}</p>
                    <p className="text-slate-400">{aiExp.uncertaintyNote}</p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
