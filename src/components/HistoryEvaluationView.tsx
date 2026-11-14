import React, { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Info, Sliders } from 'lucide-react';
import type { LoggedPrediction } from '../types/sports.ts';
import {
  evaluatePredictionHistory,
  MIN_CALIBRATION_SAMPLES,
} from '../engine/calibrationEngine.ts';

interface HistoryEvaluationViewProps {
  predictions: LoggedPrediction[];
  onResolve: (id: string, status: 'won' | 'lost', actualValue?: number) => Promise<void>;
}

export const HistoryEvaluationView: React.FC<HistoryEvaluationViewProps> = ({
  predictions,
  onResolve,
}) => {
  const metrics = useMemo(() => evaluatePredictionHistory(predictions), [predictions]);
  const [actualInputs, setActualInputs] = useState<Record<string, string>>({});

  const handleResolveClick = async (id: string, status: 'won' | 'lost') => {
    const raw = actualInputs[id]?.trim();
    const parsed = raw !== undefined && raw !== '' ? Number(raw) : undefined;
    const validActual = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
    await onResolve(id, status, validActual);
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h2 className="text-xl sm:text-2xl font-bold text-white">
          Historial de predicciones y calibración empírica
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Auditoría objetiva de precisión probabilística (Brier Score, Log Loss, ECE%, MAE, RMSE) y ajuste empírico por deporte.
        </p>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {[
          { label: 'Evaluadas', value: `${metrics.resolvedCount}/${metrics.totalLogged}` },
          { label: '% Aciertos', value: `${metrics.hitRatePct.toFixed(1)}%` },
          { label: 'Brier Score', value: metrics.brierScore.toFixed(3) },
          { label: 'Log Loss', value: metrics.logLoss.toFixed(3) },
          { label: 'ECE %', value: `${metrics.ecePct.toFixed(1)}%` },
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

      {/* Empirical Calibration Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(
          [
            { title: 'Calibración Modelo Fútbol', profile: metrics.calibrationProfiles.football },
            { title: 'Calibración Modelo NBA', profile: metrics.calibrationProfiles.nba },
          ] as const
        ).map(({ title, profile }) => (
          <div
            key={title}
            className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 space-y-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-white">
                <Sliders className="w-4 h-4 text-blue-400" />
                <span>{title}</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                  profile.active
                    ? 'border-emerald-500/35 bg-emerald-950/30 text-emerald-300'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                {profile.active
                  ? `Activa (${profile.sampleCount} muestras)`
                  : `Inactiva (${profile.sampleCount}/${profile.minSamplesRequired ?? MIN_CALIBRATION_SAMPLES} muestras)`}
              </span>
            </div>
            <p className="text-slate-300 leading-relaxed">{profile.summary}</p>
            {profile.sampleCount > 0 && (
              <div className="flex flex-wrap gap-4 text-[11px] font-mono tabular-nums text-slate-400 pt-1">
                <span>τ = {profile.temperature.toFixed(2)}</span>
                <span>Sesgo = {profile.bias >= 0 ? `+${profile.bias.toFixed(2)}` : profile.bias.toFixed(2)}</span>
                <span>Brier: {profile.rawBrier.toFixed(3)} → {profile.calibratedBrier.toFixed(3)}</span>
                <span>ECE: {profile.eceBeforePct.toFixed(1)}% → {profile.eceAfterPct.toFixed(1)}%</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#0D1526] px-4 py-3 text-xs text-slate-300 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <span>
          Transparencia metodológica: al alcanzar al menos {MIN_CALIBRATION_SAMPLES} predicciones reales resueltas por deporte (excluyendo ejemplos ilustrativos), el motor valida mediante validación cruzada fuera de muestra si la temperatura logística (τ) y el sesgo reducen el error real sin sobreajuste antes de activarlos.
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
        {predictions.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            Aún no has guardado ninguna predicción. Abre un partido y pulsa «Registrar predicción» para iniciar la auditoría empírica.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {predictions.map((p) => (
              <div
                key={p.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 font-semibold text-slate-100">
                    <span>
                      {p.matchLabel} · {p.selection}
                    </span>
                    {p.isReferenceExample && (
                      <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] font-normal text-slate-400">
                        Ejemplo inicial (excluido de calibración)
                      </span>
                    )}
                  </div>
                  <div className="text-slate-400 font-mono tabular-nums">
                    {p.sport === 'football' ? 'Fútbol' : 'NBA'} · {p.market} ·{' '}
                    {new Date(p.createdAt).toLocaleDateString('es-ES')}
                    {p.predictedValue !== undefined ? ` · Valor esp. ${p.predictedValue}` : ''}
                    {p.actualValue !== undefined ? ` · Real ${p.actualValue}` : ''}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="font-mono tabular-nums text-right">
                    <span className="text-slate-400 block text-[11px]">
                      Probabilidad{p.rawPredictedProb !== undefined ? ' (bruta → cal.)' : ''}
                    </span>
                    <span className="text-sm font-bold text-blue-300">
                      {p.rawPredictedProb !== undefined &&
                      Math.abs(p.rawPredictedProb - p.predictedProb) > 0.005
                        ? `${(p.rawPredictedProb * 100).toFixed(1)}% → ${(p.predictedProb * 100).toFixed(1)}%`
                        : `${(p.predictedProb * 100).toFixed(1)}%`}
                    </span>
                  </div>

                  {p.status === 'pending' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="number"
                        step="0.1"
                        placeholder="Valor real"
                        value={actualInputs[p.id] ?? ''}
                        onChange={(e) =>
                          setActualInputs((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        aria-label={`Valor real observado para ${p.matchLabel}`}
                        className="w-24 min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-950 text-xs font-mono text-white placeholder:text-slate-500"
                      />
                      <button
                        type="button"
                        onClick={() => void handleResolveClick(p.id, 'won')}
                        className="min-h-[36px] px-3 py-1 rounded-lg border border-emerald-500/40 bg-emerald-950/30 hover:bg-emerald-900/40 text-emerald-300 font-medium cursor-pointer"
                      >
                        Acertada
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveClick(p.id, 'lost')}
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
        )}
      </section>
    </div>
  );
};
