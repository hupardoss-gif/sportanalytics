import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  CheckCircle2,
  Clock,
  RefreshCw,
  Newspaper,
  ExternalLink,
  Search,
  AlertTriangle,
} from 'lucide-react';
import type { AvailabilityStatus, MatchRecord, PlayerProfile } from '../types/sports.ts';
import { computeNbaPlayerProp } from '../engine/nbaModel.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';

interface BasketballCourtProps {
  match: MatchRecord;
  homePlayers: PlayerProfile[];
  awayPlayers: PlayerProfile[];
  refreshingNews?: boolean;
  onRefreshNbaNews?: () => void;
  onSelectPlayer: (player: PlayerProfile) => void;
  onToggleAvailability: (playerId: string, nextStatus: AvailabilityStatus) => void;
}

function getNbaStatusBadge(status: AvailabilityStatus): {
  label: string;
  shortTag: string;
  cls: string;
} {
  switch (status) {
    case 'confirmed_starter':
    case 'starter':
      return {
        label: 'Titular confirmado',
        shortTag: 'Tit. conf.',
        cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35',
      };
    case 'possible_starter':
      return {
        label: 'Posible titular',
        shortTag: 'Pos. tit.',
        cls: 'bg-blue-500/15 text-blue-300 border-blue-500/35',
      };
    case 'probable':
      return {
        label: 'Probable',
        shortTag: 'Prob.',
        cls: 'bg-sky-500/15 text-sky-300 border-sky-500/35',
      };
    case 'available':
    case 'bench':
      return {
        label: 'Disponible (rotación)',
        shortTag: 'Disp.',
        cls: 'bg-slate-800 text-slate-200 border-slate-700',
      };
    case 'doubtful':
      return {
        label: 'Dudoso (GTD)',
        shortTag: 'GTD',
        cls: 'bg-amber-500/15 text-amber-300 border-amber-500/35',
      };
    case 'out':
    case 'suspended':
      return {
        label: status === 'suspended' ? 'Sancionado' : 'Descartado (OUT)',
        shortTag: 'OUT',
        cls: 'bg-rose-500/15 text-rose-300 border-rose-500/35',
      };
  }
}

function isCourtStarterCandidate(p: PlayerProfile): boolean {
  if (
    p.availability === 'confirmed_starter' ||
    p.availability === 'possible_starter' ||
    p.availability === 'starter'
  ) {
    return true;
  }
  if ((p.availability === 'probable' || p.availability === 'doubtful') && p.pitchCoord) {
    return true;
  }
  return false;
}

export const BasketballCourt: React.FC<BasketballCourtProps> = ({
  match,
  homePlayers,
  awayPlayers,
  refreshingNews = false,
  onRefreshNbaNews,
  onSelectPlayer,
  onToggleAvailability,
}) => {
  const [showBench, setShowBench] = useState(true);

  const homeStarters = homePlayers.filter(isCourtStarterCandidate).slice(0, 5);
  const awayStarters = awayPlayers.filter(isCourtStarterCandidate).slice(0, 5);

  const mapToCourt = (p: PlayerProfile, idx: number, isHome: boolean) => {
    const fallbackCoords = [
      { x: 50, y: 63 },
      { x: 24, y: 69 },
      { x: 76, y: 69 },
      { x: 31, y: 82 },
      { x: 69, y: 84 },
    ];
    const coord = p.pitchCoord ?? fallbackCoords[idx % 5];
    const px = coord.x;
    const py = coord.y;
    if (isHome) {
      const leftPct = 8 + ((100 - py) / 40) * 35;
      const topPct = px;
      return { leftPct, topPct };
    }
    const leftPct = 92 - ((100 - py) / 40) * 35;
    const topPct = 100 - px;
    return { leftPct, topPct };
  };

  if (homePlayers.length === 0 && awayPlayers.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-6 text-center space-y-3">
        <p className="text-sm font-semibold text-slate-200">
          {match.hydrationStatus === 'provider_unavailable'
            ? 'El proveedor NBA seleccionado no habilita plantillas'
            : match.hydrationStatus === 'network_error' || match.hydrationStatus === 'query_error'
              ? 'No se pudieron consultar las rotaciones NBA'
              : 'Quintetos y rotaciones todavía no publicados'}
        </p>
        <p className="text-xs text-slate-400 max-w-xl mx-auto leading-relaxed">
          {match.hydrationNote ??
            'Cuando el proveedor publique los cinco titulares y el parte de lesiones NBA, la pista interactiva se completará automáticamente.'}
        </p>
        {onRefreshNbaNews && (
          <button
            type="button"
            onClick={onRefreshNbaNews}
            disabled={refreshingNews}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingNews ? 'animate-spin' : ''}`} />
            {refreshingNews ? 'Consultando fuentes...' : 'Consultar rotaciones y noticias NBA'}
          </button>
        )}
      </div>
    );
  }

  const news = match.nbaNews;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {match.lineupStatus === 'confirmed' ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              Quintetos confirmados
            </span>
          ) : match.lineupStatus === 'provisional' ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-400">
              <Clock className="w-4 h-4" />
              Quintetos proyectados + parte médico oficial
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-300">
              <Clock className="w-4 h-4" />
              Quintetos aún no confirmados
            </span>
          )}
          <span className="text-slate-500">·</span>
          <span className="text-slate-300">
            {match.homeTeam.shortName} vs {match.awayTeam.shortName}
          </span>
        </div>
        <span className="text-slate-400">
          En pista: quinteto titular · En lista inferior: titulares vs disponibles en rotación
        </span>
      </div>

      {/* Top-Down Interactive Basketball Court (Starters Only) */}
      <div className="relative w-full aspect-[16/9] min-h-[300px] sm:min-h-[400px] rounded-xl overflow-hidden border border-blue-500/25 bg-[#0F172A]">
        <svg
          viewBox="0 0 1000 562"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full pointer-events-none"
          aria-hidden="true"
        >
          <rect x="0" y="0" width="1000" height="562" fill="#131C2E" />
          <rect
            x="30"
            y="24"
            width="940"
            height="514"
            fill="#172338"
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth="2.5"
          />
          <line
            x1="500"
            y1="24"
            x2="500"
            y2="538"
            stroke="rgba(148, 163, 184, 0.32)"
            strokeWidth="2.5"
          />
          <circle
            cx="500"
            cy="281"
            r="68"
            fill="rgba(37, 99, 235, 0.12)"
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth="2.5"
          />
          <rect
            x="30"
            y="191"
            width="190"
            height="180"
            fill="rgba(37, 99, 235, 0.14)"
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth="2.5"
          />
          <circle
            cx="220"
            cy="281"
            r="60"
            fill="none"
            stroke="rgba(148, 163, 184, 0.3)"
            strokeWidth="2"
          />
          <path
            d="M 30 68 L 145 68 A 242 242 0 0 1 145 494 L 30 494"
            fill="none"
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth="2.5"
          />
          <rect
            x="780"
            y="191"
            width="190"
            height="180"
            fill="rgba(59, 130, 246, 0.08)"
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth="2.5"
          />
          <circle
            cx="780"
            cy="281"
            r="60"
            fill="none"
            stroke="rgba(148, 163, 184, 0.3)"
            strokeWidth="2"
          />
          <path
            d="M 970 68 L 855 68 A 242 242 0 0 0 855 494 L 970 494"
            fill="none"
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth="2.5"
          />
        </svg>

        {homeStarters.map((p, idx) => {
          const { leftPct, topPct } = mapToCourt(p, idx, true);
          const badge = getNbaStatusBadge(p.availability);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelectPlayer(p)}
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5 group cursor-pointer z-10 min-w-[44px] min-h-[44px] justify-center"
            >
              <div className="transition-transform duration-150 group-hover:scale-110">
                <PlayerAvatar
                  name={p.name}
                  number={p.number}
                  photoUrl={p.photoUrl}
                  availability={p.availability}
                  size="md"
                  accent="blue"
                />
              </div>
              <span className="px-1.5 py-0.5 rounded bg-slate-950/90 text-[10px] sm:text-[11px] font-medium text-slate-100 whitespace-nowrap border border-slate-800">
                {p.position} · {p.shortName} ·{' '}
                <span className="text-blue-300">{badge.shortTag}</span>
              </span>
            </button>
          );
        })}

        {awayStarters.map((p, idx) => {
          const { leftPct, topPct } = mapToCourt(p, idx, false);
          const badge = getNbaStatusBadge(p.availability);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelectPlayer(p)}
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5 group cursor-pointer z-10 min-w-[44px] min-h-[44px] justify-center"
            >
              <div className="transition-transform duration-150 group-hover:scale-110">
                <PlayerAvatar
                  name={p.name}
                  number={p.number}
                  photoUrl={p.photoUrl}
                  availability={p.availability}
                  size="md"
                  accent="slate"
                />
              </div>
              <span className="px-1.5 py-0.5 rounded bg-slate-950/90 text-[10px] sm:text-[11px] font-medium text-slate-200 whitespace-nowrap border border-slate-700">
                {p.position} · {p.shortName} ·{' '}
                <span className="text-sky-300">{badge.shortTag}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* External NBA Official Injury Report, Team News & Search Grounding Panel */}
      <div className="rounded-xl border border-slate-800 bg-[#0D1526] overflow-hidden">
        <div className="px-4 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Newspaper className="w-4 h-4 text-blue-400" />
              <h4 className="text-sm font-semibold text-white">
                Noticias NBA, Parte Médico Oficial y Búsqueda Externa
              </h4>
            </div>
            <p className="text-[11px] text-slate-400">
              {news ? (
                <>
                  Fuentes consultadas: {news.sourcesChecked.join(' · ')} · Actualizado{' '}
                  {new Date(news.fetchedAt).toLocaleString('es-ES', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </>
              ) : (
                'Pulsa actualizar para consultar informes oficiales de lesiones, medios NBA y restricciones de minutos.'
              )}
            </p>
          </div>

          {onRefreshNbaNews && (
            <button
              type="button"
              onClick={onRefreshNbaNews}
              disabled={refreshingNews}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingNews ? 'animate-spin' : ''}`} />
              {refreshingNews ? 'Actualizando parte y noticias...' : 'Actualizar noticias y parte médico'}
            </button>
          )}
        </div>

        <div className="p-4 space-y-3">
          {/* Honest Google Search Grounding Banner */}
          {news?.searchGrounding && (
            <div
              className={`rounded-lg border px-3.5 py-2.5 text-xs flex flex-col gap-1.5 ${
                news.searchGrounding.status === 'active'
                  ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
                  : 'border-slate-800 bg-slate-950/60 text-slate-300'
              }`}
            >
              <div className="flex items-start gap-2">
                {news.searchGrounding.status === 'active' ? (
                  <Search className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <span className="font-semibold block">
                    {news.searchGrounding.used
                      ? 'Google Search Grounding ejecutado en directo'
                      : news.searchGrounding.status === 'active'
                        ? 'Google Search Grounding disponible'
                        : 'Google Search Grounding sin activar en el servidor'}
                  </span>
                  <span className="text-[11px] text-slate-300 block leading-relaxed">
                    {news.searchGrounding.message}
                  </span>
                </div>
              </div>
              {news.searchGrounding.citations && news.searchGrounding.citations.length > 0 && (
                <div className="flex flex-wrap gap-2 pl-5 pt-1">
                  {news.searchGrounding.citations.map((c, idx) => (
                    <a
                      key={idx}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px] text-blue-300 hover:text-blue-200"
                    >
                      {c.title}
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {news?.freshnessWarning && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3.5 py-2 text-[11px] text-amber-200/95">
              {news.freshnessWarning}
            </div>
          )}

          {/* Real External News & Injury Feed */}
          {!news || news.items.length === 0 ? (
            <p className="text-xs text-slate-400 py-2">
              No hay partes médicos ni noticias recientes verificables para este partido dentro de la ventana de actualidad permitida.
            </p>
          ) : (
            <div className="max-h-[300px] overflow-y-auto divide-y divide-slate-800/80 pr-1">
              {news.items.map((item) => (
                <div key={item.id} className="py-2.5 space-y-1 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${
                          item.confirmed
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                        }`}
                      >
                        {item.confirmed ? 'Oficial / Confirmado' : 'Medio / Rumor'}
                      </span>
                      {item.statusTag && (
                        <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] font-medium text-slate-200">
                          {item.statusTag}
                        </span>
                      )}
                      {item.teamShort && (
                        <span className="font-mono text-[11px] font-bold text-blue-300">
                          {item.teamShort}
                        </span>
                      )}
                      <span className="text-[11px] font-medium text-slate-300">{item.source}</span>
                    </div>
                    <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                      {item.publishedAt
                        ? new Date(item.publishedAt).toLocaleString('es-ES', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Fecha no publicada por la fuente'}
                    </span>
                  </div>

                  <p className="font-semibold text-slate-100">{item.headline}</p>
                  {item.summary && item.summary !== item.headline && (
                    <p className="text-slate-400 text-[11px] leading-relaxed">{item.summary}</p>
                  )}
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 font-medium"
                    >
                      Leer informe completo
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Rotation, Availability States (6 levels) & Dynamic Minutes/Stats Recalculation */}
      <div className="rounded-xl border border-slate-800 bg-[#0D1526] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowBench((v) => !v)}
          className="w-full min-h-[48px] px-4 py-3 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-semibold text-slate-100">
              Disponibilidad (6 estados), minutos estimados y simulador de bajas
            </span>
          </div>
          {showBench ? (
            <ChevronUp className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </button>

        {showBench && (
          <div className="p-4 border-t border-slate-800 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[
              { title: match.homeTeam.name, all: homePlayers },
              { title: match.awayTeam.name, all: awayPlayers },
            ].map((side) => (
              <div key={side.title} className="space-y-3">
                <h5 className="text-xs font-semibold text-slate-400">{side.title}</h5>
                <div className="divide-y divide-slate-800/70">
                  {side.all.map((p) => {
                    const badge = getNbaStatusBadge(p.availability);
                    const dynPts = computeNbaPlayerProp(p, match, 'points', undefined, 'season', side.all);
                    const dynReb = computeNbaPlayerProp(p, match, 'rebounds', undefined, 'season', side.all);
                    const dynAst = computeNbaPlayerProp(p, match, 'assists', undefined, 'season', side.all);
                    return (
                      <div key={p.id} className="py-3 space-y-2 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => onSelectPlayer(p)}
                            className="flex items-start gap-2.5 text-left hover:text-blue-400 transition-colors cursor-pointer min-w-0 flex-1"
                          >
                            <span className="font-mono tabular-nums text-slate-500 w-7 pt-0.5 shrink-0">
                              #{p.number}
                            </span>
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-semibold text-slate-100 truncate">
                                  {p.name}
                                </span>
                                <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${badge.cls}`}>
                                  {badge.label}
                                </span>
                                {p.availabilityConfidence && (
                                  <span className="text-[10px] text-slate-400">
                                    ·{' '}
                                    {p.availabilityConfidence === 'confirmed'
                                      ? 'Confirmado'
                                      : p.availabilityConfidence === 'rumor'
                                        ? 'Rumor'
                                        : p.availabilityConfidence === 'projected'
                                          ? 'Proyectado'
                                          : 'Sin confirmar'}
                                  </span>
                                )}
                              </div>

                              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                                {p.position} ·{' '}
                                {p.statsQuality === 'unavailable' || p.splits.season.points === undefined ? (
                                  <span className="text-slate-300">Stats individuales: N/D</span>
                                ) : (
                                  <>
                                    <span className="text-blue-300 font-semibold">
                                      {dynPts.expectedMinutes.toFixed(0)} min est.
                                    </span>{' '}
                                    · Proy: {dynPts.expectedValue.toFixed(1)} PTS ·{' '}
                                    {dynReb.expectedValue.toFixed(1)} REB ·{' '}
                                    {dynAst.expectedValue.toFixed(1)} AST
                                    {dynPts.absenceAdjustmentPct > 1 && (
                                      <span className="text-emerald-400">
                                        {' '}
                                        (+{dynPts.absenceAdjustmentPct.toFixed(0)}% uso)
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>

                              {p.minutesRestriction && (
                                <div className="text-[11px] text-blue-300 font-medium">
                                  ⏱ {p.minutesRestriction.note}
                                </div>
                              )}
                            </div>
                          </button>

                          <select
                            value={p.availability}
                            aria-label={`Estado de ${p.name}`}
                            onChange={(e) =>
                              onToggleAvailability(p.id, e.target.value as AvailabilityStatus)
                            }
                            className={`min-h-[36px] px-2.5 py-1 rounded-lg border text-xs font-medium bg-slate-900 cursor-pointer shrink-0 ${
                              p.availability === 'out' || p.availability === 'suspended'
                                ? 'border-rose-500/40 text-rose-300'
                                : p.availability === 'doubtful'
                                  ? 'border-amber-500/40 text-amber-300'
                                  : p.availability === 'probable'
                                    ? 'border-sky-500/40 text-sky-300'
                                    : p.availability === 'available' || p.availability === 'bench'
                                      ? 'border-slate-700 text-slate-300'
                                      : 'border-emerald-500/40 text-emerald-300'
                            }`}
                          >
                            <option value="confirmed_starter">Titular confirmado</option>
                            <option value="possible_starter">Posible titular</option>
                            <option value="probable">Probable</option>
                            <option value="available">Disponible (rotación)</option>
                            <option value="doubtful">Dudoso (GTD)</option>
                            <option value="out">Descartado (OUT)</option>
                          </select>
                        </div>

                        {(p.latestNews || p.injuryNote) && (
                          <div className="ml-9 rounded-lg border border-slate-800/90 bg-slate-950/60 px-2.5 py-2 text-[11px] space-y-1">
                            {p.latestNews ? (
                              <>
                                <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                                  <span>
                                    <strong className="text-slate-200">{p.latestNews.source}</strong>{' '}
                                    ·{' '}
                                    <span
                                      className={
                                        p.latestNews.confirmed ? 'text-emerald-400' : 'text-amber-300'
                                      }
                                    >
                                      {p.latestNews.confirmed ? 'Oficial' : 'Medio / Rumor'}
                                    </span>
                                  </span>
                                  <span className="font-mono tabular-nums">
                                    {p.latestNews.publishedAt
                                      ? new Date(p.latestNews.publishedAt).toLocaleString('es-ES', {
                                          day: '2-digit',
                                          month: 'short',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })
                                      : 'Fecha no publicada por la fuente'}
                                  </span>
                                </div>
                                <p className="text-slate-300 leading-snug">{p.latestNews.summary}</p>
                              </>
                            ) : (
                              <p className="text-amber-200/90">{p.injuryNote}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
