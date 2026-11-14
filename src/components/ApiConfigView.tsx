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
} from 'lucide-react';
import type { ApiConfigState } from '../types/sports.ts';

interface ApiConfigViewProps {
  config: ApiConfigState;
  onConfigUpdated: (next: ApiConfigState) => void;
  onRefreshLive: () => Promise<void>;
}

const FOOTBALL_PROVIDERS = [
  { id: 'football-data', label: 'Football-Data.org v4 (football-data.org)' },
  { id: 'espn-football', label: 'ESPN Fútbol + Competiciones Europeas (Sin clave)' },
  { id: 'api-football', label: 'API-Football (v3.football.api-sports.io)' },
];

const NBA_PROVIDERS = [
  { id: 'espn-nba', label: 'ESPN NBA Oficial (Gratis / Sin clave)' },
  { id: 'basketballapi-net', label: 'BasketballAPI.net v1 (api.basketballapi.net)' },
  { id: 'api-basketball', label: 'API-Basketball (v1.basketball.api-sports.io)' },
  { id: 'api-nba', label: 'API-NBA (v2.nba.api-sports.io)' },
  { id: 'balldontlie', label: 'BallDontLie NBA (v1)' },
];

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
      : 'espn-nba'
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
            }
          : {
              sport: 'nba',
              provider: activeNbaProv,
              apiKey: activeNbaProv === 'espn-nba' || reuseFbKey ? undefined : nbaKeyInput,
              reuseFootballKey: activeNbaProv === 'espn-nba' ? false : reuseFbKey,
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
        `Configuración de ${sport === 'football' ? 'Fútbol' : 'NBA'} guardada y cifrada en el servidor.`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Error guardando configuración');
    } finally {
      setFbBusy(null);
      setNbaBusy(null);
    }
  };

  const handleTest = async (sport: 'football' | 'nba') => {
    setFeedback(null);
    if (sport === 'football') setFbBusy('test');
    else setNbaBusy('test');

    try {
      const bodyPayload =
        sport === 'football'
          ? { sport: 'football', provider: fbProvider, apiKey: fbKeyInput || undefined }
          : {
              sport: 'nba',
              provider: nbaProvider,
              apiKey: reuseFbKey ? undefined : nbaKeyInput || undefined,
              reuseFootballKey: reuseFbKey,
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

  const handleClear = async (sport: 'football' | 'nba') => {
    setFeedback(null);
    try {
      const res = await fetch(`/api/config/apis?sport=${sport}`, { method: 'DELETE' });
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

  const renderStatus = (
    status: ApiConfigState['football'],
    label: string,
    fallbackHint?: string
  ) => {
    if (status.connected) {
      return (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/25 p-3 text-xs space-y-1">
          <div className="flex items-center gap-2 font-semibold text-emerald-400">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{label}: Conectado</span>
          </div>
          {status.accountInfo && <p className="text-slate-300">{status.accountInfo}</p>}
          {status.maskedKey && (
            <p className="font-mono text-slate-400">Clave cifrada: {status.maskedKey}</p>
          )}
        </div>
      );
    }
    if (status.error) {
      return (
        <div className="rounded-lg border border-rose-500/30 bg-rose-950/25 p-3 text-xs space-y-1">
          <div className="flex items-center gap-2 font-semibold text-rose-400">
            <XCircle className="w-4 h-4 shrink-0" />
            <span>{label}: Error de conexión</span>
          </div>
          <p className="text-rose-200">{status.error}</p>
          {fallbackHint && <p className="text-slate-300 pt-1">{fallbackHint}</p>}
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs space-y-1">
        <div className="flex items-center gap-2 font-semibold text-slate-300">
          <KeyRound className="w-4 h-4 text-slate-400 shrink-0" />
          <span>{label}: Sin configurar</span>
        </div>
        <p className="text-slate-400">
          {fallbackHint ??
            'Pega tu clave API abajo o selecciona una fuente pública gratuita para alimentar calendarios, clasificaciones y plantillas reales.'}
        </p>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-white">CONFIGURACIÓN DE APIS</h2>
          <p className="text-sm text-slate-400 mt-1">
            Introduce tus claves directamente o activa fuentes públicas oficiales. Todas las claves se cifran con AES-256-GCM en el servidor.
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
                  ? 'Sesión de administrador desbloqueada mediante cookie HttpOnly firmada. Puedes guardar, probar o desconectar proveedores.'
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
            {(config.football.maskedKey || config.football.connected) && (
              <button
                type="button"
                onClick={() => void handleClear('football')}
                disabled={!security.unlocked}
                className="text-xs text-slate-400 hover:text-rose-400 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Desconectar
              </button>
            )}
          </div>

          {renderStatus(config.football, 'API Fútbol')}

          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Proveedor de datos de Fútbol</span>
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
                Esta fuente no requiere API Key. Incluye LaLiga, Premier League, Bundesliga, Serie A, Ligue 1, Champions, Europa League y Conference League.
              </div>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-300">
                  Clave API de Fútbol {config.football.maskedKey ? `(actual: ${config.football.maskedKey})` : ''}
                </span>
                <div className="relative">
                  <input
                    type={fbShowKey ? 'text' : 'password'}
                    value={fbKeyInput}
                    onChange={(e) => setFbKeyInput(e.target.value)}
                    placeholder="Pega aquí tu token de football-data.org..."
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
                  Copia tu token desde <span className="font-mono text-blue-300">football-data.org/client/home</span>. Se complementa con competiciones europeas y clasificaciones reales.
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
              {fbZeroKey ? 'Activar fuente gratuita' : 'Guardar y conectar'}
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
            {(config.nba.maskedKey || config.nba.connected) && !reuseFbKey && (
              <button
                type="button"
                onClick={() => void handleClear('nba')}
                disabled={!security.unlocked}
                className="text-xs text-slate-400 hover:text-rose-400 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Desconectar
              </button>
            )}
          </div>

          {renderStatus(
            config.nba,
            'API NBA',
            'SportAnalytics AI mantiene activo el feed público oficial ESPN NBA como respaldo automático para el calendario, clasificaciones, lesiones y game logs.'
          )}

          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-300">Proveedor de datos de NBA</span>
              <select
                value={nbaProvider}
                onChange={(e) => setNbaProvider(e.target.value)}
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
                Fuente oficial sin clave: obtiene calendario completo de 16 días, clasificaciones Este/Oeste, reporte de lesiones (OUT/GTD), noticias externas NBA y game logs reales (L5/L10/L15).
              </div>
            ) : (
              <>
                <label className="flex items-center gap-2.5 min-h-[40px] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={reuseFbKey}
                    onChange={(e) => setReuseFbKey(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-xs text-slate-200">
                    Reutilizar la misma clave de API de Fútbol (útil para API-Sports)
                  </span>
                </label>

                {!reuseFbKey && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-slate-300">
                      Clave API de NBA {config.nba.maskedKey ? `(actual: ${config.nba.maskedKey})` : ''}
                    </span>
                    <div className="relative">
                      <input
                        type={nbaShowKey ? 'text' : 'password'}
                        value={nbaKeyInput}
                        onChange={(e) => setNbaKeyInput(e.target.value)}
                        placeholder="Pega aquí tu clave de basketballapi.net o API-Sports..."
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
                      Si el plan gratuito de tu API externa limita endpoints (HTTP 401/403), selecciona <span className="text-blue-300">ESPN NBA Oficial (Gratis / Sin clave)</span> arriba.
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
              {nbaZeroKey ? 'Activar fuente gratuita' : 'Guardar y conectar'}
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
            {nbaProvider !== 'espn-nba' && (
              <button
                type="button"
                onClick={() => {
                  setNbaProvider('espn-nba');
                  setReuseFbKey(false);
                  void handleSave('nba', 'espn-nba');
                }}
                disabled={nbaBusy !== null || !security.unlocked}
                className="min-h-[44px] px-3 py-2 rounded-lg border border-blue-500/30 bg-blue-950/20 hover:bg-blue-950/40 disabled:opacity-50 text-xs font-semibold text-blue-300 cursor-pointer"
              >
                Usar ESPN NBA (Gratis)
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
