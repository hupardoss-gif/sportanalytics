import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  ApiConfigState,
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
  fetchTheOddsApiForSport,
  mergeRealOddsIntoMatches,
  teamsMatch,
} from './server/espnAdapters.ts';
import {
  applyNewsAndInjuriesToNbaPlayers,
  fetchNbaExternalNews,
  fetchOfficialNbaInjuriesFeed,
  normalizeNbaName,
  queryGeminiNbaSearchGrounding,
} from './server/nbaIntelligence.ts';

dotenv.config();

let liveCache: {
  expiresAt: number;
  payload: {
    matches: MatchRecord[];
    standings: StandingEntry[];
    errors: string[];
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
  football: StoredSportConfig;
  nba: StoredSportConfig & { reuseFootballKey: boolean };
  odds: StoredSportConfig;
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
  odds: {
    provider: 'the-odds-api',
    apiKey: '',
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
    return {
      football: { ...DEFAULT_VAULT.football, ...(parsed.football ?? {}) },
      nba: { ...DEFAULT_VAULT.nba, ...(parsed.nba ?? {}) },
      odds: { ...DEFAULT_VAULT.odds, ...(parsed.odds ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_VAULT);
  }
}

async function writeVault(vault: StoredVault): Promise<void> {
  await fs.writeFile(VAULT_PATH, JSON.stringify(vault, null, 2), 'utf8');
}

function toPublicConfig(vault: StoredVault): ApiConfigState {
  const effectiveNbaKey = vault.nba.reuseFootballKey
    ? vault.football.apiKey
    : vault.nba.apiKey;
  const fbZeroKey = vault.football.provider === 'espn-football';
  const nbaZeroKey = vault.nba.provider === 'espn-nba';

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
    odds: {
      connected: vault.odds.connected && Boolean(vault.odds.apiKey),
      provider: vault.odds.provider,
      maskedKey: maskKey(vault.odds.apiKey),
      lastChecked: vault.odds.lastChecked,
      accountInfo: vault.odds.accountInfo,
      error: vault.odds.error,
    },
  };
}

async function testProviderConnection(
  sport: 'football' | 'nba' | 'odds',
  provider: string,
  apiKey: string
): Promise<{ ok: boolean; accountInfo: string | null; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    if (provider === 'espn-football') {
      const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard', {
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, accountInfo: null, error: `ESPN Soccer devolvió HTTP ${res.status}` };
      }
      return {
        ok: true,
        accountInfo: 'ESPN Soccer Oficial + DraftKings · 8 competiciones (incl. Europa y Conference League)',
        error: null,
      };
    }

    if (provider === 'espn-nba') {
      const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', {
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, accountInfo: null, error: `ESPN NBA devolvió HTTP ${res.status}` };
      }
      return {
        ok: true,
        accountInfo: 'ESPN NBA Oficial + Cuotas DraftKings · Calendario, lesiones, clasificaciones y game logs',
        error: null,
      };
    }

    if (!apiKey.trim()) {
      return { ok: false, accountInfo: null, error: 'Introduce una clave API válida antes de comprobar.' };
    }
    if (provider === 'api-football' || (sport === 'football' && provider === 'api-sports')) {
      const res = await fetch('https://v3.football.api-sports.io/status', {
        headers: { 'x-apisports-key': apiKey.trim() },
        signal: controller.signal,
      });
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
      const res = await fetch('https://api.football-data.org/v4/competitions', {
        headers: { 'X-Auth-Token': apiKey.trim() },
        signal: controller.signal,
      });
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
      const res = await fetch(url, {
        headers: { 'x-apisports-key': apiKey.trim() },
        signal: controller.signal,
      });
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

      const compRes = await fetch('https://api.basketballapi.net/v1/competitions', {
        headers,
        signal: controller.signal,
      });

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

      // Fallback check on /v1/results/yesterday (included in Free tier)
      const yestRes = await fetch('https://api.basketballapi.net/v1/results/yesterday', {
        headers,
        signal: controller.signal,
      });
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
      const res = await fetch('https://api.balldontlie.io/v1/teams', {
        headers: { Authorization: apiKey.trim() },
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          ok: false,
          accountInfo: null,
          error: `BallDontLie devolvió HTTP ${res.status}. Revisa tu clave API.`,
        };
      }
      return { ok: true, accountInfo: 'BallDontLie NBA v1 · Conexión verificada', error: null };
    }

    if (provider === 'the-odds-api') {
      const res = await fetch(
        `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(apiKey.trim())}`,
        { signal: controller.signal }
      );
      if (!res.ok) {
        return {
          ok: false,
          accountInfo: null,
          error: `The Odds API devolvió HTTP ${res.status}. Verifica tu API key.`,
        };
      }
      const remaining = res.headers.get('x-requests-remaining');
      return {
        ok: true,
        accountInfo: `The Odds API v4 · Cuotas en vivo${remaining ? ` · ${remaining} créditos restantes` : ''}`,
        error: null,
      };
    }

    return { ok: false, accountInfo: null, error: `Proveedor no reconocido: ${provider}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error de red desconocido';
    return { ok: false, accountInfo: null, error: `No se pudo contactar con el proveedor: ${message}` };
  } finally {
    clearTimeout(timeout);
  }
}


async function readHistory(): Promise<LoggedPrediction[]> {
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8');
    return JSON.parse(raw) as LoggedPrediction[];
  } catch {
    await fs.writeFile(HISTORY_PATH, JSON.stringify(INITIAL_PREDICTION_HISTORY, null, 2), 'utf8');
    return INITIAL_PREDICTION_HISTORY;
  }
}

async function writeHistory(items: LoggedPrediction[]): Promise<void> {
  await fs.writeFile(HISTORY_PATH, JSON.stringify(items, null, 2), 'utf8');
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 1. API Vault Configuration Routes (Server-side secret protection)
  app.get('/api/config/apis', async (_req, res) => {
    const vault = await readVault();
    res.json(toPublicConfig(vault));
  });

  app.post('/api/config/apis', async (req, res) => {
    try {
      const { sport, provider, apiKey, reuseFootballKey } = req.body as {
        sport: 'football' | 'nba' | 'odds';
        provider?: string;
        apiKey?: string;
        reuseFootballKey?: boolean;
      };

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

        // If NBA is configured to reuse Football key, re-check NBA too
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
      } else if (sport === 'nba') {
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
      } else if (sport === 'odds') {
        if (provider) vault.odds.provider = provider;
        if (typeof apiKey === 'string' && apiKey.trim()) {
          vault.odds.apiKey = apiKey.trim();
        }
        const test = await testProviderConnection('odds', vault.odds.provider, vault.odds.apiKey);
        vault.odds.connected = test.ok;
        vault.odds.accountInfo = test.accountInfo;
        vault.odds.error = test.error;
        vault.odds.lastChecked = now;
      }

      liveCache = null;
      await writeVault(vault);
      res.json(toPublicConfig(vault));
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error guardando configuración API',
      });
    }
  });

  app.post('/api/config/apis/test', async (req, res) => {
    try {
      const { sport, provider, apiKey, reuseFootballKey } = req.body as {
        sport: 'football' | 'nba' | 'odds';
        provider?: string;
        apiKey?: string;
        reuseFootballKey?: boolean;
      };
      const vault = await readVault();
      const now = new Date().toISOString();

      const targetProvider =
        provider ??
        (sport === 'football'
          ? vault.football.provider
          : sport === 'nba'
            ? vault.nba.provider
            : vault.odds.provider);

      let targetKey = apiKey?.trim() ?? '';
      if (!targetKey) {
        if (sport === 'football') {
          targetKey = vault.football.apiKey;
        } else if (sport === 'nba') {
          const useFb =
            typeof reuseFootballKey === 'boolean' ? reuseFootballKey : vault.nba.reuseFootballKey;
          targetKey = useFb ? vault.football.apiKey : vault.nba.apiKey;
        } else {
          targetKey = vault.odds.apiKey;
        }
      }

      const result = await testProviderConnection(sport, targetProvider, targetKey);
      if (sport === 'football') {
        vault.football.connected = result.ok;
        vault.football.accountInfo = result.accountInfo;
        vault.football.error = result.error;
        vault.football.lastChecked = now;
      } else if (sport === 'nba') {
        vault.nba.connected = result.ok;
        vault.nba.accountInfo = result.accountInfo;
        vault.nba.error = result.error;
        vault.nba.lastChecked = now;
      } else {
        vault.odds.connected = result.ok;
        vault.odds.accountInfo = result.accountInfo;
        vault.odds.error = result.error;
        vault.odds.lastChecked = now;
      }
      liveCache = null;
      await writeVault(vault);
      res.json({ result, config: toPublicConfig(vault) });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Error comprobando conexión API',
      });
    }
  });

  app.delete('/api/config/apis', async (req, res) => {
    const sport = (req.query.sport as string) || 'all';
    const vault = await readVault();
    if (sport === 'football' || sport === 'all') {
      vault.football = structuredClone(DEFAULT_VAULT.football);
    }
    if (sport === 'nba' || sport === 'all') {
      vault.nba = structuredClone(DEFAULT_VAULT.nba);
    }
    if (sport === 'odds' || sport === 'all') {
      vault.odds = structuredClone(DEFAULT_VAULT.odds);
    }
    liveCache = null;
    await writeVault(vault);
    res.json(toPublicConfig(vault));
  });

  // 2. Live Sports Data Proxy Routes (Multi-day Calendar, Standings & On-Demand Match Hydration)
  app.get('/api/sports/live', async (req, res) => {
    const forceRefresh = req.query.refresh === '1';
    const vault = await readVault();

    if (!forceRefresh && liveCache && Date.now() < liveCache.expiresAt) {
      return res.json({
        config: toPublicConfig(vault),
        ...liveCache.payload,
      });
    }

    let matches: MatchRecord[] = [];
    const standings: StandingEntry[] = [];
    const errors: string[] = [];

    if (
      vault.football.connected &&
      (vault.football.provider === 'espn-football' || vault.football.apiKey)
    ) {
      try {
        const fb = await fetchFootballCalendarAndStandings(
          vault.football.provider,
          vault.football.apiKey
        );
        matches.push(...fb.matches);
        standings.push(...fb.standings);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Error obteniendo calendario de fútbol');
      }
    } else if (!vault.football.connected) {
      // Provide public ESPN Soccer calendar + DraftKings odds if no Football API key is configured yet
      try {
        const fbPublic = await fetchFootballCalendarAndStandings('espn-football', '');
        matches.push(...fbPublic.matches);
      } catch {
        // Ignore silent fallback error
      }
    }

    const nbaKey = vault.nba.reuseFootballKey ? vault.football.apiKey : vault.nba.apiKey;
    if (
      vault.nba.connected &&
      (vault.nba.provider === 'espn-nba' || nbaKey)
    ) {
      try {
        const nba = await fetchNbaCalendarAndStandings(vault.nba.provider, nbaKey);
        matches.push(...nba.matches);
        standings.push(...nba.standings);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Error obteniendo calendario de NBA');
      }
    } else {
      // Automatic public ESPN NBA feed so NBA calendar, standings, injuries & DraftKings odds always work
      try {
        const nbaPublic = await fetchNbaCalendarAndStandings('espn-nba', '');
        matches.push(...nbaPublic.matches);
        standings.push(...nbaPublic.standings);
      } catch {
        // Ignore silent fallback error
      }
    }

    // Optional The Odds API multi-bookmaker enrichment
    if (vault.odds.connected && vault.odds.apiKey) {
      try {
        const [fbOdds, nbaOdds] = await Promise.all([
          fetchTheOddsApiForSport('football', vault.odds.apiKey),
          fetchTheOddsApiForSport('nba', vault.odds.apiKey),
        ]);
        matches = mergeRealOddsIntoMatches(matches, [...fbOdds, ...nbaOdds]);
      } catch {
        // Keep primary odds cleanly if optional Odds API fails
      }
    }

    const payload = {
      matches,
      standings,
      errors,
      fetchedAt: new Date().toISOString(),
    };
    liveCache = {
      expiresAt: Date.now() + 180_000,
      payload,
    };

    res.json({
      config: toPublicConfig(vault),
      ...payload,
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
          const publishedAt = f.publishedAt || nowIso;
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
        contextType: 'match' | 'player_prop' | 'odds_discrepancy';
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
2. Explica ÚNICAMENTE utilizando los números, probabilidades, alineaciones, bajas y discrepancias exactas recibidas en el JSON de entrada.
3. NUNCA inventes estadísticas, lesiones, cuotas, historiales ni probabilidades independientes.
4. Señala siempre factores favorables, factores desfavorables, impacto de ausencias/rotaciones y la incertidumbre real del modelo (varianza, muestra, alineaciones provisionales).
5. Nunca garantices resultados ni presentes una ventaja estadística como apuesta segura.`;

      const prompt = `Tipo de análisis: ${contextType}
Datos exactos calculados por los modelos matemáticos de SportAnalytics AI:
${JSON.stringify(payload, null, 2)}

Genera una explicación estructurada con resumen ejecutivo, factores favorables, factores desfavorables, impacto de disponibilidad/bajas y nota de incertidumbre.`;

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
                description: 'Nota sobre varianza, tamaño muestral, margen de casa y fiabilidad.',
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
    const entry = req.body as LoggedPrediction;
    const next: LoggedPrediction = {
      ...entry,
      id: entry.id || `pred-${Date.now()}`,
      createdAt: entry.createdAt || new Date().toISOString(),
      status: entry.status || 'pending',
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
            actualValue: actualValue ?? item.actualValue,
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
