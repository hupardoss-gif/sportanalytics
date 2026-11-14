import { GoogleGenAI } from '@google/genai';
import type { AvailabilityStatus, MatchRecord, PlayerNewsItem, PlayerProfile } from '../src/types/sports.ts';
import { fetchWithTimeout } from './httpUtils.ts';

type AnyObj = Record<string, unknown>;

export interface ParsedInjuryRecord {
  athleteId: string;
  playerName: string;
  normalizedName: string;
  teamId: string;
  teamName: string;
  status: AvailabilityStatus;
  statusTag: string;
  confirmed: boolean;
  source: string;
  publishedAt?: string;
  headline: string;
  summary: string;
  url?: string;
  minutesRestriction?: {
    maxMinutes?: number;
    note: string;
  };
  roleCue?: 'starter' | 'bench' | null;
}

let injuriesFeedCache: {
  expiresAt: number;
  byTeamId: Map<string, ParsedInjuryRecord[]>;
  all: ParsedInjuryRecord[];
} | null = null;

let rssCache: {
  expiresAt: number;
  items: Array<{
    source: string;
    title: string;
    summary: string;
    publishedAt?: string;
    url?: string;
  }>;
} | null = null;

export function normalizeNbaName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseValidPublishedAt(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function isPublishedNewsRecent(
  publishedAt: string | undefined,
  maxAgeDays: number,
  nowMs = Date.now()
): boolean {
  if (!publishedAt) return false;
  const ts = Date.parse(publishedAt);
  if (!Number.isFinite(ts)) return false;
  if (ts > nowMs + 12 * 3600_000) return false;
  return nowMs - ts <= maxAgeDays * 86_400_000;
}

function decodeXml(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectMinutesRestriction(text: string): { maxMinutes?: number; note: string } | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const numMatch =
    text.match(/(?:limit(?:ed)?(?:\s+to)?|around|roughly|approx(?:imately)?|cap(?:ped)?(?:\s+at)?)\s*(?:around|about)?\s*(\d{2})\s*[-]?\s*minutes?/i) ??
    text.match(/(\d{2})\s*[-]?\s*minute\s*(?:limit|cap|restriction)/i);
  if (numMatch) {
    const mins = Number(numMatch[1]);
    if (Number.isFinite(mins) && mins >= 10 && mins <= 34) {
      return {
        maxMinutes: mins,
        note: `Restricción estimada de ~${mins} min detectada en parte reciente`,
      };
    }
  }
  if (
    lower.includes('minutes limit') ||
    lower.includes('minute limit') ||
    lower.includes('minutes restriction') ||
    lower.includes('minute restriction') ||
    lower.includes('easing back') ||
    lower.includes('limited workload')
  ) {
    return {
      note: 'Restricción de minutos reportada en el último parte médico',
    };
  }
  return undefined;
}

function detectRoleCue(text: string): 'starter' | 'bench' | null {
  const lower = (text || '').toLowerCase();
  if (
    lower.includes('off the bench') ||
    lower.includes('second unit') ||
    lower.includes('come off the bench')
  ) {
    return 'bench';
  }
  if (
    lower.includes('will start') ||
    lower.includes('in the starting lineup') ||
    lower.includes('expected to start') ||
    lower.includes('named a starter')
  ) {
    return 'starter';
  }
  return null;
}

function mapRawNbaInjuryStatus(
  rawStatus: string,
  textHint: string
): { status: AvailabilityStatus; statusTag: string; confirmed: boolean } {
  const s = `${rawStatus} ${textHint}`.toLowerCase();
  if (s.includes('suspen')) {
    return { status: 'out', statusTag: 'Sancionado (OUT)', confirmed: true };
  }
  if (
    rawStatus.toLowerCase().includes('out') ||
    s.includes('ruled out') ||
    s.includes('will not play') ||
    s.includes("won't play") ||
    s.includes('sidelined') ||
    (s.includes('rest') && rawStatus.toLowerCase().includes('out'))
  ) {
    return {
      status: 'out',
      statusTag: s.includes('rest') || s.includes('load management') ? 'Descanso (OUT)' : 'Descartado (OUT)',
      confirmed: true,
    };
  }
  if (rawStatus.toLowerCase().includes('probable')) {
    return { status: 'probable', statusTag: 'Probable', confirmed: true };
  }
  if (
    rawStatus.toLowerCase().includes('doubt') ||
    rawStatus.toLowerCase().includes('question') ||
    rawStatus.toLowerCase().includes('day-to-day') ||
    s.includes('game-time decision') ||
    s.includes('gtd')
  ) {
    return { status: 'doubtful', statusTag: 'Dudoso (GTD)', confirmed: true };
  }
  if (rawStatus.toLowerCase().includes('active') || rawStatus.toLowerCase().includes('avail')) {
    return { status: 'available', statusTag: 'Disponible', confirmed: true };
  }
  return { status: 'doubtful', statusTag: rawStatus || 'En seguimiento', confirmed: false };
}

function extractAthleteId(athlete: AnyObj): string {
  if (athlete.id) return String(athlete.id);
  const uid = String(athlete.uid ?? '');
  const uidMatch = uid.match(/~a:(\d+)/);
  if (uidMatch) return uidMatch[1];
  const links = (athlete.links as AnyObj[] | undefined) ?? [];
  for (const l of links) {
    const href = String(l.href ?? '');
    const m = href.match(/\/id\/(\d+)/);
    if (m) return m[1];
  }
  return '';
}

export async function fetchOfficialNbaInjuriesFeed(forceRefresh = false): Promise<{
  byTeamId: Map<string, ParsedInjuryRecord[]>;
  all: ParsedInjuryRecord[];
}> {
  if (!forceRefresh && injuriesFeedCache && Date.now() < injuriesFeedCache.expiresAt) {
    return { byTeamId: injuriesFeedCache.byTeamId, all: injuriesFeedCache.all };
  }

  const byTeamId = new Map<string, ParsedInjuryRecord[]>();
  const all: ParsedInjuryRecord[] = [];

  try {
    const res = await fetchWithTimeout(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
      undefined,
      9000
    );
    if (!res.ok) return { byTeamId, all };
    const json = (await res.json()) as { injuries?: AnyObj[] };

    for (const teamBlock of json.injuries ?? []) {
      const teamId = String(teamBlock.id ?? '');
      const teamName = String(teamBlock.displayName ?? '');
      const list: ParsedInjuryRecord[] = [];

      for (const inj of (teamBlock.injuries as AnyObj[] | undefined) ?? []) {
        const athlete = (inj.athlete as AnyObj | undefined) ?? {};
        const playerName = String(athlete.displayName ?? athlete.fullName ?? '').trim();
        if (!playerName) continue;

        const athleteId = extractAthleteId(athlete);
        const rawStatus = String(inj.status ?? (inj.type as AnyObj | undefined)?.description ?? '');
        const noteItem = ((athlete.notes as AnyObj | undefined)?.items as AnyObj[] | undefined)?.[0];
        const shortComment = String(inj.shortComment ?? noteItem?.headline ?? '').trim();
        const longComment = String(inj.longComment ?? noteItem?.text ?? '').trim();
        const combinedText = `${shortComment} ${longComment}`.trim();

        const mapped = mapRawNbaInjuryStatus(rawStatus, shortComment);
        const minutesRestriction = detectMinutesRestriction(combinedText);
        const roleCue = detectRoleCue(combinedText);

        const details = (inj.details as AnyObj | undefined) ?? {};
        const detailTag = [details.side, details.type, details.detail].filter(Boolean).join(' ');
        const headline =
          String(noteItem?.headline ?? '').trim() ||
          `${playerName}: ${rawStatus}${detailTag ? ` (${detailTag})` : ''}`;
        const summary = shortComment || longComment || headline;
        const rawSource = String(noteItem?.source ?? '').trim();
        const source = rawSource
          ? `Parte médico NBA · ${rawSource}`
          : 'Parte oficial de lesiones NBA (ESPN)';
        // Strictly parse real upstream timestamp; NEVER fabricate current time
        const publishedAt = parseValidPublishedAt(noteItem?.date ?? inj.date);
        const links = (athlete.links as AnyObj[] | undefined) ?? [];
        const webLink = links.find((l) => Array.isArray(l.rel) && l.rel.includes('player'))?.href;

        const rec: ParsedInjuryRecord = {
          athleteId,
          playerName,
          normalizedName: normalizeNbaName(playerName),
          teamId,
          teamName,
          status: mapped.status,
          statusTag: mapped.statusTag,
          confirmed: mapped.confirmed,
          source,
          publishedAt,
          headline,
          summary,
          url: typeof webLink === 'string' ? webLink : undefined,
          minutesRestriction,
          roleCue,
        };
        list.push(rec);
        all.push(rec);
      }
      if (teamId) byTeamId.set(teamId, list);
    }
  } catch {
    // Return partial/empty on network issue
  }

  injuriesFeedCache = {
    expiresAt: Date.now() + 90_000,
    byTeamId,
    all,
  };
  return { byTeamId, all };
}

async function fetchLeagueRssNews(forceRefresh = false) {
  if (!forceRefresh && rssCache && Date.now() < rssCache.expiresAt) {
    return rssCache.items;
  }

  const feeds = [
    { source: 'Yahoo Sports NBA', url: 'https://sports.yahoo.com/nba/rss/' },
    { source: 'CBS Sports NBA', url: 'https://www.cbssports.com/rss/headlines/nba/' },
  ];

  const collected: Array<{
    source: string;
    title: string;
    summary: string;
    publishedAt?: string;
    url?: string;
  }> = [];

  await Promise.all(
    feeds.map(async (f) => {
      try {
        const res = await fetchWithTimeout(f.url, undefined, 8000);
        if (!res.ok) return;
        const xml = await res.text();
        const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
        for (const block of itemBlocks.slice(0, 35)) {
          const titleRaw = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '';
          const descRaw = block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '';
          const linkRaw = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '';
          const pubRaw = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? '';
          const title = decodeXml(titleRaw);
          const summary = decodeXml(descRaw) || title;
          if (!title) continue;
          const publishedAt = parseValidPublishedAt(decodeXml(pubRaw));
          collected.push({
            source: f.source,
            title,
            summary: summary.slice(0, 280),
            publishedAt,
            url: decodeXml(linkRaw) || undefined,
          });
        }
      } catch {
        // Ignore single RSS failure
      }
    })
  );

  rssCache = {
    expiresAt: Date.now() + 90_000,
    items: collected,
  };
  return collected;
}

export async function fetchNbaExternalNews(params: {
  homeEspnId: string;
  awayEspnId: string;
  homeTeamName: string;
  awayTeamName: string;
  homeShort: string;
  awayShort: string;
  playerNames: string[];
  injuriesForMatch: ParsedInjuryRecord[];
  forceRefresh?: boolean;
}): Promise<{
  items: PlayerNewsItem[];
  sourcesChecked: string[];
  rejectedStaleCount: number;
  freshnessWarning?: string;
}> {
  const {
    homeEspnId,
    awayEspnId,
    homeTeamName,
    awayTeamName,
    homeShort,
    awayShort,
    playerNames,
    injuriesForMatch,
    forceRefresh = false,
  } = params;

  const sourcesChecked = [
    'Informe oficial de lesiones NBA (ESPN / RotoWire)',
    'ESPN NBA Team News',
    'Yahoo Sports NBA',
    'CBS Sports NBA',
  ];

  const items: PlayerNewsItem[] = [];
  const seenHeadlines = new Set<string>();
  const nowMs = Date.now();
  let rejectedStaleCount = 0;

  const pushUnique = (item: PlayerNewsItem, maxAgeDays: number) => {
    if (!isPublishedNewsRecent(item.publishedAt, maxAgeDays, nowMs)) {
      rejectedStaleCount += 1;
      return;
    }
    const key = normalizeNbaName(item.headline).slice(0, 64);
    if (!key || seenHeadlines.has(key)) return;
    seenHeadlines.add(key);
    items.push(item);
  };

  for (const inj of injuriesForMatch) {
    const teamTag = inj.teamId === homeEspnId ? homeShort : awayShort;
    pushUnique(
      {
        id: `inj-${inj.teamId}-${inj.normalizedName}`,
        source: inj.source,
        publishedAt: inj.publishedAt,
        headline: inj.headline,
        summary: inj.summary,
        url: inj.url,
        confirmed: inj.confirmed,
        playerNames: [inj.playerName],
        teamShort: teamTag,
        statusTag: inj.minutesRestriction
          ? `${inj.statusTag} · Límite min.`
          : inj.statusTag,
      },
      10
    );
  }

  const [homeNewsRes, awayNewsRes, rssItems] = await Promise.all([
    homeEspnId
      ? fetchWithTimeout(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?team=${homeEspnId}&limit=8`,
          undefined,
          8000
        )
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<{ articles?: AnyObj[] }>
      : Promise.resolve({} as { articles?: AnyObj[] }),
    awayEspnId
      ? fetchWithTimeout(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?team=${awayEspnId}&limit=8`,
          undefined,
          8000
        )
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})) as Promise<{ articles?: AnyObj[] }>
      : Promise.resolve({} as { articles?: AnyObj[] }),
    fetchLeagueRssNews(forceRefresh),
  ]);

  const buildTeamKeywords = (full: string): string[] => {
    const genericGeo = new Set([
      'los', 'angeles', 'new', 'york', 'golden', 'state', 'san', 'antonio', 'oklahoma', 'city', 'portland',
    ]);
    const tokens = normalizeNbaName(full)
      .split(' ')
      .filter((t) => t.length >= 4 && !genericGeo.has(t));
    const fullNorm = normalizeNbaName(full);
    return Array.from(new Set([fullNorm, ...tokens])).filter(Boolean);
  };

  const homeKeys = buildTeamKeywords(homeTeamName);
  const awayKeys = buildTeamKeywords(awayTeamName);
  const playerTokens = playerNames.map((n) => ({
    raw: n,
    norm: normalizeNbaName(n),
  }));

  const findMatchedPlayers = (text: string): string[] => {
    const nt = ` ${normalizeNbaName(text)} `;
    const hits: string[] = [];
    for (const p of playerTokens) {
      if (p.norm && p.norm.length >= 5 && nt.includes(` ${p.norm} `)) {
        hits.push(p.raw);
      }
    }
    return hits;
  };

  const ingestEspnTeamArticles = (articles: AnyObj[] | undefined, teamShortTag: string) => {
    for (const art of articles ?? []) {
      const headline = String(art.headline ?? '').trim();
      const desc = String(art.description ?? '').trim();
      if (!headline) continue;
      const combined = `${headline} ${desc}`;
      const matchedPlayers = findMatchedPlayers(combined);
      const isAvailabilityRelevant =
        matchedPlayers.length > 0 ||
        /\b(injur|out|doubt|questionable|probable|start|lineup|bench|rest|minutes|ankle|knee|heel|back|illness|return|scratched)\b/i.test(
          combined
        );
      if (!isAvailabilityRelevant) continue;

      const lower = combined.toLowerCase();
      const statusTag = lower.includes('out') || lower.includes('ruled out')
        ? 'Posible baja (Prensa)'
        : lower.includes('day-to-day') || lower.includes('questionable') || lower.includes('doubtful')
          ? 'En duda (Prensa)'
          : lower.includes('start') || lower.includes('lineup')
            ? 'Rotación / Quinteto'
            : 'Prensa equipo';

      pushUnique(
        {
          id: `espn-art-${String(art.id ?? headline.slice(0, 20))}`,
          source: 'ESPN NBA News',
          publishedAt: parseValidPublishedAt(art.published),
          headline,
          summary: desc || headline,
          url: String(((art.links as AnyObj | undefined)?.web as AnyObj | undefined)?.href ?? '') || undefined,
          confirmed: false,
          playerNames: matchedPlayers,
          teamShort: teamShortTag,
          statusTag,
        },
        5
      );
    }
  };

  ingestEspnTeamArticles(homeNewsRes.articles, homeShort);
  ingestEspnTeamArticles(awayNewsRes.articles, awayShort);

  for (const r of rssItems) {
    const textNorm = ` ${normalizeNbaName(`${r.title} ${r.summary}`)} `;
    const hitsHome = homeKeys.some((k) => textNorm.includes(` ${k} `));
    const hitsAway = awayKeys.some((k) => textNorm.includes(` ${k} `));
    const matchedPlayers = findMatchedPlayers(`${r.title} ${r.summary}`);
    if (!hitsHome && !hitsAway && matchedPlayers.length === 0) continue;

    pushUnique(
      {
        id: `rss-${normalizeNbaName(r.source)}-${normalizeNbaName(r.title).slice(0, 24)}`,
        source: r.source,
        publishedAt: r.publishedAt,
        headline: r.title,
        summary: r.summary,
        url: r.url,
        confirmed: false,
        playerNames: matchedPlayers,
        teamShort: hitsHome && !hitsAway ? homeShort : hitsAway && !hitsHome ? awayShort : undefined,
        statusTag: 'Prensa / Rumor',
      },
      5
    );
  }

  items.sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });

  const freshnessWarning =
    items.length === 0
      ? rejectedStaleCount > 0
        ? `No hay partes ni noticias recientes verificables (${rejectedStaleCount} antiguos o sin fecha fueron descartados).`
        : 'No se encontraron noticias recientes verificables con fecha de publicación para este partido.'
      : rejectedStaleCount > 0
        ? `Se descartaron ${rejectedStaleCount} elementos antiguos o sin fecha verificable.`
        : undefined;

  return {
    items: items.slice(0, 18),
    sourcesChecked,
    rejectedStaleCount,
    freshnessWarning,
  };
}

type NbaGroundingResult = {
  available: boolean;
  used: boolean;
  status: 'active' | 'unconfigured' | 'error';
  message?: string;
  citations?: Array<{ title: string; url: string }>;
  findings?: Array<{
    playerName: string;
    status: 'confirmed_starter' | 'possible_starter' | 'probable' | 'available' | 'doubtful' | 'out';
    confirmed: boolean;
    minutesLimit?: number;
    source: string;
    publishedAt?: string;
    summary: string;
  }>;
};

const groundingMatchCache = new Map<string, { expiresAt: number; result: NbaGroundingResult }>();

export async function queryGeminiNbaSearchGrounding(match: MatchRecord): Promise<NbaGroundingResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return {
      available: false,
      used: false,
      status: 'unconfigured',
      message:
        'GEMINI_API_KEY no configurada en el servidor (Settings > Secrets). La búsqueda web con Google Search permanece desactivada; se utilizan únicamente los feeds oficiales NBA (ESPN, RotoWire, Yahoo Sports y CBS Sports).',
    };
  }

  const matchDate = match.kickoffIso.slice(0, 10);
  const cacheKey = `${normalizeNbaName(match.homeTeam.name)}::${normalizeNbaName(match.awayTeam.name)}::${matchDate}`;
  const cached = groundingMatchCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const rosterList = [...match.homePlayers, ...match.awayPlayers].map((p) => p.name).join(', ');
    const prompt = `Search official NBA injury reports, beat writers, and starting lineup updates for the NBA game ${match.homeTeam.name} vs ${match.awayTeam.name} around ${matchDate}.
Focus ONLY on players in these teams (${rosterList || 'active rosters'}).
Identify ONLY verified updates from web search results regarding:
- Confirmed starting lineup vs projected starters
- Players ruled out, resting (load management), suspended, doubtful, questionable, or probable
- Minutes restrictions / limits
- Distinguish clearly between official confirmed reports ("confirmed": true) vs beat writer rumors ("confirmed": false).
Do NOT invent any player status, confirmation, or publication date if not explicitly found in search results (omit publishedAt or set null if unknown).

Respond with a single JSON object (no markdown fences) with schema:
{
  "findings": [
    {
      "playerName": "Exact Name",
      "status": "confirmed_starter" | "possible_starter" | "probable" | "available" | "doubtful" | "out",
      "confirmed": boolean,
      "minutesLimit": number | null,
      "source": "Source name",
      "publishedAt": "ISO timestamp or null if not published",
      "summary": "Brief concise summary in Spanish of the verified report"
    }
  ]
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const citations: Array<{ title: string; url: string }> = [];
    for (const c of chunks as Array<{ web?: { uri?: string; title?: string } }>) {
      if (c.web?.uri) {
        citations.push({
          title: c.web.title || c.web.uri,
          url: c.web.uri,
        });
      }
    }

    const rawText = (response.text ?? '').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    let findings: NbaGroundingResult['findings'] = [];

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { findings?: NbaGroundingResult['findings'] };
        if (Array.isArray(parsed.findings)) {
          findings = parsed.findings
            .filter((f) => f && f.playerName && f.summary)
            .map((f) => ({
              ...f,
              publishedAt: parseValidPublishedAt(f.publishedAt),
            }));
        }
      } catch {
        // Fallback: keep citations if JSON wasn't strictly formatted
      }
    }

    const result: NbaGroundingResult = {
      available: true,
      used: true,
      status: 'active',
      message:
        citations.length > 0
          ? `Google Search Grounding consultado (${citations.length} fuentes web verificadas).`
          : 'Google Search Grounding ejecutado en directo.',
      citations: citations.slice(0, 8),
      findings,
    };
    groundingMatchCache.set(cacheKey, {
      expiresAt: Date.now() + 300_000,
      result,
    });
    return result;
  } catch (err) {
    return {
      available: true,
      used: false,
      status: 'error',
      message:
        err instanceof Error
          ? `Límite temporal o error consultando Google Search Grounding: ${err.message.slice(0, 140)}`
          : 'Error consultando Google Search Grounding.',
    };
  }
}

export function applyNewsAndInjuriesToNbaPlayers(
  players: PlayerProfile[],
  injuries: ParsedInjuryRecord[],
  newsItems: PlayerNewsItem[],
  lineupConfirmed: boolean,
  nowMs = Date.now()
): PlayerProfile[] {
  const recentInjuries = injuries.filter((i) => isPublishedNewsRecent(i.publishedAt, 10, nowMs));
  const recentNews = newsItems.filter((n) => isPublishedNewsRecent(n.publishedAt, 5, nowMs));

  return players.map((p) => {
    const norm = normalizeNbaName(p.name);
    const espnId = p.id.replace('espn-nba-p-', '');
    const inj = recentInjuries.find(
      (i) => (i.athleteId && i.athleteId === espnId) || i.normalizedName === norm
    );

    const playerArticle = recentNews.find((n) =>
      (n.playerNames ?? []).some((pn) => normalizeNbaName(pn) === norm)
    );

    let nextAvailability = p.availability;
    let confidence = p.availabilityConfidence ?? (lineupConfirmed ? 'confirmed' : 'projected');
    let minutesRestriction = p.minutesRestriction;
    let injuryNote = p.injuryNote;

    if (inj) {
      nextAvailability = inj.status;
      confidence = inj.confirmed ? 'confirmed' : 'rumor';
      injuryNote = inj.summary;
      if (inj.minutesRestriction) {
        minutesRestriction = inj.minutesRestriction;
      }
      if (inj.roleCue === 'bench' && nextAvailability === 'available') {
        nextAvailability = 'available';
      }
    } else if (nextAvailability === 'starter') {
      nextAvailability = lineupConfirmed ? 'confirmed_starter' : 'possible_starter';
      confidence = lineupConfirmed ? 'confirmed' : 'projected';
    } else if (nextAvailability === 'bench') {
      nextAvailability = 'available';
      confidence = lineupConfirmed ? 'confirmed' : 'projected';
    } else if (playerArticle && !playerArticle.confirmed && confidence !== 'confirmed') {
      // Attach rumor context without promoting unverified media to confirmed status
      confidence = 'rumor';
    }

    const latestNews = inj
      ? {
          source: inj.source,
          publishedAt: inj.publishedAt,
          summary: inj.summary,
          url: inj.url,
          confirmed: inj.confirmed,
        }
      : playerArticle
        ? {
            source: playerArticle.source,
            publishedAt: playerArticle.publishedAt,
            summary: playerArticle.summary,
            url: playerArticle.url,
            confirmed: playerArticle.confirmed,
          }
        : p.latestNews;

    return {
      ...p,
      availability: nextAvailability,
      availabilityConfidence: confidence,
      injuryNote,
      minutesRestriction,
      latestNews,
    };
  });
}
