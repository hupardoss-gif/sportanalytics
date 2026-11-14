export type SportType = 'football' | 'nba';

export type MatchStatus = 'live' | 'today' | 'upcoming' | 'finished';

export type AvailabilityStatus =
  | 'confirmed_starter'
  | 'possible_starter'
  | 'starter'
  | 'probable'
  | 'bench'
  | 'available'
  | 'doubtful'
  | 'out'
  | 'suspended';

export interface PlayerNewsItem {
  id: string;
  source: string;
  publishedAt: string;
  headline: string;
  summary: string;
  url?: string;
  confirmed: boolean;
  playerNames?: string[];
  teamShort?: string;
  statusTag?: string;
}

export type LineupConfirmation = 'confirmed' | 'provisional' | 'unknown';

export type TimeframeSplit = 'season' | 'last5' | 'last10' | 'last15' | 'home' | 'away' | 'h2h';

export type FootballPropStat =
  | 'goals'
  | 'assists'
  | 'shots'
  | 'shotsOnTarget'
  | 'foulsCommitted'
  | 'foulsDrawn'
  | 'yellowCards'
  | 'redCards'
  | 'passes';

export type NbaPropStat =
  | 'points'
  | 'rebounds'
  | 'assists'
  | 'threes'
  | 'steals'
  | 'blocks'
  | 'turnovers'
  | 'pra';

export type PropStatKey = FootballPropStat | NbaPropStat;

export interface StatSplitValues {
  games: number;
  minutes: number;
  starterRate: number;
  // Football metrics
  goals?: number;
  assists?: number;
  shots?: number;
  shotsOnTarget?: number;
  foulsCommitted?: number;
  foulsDrawn?: number;
  yellowCards?: number;
  redCards?: number;
  passes?: number;
  // NBA metrics
  points?: number;
  rebounds?: number;
  threes?: number;
  steals?: number;
  blocks?: number;
  turnovers?: number;
}

export interface PlayerGameLogEntry {
  date: string;
  opponent: string;
  isHome: boolean;
  minutes: number;
  stats: Partial<Record<PropStatKey, number>>;
}

export interface PlayerProfile {
  id: string;
  sport: SportType;
  name: string;
  shortName: string;
  teamId: string;
  teamName: string;
  teamShort: string;
  number: number;
  position: string;
  photoUrl?: string;
  availability: AvailabilityStatus;
  availabilityConfidence?: 'confirmed' | 'projected' | 'rumor' | 'unknown';
  injuryNote?: string;
  minutesRestriction?: {
    maxMinutes?: number;
    note: string;
  };
  latestNews?: {
    source: string;
    publishedAt: string;
    summary: string;
    url?: string;
    confirmed: boolean;
  };
  isKeyPlayer: boolean;
  /** Pitch / Court normalized coordinates (0-100) */
  pitchCoord?: { x: number; y: number };
  /** Impact metrics used when recalculating team & teammate projections on absence */
  impact: {
    offenseDelta: number; // xG boost (football) or ORtg boost (NBA)
    defenseDelta: number; // xGA reduction (football) or DRtg improvement (NBA)
    usageShare: number;   // 0..0.40 share of team shots/usage
    assistShare: number;  // 0..0.45 share of team assists
  };
  splits: Record<TimeframeSplit, StatSplitValues>;
  recentLogs: PlayerGameLogEntry[];
  sampleSizeGames: number;
}

export interface TeamRecentGame {
  date: string;
  opponent: string;
  isHome: boolean;
  scoreFor: number;
  scoreAgainst: number;
  result: 'W' | 'D' | 'L';
}

export interface TeamInfo {
  id: string;
  name: string;
  shortName: string;
  league: string;
  formation?: string; // e.g., "4-3-3", "4-2-3-1"
  record: string;
  homeRecord?: string;
  awayRecord?: string;
  ppgOrGpg?: number;
  oppgOrGapg?: number;
  formRecent: ('W' | 'D' | 'L')[];
  recentGames?: TeamRecentGame[];
  restDays: number;
  isBackToBack?: boolean;
  // Football strength params
  attackHome?: number;
  attackAway?: number;
  defenseHome?: number;
  defenseAway?: number;
  avgCorners?: number;
  avgYellowCards?: number;
  // NBA strength params
  offRating?: number;
  defRating?: number;
  pace?: number;
  homeCourtBoost?: number;
}

export interface BookmakerOdd {
  id: string;
  marketCategory: 'match' | 'totals' | 'btts' | 'player_prop';
  marketLabel: string;
  selectionLabel: string;
  playerId?: string;
  playerName?: string;
  statKey?: PropStatKey;
  line?: number;
  side?: 'over' | 'under' | 'home' | 'draw' | 'away' | 'yes' | 'no';
  decimalOdds: number;
  complementOdds?: number; // Other side odds for 2-way de-vigging
  threeWayOdds?: [number, number, number]; // For 1X2 de-vigging
  bookmaker: string;
  updatedAt: string;
}

export interface MatchRecord {
  id: string;
  sport: SportType;
  competition: string;
  season: string;
  status: MatchStatus;
  kickoffIso: string;
  minuteOrClock?: string;
  venue: string;
  homeTeam: TeamInfo;
  awayTeam: TeamInfo;
  score?: {
    home: number;
    away: number;
    periods?: string;
  };
  lineupStatus: LineupConfirmation;
  homePlayers: PlayerProfile[];
  awayPlayers: PlayerProfile[];
  h2hSummary: {
    played: number;
    homeWins: number;
    draws: number;
    awayWins: number;
    avgTotalPointsOrGoals: number;
    lastMeetings: Array<{
      date: string;
      home: string;
      away: string;
      score: string;
    }>;
  };
  odds: BookmakerOdd[];
  teamStats?: Array<{
    label: string;
    homeValue: string;
    awayValue: string;
  }>;
  nbaNews?: {
    fetchedAt: string;
    sourcesChecked: string[];
    searchGrounding: {
      available: boolean;
      used: boolean;
      status: 'active' | 'unconfigured' | 'error';
      message?: string;
      citations?: Array<{ title: string; url: string }>;
    };
    items: PlayerNewsItem[];
  };
  hydrationStatus?: 'idle' | 'ok' | 'partial' | 'not_published' | 'provider_unavailable' | 'query_error' | 'network_error';
  hydrationNote?: string;
  dataOrigin: string;
  updatedAt: string;
  isOfflineReference?: boolean;
}

export interface StandingEntry {
  rank: number;
  teamId: string;
  teamName: string;
  teamShort: string;
  league: string;
  conference?: 'Eastern' | 'Western';
  played: number;
  won: number;
  drawn?: number;
  lost: number;
  goalsForOrPtsFor: number;
  goalsAgainstOrPtsAgainst: number;
  diff: number;
  pointsOrWinPct: string;
  form: ('W' | 'D' | 'L')[];
  homeRecord: string;
  awayRecord: string;
}

export interface FootballPredictionResult {
  lambdaHome: number;
  lambdaAway: number;
  probHome: number;
  probDraw: number;
  probAway: number;
  over15: number;
  over25: number;
  over35: number;
  bttsYes: number;
  expectedCorners: number;
  expectedCardsHome: number;
  expectedCardsAway: number;
  exactScores: Array<{
    home: number;
    away: number;
    probability: number;
  }>;
  absenceImpactSummary: string[];
  dataConfidence: number; // 0..100
}

export interface NbaPredictionResult {
  expectedPace: number;
  expectedHomePts: number;
  expectedAwayPts: number;
  expectedTotal: number;
  expectedSpreadHome: number; // Positive means home favored by X
  probHomeWin: number;
  probAwayWin: number;
  spreadStdDev: number;
  totalStdDev: number;
  absenceImpactSummary: string[];
  dataConfidence: number;
}

export interface PropDistributionBin {
  value: number;
  label: string;
  probability: number;
  isOver: boolean;
}

export interface PropProjectionResult {
  statKey: PropStatKey;
  statLabel: string;
  line: number;
  minLine: number;
  maxLine: number;
  step: number;
  expectedValue: number;
  median: number;
  stdDev: number;
  intervalLow: number;
  intervalHigh: number;
  probOver: number; // 0..100
  probUnder: number; // 0..100 (always probOver + probUnder === 100)
  expectedMinutes: number;
  absenceAdjustmentPct: number;
  sampleConfidence: number;
  distribution: PropDistributionBin[];
}

export interface OddsDiscrepancyItem {
  id: string;
  sport: SportType;
  matchId: string;
  matchLabel: string;
  competition: string;
  kickoffIso: string;
  playerId?: string;
  playerName?: string;
  marketLabel: string;
  marketCategory: BookmakerOdd['marketCategory'];
  selectionLabel: string;
  line?: number;
  availableOdds: number;
  bookmaker: string;
  updatedAt: string;
  modelProbability: number; // 0..1
  rawImpliedProbability: number; // 0..1
  fairImpliedProbability: number; // 0..1 (de-vigged)
  bookmakerMarginPct: number; // Overround %
  modelFairOdds: number;
  edgePct: number; // (modelProb - fairImpliedProb) * 100
  expectedValuePct: number; // (modelProb * availableOdds - 1) * 100
  dataQualityScore: number; // 0..100
  uncertaintyBandPct: number; // +/- %
  mainReason: string;
  isOfflineReference?: boolean;
}

export interface LoggedPrediction {
  id: string;
  createdAt: string;
  sport: SportType;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  predictedProb: number; // 0..1
  predictedValue?: number; // e.g., expected goals or points
  bookmakerOdds?: number;
  status: 'pending' | 'won' | 'lost';
  actualValue?: number;
  resolvedAt?: string;
}

export interface HistoryEvaluationMetrics {
  totalLogged: number;
  resolvedCount: number;
  hitRatePct: number;
  brierScore: number;
  logLoss: number;
  mae: number;
  rmse: number;
  calibrationBins: Array<{
    bucketLabel: string;
    avgPredictedPct: number;
    observedHitPct: number;
    count: number;
  }>;
}

export type FootballProviderId = 'api-football' | 'football-data' | 'espn-football' | 'the-odds-api';
export type NbaProviderId = 'espn-nba' | 'basketballapi-net' | 'api-basketball' | 'api-nba' | 'balldontlie' | 'the-odds-api';

export interface ApiProviderStatus {
  connected: boolean;
  provider: string;
  maskedKey: string | null;
  reuseFootballKey?: boolean;
  lastChecked: string | null;
  accountInfo?: string | null;
  error: string | null;
}

export interface ApiConfigState {
  football: ApiProviderStatus;
  nba: ApiProviderStatus;
  odds?: ApiProviderStatus;
}
