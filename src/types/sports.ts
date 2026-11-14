export type SportType = 'football' | 'nba';

export type MatchStatus = 'live' | 'today' | 'upcoming' | 'finished';

export type DataReliability = 'verified' | 'estimated' | 'unavailable';

export type DataFreshnessStatus = 'fresh' | 'aging' | 'stale' | 'unknown';

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
  publishedAt?: string;
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
  | 'passes'
  | 'saves'
  | 'goalsConceded';

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
  saves?: number;
  goalsConceded?: number;
  savePct?: number;
  cleanSheets?: number;
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
  starterConfidence?: number; // 0..100 probability of starting for probable lineups
  roleReason?: string;
  injuryNote?: string;
  minutesRestriction?: {
    maxMinutes?: number;
    note: string;
  };
  latestNews?: {
    source: string;
    publishedAt?: string;
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
  statsQuality?: DataReliability;
  statsOriginNote?: string;
  dataFreshness?: DataFreshnessStatus;
  lastLogDate?: string;
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
  playedGames?: number;
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
  avgShots?: number;
  avgShotsOnTarget?: number;
  // NBA strength params
  offRating?: number;
  defRating?: number;
  pace?: number;
  homeCourtBoost?: number;
  avgRebounds?: number;
  avgAssists?: number;
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
  complementOdds?: number;
  threeWayOdds?: [number, number, number];
  bookmaker: string;
  updatedAt: string;
}

export interface FootballLineupSnapshot {
  confirmed: boolean;
  homeFormation?: string;
  awayFormation?: string;
  homeStarters: PlayerProfile[];
  awayStarters: PlayerProfile[];
  homeSubs: PlayerProfile[];
  awaySubs: PlayerProfile[];
  homeAbsences: PlayerProfile[];
  awayAbsences: PlayerProfile[];
  sourcesConsulted: string[];
  officialSource?: string;
  publishedAt?: string;
  updatedAt: string;
  overallConfidence?: number; // 0..100
  discrepancyDetected?: boolean;
  discrepancyNote?: string;
  notes?: string[];
}

export interface FootballNewsBundle {
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
  rejectedStaleCount?: number;
  freshnessWarning?: string;
}

export interface DataProvenanceMeta {
  source: string;
  fetchedAt: string;
  status: 'ok' | 'partial' | 'stale' | 'error' | 'unavailable';
  isStale: boolean;
  staleAgeMinutes: number;
  dataType: 'real' | 'estimated' | 'unavailable';
  errorMessage?: string;
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
  probableLineup?: FootballLineupSnapshot;
  confirmedLineup?: FootballLineupSnapshot;
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
    rejectedStaleCount?: number;
    freshnessWarning?: string;
  };
  footballNews?: FootballNewsBundle;
  teamStatsQuality?: DataReliability;
  hydrationStatus?: 'idle' | 'ok' | 'partial' | 'not_published' | 'provider_unavailable' | 'query_error' | 'network_error';
  hydrationNote?: string;
  provenance?: DataProvenanceMeta;
  sourceIds?: Record<string, string>;
  verifiedSources?: string[];
  sourceDiscrepancies?: string[];
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

export interface MatchStatDistributionSpec {
  kind: 'poisson' | 'negbin' | 'normal';
  mean: number;
  overdispersion?: number;
  stdDev?: number;
  minLine: number;
  maxLine: number;
  step: number;
  defaultLine: number;
}

export interface StatExpectationWithInterval {
  key: string;
  label: string;
  pointEstimate: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  unit?: string;
  reliability: DataReliability;
  note?: string;
  distributionSpec?: MatchStatDistributionSpec;
}

export interface FootballPredictionResult {
  lambdaHome: number;
  lambdaAway: number;
  expectedGoalsTotal: number;
  probHome: number;
  probDraw: number;
  probAway: number;
  rawProbHome: number;
  rawProbDraw: number;
  rawProbAway: number;
  over15: number;
  over25: number;
  over35: number;
  bttsYes: number;
  expectedCorners: number;
  expectedCardsHome: number;
  expectedCardsAway: number;
  expectedShotsHome: number;
  expectedShotsAway: number;
  expectedShotsOnTargetHome: number;
  expectedShotsOnTargetAway: number;
  expectedStats: StatExpectationWithInterval[];
  exactScores: Array<{
    home: number;
    away: number;
    probability: number;
  }>;
  absenceImpactSummary: string[];
  dataConfidence: number; // 0..100 (represents data coverage & certainty, NEVER match outcome probability)
  dataQuality: DataReliability;
  calibrationApplied: boolean;
  calibrationNote?: string;
  modelWarnings: string[];
}

export interface NbaPredictionResult {
  expectedPace: number;
  expectedHomePts: number;
  expectedAwayPts: number;
  expectedTotal: number;
  expectedSpreadHome: number; // Positive means home favored by X
  expectedReboundsHome: number;
  expectedReboundsAway: number;
  expectedAssistsHome: number;
  expectedAssistsAway: number;
  expectedStats: StatExpectationWithInterval[];
  probHomeWin: number;
  probAwayWin: number;
  rawProbHomeWin: number;
  rawProbAwayWin: number;
  spreadStdDev: number;
  totalStdDev: number;
  absenceImpactSummary: string[];
  dataConfidence: number; // 0..100 (data coverage & certainty, separate from win probability)
  dataQuality: DataReliability;
  calibrationApplied: boolean;
  calibrationNote?: string;
  modelWarnings: string[];
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
  sampleSizeGames: number;
  statsQuality: DataReliability;
  statsOriginNote?: string;
  dataFreshness?: DataFreshnessStatus;
  freshnessWarning?: string;
  multiSplitSummary?: {
    seasonAvg: number;
    last5Avg: number;
    last10Avg: number;
    homeAwayAvg: number;
    h2hAvg?: number;
    weightsNote: string;
  };
  unavailable?: boolean;
  unavailableReason?: string;
  distribution: PropDistributionBin[];
}

export interface MatchNarrativeExplanation {
  headline: string;
  homeFavoringFactors: string[];
  awayFavoringFactors: string[];
  homeStrengthsWeaknesses: string;
  awayStrengthsWeaknesses: string;
  keyAbsencesImpact: string[];
  h2hAssessment: string;
  tacticalMatchups: string[];
  uncertaintiesAndLimits: string[];
}

export interface LoggedPrediction {
  id: string;
  createdAt: string;
  sport: SportType;
  competition?: string;
  matchId: string;
  matchLabel: string;
  market: string;
  selection: string;
  predictedProb: number; // 0..1
  rawPredictedProb?: number; // 0..1 before empirical calibration
  predictedValue?: number; // e.g., expected goals, spread or points
  status: 'pending' | 'won' | 'lost';
  actualValue?: number;
  resolvedAt?: string;
  isReferenceExample?: boolean;
}

export interface EmpiricalCalibrationProfile {
  sport: SportType;
  sampleCount: number;
  minSamplesRequired?: number;
  active: boolean;
  temperature: number; // Logit scale factor (tau < 1 moderates overconfidence)
  bias: number;
  rawBrier: number;
  calibratedBrier: number;
  cvBrier?: number;
  cvLogLoss?: number;
  baselineLogLoss?: number;
  eceBeforePct: number;
  eceAfterPct: number;
  summary: string;
}

export interface CalibrationBreakdownRow {
  key: string;
  label: string;
  count: number;
  hitRatePct: number;
  brierScore: number;
  logLoss: number;
  ecePct: number;
  mae: number;
  rmse: number;
}

export interface TemporalValidationResult {
  evaluatedCount: number;
  skippedWarmup: number;
  baseBrier: number;
  calibratedBrier: number;
  baseLogLoss: number;
  calibratedLogLoss: number;
  baseEcePct: number;
  calibratedEcePct: number;
  improvementBrierPct: number;
  activeRatePct: number;
  leakFreeVerified: boolean;
  note: string;
}

export interface HistoryEvaluationMetrics {
  totalLogged: number;
  resolvedCount: number;
  hitRatePct: number;
  brierScore: number;
  logLoss: number;
  mae: number;
  rmse: number;
  ecePct: number;
  calibrationBins: Array<{
    bucketLabel: string;
    avgPredictedPct: number;
    observedHitPct: number;
    count: number;
  }>;
  calibrationProfiles: {
    football: EmpiricalCalibrationProfile;
    nba: EmpiricalCalibrationProfile;
  };
  temporalValidation: TemporalValidationResult;
  breakdownBySport: CalibrationBreakdownRow[];
  breakdownByCompetition: CalibrationBreakdownRow[];
  breakdownByMarket: CalibrationBreakdownRow[];
}

export type FootballProviderId = 'api-football' | 'football-data' | 'espn-football';
export type NbaProviderId = 'espn-nba' | 'basketballapi-net' | 'api-basketball' | 'api-nba' | 'balldontlie';

export interface ApiProviderStatus {
  connected: boolean;
  enabled?: boolean;
  provider: string;
  role?: 'primary' | 'verification' | 'complementary';
  maskedKey: string | null;
  reuseFootballKey?: boolean;
  lastChecked: string | null;
  accountInfo?: string | null;
  error: string | null;
}

export interface ApiSecurityStatus {
  pinConfigured: boolean;
  unlocked: boolean;
  envProtected: boolean;
}

export interface LiveFeedSourceStatus {
  sport: SportType;
  provider: string;
  status: 'ok' | 'error' | 'stale';
  updatedAt: string;
  matchCount: number;
  error?: string;
}

export interface LiveFeedMeta {
  fetchedAt: string;
  fromCache: boolean;
  cacheAgeMinutes: number;
  isStale: boolean;
  staleReason?: string;
  sources: LiveFeedSourceStatus[];
}

export interface ApiConfigState {
  football: ApiProviderStatus;
  nba: ApiProviderStatus;
  footballProviders?: Record<string, ApiProviderStatus>;
  nbaProviders?: Record<string, ApiProviderStatus>;
  security?: ApiSecurityStatus;
}
