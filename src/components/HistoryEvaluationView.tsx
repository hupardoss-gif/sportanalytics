import React, { useMemo } from 'react';
import { CheckCircle2, XCircle, Info } from 'lucide-react';
import type { LoggedPrediction } from '../types/sports.ts';
import { evaluatePredictionHistory } from '../engine/oddsEngine.ts';

interface HistoryEvaluationViewProps {
  predictions: LoggedPrediction[];
  onResolve: (id: string, status: 'won' | 'lost') => Promise<void>;
}

export const HistoryEvaluationView: React.FC<HistoryEvaluationViewProps> = ({
  predictions,
  onResolve,
}) => {
  const metrics = useMemo(() => evaluatePredictionHistory(predictions), [predictions]);

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h2 className="text-xl sm:text-2xl font-bold text-white">
          Historial de predicciones y calibración
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Auditoría objetiva de precisión probabilística (Brier Score, Log Loss, MAE, RMSE y curva de calibración).
        </p>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Evaluadas', value: `${metrics.resolvedCount}/${metrics.totalLogged}` },
          { label: '% Aciertos', value: `${metrics.hitRatePct.toFixed(1)}%` },
          { label: 'Brier Score', value: metrics.brierScore.toFixed(3) },
          { label: 'Log Loss', value: metrics.logLoss.toFixed(3) },
          { label: 'MAE', value: metrics.mae.toFixed(3) },
          { label: 'RMSE', value: metrics.rmse.toFixed(3) },
        ].map((m) => (
          <div
            key={m.label}
            className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 space-y-1"
          >
            <span className="text-xs text-slate-400 block">{m.label}</span>
            <span className="text-xl font-bold font-mono tabular-nums text-white">
              {m.value}
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#0D1526] px-4 py-3 text-xs text-slate-300 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <span>
          Transparencia metodológica: este módulo evalúa estadísticamente las predicciones guardadas frente a sus resultados reales. Los modelos matemáticos utilizan parámetros calibrados explícitos y no ejecutan autoentrenamiento automático sin un pipeline externo.
        </span>
      </div>

      {/* Calibration Chart */}
      {metrics.calibrationBins.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-white">
              Calibración por rango de probabilidad
            </h3>
            <span className="text-xs text-slate-400">
              Barra azul: prob. predicha media · Barra verde: frecuencia real observada
            </span>
          </div>

          <div className="space-y-3">
            {metrics.calibrationBins.map((bin) => (
              <div key={bin.bucketLabel} className="space-y-1.5 text-xs">
                <div className="flex justify-between font-mono tabular-nums">
                  <span className="text-slate-300">
                    Rango {bin.bucketLabel} ({bin.count} muestras)
                  </span>
                  <span className="text-slate-200">
                    Esperado {bin.avgPredictedPct.toFixed(0)}% vs Real {bin.observedHitPct.toFixed(0)}%
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      style={{ width: `${bin.avgPredictedPct}%` }}
                      className="h-full bg-blue-500"
                    />
                  </div>
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      style={{ width: `${bin.observedHitPct}%` }}
                      className="h-full bg-emerald-500"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Logged Predictions List */}
      <section className="rounded-xl border border-slate-800 bg-[#0D1526] overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800">
          <h3 className="text-base font-semibold text-white">Registro de predicciones</h3>
        </div>
        <div className="divide-y divide-slate-800/80">
          {predictions.map((p) => (
            <div
              key={p.id}
              className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
            >
              <div className="space-y-1">
                <div className="font-semibold text-slate-100">
                  {p.matchLabel} · {p.selection}
                </div>
                <div className="text-slate-400 font-mono tabular-nums">
                  {p.sport === 'football' ? 'Fútbol' : 'NBA'} · {p.market} ·{' '}
                  {new Date(p.createdAt).toLocaleDateString('es-ES')}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div className="font-mono tabular-nums text-right">
                  <span className="text-slate-400 block text-[11px]">Probabilidad</span>
                  <span className="text-sm font-bold text-blue-300">
                    {(p.predictedProb * 100).toFixed(1)}%
                  </span>
                </div>

                {p.status === 'pending' ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onResolve(p.id, 'won')}
                      className="min-h-[36px] px-3 py-1 rounded-lg border border-emerald-500/40 bg-emerald-950/30 hover:bg-emerald-900/40 text-emerald-300 font-medium cursor-pointer"
                    >
                      Acertada
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolve(p.id, 'lost')}
                      className="min-h-[36px] px-3 py-1 rounded-lg border border-rose-500/40 bg-rose-950/30 hover:bg-rose-900/40 text-rose-300 font-medium cursor-pointer"
                    >
                      Fallada
                    </button>
                  </div>
                ) : (
                  <div
                    className={`flex items-center gap-1.5 font-semibold ${
                      p.status === 'won' ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {p.status === 'won' ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <XCircle className="w-4 h-4" />
                    )}
                    <span>{p.status === 'won' ? 'Acertada' : 'Fallada'}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
