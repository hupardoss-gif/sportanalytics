import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  ApiConfigState,
  LiveFeedSourceStatus,
  LoggedPrediction,
  MatchRecord,
  StandingEntry,
} from './src/types/sports.ts';
import { INITIAL_PREDICTION_HISTORY } from './src/data/sandboxData.ts';
import {
  fetchFootballCalendarAndStandings,
  fetchNbaCalendarAndStandings,
  hydrateLiveMatchDetails,
} from './server/liveAdapters.ts';
import {
  fetchEspnNbaCalendarAndStandings,
  teamsMatch,
} from './server/espnAdapters.ts';
import {
  applyNewsAndInjuriesToNbaPlayers,
  fetchNbaExternalNews,
  fetchOfficialNbaInjuriesFeed,
  normalizeNbaName,
  parseValidPublishedAt,
  queryGeminiNbaSearchGrounding,
} from './server/nbaIntelligence.ts';
import {
  buildProbableFootballLineups,
  resolveEspnSoccerIdsForMatch,
} from './server/footballIntelligence.ts';
import { evaluateFeedStaleness } from './server/dataHealth.ts';
import {
  createRequireConfigAdmin,
  decryptVaultSecret,
  encryptVaultSecret,
  isConfigRequestAuthorized,
  registerConfigAuthRoutes,
} from './server/configSecurity.ts';
import { fetchWithTimeout, writeFileAtomic } from './server/httpUtils.ts';

dotenv.config();

let liveCache: {
  expiresAt: number;
  payload: {
    matches: MatchRecord[];
    standings: StandingEntry[];
    errors: string[];
    sources: LiveFeedSourceStatus[];
    fetchedAt: string;
  };
} | null = null;

const PORT = 3000;
const VAULT_PATH = path.resolve(process.cwd(), '.sportanalytics-vault.json');
const HISTORY_PATH = path.resolve(process.cwd(), '.sportanalytics-history.json');

interface StoredSportConfig {
  provider: string;
  apiKey: string;
  connected: boolean;
  lastChecked: string | null;
  accountInfo: string | null;
  error: string | null;
}

interface StoredVault {
  adminPinHash?: string;
  football: StoredSportConfig;
  nba: StoredSportConfig & { reuseFootballKey: boolean };
}

const DEFAULT_VAULT: StoredVault = {
  football: {
    provider: 'football-data',
    apiKey: '',
    connected: false,
    lastChecked: null,
    accountInfo: null,
    error: null,
  },
  nba: {
    provider: 'espn-nba',
    apiKey: '',
    reuseFootballKey: false,
    connected: false,
    lastChecked: null,
    accountInfo: null,
    error: null,
  },
};

function maskKey(key: string): string | null {
  if (!key || key.length < 4) return key ? '••••' : null;
  return `••••••••${key.slice(-4)}`;
}

async function readVault(): Promise<StoredVault> {
  try {
    const raw = await fs.readFile(VAULT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredVault>;
    const fbKey = await decryptVaultSecret(parsed.football?.apiKey ?? '');
    const nbaKey = await decryptVaultSecret(parsed.nba?.apiKey ?? '');
    return {
      adminPinHash: typeof parsed.adminPinHash === 'string' ? parsed.adminPinHash : undefined,
      football: { ...DEFAULT_VAULT.football, ...(parsed.football ?? {}), apiKey: fbKey },
      nba: { ...DEFAULT_VAULT.nba, ...(parsed.nba ?? {}), apiKey: nbaKey },
    };
  } catch {
    return structuredClone(DEFAULT_VAULT);
  }
}

async function writeVault(vault: StoredVault): Promise<void> {
  const encryptedPayload: StoredVault = {
    adminPinHash: vault.adminPinHash,
    football: {
      ...vault.football,
      apiKey: await encryptVaultSecret(vault.football.apiKey),
    },
    nba: {
      ...vault.nba,
      apiKey: await encryptVaultSecret(vault.nba.apiKey),
    },
  };
  await writeFileAtomic(VAULT_PATH, JSON.stringify(encryptedPayload, null, 2), 0o600);
}

async function toPublicConfig(vault: StoredVault, req?: express.Request): Promise<ApiConfigState> {
  const effectiveNbaKey = vault.nba.reuseFootballKey
    ? vault.football.apiKey
    : vault.nba.apiKey;
  const fbZeroKey = vault.football.provider === 'espn-football';
  const nbaZeroKey = vault.nba.provider === 'espn-nba';
  const unlocked = req ? await isConfigRequestAuthorized(req, vault) : false;

  return {
    football: {
      connected: vault.football.connected && (fbZeroKey || Boolean(vault.football.apiKey)),
      provider: vault.football.provider,
      maskedKey: fbZeroKey ? null : maskKey(vault.football.apiKey),
      lastChecked: vault.football.lastChecked,
      accountInfo: vault.football.accountInfo,
      error: vault.football.error,
    },
    nba: {
      connected: vault.nba.connected && (nbaZeroKey || Boolean(effectiveNbaKey)),
      provider: vault.nba.provider,
      maskedKey: nbaZeroKey ? null : maskKey(effectiveNbaKey),
      reuseFootballKey: vault.nba.reuseFootballKey,
      lastChecked: vault.nba.lastChecked,
      accountInfo: vault.nba.accountInfo,
      error: vault.nba.error,
    },
    security: {
      pinConfigured: Boolean(vault.adminPinHash),
      unlocked,
      envProtected: Boolean(process.env.CONFIG_ADMIN_KEY?.trim()),
    },
  };
}

async function testProviderConnection(
  sport: 'football' | 'nba',
  provider: string,
  apiKey: string
): Promise<{ ok: boolean; accountInfo: string | null; error: string | null }> {
  try {
    if (provider === 'espn-football') {
      const res = await fetchWithTimeout(
        'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
        undefined,
        9000
      );
      if (!res.ok) {
        return { ok: false, accountInfo: null, error: `ESPN Soccer devolvió HTTP ${res.status}` };
      }
      return {
        ok: true,
        accountInfo: 'ESPN Soccer Oficial · Ligas europeas y competiciones UEFA (calendario y clasificaciones)',
        error: null,
      };
    }

    if (provider === 'espn-nba') {
      const res = await fetchWithTimeout(
        'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
        undefined,
        9000
      );
      if (!res.ok) {
        return { ok: false, accountInfo: null, error: `ESPN NBA devolvió HTTP ${res.status}` };
      }
      return {
        ok: true,
        accountInfo: 'ESPN NBA Oficial · Calendario, lesiones oficiales, clasificaciones y game logs',
        error: null,
      };
    }

    if (!apiKey.trim()) {
      return { ok: false, accountInfo: null, error: 'Introduce una clave API válida antes de comprobar.' };
    }

    if (provider === 'api-football' || (sport === 'football' && provider === 'api-sports')) {
      const res = await fetchWithTimeout(
        'https://v3.football.api-sports.io/status',
        { headers: { 'x-apisports-key': apiKey.trim() } },
        9000
      );
      const json = (await res.json().catch(() => ({}))) as {
        errors?: Record<string, string> | string[];
        response?: { account?: { email?: string }; subscription?: { plan?: string; active?: boolean }; requests?: { current?: number; limit_day?: number } };
      };
      const hasErr =
        !res.ok ||
        (json.errors && !Array.isArray(json.errors) && Object.keys(json.errors).length > 0) ||
        (Array.isArray(json.errors) && json.errors.length > 0);
      if (hasErr) {
        const msg =
          typeof json.errors === 'object' ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
        return { ok: false, accountInfo: null, error: `Error de autenticación API-Football: ${msg}` };
      }
      const plan = json.response?.subscription?.plan ?? 'Estándar';
      const reqs = json.response?.requests
        ? `${json.response.requests.current ?? 0}/${json.response.requests.limit_day ?? 0} req hoy`
        : 'Activa';
      return { ok: true, accountInfo: `API-Football · Plan ${plan} · ${reqs}`, error: null };
    }

    if (provider === 'football-data') {
      const res = await fetchWithTimeout(
        'https://api.football-data.org/v4/competitions',
        { headers: { 'X-Auth-Token': apiKey.trim() } },
        9000
      );
      if (!res.ok) {
        return {
          ok: false,
          accountInfo: null,
          error: `Football-Data.org devolvió HTTP ${res.status}. Verifica tu token.`,
        };
      }
      const json = (await res.json().catch(() => ({}))) as { count?: number };
      return {
        ok: true,
        accountInfo: `Football-Data.org v4 · ${json.count ?? 'Múltiples'} competiciones accesibles`,
        error: null,
      };
    }

    if (provider === 'api-basketball' || provider === 'api-nba') {
      const url =
        provider === 'api-nba'
          ? 'https://v2.nba.api-sports.io/status'
          : 'https://v1.basketball.api-sports.io/status';
      const res = await fetchWithTimeout(
        url,
        { headers: { 'x-apisports-key': apiKey.trim() } },
        9000
      );
      const json = (await res.json().catch(() => ({}))) as {
        errors?: Record<string, string> | string[];
        response?: { subscription?: { plan?: string }; requests?: { current?: number; limit_day?: number } };
      };
      const hasErr =
        !res.ok ||
        (json.errors && !Array.isArray(json.errors) && Object.keys(json.errors).length > 0) ||
        (Array.isArray(json.errors) && json.errors.length > 0);
      if (hasErr) {
        const msg =
          typeof json.errors === 'object' ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
        return { ok: false, accountInfo: null, error: `Error API-Sports NBA: ${msg}` };
      }
      const plan = json.response?.subscription?.plan ?? 'Estándar';
      const reqs = json.response?.requests
        ? `${json.response.requests.current ?? 0}/${json.response.requests.limit_day ?? 0} req hoy`
        : 'Activa';
      return {
        ok: true,
        accountInfo: `${provider === 'api-nba' ? 'API-NBA v2' : 'API-Basketball v1'} · Plan ${plan} · ${reqs}`,
        error: null,
      };
    }

    if (provider === 'basketballapi-net') {
      const token = apiKey.trim().replace(/^Bearer\s+/i, '');
      const headers = { Authorization: `Bearer ${token}` };

      const compRes = await fetchWithTimeout(
        'https://api.basketballapi.net/v1/competitions',
        { headers },
        9000
      );

      if (compRes.status === 401) {
        return {
          ok: false,
          accountInfo: null,
          error: 'BasketballAPI.net rechazó la clave (HTTP 401). Verifica tu Bearer token.',
        };
      }

      if (compRes.ok) {
        const compJson = (await compRes.json().catch(() => ({}))) as { data?: unknown[]; competitions?: unknown[] };
        const count = Array.isArray(compJson.data)
          ? compJson.data.length
          : Array.isArray(compJson.competitions)
            ? compJson.competitions.length
            : null;
        return {
          ok: true,
          accountInfo: `BasketballAPI.net v1 · Conectado${count ? ` (${count} competiciones disponibles)` : ''}`,
          error: null,
        };
      }

      const yestRes = await fetchWithTimeout(
        'https://api.basketballapi.net/v1/results/yesterday',
        { headers },
        9000
      );
      if (yestRes.ok) {
        return {
          ok: true,
          accountInfo: 'BasketballAPI.net v1 · Plan Free conectado (resultados de hoy y ayer)',
          error: null,
        };
      }

      const errBody = await yestRes.text().catch(() => '');
      return {
        ok: false,
        accountInfo: null,
        error: `BasketballAPI.net devolvió HTTP ${yestRes.status}. ${errBody ? errBody.slice(0, 140) : 'Verifica tu clave API.'}`,
      };
    }

    if (provider === 'balldontlie') {
      const res = await fetchWithTimeout(
        'https://api.balldontlie.io/v1/teams',
        { headers: { Authorization: apiKey.trim() } },
        9000
      );
      if (!res.ok) {
        return {
          ok: false,
          accountInfo: null,
          error: `BallDontLie devolvió HTTP ${res.status}. Revisa tu clave API.`,
        };
      }
      return { ok: true, accountInfo: 'BallDontLie NBA v1 · Conexión verificada', error: null };
    }

    return { ok: false, accountInfo: null, error: `Proveedor no reconocido: ${provider}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error de red desconocido';
    return { ok: false, accountInfo: null, error: `No se pudo contactar con el proveedor: ${message}` };
  }
}

function sanitizeHistoryList(rawList: unknown[]): LoggedPrediction[] {
  return rawList
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
    .map((x) => {
      const copy = { ...x };
      delete copy.bookmakerOdds;
      return copy as unknown as LoggedPrediction;
    });
}

async function readHistory(): Promise<LoggedPrediction[]> {
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizeHistoryList(parsed);
  } catch {
    await writeFileAtomic(HISTORY_PATH, JSON.stringify(INITIAL_PREDICTION_HISTORY, null, 2), 0o600);
    return INITIAL_PREDICTION_HISTORY;
  }
}

async function writeHistory(items: LoggedPrediction[]): Promise<void> {
  await writeFileAtomic(HISTORY_PATH, JSON.stringify(items, null, 2), 0o600);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const requireConfigAdmin = createRequireConfigAdmin(readVault);

  // 1. Config Auth & API Vault Configuration Routes (Server-side secret protection)
  registerConfigAuthRoutes(app, readVault, writeVault);

  app.get('/api/config/apis', async (req, res) => {
    const vault = await readVault();
    res.json(await toPublicConfig(vault, req));
  });

  app.post('/api/config/apis', requireConfigAdmin, async (req, res) => {
    try {
      const { sport, provider, apiKey, reuseFootballKey } = req.body as {
        sport: 'football' | 'nba';
        provider?: string;
        apiKey?: string;
        reuseFootballKey?: boolean;
      };

      if (sport !== 'football' && sport !== 'nba') {
        return res.status(400).json({ error: 'Deporte no válido; solo se admite football o nba.' });
      }

      const vault = await readVault();
      const now = new Date().toISOString();

      if (sport === 'football') {
        if (provider) vault.football.provider = provider;
        if (typeof apiKey === 'string' && apiKey.trim()) {
          vault.football.apiKey = apiKey.trim();
        }
        const test = await testProviderConnection(
          'football',
          vault.football.provider,
          vault.football.apiKey
        );
        vault.football.connected = test.ok;
        vault.football.accountInfo = test.accountInfo;
        vault.football.error = test.error;
        vault.football.lastChecked = now;

        if (vault.nba.reuseFootballKey && vault.football.apiKey) {
          const nbaTest = await testProviderConnection(
            'nba',
            vault.nba.provider,
            vault.football.apiKey
          );
          vault.nba.connected = nbaTest.ok;
          vault.nba.accountInfo = nbaTest.accountInfo;
          vault.nba.error = nbaTest.error;
          vault.nba.lastChecked = now;
        }
      } else {
        if (provider) vault.nba.provider = provider;
        if (typeof reuseFootballKey === 'boolean') {
          vault.nba.reuseFootballKey = reuseFootballKey;
        }
        if (typeof apiKey === 'string' && apiKey.trim() && !vault.nba.reuseFootballKey) {
          vault.nba.apiKey = apiKey.trim();
        }
        const keyToUse = vault.nba.reuseFootballKey
          ? vault.football.apiKey
          : vault.nba.apiKey;
        const test = await testProviderConnection('nba', vault.nba.provider, keyToUse);
        vault.nba.connected = test.ok;
        vault.nba.accountInfo = test.accountInfo;
        vault.nba.error = test.error;
        vault.nba.lastChecked = now;
      }

      liveCache = null;
      await writeVault(vault);
      return res.json(await toPublicConfig(vault, req));
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Error guardando configuración API',
      });
    }
  });

  app.post('/api/config/apis/test', requireConfigAdmin, async (req, res) => {
    try {
      const { sport, provider, apiKey, reuseFootballKey } = req.body as {
        sport: 'football' | 'nba';
        provider?: string;
        apiKey?: string;
        reuseFootballKey?: boolean;
      };

      if (sport !== 'football' && sport !== 'nba') {
        return res.status(400).json({ error: 'Deporte no válido; solo se admite football o nba.' });
      }

      const vault = await readVault();
      const now = new Date().toISOString();

      const targetProvider =
        provider ?? (sport === 'football' ? vault.football.provider : vault.nba.provider);

      let targetKey = apiKey?.trim() ?? '';
      if (!targetKey) {
        if (sport === 'football') {
          targetKey = vault.football.apiKey;
        } else {
          const useFb =
            typeof reuseFootballKey === 'boolean' ? reuseFootballKey : vault.nba.reuseFootballKey;
          targetKey = useFb ? vault.football.apiKey : vault.nba.apiKey;
        }
      }

      const result = await testProviderConnection(sport, targetProvider, targetKey);
      if (sport === 'football') {
        vault.football.connected = result.ok;
        vault.football.accountInfo = result.accountInfo;
        vault.football.error = result.error;
        vault.football.lastChecked = now;
      } else {
        vault.nba.connected = result.ok;
        vault.nba.accountInfo = result.accountInfo;
        vault.nba.error = result.error;
        vault.nba.lastChecked = now;
      }
      liveCache = null;
      await writeVault(vault);
      return res.json({ result, config: await toPublicConfig(vault, req) });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Error comprobando conexión API',
      });
    }
  });

  app.delete('/api/config/apis', requireConfigAdmin, async (req, res) => {
    const sport = (req.query.sport as string) || 'all';
    const vault = await readVault();
    if (sport === 'football' || sport === 'all') {
      vault.football = structuredClone(DEFAULT_VAULT.football);
    }
    if (sport === 'nba' || sport === 'all') {
      vault.nba = structuredClone(DEFAULT_VAULT.nba);
    }
    liveCache = null;
    await writeVault(vault);
    res.json(await toPublicConfig(vault, req));
  });

  // 2. Live Sports Data Proxy Routes (Multi-day Calendar, Standings & On-Demand Match Hydration)
  app.get('/api/sports/live', async (req, res) => {
    const forceRefresh = req.query.refresh === '1';
    const vault = await readVault();

    if (!forceRefresh && liveCache && Date.now() < liveCache.expiresAt) {
      return res.json({
        config: await toPublicConfig(vault, req),
        ...liveCache.payload,
        feedMeta: evaluateFeedStaleness({
          fetchedAt: liveCache.payload.fetchedAt,
          fromCache: true,
          sources: liveCache.payload.sources,
          errors: liveCache.payload.errors,
        }),
      });
    }

    const matches: MatchRecord[] = [];
    const standings: StandingEntry[] = [];
    const errors: string[] = [];
    const sources: LiveFeedSourceStatus[] = [];

    const fbProvider =
      vault.football.connected &&
      (vault.football.provider === 'espn-football' || vault.football.apiKey)
        ? vault.football.provider
        : 'espn-football';
    const fbKey = fbProvider === vault.football.provider ? vault.football.apiKey : '';

    try {
      const fb = await fetchFootballCalendarAndStandings(fbProvider, fbKey);
      matches.push(...fb.matches);
      standings.push(...fb.standings);
      sources.push({
        sport: 'football',
        provider: fbProvider,
        status: 'ok',
        updatedAt: new Date().toISOString(),
        matchCount: fb.matches.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error obteniendo calendario de fútbol';
      errors.push(msg);
      sources.push({
        sport: 'football',
        provider: fbProvider,
        status: 'error',
        updatedAt: new Date().toISOString(),
        matchCount: 0,
        error: msg,
      });
    }

    const nbaKey = vault.nba.reuseFootballKey ? vault.football.apiKey : vault.nba.apiKey;
    const nbaProvider =
      vault.nba.connected && (vault.nba.provider === 'espn-nba' || nbaKey)
        ? vault.nba.provider
        : 'espn-nba';
    const effNbaKey = nbaProvider === vault.nba.provider ? nbaKey : '';

    try {
      const nba = await fetchNbaCalendarAndStandings(nbaProvider, effNbaKey);
      matches.push(...nba.matches);
      standings.push(...nba.standings);
      sources.push({
        sport: 'nba',
        provider: nbaProvider,
        status: 'ok',
        updatedAt: new Date().toISOString(),
        matchCount: nba.matches.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error obteniendo calendario de NBA';
      errors.push(msg);
      sources.push({
        sport: 'nba',
        provider: nbaProvider,
        status: 'error',
        updatedAt: new Date().toISOString(),
        matchCount: 0,
        error: msg,
      });
    }

    const fetchedAt = new Date().toISOString();
    const payload = {
      matches,
      standings,
      errors,
      sources,
      fetchedAt,
    };

    // Never cache failed responses as fresh valid cache
    if (errors.length === 0) {
      liveCache = {
        expiresAt: Date.now() + 180_000,
        payload,
      };
    } else {
      liveCache = null;
    }

    res.json({
      config: await toPublicConfig(vault, req),
      ...payload,
      feedMeta: evaluateFeedStaleness({
        fetchedAt,
        fromCache: false,
        sources,
        errors,
      }),
    });
  });

  app.post('/api/sports/match/hydrate', async (req, res) => {
    try {
      const { match } = req.body as { match: MatchRecord };
      if (!match || match.isOfflineReference) {
        return res.json({ match });
      }
      if (match.id.startsWith('espn-nba-')) {
        const hydrated = await hydrateLiveMatchDetails(match, 'espn-nba', '');
        return res.json({ match: hydrated });
      }
      if (match.id.startsWith('espnsoc-')) {
        const hydrated = await hydrateLiveMatchDetails(match, 'espn-football', '');
        return res.json({ match: hydrated });
      }

      const vault = await readVault();
      if (match.sport === 'football' && vault.football.connected && vault.football.apiKey) {
        const hydrated = await hydrateLiveMatchDetails(
          match,
          vault.football.provider,
          vault.football.apiKey
        );
        return res.json({ match: hydrated });
      }
      const nbaKey = vault.nba.reuseFootballKey ? vault.football.apiKey : vault.nba.apiKey;
      if (match.sport === 'nba') {
        const hydrated = await hydrateLiveMatchDetails(
          match,
          vault.nba.connected && nbaKey ? vault.nba.provider : 'espn-nba',
          nbaKey
        );
        return res.json({ match: hydrated });
      }
      return res.json({
        match: {
          ...match,
          hydrationStatus: 'provider_unavailable',
          hydrationNote:
            'El proveedor configurado para este deporte no está conectado en Configuración de APIs.',
        },
      });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Error hidratando detalle del partido',
      });
    }
  });

  // 2B. Real-Time NBA Injuries, Lineups & External News Refresh Route
  app.post('/api/nba/match/refresh-news', async (req, res) => {
    try {
      const { match, includeSearchGrounding = true } = req.body as {
        match: MatchRecord;
        includeSearchGrounding?: boolean;
      };
      if (!match || match.sport !== 'nba' || match.isOfflineReference) {
        return res.json({ match });
      }

      let workingMatch = match;
      if (workingMatch.homePlayers.length === 0 && workingMatch.awayPlayers.length === 0) {
        workingMatch = await hydrateLiveMatchDetails(workingMatch, 'espn-nba', '');
      }

      let homeEspnId = workingMatch.homeTeam.id.startsWith('espn-nba-team-')
        ? workingMatch.homeTeam.id.replace('espn-nba-team-', '')
        : workingMatch.homeTeam.id.startsWith('espn-nba-t-')
          ? workingMatch.homeTeam.id.replace('espn-nba-t-', '')
          : '';
      let awayEspnId = workingMatch.awayTeam.id.startsWith('espn-nba-team-')
        ? workingMatch.awayTeam.id.replace('espn-nba-team-', '')
        : workingMatch.awayTeam.id.startsWith('espn-nba-t-')
          ? workingMatch.awayTeam.id.replace('espn-nba-t-', '')
          : '';

      if (!homeEspnId || !awayEspnId) {
        const espnCal = await fetchEspnNbaCalendarAndStandings().catch(() => ({
          matches: [] as MatchRecord[],
          standings: [] as StandingEntry[],
        }));
        const matched = espnCal.matches.find(
          (em) =>
            teamsMatch(em.homeTeam.name, workingMatch.homeTeam.name) &&
            teamsMatch(em.awayTeam.name, workingMatch.awayTeam.name)
        );
        if (matched) {
          homeEspnId = matched.homeTeam.id.replace('espn-nba-team-', '').replace('espn-nba-t-', '');
          awayEspnId = matched.awayTeam.id.replace('espn-nba-team-', '').replace('espn-nba-t-', '');
        }
      }

      const injFeed = await fetchOfficialNbaInjuriesFeed(true);
      const homeInjuries = homeEspnId
        ? injFeed.byTeamId.get(homeEspnId) ?? []
        : injFeed.all.filter((i) => teamsMatch(i.teamName, workingMatch.homeTeam.name));
      const awayInjuries = awayEspnId
        ? injFeed.byTeamId.get(awayEspnId) ?? []
        : injFeed.all.filter((i) => teamsMatch(i.teamName, workingMatch.awayTeam.name));
      const injuriesForMatch = [...homeInjuries, ...awayInjuries];

      const playerNames = [...workingMatch.homePlayers, ...workingMatch.awayPlayers].map(
        (p) => p.name
      );

      const [externalNews, grounding] = await Promise.all([
        fetchNbaExternalNews({
          homeEspnId,
          awayEspnId,
          homeTeamName: workingMatch.homeTeam.name,
          awayTeamName: workingMatch.awayTeam.name,
          homeShort: workingMatch.homeTeam.shortName,
          awayShort: workingMatch.awayTeam.shortName,
          playerNames,
          injuriesForMatch,
          forceRefresh: true,
        }),
        includeSearchGrounding
          ? queryGeminiNbaSearchGrounding(workingMatch)
          : Promise.resolve({
              available: Boolean(process.env.GEMINI_API_KEY?.trim()),
              used: false,
              status: 'unconfigured' as const,
              message: 'Búsqueda web omitida en esta consulta.',
              citations: undefined as Array<{ title: string; url: string }> | undefined,
            }),
      ]);

      const nowIso = new Date().toISOString();
      const mergedNewsItems = [...externalNews.items];
      const sourcesChecked = [...externalNews.sourcesChecked];

      let updatedHomePlayers = applyNewsAndInjuriesToNbaPlayers(
        workingMatch.homePlayers,
        homeInjuries,
        mergedNewsItems,
        workingMatch.lineupStatus === 'confirmed'
      );
      let updatedAwayPlayers = applyNewsAndInjuriesToNbaPlayers(
        workingMatch.awayPlayers,
        awayInjuries,
        mergedNewsItems,
        workingMatch.lineupStatus === 'confirmed'
      );

      if (grounding.status === 'active') {
        sourcesChecked.push('Google Search Grounding (Gemini Web Search)');
        for (const f of grounding.findings ?? []) {
          const normPlayer = normalizeNbaName(f.playerName);
          // Strictly preserve upstream publishedAt without fabricating fallback dates
          const publishedAt = parseValidPublishedAt(f.publishedAt);
          mergedNewsItems.unshift({
            id: `ground-${normPlayer}-${Date.now()}`,
            source: f.source || 'Google Search Grounding',
            publishedAt,
            headline: `${f.playerName} · ${f.status}`,
            summary: f.summary,
            url: grounding.citations?.[0]?.url,
            confirmed: Boolean(f.confirmed),
            playerNames: [f.playerName],
            statusTag: f.confirmed ? 'Verificado Web' : 'Medio / Rumor',
          });

          const applyFinding = (list: typeof updatedHomePlayers) =>
            list.map((p) => {
              if (normalizeNbaName(p.name) !== normPlayer) return p;
              // Never overwrite a confirmed official status with an unconfirmed rumor
              if (p.availabilityConfidence === 'confirmed' && !f.confirmed) {
                return {
                  ...p,
                  latestNews: {
                    source: f.source || 'Google Search Grounding',
                    publishedAt,
                    summary: f.summary,
                    url: grounding.citations?.[0]?.url,
                    confirmed: false,
                  },
                };
              }
              return {
                ...p,
                availability: f.status,
                availabilityConfidence: f.confirmed ? ('confirmed' as const) : ('rumor' as const),
                injuryNote: f.summary,
                minutesRestriction: f.minutesLimit
                  ? {
                      maxMinutes: f.minutesLimit,
                      note: `Límite estimado ~${f.minutesLimit} min (${f.source})`,
                    }
                  : p.minutesRestriction,
                latestNews: {
                  source: f.source || 'Google Search Grounding',
                  publishedAt,
                  summary: f.summary,
                  url: grounding.citations?.[0]?.url,
                  confirmed: Boolean(f.confirmed),
                },
              };
            });

          updatedHomePlayers = applyFinding(updatedHomePlayers);
          updatedAwayPlayers = applyFinding(updatedAwayPlayers);
        }
      }

      const updatedMatch: MatchRecord = {
        ...workingMatch,
        homePlayers: updatedHomePlayers,
        awayPlayers: updatedAwayPlayers,
        lineupStatus:
          workingMatch.lineupStatus === 'confirmed'
            ? 'confirmed'
            : updatedHomePlayers.length > 0 && updatedAwayPlayers.length > 0
              ? 'provisional'
              : workingMatch.lineupStatus,
        nbaNews: {
          fetchedAt: nowIso,
          sourcesChecked,
          searchGrounding: {
            available: grounding.available,
            used: grounding.used,
            status: grounding.status,
            message: grounding.message,
            citations: grounding.citations,
          },
          items: mergedNewsItems.slice(0, 20),
        },
        updatedAt: nowIso,
      };

      return res.json({ match: updatedMatch });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Error actualizando noticias NBA',
      });
    }
  });

  // 2C. Real-Time Football Probable vs Confirmed Lineups, Club Releases & Press Refresh Route
  app.post('/api/football/match/refresh-lineups', async (req, res) => {
    try {
      const { match, includeSearchGrounding = true } = req.body as {
        match: MatchRecord;
        includeSearchGrounding?: boolean;
      };
      if (!match || match.sport !== 'football' || match.isOfflineReference) {
        return res.json({ match });
      }

      const vault = await readVault();
      let workingMatch = match;

      // Re-hydrate from primary live provider first to catch newly confirmed official starting XIs
      if (match.id.startsWith('espnsoc-')) {
        workingMatch = await hydrateLiveMatchDetails(workingMatch, 'espn-football', '');
      } else if (vault.football.connected && vault.football.apiKey) {
        workingMatch = await hydrateLiveMatchDetails(
          workingMatch,
          vault.football.provider,
          vault.football.apiKey
        );
      }

      // If official lineup was just published, ensure probableLineup is preserved cleanly alongside confirmedLineup
      if (workingMatch.lineupStatus === 'confirmed' && workingMatch.confirmedLineup) {
        if (!workingMatch.probableLineup && match.probableLineup) {
          workingMatch.probableLineup = match.probableLineup;
        }
        return res.json({ match: workingMatch });
      }

      // Otherwise refresh probable lineups + RSS + Google Search Grounding (club websites & Marca/AS/MD/SPORT/Relevo/ESPN/BBC/Sky)
      const espnIds = await resolveEspnSoccerIdsForMatch(
        workingMatch.competition,
        workingMatch.homeTeam.name,
        workingMatch.awayTeam.name
      );
      const bundle = await buildProbableFootballLineups({
        match: workingMatch,
        slug: espnIds.slug,
        homeEspnTeamId: espnIds.homeEspnTeamId,
        awayEspnTeamId: espnIds.awayEspnTeamId,
        includeSearchGrounding,
        forceRefresh: true,
      });

      const nowIso = new Date().toISOString();
      const updatedHome = bundle.homePlayers.length >= 11 ? bundle.homePlayers : workingMatch.homePlayers;
      const updatedAway = bundle.awayPlayers.length >= 11 ? bundle.awayPlayers : workingMatch.awayPlayers;
      const hasLineups = updatedHome.length > 0 || updatedAway.length > 0;

      const updatedMatch: MatchRecord = {
        ...workingMatch,
        homeTeam: {
          ...workingMatch.homeTeam,
          formation: bundle.homeFormation ?? workingMatch.homeTeam.formation,
        },
        awayTeam: {
          ...workingMatch.awayTeam,
          formation: bundle.awayFormation ?? workingMatch.awayTeam.formation,
        },
        lineupStatus: hasLineups ? 'provisional' : 'unknown',
        homePlayers: updatedHome,
        awayPlayers: updatedAway,
        probableLineup: bundle.probableLineup ?? workingMatch.probableLineup,
        footballNews: bundle.footballNews,
        hydrationStatus: hasLineups ? 'ok' : 'not_published',
        hydrationNote: hasLineups
          ? 'Alineación probable actualizada con fuentes deportivas y estado reciente.'
          : 'Sin novedades suficientes para proyectar el once todavía.',
        provenance: {
          source: bundle.footballNews.sourcesChecked.slice(0, 4).join(' · ') || workingMatch.dataOrigin,
          fetchedAt: nowIso,
          status: hasLineups ? 'ok' : 'partial',
          isStale: false,
          staleAgeMinutes: 0,
          dataType: hasLineups ? 'estimated' : 'unavailable',
        },
        updatedAt: nowIso,
      };

      return res.json({ match: updatedMatch });
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : 'Error actualizando alineaciones de fútbol',
      });
    }
  });

  // 3. Server-Side Gemini AI Analyst Route
  app.post('/api/ai/explain', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error:
          'GEMINI_API_KEY no está configurada en el servidor. Añádela en Settings > Secrets para activar el analista explicativo.',
      });
    }

    try {
      const { contextType, payload } = req.body as {
        contextType: 'match' | 'player_prop';
        payload: Record<string, unknown>;
      };

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const systemInstruction = `Eres el analista cuantitativo de SportAnalytics AI.
Reglas estrictas e inquebrantables:
1. Responde siempre en español claro, técnico y preciso.
2. Explica ÚNICAMENTE utilizando los números, probabilidades, alineaciones, bajas y métricas estadísticas exactas recibidas en el JSON de entrada.
3. NUNCA inventes estadísticas, lesiones, fechas ni probabilidades independientes, y NO hagas referencias a casas de apuestas o cuotas.
4. Diferencia claramente entre datos verificados, estimaciones posicionales, rumores de prensa e información no disponible.
5. Señala siempre factores favorables, factores desfavorables, impacto de ausencias/rotaciones y la incertidumbre estadística real del modelo.`;

      const prompt = `Tipo de análisis: ${contextType}
Datos exactos calculados por los modelos matemáticos de SportAnalytics AI:
${JSON.stringify(payload, null, 2)}

Genera una explicación estructurada con resumen estadístico, factores favorables, factores desfavorables, impacto de disponibilidad/bajas y nota de incertidumbre.`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: 'Resumen cuantitativo conciso basado exclusivamente en los datos del modelo.',
              },
              favorableFactors: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Factores estadísticos que respaldan la proyección.',
              },
              unfavorableFactors: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Riesgos estadísticos, factores contrarios o regresiones.',
              },
              absenceImpact: {
                type: Type.STRING,
                description: 'Explicación del efecto de bajas, dudas o rotaciones en los números.',
              },
              uncertaintyNote: {
                type: Type.STRING,
                description: 'Nota sobre varianza, tamaño muestral, calidad de los datos y fiabilidad.',
              },
            },
            required: [
              'summary',
              'favorableFactors',
              'unfavorableFactors',
              'absenceImpact',
              'uncertaintyNote',
            ],
          },
        },
      });

      const text = (response.text ?? '{}').trim();
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error consultando Gemini AI';
      res.status(500).json({ error: msg });
    }
  });

  // 4. Prediction History & Calibration Persistence Routes
  app.get('/api/history', async (_req, res) => {
    const items = await readHistory();
    res.json(items);
  });

  app.post('/api/history', async (req, res) => {
    const items = await readHistory();
    const entry = req.body as Record<string, unknown>;
    const cleanEntry = { ...entry };
    delete cleanEntry.bookmakerOdds;
    const next: LoggedPrediction = {
      ...(cleanEntry as unknown as LoggedPrediction),
      id: typeof cleanEntry.id === 'string' && cleanEntry.id ? cleanEntry.id : `pred-${Date.now()}`,
      createdAt:
        typeof cleanEntry.createdAt === 'string' && cleanEntry.createdAt
          ? cleanEntry.createdAt
          : new Date().toISOString(),
      status:
        cleanEntry.status === 'won' || cleanEntry.status === 'lost' || cleanEntry.status === 'pending'
          ? cleanEntry.status
          : 'pending',
    };
    const updated = [next, ...items];
    await writeHistory(updated);
    res.json(updated);
  });

  app.patch('/api/history/:id', async (req, res) => {
    const { id } = req.params;
    const { status, actualValue } = req.body as {
      status: 'won' | 'lost' | 'pending';
      actualValue?: number;
    };
    const items = await readHistory();
    const updated = items.map((item) =>
      item.id === id
        ? {
            ...item,
            status,
            actualValue:
              typeof actualValue === 'number' && Number.isFinite(actualValue)
                ? actualValue
                : item.actualValue,
            resolvedAt: status === 'pending' ? undefined : new Date().toISOString(),
          }
        : item
    );
    await writeHistory(updated);
    res.json(updated);
  });

  // Vite Dev Middleware or Static Prod Build
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SportAnalytics AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
