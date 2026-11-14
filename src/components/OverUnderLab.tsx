import React, { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, SlidersHorizontal } from 'lucide-react';
import type {
  FootballPropStat,
  MatchRecord,
  NbaPropStat,
  PlayerProfile,
  PropStatKey,
  TimeframeSplit,
} from '../types/sports.ts';
import {
  computeFootballPlayerProp,
  FOOTBALL_STAT_CONFIG,
} from '../engine/footballModel.ts';
import { computeNbaPlayerProp, NBA_STAT_CONFIG } from '../engine/nbaModel.ts';

interface OverUnderLabProps {
  player: PlayerProfile;
  match: MatchRecord;
  timeframe: TimeframeSplit;
  teammatesOverride?: PlayerProfile[];
  initialStat?: PropStatKey;
  initialLine?: number;
}

const FOOTBALL_STATS: FootballPropStat[] = [
  'shots',
  'shotsOnTarget',
  'goals',
  'assists',
  'foulsCommitted',
  'foulsDrawn',
  'yellowCards',
  'redCards',
  'passes',
];

const NBA_STATS: NbaPropStat[] = [
  'points',
  'rebounds',
  'assists',
  'threes',
  'pra',
  'steals',
  'blocks',
  'turnovers',
];

export const OverUnderLab: React.FC<OverUnderLabProps> = ({
  player,
  match,
  timeframe,
  teammatesOverride,
  initialStat,
  initialLine,
}) => {
  const availableStats: PropStatKey[] =
    player.sport === 'football' ? FOOTBALL_STATS : NBA_STATS;

  const [statKey, setStatKey] = useState<PropStatKey>(
    initialStat && availableStats.includes(initialStat)
      ? initialStat
      : player.sport === 'football'
      ? 'shots'
      : 'points'
  );

  // Baseline projection to get default recommended line when stat or player changes
  const defaultProjection = useMemo(() => {
    if (player.sport === 'football') {
      return computeFootballPlayerProp(
        player,
        match,
        statKey as FootballPropStat,
        undefined,
        timeframe,
        teammatesOverride
      );
    }
    return computeNbaPlayerProp(
      player,
      match,
      statKey as NbaPropStat,
      undefined,
      timeframe,
      teammatesOverride
    );
  }, [player, match, statKey, timeframe, teammatesOverride]);

  const [customLine, setCustomLine] = useState<number>(
    initialLine ?? defaultProjection.line
  );

  useEffect(() => {
    setCustomLine(initialLine ?? defaultProjection.line);
  }, [player.id, statKey, initialLine, defaultProjection.line]);

  const projection = useMemo(() => {
    if (player.sport === 'football') {
      return computeFootballPlayerProp(
        player,
        match,
        statKey as FootballPropStat,
        customLine,
        timeframe,
        teammatesOverride
      );
    }
    return computeNbaPlayerProp(
      player,
      match,
      statKey as NbaPropStat,
      customLine,
      timeframe,
      teammatesOverride
    );
  }, [player, match, statKey, customLine, timeframe, teammatesOverride]);

  const maxProbBin = useMemo(
    () => Math.max(0.05, ...projection.distribution.map((d) => d.probability)),
    [projection.distribution]
  );

  const stepDown = () => {
    setCustomLine((prev) =>
      Math.max(projection.minLine, +(prev - projection.step).toFixed(1))
    );
  };
  const stepUp = () => {
    setCustomLine((prev) =>
      Math.min(projection.maxLine, +(prev + projection.step).toFixed(1))
    );
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 sm:p-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-blue-400" />
          <h4 className="text-sm font-semibold text-slate-100">
            Simulador Over / Under personalizado
          </h4>
        </div>
        <div className="text-xs text-slate-400 font-mono tabular-nums">
          Min. esperados: {projection.expectedMinutes.toFixed(0)}&apos;
          {projection.absenceAdjustmentPct > 0.5 && (
            <span className="text-blue-400">
              {' '}
              · +{projection.absenceAdjustmentPct.toFixed(1)}% por bajas
            </span>
          )}
        </div>
      </div>

      {/* Stat Selector Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {availableStats.map((key) => {
          const label =
            player.sport === 'football'
              ? FOOTBALL_STAT_CONFIG[key as FootballPropStat].label
              : NBA_STAT_CONFIG[key as NbaPropStat].label;
          const active = key === statKey;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setStatKey(key)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-900/90 text-slate-300 border border-slate-800 hover:border-slate-700 hover:text-white'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Horizontal Slider + Stepper Controls */}
      <div className="space-y-3 pt-1">
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-xs text-slate-400 block">Línea seleccionada</span>
            <span className="text-2xl font-bold font-mono tabular-nums text-white">
              {projection.line.toFixed(1)}{' '}
              <span className="text-sm font-normal text-slate-400">
                {projection.statLabel.toLowerCase()}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={stepDown}
              aria-label="Reducir línea"
              className="w-11 h-11 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
            >
              <Minus className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={stepUp}
              aria-label="Aumentar línea"
              className="w-11 h-11 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div>
          <input
            type="range"
            min={projection.minLine}
            max={projection.maxLine}
            step={projection.step}
            value={projection.line}
            onChange={(e) => setCustomLine(parseFloat(e.target.value))}
            aria-label={`Deslizador Over/Under para ${projection.statLabel}`}
            className="analytics-slider"
          />
          <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-500 -mt-1">
            <span>{projection.minLine.toFixed(1)}</span>
            <span>Media modelo: {projection.expectedValue.toFixed(2)}</span>
            <span>{projection.maxLine.toFixed(1)}</span>
          </div>
        </div>
      </div>

      {/* Complementary Over / Under Probability Bar (Always Sums to 100.0%) */}
      <div className="space-y-2">
        <div className="flex items-end justify-between text-xs">
          <div>
            <span className="text-emerald-400 font-semibold block">
              Supera la línea (Más de {projection.line.toFixed(1)})
            </span>
            <span className="text-xl font-bold font-mono tabular-nums text-white">
              {projection.probOver.toFixed(1)}%
            </span>
          </div>
          <div className="text-right">
            <span className="text-slate-300 font-semibold block">
              Por debajo (Menos de {projection.line.toFixed(1)})
            </span>
            <span className="text-xl font-bold font-mono tabular-nums text-slate-200">
              {projection.probUnder.toFixed(1)}%
            </span>
          </div>
        </div>

        <div className="h-3.5 w-full rounded-full overflow-hidden bg-slate-800 flex">
          <div
            style={{ width: `${projection.probOver}%` }}
            className="bg-emerald-500 transition-all duration-150"
          />
          <div
            style={{ width: `${projection.probUnder}%` }}
            className="bg-slate-600 transition-all duration-150"
          />
        </div>
      </div>

      {/* Data Provenance & Sample Quality Indicator */}
      <div
        className={`rounded-lg border px-3 py-2.5 text-xs ${
          projection.statsQuality === 'verified'
            ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
            : projection.statsQuality === 'estimated'
              ? 'border-amber-500/30 bg-amber-950/20 text-amber-200'
              : 'border-slate-800 bg-slate-950/60 text-slate-300'
        }`}
      >
        <span className="font-semibold block">
          {projection.statsQuality === 'verified'
            ? `Datos verificados (${projection.sampleSizeGames} partidos reales)`
            : projection.statsQuality === 'estimated'
              ? `Estimación posicional / muestra reducida (${projection.sampleSizeGames} partidos)`
              : 'Sin datos individuales suficientes'}
        </span>
        <span className="text-[11px] opacity-90 block mt-0.5">
          {projection.statsOriginNote ??
            (projection.statsQuality === 'verified'
              ? 'Proyección calculada con estadísticas individuales reales del jugador.'
              : 'La fuente actual no publica game logs individuales completos; la proyección aplica estimación posicional con mayor amplitud de incertidumbre.')}
        </span>
      </div>

      {projection.freshnessWarning && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            projection.dataFreshness === 'stale'
              ? 'border-amber-500/40 bg-amber-950/30 text-amber-200'
              : 'border-slate-800 bg-slate-950/60 text-slate-300'
          }`}
        >
          {projection.freshnessWarning}
        </div>
      )}

      {/* Key Quantitative Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-800/80 text-xs">
        <div>
          <span className="text-slate-400 block">Valor esperado</span>
          <span className="text-base font-semibold font-mono tabular-nums text-white">
            {projection.expectedValue.toFixed(2)}
          </span>
        </div>
        <div>
          <span className="text-slate-400 block">Mediana</span>
          <span className="text-base font-semibold font-mono tabular-nums text-white">
            {projection.median.toFixed(1)}
          </span>
        </div>
        <div>
          <span className="text-slate-400 block">Intervalo 80%</span>
          <span className="text-base font-semibold font-mono tabular-nums text-blue-300">
            {projection.intervalLow.toFixed(1)} – {projection.intervalHigh.toFixed(1)}
          </span>
        </div>
        <div>
          <span className="text-slate-400 block">Confianza muestral</span>
          <span className="text-base font-semibold font-mono tabular-nums text-slate-200">
            {projection.sampleConfidence.toFixed(0)}%
          </span>
        </div>
      </div>

      {projection.multiSplitSummary && (
        <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2.5 text-[11px] space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono tabular-nums text-slate-200">
            <span>Temp: {projection.multiSplitSummary.seasonAvg}</span>
            <span>L5: {projection.multiSplitSummary.last5Avg}</span>
            <span>L10: {projection.multiSplitSummary.last10Avg}</span>
            <span>Casa/Fuera: {projection.multiSplitSummary.homeAwayAvg}</span>
            {projection.multiSplitSummary.h2hAvg !== undefined && (
              <span>H2H: {projection.multiSplitSummary.h2hAvg}</span>
            )}
          </div>
          <p className="text-slate-400">{projection.multiSplitSummary.weightsNote}</p>
        </div>
      )}

      {/* Probability Distribution Chart */}
      <div className="space-y-2 pt-2 border-t border-slate-800/80">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Distribución de probabilidad estimada</span>
          <span>
            Verde: &gt; {projection.line.toFixed(1)} · Gris: &lt; {projection.line.toFixed(1)}
          </span>
        </div>

        <div className="h-36 flex items-end gap-1.5 pt-4">
          {projection.distribution.map((bin) => {
            const pctHeight = Math.max(4, (bin.probability / maxProbBin) * 100);
            return (
              <div
                key={bin.label}
                className="flex-1 flex flex-col items-center justify-end h-full group"
              >
                <span className="text-[10px] font-mono tabular-nums text-slate-400 mb-1">
                  {(bin.probability * 100).toFixed(0)}%
                </span>
                <div
                  style={{ height: `${pctHeight}%` }}
                  className={`w-full max-w-[34px] rounded-t transition-all duration-150 ${
                    bin.isOver
                      ? 'bg-emerald-500/85 group-hover:bg-emerald-400'
                      : 'bg-slate-600/75 group-hover:bg-slate-500'
                  }`}
                />
                <span className="text-[11px] font-mono tabular-nums text-slate-300 mt-1.5">
                  {bin.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
