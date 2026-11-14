import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  GitCompare,
  Info,
  Loader2,
  Percent,
  RefreshCw,
  Scale,
} from 'lucide-react';
import type {
  FootballPredictionResult,
  MatchOddsResponse,
  MatchRecord,
  NbaPredictionResult,
  OddsMarketKind,
  OddsMarketSnapshot,
  OddsSourceSnapshot,
} from '../types/sports.ts';
import {
  analyzeMarketOutcomes,
  compareProbabilities,
  describeModelBasis,
  detectSourceDiscrepancies,
  formatOdds,
  formatPct,
  formatSignedPct,
  formatSignedPp,
  modelProbabilitiesForMarket,
  SOURCE_DISCREPANCY_THRESHOLD_PP,
  type ModelOddsContext,
} from '../engine/oddsMath.ts';

interface OddsProbabilityPanelProps {
  match: MatchRecord;
  footballPred: FootballPredictionResult | null;
  nbaPred: NbaPredictionResult | null;
}

interface MarketGroup {
  id: string;
  kind: OddsMarketKind;
  label: string;
  line?: number;
  entries: Array<{ source: OddsSourceSnapshot; market: OddsMarketSnapshot }>;
}

const FOOTBALL_KINDS: Array<{ kind: OddsMarketKind; label: string }> = [
  { kind: 'match_winner_3way', label: 'Resultado final (1X2)' },
  { kind: 'totals', label: 'Total de goles (más / menos)' },
  { kind: 'btts', label: 'Ambos equipos marcan' },
];

const NBA_KINDS: Array<{ kind: OddsMarketKind; label: string }> = [
  { kind: 'moneyline_2way', label: 'Ganador del partido (moneyline)' },
  { kind: 'spread', label: 'Hándicap' },
  { kind: 'totals', label: 'Total de puntos (más / menos)' },
];

const KIND_ORDER: OddsMarketKind[] = ['match_winner_3way', 'moneyline_2way', 'spread', 'totals', 'btts'];

/** Diferencia (pp) a partir de la cual se marca visualmente que el modelo se aparta de la referencia. */
const DIFF_HIGHLIGHT_PP = 3;

function Unavailable() {
  return <span className="text-slate-500">No disponible</span>;
}

function ProbBar({ referencePct, modelPct }: { referencePct: number | null; modelPct: number | null }) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return (
    <div className="w-28 space-y-1" aria-hidden="true">
      <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
        {referencePct !== null && (
          <div className="h-full bg-slate-400" style={{ width: `${clamp(referencePct)}%` }} />
        )}
      </div>
      <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
        {modelPct !== null && <div className="h-full bg-blue-500" style={{ width: `${clamp(modelPct)}%` }} />}
      </div>
    </div>
  );
}

function DiffBadge({ diffPp }: { diffPp: number | null }) {
  if (diffPp === null) return <Unavailable />;
  const cls =
    diffPp >= DIFF_HIGHLIGHT_PP
      ? 'border-sky-500/40 bg-sky-950/30 text-sky-300'
      : diffPp <= -DIFF_HIGHLIGHT_PP
        ? 'border-amber-500/40 bg-amber-950/30 text-amber-300'
        : 'border-slate-700 bg-slate-900/60 text-slate-300';
  const text =
    diffPp >= DIFF_HIGHLIGHT_PP ? 'Modelo por encima' : diffPp <= -DIFF_HIGHLIGHT_PP ? 'Modelo por debajo' : 'En línea';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold whitespace-nowrap ${cls}`}>
      {text}
    </span>
  );
}

function MarginBadge({ marginPct }: { marginPct: number | null }) {
  if (marginPct === null) return <Unavailable />;
  const cls =
    marginPct < 4
      ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-300'
      : marginPct <= 8
        ? 'border-amber-500/35 bg-amber-950/25 text-amber-300'
        : 'border-rose-500/35 bg-rose-950/25 text-rose-300';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-bold ${cls}`}>
      {formatPct(marginPct, 2)}
    </span>
  );
}

function SourceStatusBadge({ status }: { status: OddsSourceSnapshot['status'] }) {
  const map: Record<OddsSourceSnapshot['status'], { label: string; cls: string }> = {
    ok: { label: 'Con cuotas', cls: 'border-emerald-500/35 bg-emerald-950/25 text-emerald-300' },
    no_odds: { label: 'Sin cuotas', cls: 'border-slate-600 bg-slate-900/60 text-slate-300' },
    unavailable: { label: 'No disponible', cls: 'border-slate-600 bg-slate-900/60 text-slate-300' },
    error: { label: 'Error', cls: 'border-rose-500/35 bg-rose-950/25 text-rose-300' },
  };
  const m = map[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

function groupMarkets(sources: OddsSourceSnapshot[]): MarketGroup[] {
  const map = new Map<string, MarketGroup>();
  for (const source of sources) {
    for (const market of source.markets) {
      const existing = map.get(market.id);
      if (existing) {
        existing.entries.push({ source, market });
      } else {
        map.set(market.id, {
          id: market.id,
          kind: market.kind,
          label: market.label,
          line: market.line,
          entries: [{ source, market }],
        });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

export const OddsProbabilityPanel: React.FC<OddsProbabilityPanelProps> = ({ match, footballPred, nbaPred }) => {
  const [data, setData] = useState<MatchOddsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHow, setShowHow] = useState(false);

  // Solo se envía lo necesario para identificar el partido (evita transferir plantillas completas).
  // Se memoriza por valores primitivos para no volver a consultar cuando cambian referencias de objetos.
  const sourceIdsKey = JSON.stringify(match.sourceIds ?? {});
  const slim = useMemo(
    () => ({
      id: match.id,
      sport: match.sport,
      kickoffIso: match.kickoffIso,
      isOfflineReference: match.isOfflineReference,
      sourceIds: JSON.parse(sourceIdsKey) as Record<string, string>,
      homeTeam: { id: match.homeTeam.id, name: match.homeTeam.name, shortName: match.homeTeam.shortName },
      awayTeam: { id: match.awayTeam.id, name: match.awayTeam.name, shortName: match.awayTeam.shortName },
    }),
    [
      match.id,
      match.sport,
      match.kickoffIso,
      match.isOfflineReference,
      sourceIdsKey,
      match.homeTeam.id,
      match.homeTeam.name,
      match.homeTeam.shortName,
      match.awayTeam.id,
      match.awayTeam.name,
      match.awayTeam.shortName,
    ]
  );

  const load = useCallback(
    async (refresh: boolean, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/odds/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ match: slim, refresh }),
          signal,
        });
        const json = (await res.json()) as MatchOddsResponse & { error?: string };
        if (!res.ok) throw new Error(json.error ?? `Error HTTP ${res.status}`);
        setData(json);
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        setData(null);
        setError(err instanceof Error ? err.message : 'No se pudieron cargar las cuotas de referencia.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [slim]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  const ctx: ModelOddsContext = useMemo(
    () => ({ sport: match.sport, football: footballPred, nba: nbaPred }),
    [match.sport, footballPred, nbaPred]
  );

  const sources = data?.sources ?? [];
  const groups = useMemo(() => groupMarkets(sources), [sources]);
  const discrepancies = useMemo(() => detectSourceDiscrepancies(sources), [sources]);
  const sourcesWithOdds = sources.filter((s) => s.markets.length > 0);

  const expectedKinds = match.sport === 'football' ? FOOTBALL_KINDS : NBA_KINDS;
  const missingKinds = expectedKinds.filter((k) => !groups.some((g) => g.kind === k.kind));

  const basis = useMemo(
    () =>
      describeModelBasis(
        {
          homeName: match.homeTeam.shortName || match.homeTeam.name,
          awayName: match.awayTeam.shortName || match.awayTeam.name,
          homePlayedGames: match.homeTeam.playedGames,
          awayPlayedGames: match.awayTeam.playedGames,
          homeRecentGames: match.homeTeam.recentGames?.length,
          awayRecentGames: match.awayTeam.recentGames?.length,
          h2hPlayed: match.h2hSummary.played,
        },
        ctx
      ),
    [match, ctx]
  );

  // Estimaciones del modelo que se muestran siempre, con o sin cuotas de referencia.
  const modelRows = useMemo(() => {
    const homeName = match.homeTeam.shortName || match.homeTeam.name;
    const awayName = match.awayTeam.shortName || match.awayTeam.name;
    const rows: Array<{ market: string; outcome: string; pct: number | null; note?: string }> = [];
    const push = (
      market: string,
      kind: OddsMarketKind,
      line: number | undefined,
      outcomes: Array<{ key: 'home' | 'draw' | 'away' | 'over' | 'under' | 'yes' | 'no'; label: string }>
    ) => {
      const r = modelProbabilitiesForMarket({ kind, line }, ctx);
      for (const o of outcomes) {
        rows.push({ market, outcome: o.label, pct: r.available ? (r.probabilitiesPct[o.key] ?? null) : null, note: r.note });
      }
    };
    if (match.sport === 'football') {
      push('Resultado final (1X2)', 'match_winner_3way', undefined, [
        { key: 'home', label: `Gana ${homeName}` },
        { key: 'draw', label: 'Empate' },
        { key: 'away', label: `Gana ${awayName}` },
      ]);
      for (const line of [1.5, 2.5, 3.5]) {
        push(`Total de goles (línea ${line})`, 'totals', line, [
          { key: 'over', label: `Más de ${line}` },
          { key: 'under', label: `Menos de ${line}` },
        ]);
      }
      push('Ambos equipos marcan', 'btts', undefined, [
        { key: 'yes', label: 'Sí' },
        { key: 'no', label: 'No' },
      ]);
    } else {
      push('Ganador del partido (moneyline)', 'moneyline_2way', undefined, [
        { key: 'home', label: `Gana ${homeName}` },
        { key: 'away', label: `Gana ${awayName}` },
      ]);
    }
    return rows;
  }, [ctx, match]);

  const modelUnavailable = (match.sport === 'football' && !footballPred) || (match.sport === 'nba' && !nbaPred);

  return (
    <div className="space-y-6">
      {/* Aviso y cabecera */}
      <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <h3 className="text-base font-semibold text-white flex items-center gap-2">
              <Percent className="w-4 h-4 text-blue-400" />
              Cuotas de referencia y probabilidades
            </h3>
            <p className="text-xs text-slate-400 max-w-3xl">
              Apartado con finalidad estadística e informativa. Las cuotas son datos de referencia publicados por terceros
              y se muestran con su fuente; no son recomendaciones ni garantizan ningún resultado.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowHow((v) => !v)}
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900/60 text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 cursor-pointer"
            >
              <Calculator className="w-3.5 h-3.5" />
              {showHow ? 'Ocultar cálculos' : 'Cómo se calcula'}
            </button>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="min-h-[38px] px-3 py-1.5 rounded-lg bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60 flex items-center gap-1.5 cursor-pointer"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Actualizar cuotas
            </button>
          </div>
        </div>

        {data && (
          <p className="text-[11px] text-slate-500">
            Consultado el{' '}
            {new Date(data.fetchedAt).toLocaleString('es-ES', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
            . Las cuotas pueden cambiar en cualquier momento.
          </p>
        )}

        {showHow && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-xs text-slate-300 space-y-2">
            <p>
              <strong className="text-white">Probabilidad implícita</strong> = 1 ÷ cuota decimal × 100. Con cuota 2,50 →
              1 ÷ 2,50 × 100 = 40 %.
            </p>
            <p>
              <strong className="text-white">Margen de la casa</strong> = suma de las probabilidades implícitas de todos los
              resultados del mercado − 100 %. Si suman 104 %, el margen es 4 %.
            </p>
            <p>
              <strong className="text-white">Probabilidad sin margen</strong> = probabilidad implícita ÷ suma de implícitas × 100.
              Así los resultados del mercado suman exactamente 100 %.
            </p>
            <p>
              <strong className="text-white">Modelo propio</strong>: probabilidades estimadas por SportAnalytics AI con los datos
              del partido (no son datos reales de mercado).
            </p>
            <p>
              <strong className="text-white">Comparación</strong>: diferencia en puntos porcentuales (pp) = modelo − referencia, y
              diferencia relativa = (modelo − referencia) ÷ referencia × 100. La referencia usada es la probabilidad
              sin margen, para que el margen de la casa no distorsione la diferencia.
            </p>
            <p className="text-slate-400">
              Solo se comparan resultados del mismo mercado y de la misma línea. Si falta alguna cuota de un mercado, no se
              calcula margen ni probabilidad sin margen y se indica «No disponible».
            </p>
          </div>
        )}
      </section>

      {loading && !data && (
        <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 text-sm text-slate-300 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
          Consultando cuotas de referencia en las fuentes activas…
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-500/35 bg-rose-950/25 px-3.5 py-2.5 text-xs text-rose-200 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Estado por fuente */}
      {data && (
        <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-3">
          <h4 className="text-sm font-semibold text-white">Fuentes consultadas</h4>
          {sources.length === 0 ? (
            <p className="text-xs text-slate-400">
              No hay fuentes de cuotas aplicables a este partido. <Unavailable />
            </p>
          ) : (
            <ul className="space-y-2">
              {sources.map((s) => (
                <li
                  key={s.sourceId}
                  className="rounded-lg border border-slate-800 bg-slate-950/40 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-100">{s.sourceLabel}</p>
                    <p className="text-[11px] text-slate-400">
                      {s.status === 'ok'
                        ? `${s.markets.length} mercado${s.markets.length === 1 ? '' : 's'} con cuotas`
                        : (s.message ?? 'Sin datos')}
                    </p>
                  </div>
                  <SourceStatusBadge status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Mercados con cuotas */}
      {groups.map((group) => {
        const model = modelProbabilitiesForMarket({ kind: group.kind, line: group.line }, ctx);
        return (
          <section key={group.id} className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                <Scale className="w-4 h-4 text-blue-400" />
                {group.label}
              </h4>
              <span className="text-[11px] text-slate-500">
                {group.entries.length} fuente{group.entries.length === 1 ? '' : 's'}
              </span>
            </div>

            {group.entries.map(({ source, market }) => {
              const analysis = analyzeMarketOutcomes(market.outcomes);
              return (
                <div key={source.sourceId} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-200">Fuente: {source.sourceLabel}</p>
                    <p className="text-[11px] text-slate-400 flex items-center gap-2">
                      Margen de la casa <MarginBadge marginPct={analysis.marginPct} />
                      <span className="text-slate-500">
                        · Suma implícitas{' '}
                        {analysis.sumImpliedPct === null ? 'No disponible' : formatPct(analysis.sumImpliedPct, 2)}
                      </span>
                    </p>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-slate-800">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-slate-950/60 text-slate-400">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Resultado</th>
                          <th className="px-3 py-2 font-semibold">Cuota</th>
                          <th className="px-3 py-2 font-semibold">Prob. implícita</th>
                          <th className="px-3 py-2 font-semibold">Prob. sin margen</th>
                          <th className="px-3 py-2 font-semibold">Modelo propio</th>
                          <th className="px-3 py-2 font-semibold">Dif. (pp)</th>
                          <th className="px-3 py-2 font-semibold">Dif. relativa</th>
                          <th className="px-3 py-2 font-semibold">Lectura</th>
                          <th className="px-3 py-2 font-semibold">Gráfico</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 text-slate-200">
                        {analysis.outcomes.map((o) => {
                          const modelPct = model.available ? (model.probabilitiesPct[o.key] ?? null) : null;
                          const diff =
                            modelPct !== null && o.fairPct !== null ? compareProbabilities(modelPct, o.fairPct) : null;
                          return (
                            <tr key={o.key}>
                              <td className="px-3 py-2 font-medium">{o.label}</td>
                              <td className="px-3 py-2 tabular-nums">
                                {o.decimalOdds === null ? <Unavailable /> : formatOdds(o.decimalOdds)}
                              </td>
                              <td className="px-3 py-2 tabular-nums">
                                {o.impliedPct === null ? <Unavailable /> : formatPct(o.impliedPct)}
                              </td>
                              <td className="px-3 py-2 tabular-nums">
                                {o.fairPct === null ? <Unavailable /> : formatPct(o.fairPct)}
                              </td>
                              <td className="px-3 py-2 tabular-nums">
                                {modelPct === null ? <Unavailable /> : formatPct(modelPct)}
                              </td>
                              <td className="px-3 py-2 tabular-nums">
                                {diff === null ? <Unavailable /> : formatSignedPp(diff.diffPp)}
                              </td>
                              <td className="px-3 py-2 tabular-nums">
                                {diff === null || diff.relativePct === null ? (
                                  <Unavailable />
                                ) : (
                                  formatSignedPct(diff.relativePct)
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <DiffBadge diffPp={diff ? diff.diffPp : null} />
                              </td>
                              <td className="px-3 py-2">
                                <ProbBar referencePct={o.fairPct ?? o.impliedPct} modelPct={modelPct} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {analysis.warnings.map((w) => (
                    <p key={w} className="text-[11px] text-amber-300 flex items-start gap-1.5">
                      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                      {w}
                    </p>
                  ))}
                </div>
              );
            })}

            <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
              <Info className="w-3 h-3 mt-0.5 shrink-0" />
              {model.available
                ? `Modelo: ${model.note ?? 'estimación propia de SportAnalytics AI.'}`
                : `Modelo propio: No disponible. ${model.note ?? ''}`}
              <span className="ml-1">
                Barra gris = referencia sin margen · barra azul = modelo. Diferencia marcada a partir de ±{DIFF_HIGHLIGHT_PP} pp.
              </span>
            </p>
          </section>
        );
      })}

      {/* Mercados esperados sin ninguna cuota */}
      {data && missingKinds.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-2">
          <h4 className="text-sm font-semibold text-white">Mercados sin cuotas en las fuentes activas</h4>
          <ul className="space-y-1.5">
            {missingKinds.map((k) => (
              <li key={k.kind} className="text-xs text-slate-300 flex items-center justify-between gap-2">
                <span>{k.label}</span>
                <Unavailable />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Comparación entre fuentes */}
      {data && (
        <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-3">
          <h4 className="text-sm font-semibold text-white flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-blue-400" />
            Comparación entre fuentes
          </h4>
          {sourcesWithOdds.length < 2 ? (
            <p className="text-xs text-slate-400">
              {sourcesWithOdds.length === 0
                ? 'Ninguna fuente publica cuotas para este partido, no hay nada que contrastar.'
                : 'Solo una fuente publica cuotas para este partido, por lo que no hay contraste posible.'}
            </p>
          ) : discrepancies.length === 0 ? (
            <p className="text-xs text-emerald-300">
              Sin discrepancias relevantes: en los mercados con la misma línea, las probabilidades sin margen de las fuentes
              difieren menos de {SOURCE_DISCREPANCY_THRESHOLD_PP} pp.
            </p>
          ) : (
            <ul className="space-y-2">
              {discrepancies.map((d) => (
                <li
                  key={`${d.marketId}-${d.outcomeKey}`}
                  className="rounded-lg border border-amber-500/35 bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-100 space-y-1"
                >
                  <p className="font-semibold">
                    {d.marketLabel} · {d.outcomeLabel}: diferencia de {d.spreadPp.toFixed(1)} pp entre fuentes
                  </p>
                  <p className="text-amber-200/80">
                    {d.bySource.map((s) => `${s.sourceLabel}: ${formatPct(s.fairPct)}`).join(' · ')} (probabilidad sin margen)
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Modelo propio y datos que lo sustentan */}
      <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
        <h4 className="text-sm font-semibold text-white">Estimación del modelo de SportAnalytics AI</h4>
        {modelUnavailable ? (
          <p className="text-xs text-slate-400">
            El modelo no pudo calcularse para este partido. <Unavailable />
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950/60 text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Mercado</th>
                    <th className="px-3 py-2 font-semibold">Resultado</th>
                    <th className="px-3 py-2 font-semibold">Probabilidad del modelo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200">
                  {modelRows.map((r) => (
                    <tr key={`${r.market}-${r.outcome}`}>
                      <td className="px-3 py-2">{r.market}</td>
                      <td className="px-3 py-2">{r.outcome}</td>
                      <td className="px-3 py-2 tabular-nums">{r.pct === null ? <Unavailable /> : formatPct(r.pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-200">Datos que sustentan la estimación</p>
              <ul className="space-y-1 list-disc pl-5 text-xs text-slate-300">
                {basis.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </>
        )}
        <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          Las probabilidades del modelo son estimaciones estadísticas, no datos reales de mercado, y pueden diferir de las
          cuotas de referencia por información que el modelo no conoce.
        </p>
      </section>
    </div>
  );
};
