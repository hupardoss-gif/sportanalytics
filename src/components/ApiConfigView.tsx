import React, { useState } from 'react';
import {
  KeyRound,
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldCheck,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  PlusCircle,
} from 'lucide-react';
import type { ApiConfigState, ApiProviderStatus } from '../types/sports.ts';

interface ApiConfigViewProps {
  config: ApiConfigState;
  onConfigUpdated: (next: ApiConfigState) => void;
  onRefreshLive: () => Promise<void>;
}

const FOOTBALL_PROVIDERS = [
  {
    id: 'football-data',
    label: 'Football-Data.org v4 (football-data.org)',
    shortLabel: 'Football-Data.org v4',
    hint: 'football-data.org/client/home',
    zeroKey: false,
  },
  {
    id: 'espn-football',
    label: 'ESPN Fútbol + Competiciones Europeas (Sin clave · Verificación)',
    shortLabel: 'ESPN Fútbol Oficial',
    hint: 'Fuente oficial sin clave (calendario, clasificaciones y contraste de datos)',
    zeroKey: true,
  },
  {
    id: 'api-football',
    label: 'API-Football (v3.football.api-sports.io)',
    shortLabel: 'API-Football v3',
    hint: 'dashboard.api-football.com',
    zeroKey: false,
  },
] as const;

const NBA_PROVIDERS = [
  {
    id: 'basketballapi-net',
    label: 'BasketballAPI.net v1 (basketballapi.net)',
    shortLabel: 'BasketballAPI.net v1',
    hint: 'basketballapi.net/dashboard/keys',
    zeroKey: false,
  },
  {
    id: 'espn-nba',
    label: 'ESPN NBA Oficial (Sin clave · Verificación + Lesiones)',
    shortLabel: 'ESPN NBA Oficial',
    hint: 'Fuente oficial sin clave (calendario, lesiones, game logs y contraste)',
    zeroKey: true,
  },
  {
    id: 'api-basketball',
    label: 'API-Basketball (v1.basketball.api-sports.io)',
    shortLabel: 'API-Basketball v1',
    hint: 'dashboard.api-football.com',
    zeroKey: false,
  },
  {
    id: 'api-nba',
    label: 'API-NBA (v2.nba.api-sports.io)',
    shortLabel: 'API-NBA v2',
    hint: 'dashboard.api-football.com',
    zeroKey: false,
  },
  {
    id: 'balldontlie',
    label: 'BallDontLie NBA (v1)',
    shortLabel: 'BallDontLie NBA',
    hint: 'app.balldontlie.io',
    zeroKey: false,
  },
] as const;

export const ApiConfigView: React.FC<ApiConfigViewProps> = ({
  config,
  onConfigUpdated,
  onRefreshLive,
}) => {
  const [fbProvider, setFbProvider] = useState(
    FOOTBALL_PROVIDERS.some((p) => p.id === config.football.provider)
      ? config.football.provider
      : 'football-data'
  );
  const [fbKeyInput, setFbKeyInput] = useState('');
  const [fbShowKey, setFbShowKey] = useState(false);
  const [fbBusy, setFbBusy] = useState<'save' | 'test' | null>(null);

  const [nbaProvider, setNbaProvider] = useState(
    NBA_PROVIDERS.some((p) => p.id === config.nba.provider)
      ? config.nba.provider
      : 'basketballapi-net'
  );
  const [nbaKeyInput, setNbaKeyInput] = useState('');
  const [nbaShowKey, setNbaShowKey] = useState(false);
  const [reuseFbKey, setReuseFbKey] = useState(Boolean(config.nba.reuseFootballKey));
  const [nbaBusy, setNbaBusy] = useState<'save' | 'test' | null>(null);

  const [pinInput, setPinInput] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const fbZeroKey = fbProvider === 'espn-football';
  const nbaZeroKey = nbaProvider === 'espn-nba';

  const fbProvidersMap: Record<string, ApiProviderStatus> =
    config.footballProviders ?? { [config.football.provider]: config.football };
  const nbaProvidersMap: Record<string, ApiProviderStatus> =
    config.nbaProviders ?? { [config.nba.provider]: config.nba };

  const selectedFbStatus = fbProvidersMap[fbProvider];
  const selectedNbaStatus = nbaProvidersMap[nbaProvider];

  const security = config.security ?? {
    pinConfigured: false,
    unlocked: false,
    envProtected: false,
  };

  const refreshConfigOnly = async () => {
    try {
      const res = await fetch('/api/config/apis');
      if (res.ok) {
        const latest = (await res.json()) as ApiConfigState;
        onConfigUpdated(latest);
      }
    } catch {
      // ignore
    }
  };

  const handleAuthAction = async (mode: 'setup' | 'login' | 'logout') => {
    setFeedback(null);
    setAuthBusy(true);
    try {
      if (mode === 'logout') {
        const res = await fetch('/api/config/auth/logout', { method: 'POST' });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error || 'No se pudo bloquear la sesión');
        }
        await refreshConfigOnly();
        setFeedback('Sesión de configuración bloqueada.');
        return;
      }

      const cleanPin = pinInput.trim();
      if (cleanPin.length < 4) {
        throw new Error('Introduce un PIN válido de al menos 4 caracteres.');
      }

      const res = await fetch(`/api/config/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: cleanPin }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(json.error || 'No se pudo validar el PIN');
      }
      setPinInput('');
      await refreshConfigOnly();
      setFeedback(
        mode === 'setup'
          ? 'PIN de seguridad creado y sesión desbloqueada.'
          : 'Sesión desbloqueada correctamente.'
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Error de autenticación');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSave = async (sport: 'football' | 'nba', overrideProvider?: string) => {
    setFeedback(null);
    if (sport === 'football') setFbBusy('save');
    else setNbaBusy('save');

    const activeFbProv = overrideProvider && sport === 'football' ? overrideProvider : fbProvider;
    const activeNbaProv = overrideProvider && sport === 'nba' ? overrideProvider : nbaProvider;

    try {
      const bodyPayload =
        sport === 'football'
          ? {
              sport: 'football',
              provider: activeFbProv,
              apiKey: activeFbProv === 'espn-football' ? '' : fbKeyInput,
              enabled: true,
            }
          : {
              sport: 'nba',
              provider: activeNbaProv,
              apiKey: activeNbaProv === 'espn-nba' || reuseFbKey ? undefined : nbaKeyInput,
              reuseFootballKey: activeNbaProv === 'espn-nba' ? false : reuseFbKey,
              enabled: true,
            };

      const res = await fetch('/api/config/apis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });
      const data = (await res.json()) as ApiConfigState & { error?: string };
      if (res.status === 401) {
        await refreshConfigOnly();
        throw new Error(data.error || 'Desbloquea la sesión de administrador para guardar APIs.');
      }
      if (!res.ok) throw new Error(data.error || 'Error guardando clave');
      onConfigUpdated(data);
      if (sport === 'football') setFbKeyInput('');
      else setNbaKeyInput('');
      await onRefreshLive();
      setFeedback(
        `Proveedor guardado para ${sport === 'football' ? 'Fútbol' : 'NBA'} manteniendo activas el resto de tus fuentes conectadas.`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Error guardando configuración');
    } finally {
      setFbBusy(null);
      setNbaBusy(null);
    }
  };

  const handleTest = async (sport: 'football' | 'nba', overrideProvider?: string) => {
    setFeedback(null);
    if (sport === 'football') setFbBusy('test');
    else setNbaBusy('test');

    const targetFbProv = overrideProvider && sport === 'football' ? overrideProvider : fbProvider;
    const targetNbaProv = overrideProvider && sport === 'nba' ? overrideProvider : nbaProvider;

    try {
      const bodyPayload =
        sport === 'football'
          ? {
              sport: 'football',
              provider: targetFbProv,
              apiKey: overrideProvider ? undefined : fbKeyInput || undefined,
            }
          : {
              sport: 'nba',
              provider: targetNbaProv,
              apiKey: overrideProvider || reuseFbKey ? undefined : nbaKeyInput || undefined,
              reuseFootballKey: overrideProvider ? undefined : reuseFbKey,
            };

      const res = await fetch('/api/config/apis/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });
      const data = (await res.json()) as {
        error?: string;
        result?: { ok: boolean; accountInfo: string | null; error: string | null };
        config?: ApiConfigState;
      };
      if (res.status === 401) {
        await refreshConfigOnly();
        throw new Error(data.error || 'Desbloquea la sesión de administrador para probar APIs.');
      }
      if (!res.ok || !data.config || !data.result) {
        throw new Error(data.error || 'Error comprobando conexión');
      }
      onConfigUpdated(data.config);
      if (data.result.ok) {
        await onRefreshLive();
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Error comprobando conexión');
    } finally {
      setFbBusy(null);
      setNbaBusy(null);
    }
  };

  const handleClearProvider = async (sport: 'football' | 'nba', providerId?: string) => {
    setFeedback(null);
    try {
      const qs = providerId
        ? `sport=${sport}&provider=${encodeURIComponent(providerId)}`
        : `sport=${sport}`;
      const res = await fetch(`/api/config/apis?${qs}`, { method: 'DELETE' });
      const data = (await res.json()) as ApiConfigState & { error?: string };
      if (res.status === 401) {
        await refreshConfigOnly();
        setFeedback(data.error || 'Desbloquea la sesión de administrador antes de desconectar.');
        return;
      }
      if (!res.ok) {
        setFeedback(data.error || 'Error desconectando API');
        return;
      }
      onConfigUpdated(data);
      if (sport === 'football') setFbKeyInput('');
      else setNbaKeyInput('');
      await onRefreshLive();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Error desconectando API');
    }
  };

  const renderMultiSourceList = (
    sport: 'football' | 'nba',
    catalog: ReadonlyArray<{ id: string; shortLabel: string; hint: string; zeroKey: boolean }>,
    statusMap: Record<string, ApiProviderStatus>,
    activeId: string,
    onSelect: (id: string) => void,
    busy: 'save' | 'test' | null
  ) => {
    const connectedCount = catalog.filter((item) => statusMap[item.id]?.connected).length;

    return (
      <div className="rounded-xl border border-slate-800/90 bg-slate-950/60 p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-slate-200">
            Fuentes simultáneas ({connectedCount} activas)
          </span>
          <span className="text-[11px] text-slate-400">
            Se consultan y contrastan a la vez sin sobrescribirse
          </span>
        </div>

        <div className="space-y-2">
          {catalog.map((item) => {
            const st = statusMap[item.id];
            const isConnected = Boolean(st?.connected);
            const hasSavedKey = Boolean(st?.maskedKey);
            const hasError = Boolean(st?.error);
            const isSelected = activeId === item.id;

            return (
              <div
                key={item.id}
                className={`rounded-lg border px-3 py-2 text-xs transition-colors ${
                  isSelected
                    ? 'border-blue-500/45 bg-blue-950/15'
                    : 'border-slate-800 bg-slate-900/50'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className="flex items-center gap-2 text-left cursor-pointer"
                  >
                    {isConnected ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : hasError ? (
                      <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    ) : (
                      <KeyRound className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    )}
                    <span className="font-semibold text-slate-100">{item.shortLabel}</span>
                    {st?.maskedKey && (
                      <span className="font-mono text-[11px] text-slate-400">{st.maskedKey}</span>
                    )}
                    {item.zeroKey && isConnected && (
                      <span className="text-[11px] text-emerald-300">Verificación activa</span>
                    )}
                  </button>

                  <div className="flex items-center gap-2">
                    {!isConnected && item.zeroKey && (
                      <button
                        type="button"
                        onClick={() => void handleSave(sport, item.id)}
                        disabled={busy !== null || !security.unlocked}
                        className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                      >
                        <PlusCircle className="w-3 h-3" />
                        Activar
                      </button>
                    )}
                    {(isConnected || hasSavedKey || hasError) && (
                      <button
                        type="button"
                        onClick={() => void handleTest(sport, item.id)}
                        disabled={busy !== null || !security.unlocked}
                        className="text-[11px] text-slate-300 hover:text-white disabled:opacity-40 cursor-pointer"
                      >
                        Probar
                      </button>
                    )}
                    {(isConnected || hasSavedKey) && (
                      <button
                        type="button"
                        onClick={() => void handleClearProvider(sport, item.id)}
                        disabled={!security.unlocked}
                        className="text-[11px] text-slate-400 hover:text-rose-400 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        Quitar
                      </button>
                    )}
                  </div>
                </div>

                {st?.accountInfo && (
                  <p className="text-[11px] text-slate-400 mt-1 leading-snug">{st.accountInfo}</p>
                )}
                {st?.error && (
                  <p className="text-[11px] text-rose-300 mt-1 leading-snug">{st.error}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white">CONFIGURACIÓN DE APIS</h2>
          <p className="text-sm text-slate-400 mt-1">
            Mantén conectadas todas tus claves API a la vez junto con fuentes públicas oficiales de verificación. Todas las claves se cifran con AES-256-GCM en el servidor.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <ShieldCheck className="w-4 h-4" />
          <span>Almacenamiento cifrado AES-256-GCM</span>
        </div>
      </div>

      {/* ADMIN SESSION / PIN PROTECTION PANEL */}
      <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {security.unlocked ? (
              <Unlock className="w-4 h-4 text-emerald-400" />
            ) : (
              <Lock className="w-4 h-4 text-amber-400" />
            )}
            <div>
              <h3 className="text-sm font-bold text-white">
                Protección de Configuración de APIs
              </h3>
              <p className="text-xs text-slate-400">
                {security.unlocked
                  ? 'Sesión de administrador desbloqueada mediante cookie HttpOnly firmada. Puedes añadir, probar o quitar cualquier proveedor sin perder tus otras claves.'
                  : security.pinConfigured
                    ? 'Sesión bloqueada. Introduce tu PIN de administrador para modificar o comprobar claves API.'
                    : security.envProtected
                      ? 'Protegido mediante clave administrativa del servidor.'
                      : 'Crea un PIN de administrador (mín. 4 caracteres) para proteger las modificaciones de APIs.'}
              </p>
            </div>
          </div>

          {security.unlocked && (
            <button
              type="button"
              onClick={() => void handleAuthAction('logout')}
              disabled={authBusy}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Lock className="w-3.5 h-3.5" />
              Bloquear sesión
            </button>
          )}
        </div>

        {!security.unlocked && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder={
                security.pinConfigured
                  ? 'Introduce tu PIN de administrador...'
                  : 'Crea un PIN nuevo (ej. 4-16 caracteres)...'
              }
              autoComplete="off"
              className="flex-1 min-w-[220px] max-w-sm min-h-[40px] px-3 rounded-lg border border-slate-700 bg-slate-950 text-xs font-mono text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleAuthAction(security.pinConfigured ? 'login' : 'setup')}
              disabled={authBusy}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-semibold text-white flex items-center gap-2 cursor-pointer"
            >
              {authBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {security.pinConfigured ? 'Desbloquear configuración' : 'Crear PIN y desbloquear'}
            </button>
          </div>
        )}
      </section>

      {feedback && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-950/30 px-4 py-3 text-xs text-blue-200">
          {feedback}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* API DE FÚTBOL */}
        <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">API DE FÚTBOL</h3>
            <span className="text-[11px] font-medium text-slate-400">
              Multi-fuente en paralelo
            </span>
          </div>

          {renderMultiSourceList(
            'football',
            FOOTBALL_PROVIDERS,
            fbProvidersMap,
            fbProvider,
            setFbProvider,
            fbBusy
          )}

          <div className="space-y-3 pt-1 border-t border-slate-800/80">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">
                Configurar / actualizar proveedor de Fútbol
              </span>
              <select
                value={fbProvider}
                onChange={(e) => setFbProvider(e.target.value)}
                className="w-full min-h-[44px] px-3 rounded-lg border border-slate-700 bg-slate-900 text-sm text-slate-100"
              >
                {FOOTBALL_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            {fbZeroKey ? (
              <div className="rounded-lg border border-blue-500/25 bg-blue-950/20 p-3 text-xs text-blue-200">
                Esta fuente no requiere API Key y se ejecuta simultáneamente junto con tus APIs configuradas (Football-Data.org / API-Football) para contrastar marcadores, plantillas y ligas europeas.
              </div>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-300">
                  Clave API ({FOOTBALL_PROVIDERS.find((p) => p.id === fbProvider)?.shortLabel}){' '}
                  {selectedFbStatus?.maskedKey ? `(guardada: ${selectedFbStatus.maskedKey})` : ''}
                </span>
                <div className="relative">
                  <input
                    type={fbShowKey ? 'text' : 'password'}
                    value={fbKeyInput}
                    onChange={(e) => setFbKeyInput(e.target.value)}
                    placeholder={
                      fbProvider === 'football-data'
                        ? 'Pega aquí tu token de football-data.org/client/home...'
                        : 'Pega aquí tu clave API de API-Football...'
                    }
                    autoComplete="off"
                    className="w-full min-h-[44px] pl-3.5 pr-11 rounded-lg border border-slate-700 bg-slate-950 text-sm font-mono text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setFbShowKey((v) => !v)}
                    aria-label="Mostrar u ocultar clave de fútbol"
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer"
                  >
                    {fbShowKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-slate-400">
                  Copia tu token desde{' '}
                  <span className="font-mono text-blue-300">
                    {FOOTBALL_PROVIDERS.find((p) => p.id === fbProvider)?.hint}
                  </span>
                  . Se guarda sin eliminar tus otras fuentes activas.
                </p>
              </label>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleSave('football')}
              disabled={fbBusy !== null || !security.unlocked}
              className="min-h-[44px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors flex items-center gap-2 cursor-pointer"
            >
              {fbBusy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
              {fbZeroKey ? 'Activar en paralelo' : 'Guardar y conectar'}
            </button>
            <button
              type="button"
              onClick={() => void handleTest('football')}
              disabled={fbBusy !== null || !security.unlocked}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-xs font-semibold text-slate-200 transition-colors flex items-center gap-2 cursor-pointer"
            >
              {fbBusy === 'test' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Comprobar conexión
            </button>
          </div>
        </section>

        {/* API DE NBA */}
        <section className="rounded-xl border border-slate-800 bg-[#0D1526] p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">API DE NBA</h3>
            <span className="text-[11px] font-medium text-slate-400">
              Multi-fuente en paralelo
            </span>
          </div>

          {renderMultiSourceList(
            'nba',
            NBA_PROVIDERS,
            nbaProvidersMap,
            nbaProvider,
            (id) => {
              setNbaProvider(id);
              setReuseFbKey(Boolean(nbaProvidersMap[id]?.reuseFootballKey));
            },
            nbaBusy
          )}

          <div className="space-y-3 pt-1 border-t border-slate-800/80">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">
                Configurar / actualizar proveedor de NBA
              </span>
              <select
                value={nbaProvider}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setNbaProvider(nextId);
                  setReuseFbKey(Boolean(nbaProvidersMap[nextId]?.reuseFootballKey));
                }}
                className="w-full min-h-[44px] px-3 rounded-lg border border-slate-700 bg-slate-900 text-sm text-slate-100"
              >
                {NBA_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            {nbaZeroKey ? (
              <div className="rounded-lg border border-blue-500/25 bg-blue-950/20 p-3 text-xs text-blue-200">
                Fuente oficial sin clave: se ejecuta simultáneamente junto con tus otras APIs de NBA para aportar calendario, clasificaciones, parte oficial de lesiones (OUT/GTD), noticias externas y game logs reales (L5/L10/L15).
              </div>
            ) : (
              <>
                {(nbaProvider === 'api-basketball' || nbaProvider === 'api-nba') && (
                  <label className="flex items-center gap-2.5 min-h-[40px] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={reuseFbKey}
                      onChange={(e) => setReuseFbKey(e.target.checked)}
                      className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-xs text-slate-200">
                      Reutilizar clave de API-Sports de Fútbol
                    </span>
                  </label>
                )}

                {!reuseFbKey && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-slate-300">
                      Clave API ({NBA_PROVIDERS.find((p) => p.id === nbaProvider)?.shortLabel}){' '}
                      {selectedNbaStatus?.maskedKey ? `(guardada: ${selectedNbaStatus.maskedKey})` : ''}
                    </span>
                    <div className="relative">
                      <input
                        type={nbaShowKey ? 'text' : 'password'}
                        value={nbaKeyInput}
                        onChange={(e) => setNbaKeyInput(e.target.value)}
                        placeholder={
                          nbaProvider === 'basketballapi-net'
                            ? 'Pega aquí tu clave de basketballapi.net/dashboard/keys...'
                            : 'Pega aquí tu clave API de NBA...'
                        }
                        autoComplete="off"
                        className="w-full min-h-[44px] pl-3.5 pr-11 rounded-lg border border-slate-700 bg-slate-950 text-sm font-mono text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setNbaShowKey((v) => !v)}
                        aria-label="Mostrar u ocultar clave de NBA"
                        className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer"
                      >
                        {nbaShowKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Obtén o copia tu clave desde{' '}
                      <span className="font-mono text-blue-300">
                        {NBA_PROVIDERS.find((p) => p.id === nbaProvider)?.hint}
                      </span>
                      . Se combina simultáneamente con ESPN NBA y el parte oficial de lesiones.
                    </p>
                  </label>
                )}
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleSave('nba')}
              disabled={nbaBusy !== null || !security.unlocked}
              className="min-h-[44px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors flex items-center gap-2 cursor-pointer"
            >
              {nbaBusy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
              {nbaZeroKey ? 'Activar en paralelo' : 'Guardar y conectar'}
            </button>
            <button
              type="button"
              onClick={() => void handleTest('nba')}
              disabled={nbaBusy !== null || !security.unlocked}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-xs font-semibold text-slate-200 transition-colors flex items-center gap-2 cursor-pointer"
            >
              {nbaBusy === 'test' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Comprobar conexión
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
