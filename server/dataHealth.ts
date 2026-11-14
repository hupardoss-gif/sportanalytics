import type {
  DataProvenanceMeta,
  LiveFeedMeta,
  LiveFeedSourceStatus,
  MatchRecord,
} from '../src/types/sports.ts';

export const DEFAULT_STALE_THRESHOLD_MINUTES = 15;

export function evaluateFeedStaleness(params: {
  fetchedAt: string;
  fromCache: boolean;
  sources: LiveFeedSourceStatus[];
  errors: string[];
  nowMs?: number;
  staleThresholdMinutes?: number;
}): LiveFeedMeta {
  const nowMs = params.nowMs ?? Date.now();
  const threshold = params.staleThresholdMinutes ?? DEFAULT_STALE_THRESHOLD_MINUTES;
  const fetchedMs = new Date(params.fetchedAt).getTime();
  const ageMin = Number.isFinite(fetchedMs)
    ? Math.max(0, Math.round((nowMs - fetchedMs) / 60_000))
    : 999;

  const hasErrors = params.errors.length > 0 || params.sources.some((s) => s.status === 'error');
  const agedOut = ageMin >= threshold;
  const isStale = hasErrors || agedOut;

  let staleReason: string | undefined;
  if (hasErrors && agedOut) {
    staleReason = `Datos con ${ageMin} min de antigüedad y fallo de actualización (${params.errors.join('; ') || 'error de proveedor'}).`;
  } else if (hasErrors) {
    staleReason = `Uno o más proveedores devolvieron error (${params.errors.join('; ') || 'revisar fuentes'}); la cobertura puede estar incompleta o desactualizada.`;
  } else if (agedOut) {
    staleReason = `Los datos en caché tienen ${ageMin} min de antigüedad (>= ${threshold} min). Pulsa Actualizar para recargar en directo.`;
  }

  const normalizedSources: LiveFeedSourceStatus[] = params.sources.map((s) => {
    const sMs = new Date(s.updatedAt).getTime();
    const sAge = Number.isFinite(sMs) ? Math.round((nowMs - sMs) / 60_000) : 999;
    if (s.status === 'error') return s;
    if (sAge >= threshold) return { ...s, status: 'stale' };
    return s;
  });

  return {
    fetchedAt: params.fetchedAt,
    fromCache: params.fromCache,
    cacheAgeMinutes: ageMin,
    isStale,
    staleReason,
    sources: normalizedSources,
  };
}

export function evaluateMatchProvenance(
  match: MatchRecord,
  nowMs = Date.now(),
  staleThresholdMinutes = 30
): DataProvenanceMeta {
  const updatedMs = new Date(match.updatedAt).getTime();
  const ageMin = Number.isFinite(updatedMs)
    ? Math.max(0, Math.round((nowMs - updatedMs) / 60_000))
    : 999;

  const isFailed =
    match.hydrationStatus === 'network_error' ||
    match.hydrationStatus === 'query_error' ||
    match.hydrationStatus === 'provider_unavailable';

  const isStale = isFailed || ageMin >= staleThresholdMinutes || Boolean(match.provenance?.isStale);

  return {
    source: match.provenance?.source ?? match.dataOrigin,
    fetchedAt: match.provenance?.fetchedAt ?? match.updatedAt,
    status: isFailed ? 'error' : isStale ? 'stale' : match.provenance?.status ?? 'ok',
    isStale,
    staleAgeMinutes: ageMin,
    dataType: isFailed
      ? 'unavailable'
      : match.teamStatsQuality === 'verified'
        ? 'real'
        : match.provenance?.dataType ?? 'estimated',
    errorMessage: match.provenance?.errorMessage ?? (isFailed ? match.hydrationNote : undefined),
  };
}
