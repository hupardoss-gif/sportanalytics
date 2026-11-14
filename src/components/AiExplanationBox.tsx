import React from 'react';
import { Brain, AlertTriangle, CheckCircle2, MinusCircle, Loader2 } from 'lucide-react';

export interface AiExplanationPayload {
  summary: string;
  favorableFactors: string[];
  unfavorableFactors: string[];
  absenceImpact: string;
  uncertaintyNote: string;
}

interface AiExplanationBoxProps {
  title: string;
  loading: boolean;
  error: string | null;
  explanation: AiExplanationPayload | null;
  onTrigger: () => void;
  buttonLabel?: string;
}

export const AiExplanationBox: React.FC<AiExplanationBoxProps> = ({
  title,
  loading,
  error,
  explanation,
  onTrigger,
  buttonLabel = 'Explicar con IA',
}) => {
  return (
    <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600/15 border border-blue-500/30 flex items-center justify-center text-blue-400">
            <Brain className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
            <p className="text-xs text-slate-400">
              Análisis explicativo basado únicamente en los datos del modelo cuantitativo
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onTrigger}
          disabled={loading}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer"
        >
          {loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Analizando modelo...
            </>
          ) : (
            buttonLabel
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {explanation && !loading && (
        <div className="space-y-4 pt-2 border-t border-slate-800/80">
          <p className="text-sm leading-relaxed text-slate-200">{explanation.summary}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Factores favorables</span>
              </div>
              <ul className="space-y-1.5 text-xs text-slate-300 leading-relaxed">
                {explanation.favorableFactors.map((item, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-emerald-400 mt-0.5">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                <MinusCircle className="w-3.5 h-3.5" />
                <span>Factores desfavorables y riesgos</span>
              </div>
              <ul className="space-y-1.5 text-xs text-slate-300 leading-relaxed">
                {explanation.unfavorableFactors.map((item, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-amber-400 mt-0.5">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800/60 text-xs">
            <div>
              <span className="font-semibold text-slate-300 block mb-1">
                Impacto de bajas y rotaciones
              </span>
              <p className="text-slate-400 leading-relaxed">{explanation.absenceImpact}</p>
            </div>
            <div>
              <span className="font-semibold text-slate-300 block mb-1">
                Incertidumbre y fiabilidad
              </span>
              <p className="text-slate-400 leading-relaxed">{explanation.uncertaintyNote}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
