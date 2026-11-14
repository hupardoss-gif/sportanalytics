import type {
  LoggedPrediction,
  MatchRecord,
  PlayerProfile,
  StandingEntry,
  StatSplitValues,
} from '../types/sports.ts';

function makeFootballSplits(
  base: {
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    sot: number;
    fc: number;
    fd: number;
    yc: number;
    passes: number;
  },
  starterRate = 0.92
): PlayerProfile['splits'] {
  const scale = (m: number): StatSplitValues => ({
    games: m === 1 ? 15 : m === 0.9 ? 5 : 10,
    minutes: Math.round(base.minutes),
    starterRate,
    goals: +(base.goals * m).toFixed(2),
    assists: +(base.assists * m).toFixed(2),
    shots: +(base.shots * m).toFixed(2),
    shotsOnTarget: +(base.sot * m).toFixed(2),
    foulsCommitted: +(base.fc * m).toFixed(2),
    foulsDrawn: +(base.fd * m).toFixed(2),
    yellowCards: +(base.yc * m).toFixed(2),
    redCards: 0.01,
    passes: Math.round(base.passes * m),
  });
  return {
    season: { ...scale(1), games: 24 },
    last5: { ...scale(1.08), games: 5 },
    last10: { ...scale(1.03), games: 10 },
    last15: { ...scale(1.01), games: 15 },
    home: { ...scale(1.1), games: 12 },
    away: { ...scale(0.91), games: 12 },
    h2h: { ...scale(1.05), games: 4 },
  };
}

function makeFootballLogs(
  oppList: string[],
  baseShots: number,
  baseGoals: number,
  baseAssists: number,
  baseFouls: number,
  basePasses: number
) {
  return oppList.map((opp, idx) => ({
    date: `2026-10-${String(28 - idx * 4).padStart(2, '0')}`,
    opponent: opp,
    isHome: idx % 2 === 0,
    minutes: idx === 3 ? 74 : 88,
    stats: {
      shots: Math.max(0, Math.round(baseShots + ((idx % 3) - 1))),
      shotsOnTarget: Math.max(0, Math.round(baseShots * 0.48 + (idx % 2 === 0 ? 1 : 0))),
      goals: idx === 0 || idx === 2 ? Math.max(0, Math.round(baseGoals + 0.4)) : 0,
      assists: idx === 1 ? Math.max(0, Math.round(baseAssists + 0.5)) : 0,
      foulsCommitted: Math.max(0, Math.round(baseFouls + (idx % 2))),
      foulsDrawn: Math.max(0, Math.round(baseFouls + 0.5)),
      yellowCards: idx === 2 ? 1 : 0,
      passes: Math.round(basePasses + (idx % 3) * 4 - 3),
    },
  }));
}

function makeNbaSplits(base: {
  minutes: number;
  pts: number;
  reb: number;
  ast: number;
  threes: number;
  stl: number;
  blk: number;
  tov: number;
}): PlayerProfile['splits'] {
  const s = (m: number, g: number): StatSplitValues => ({
    games: g,
    minutes: +(base.minutes * (m > 1 ? 1.02 : 0.99)).toFixed(1),
    starterRate: base.minutes >= 27 ? 0.98 : 0.22,
    points: +(base.pts * m).toFixed(1),
    rebounds: +(base.reb * m).toFixed(1),
    assists: +(base.ast * m).toFixed(1),
    threes: +(base.threes * m).toFixed(1),
    steals: +(base.stl * m).toFixed(1),
    blocks: +(base.blk * m).toFixed(1),
    turnovers: +(base.tov * m).toFixed(1),
  });
  return {
    season: s(1, 38),
    last5: s(1.07, 5),
    last10: s(1.04, 10),
    last15: s(1.01, 15),
    home: s(1.06, 19),
    away: s(0.95, 19),
    h2h: s(1.03, 3),
  };
}

function makeNbaLogs(
  opps: string[],
  pts: number,
  reb: number,
  ast: number,
  threes: number
) {
  return opps.map((opp, idx) => ({
    date: `2026-11-${String(11 - idx * 2).padStart(2, '0')}`,
    opponent: opp,
    isHome: idx % 2 === 0,
    minutes: Math.round(32 + (idx % 3) * 2),
    stats: {
      points: Math.max(4, Math.round(pts + ((idx % 3) - 1) * 4)),
      rebounds: Math.max(1, Math.round(reb + (idx % 2 === 0 ? 1 : -1))),
      assists: Math.max(1, Math.round(ast + ((idx % 3) - 1))),
      threes: Math.max(0, Math.round(threes + (idx % 2 === 0 ? 1 : -1))),
      steals: idx % 2,
      blocks: idx === 1 ? 1 : 0,
      turnovers: Math.max(1, Math.round(2 + (idx % 2))),
      pra: Math.max(
        10,
        Math.round(pts + reb + ast + ((idx % 3) - 1) * 5)
      ),
    },
  }));
}

function makeFootballGkSplits(
  base: {
    minutes: number;
    saves: number;
    goalsConceded: number;
    savePct: number;
    cleanSheets: number;
    fc: number;
    fd: number;
    yc: number;
    passes: number;
  },
  starterRate = 0.96
): PlayerProfile['splits'] {
  const scale = (m: number, g: number): StatSplitValues => ({
    games: g,
    minutes: Math.round(base.minutes),
    starterRate,
    saves: +(base.saves * m).toFixed(2),
    goalsConceded: +(base.goalsConceded / Math.max(0.85, m)).toFixed(2),
    savePct: +Math.min(92, base.savePct * (0.98 + (m - 1) * 0.25)).toFixed(1),
    cleanSheets: +(Math.min(1, base.cleanSheets * m)).toFixed(2),
    foulsCommitted: +(base.fc * m).toFixed(2),
    foulsDrawn: +(base.fd * m).toFixed(2),
    yellowCards: +(base.yc * m).toFixed(2),
    redCards: 0.01,
    passes: Math.round(base.passes * m),
  });
  return {
    season: scale(1, 24),
    last5: scale(1.06, 5),
    last10: scale(1.02, 10),
    last15: scale(1.01, 15),
    home: scale(1.08, 12),
    away: scale(0.93, 12),
    h2h: scale(1.04, 4),
  };
}

function makeFootballGkLogs(
  oppList: string[],
  baseSaves: number,
  baseConceded: number,
  basePasses: number
) {
  return oppList.map((opp, idx) => ({
    date: `2026-10-${String(28 - idx * 4).padStart(2, '0')}`,
    opponent: opp,
    isHome: idx % 2 === 0,
    minutes: 90,
    stats: {
      saves: Math.max(1, Math.round(baseSaves + ((idx % 3) - 1))),
      goalsConceded: Math.max(0, Math.round(baseConceded + (idx === 1 ? 1 : idx === 3 ? -1 : 0))),
      foulsCommitted: 0,
      foulsDrawn: idx % 2 === 0 ? 1 : 0,
      yellowCards: idx === 4 ? 1 : 0,
      passes: Math.round(basePasses + (idx % 3) * 3 - 2),
    },
  }));
}

function isSandboxGoalkeeper(pos: string): boolean {
  const norm = pos.trim().toUpperCase();
  return norm === 'POR' || norm === 'GK' || norm.includes('GOALKEEPER') || norm.includes('PORTERO');
}

function buildFootballTeamRoster(
  teamId: string,
  teamName: string,
  teamShort: string,
  isHomeSide: boolean,
  starters: Array<{
    id: string;
    name: string;
    short: string;
    num: number;
    pos: string;
    x: number;
    y: number;
    key?: boolean;
    avail?: PlayerProfile['availability'];
    injuryNote?: string;
    off: number;
    def: number;
    usage: number;
    astShare: number;
    goals: number;
    assists: number;
    shots: number;
    sot: number;
    saves?: number;
    goalsConceded?: number;
    savePct?: number;
    cleanSheets?: number;
    fc: number;
    fd: number;
    yc: number;
    passes: number;
  }>,
  bench: Array<{
    id: string;
    name: string;
    short: string;
    num: number;
    pos: string;
    avail?: PlayerProfile['availability'];
    injuryNote?: string;
    shots: number;
    goals: number;
    assists: number;
  }>
): PlayerProfile[] {
  const oppSamples = isHomeSide
    ? ['VAL', 'SEV', 'BET', 'ATH', 'GIR']
    : ['GET', 'OSA', 'CEL', 'SOC', 'VIL'];

  const list: PlayerProfile[] = starters.map((p) => {
    const isGk = isSandboxGoalkeeper(p.pos);
    const savesBase = p.saves ?? 2.85;
    const concededBase = p.goalsConceded ?? 0.92;
    const savePctBase = p.savePct ?? 76.2;
    const cleanSheetsBase = p.cleanSheets ?? 0.42;

    return {
      id: p.id,
      sport: 'football',
      name: p.name,
      shortName: p.short,
      teamId,
      teamName,
      teamShort,
      number: p.num,
      position: p.pos,
      availability: p.avail ?? 'starter',
      injuryNote: p.injuryNote,
      isKeyPlayer: !!p.key,
      pitchCoord: { x: p.x, y: p.y },
      impact: {
        offenseDelta: p.off,
        defenseDelta: p.def,
        usageShare: p.usage,
        assistShare: p.astShare,
      },
      splits: isGk
        ? makeFootballGkSplits({
            minutes: 90,
            saves: savesBase,
            goalsConceded: concededBase,
            savePct: savePctBase,
            cleanSheets: cleanSheetsBase,
            fc: p.fc,
            fd: p.fd,
            yc: p.yc,
            passes: p.passes,
          })
        : makeFootballSplits({
            minutes: 84,
            goals: p.goals,
            assists: p.assists,
            shots: p.shots,
            sot: p.sot,
            fc: p.fc,
            fd: p.fd,
            yc: p.yc,
            passes: p.passes,
          }),
      recentLogs: isGk
        ? makeFootballGkLogs(oppSamples, savesBase, concededBase, p.passes)
        : makeFootballLogs(oppSamples, p.shots, p.goals, p.assists, p.fc, p.passes),
      sampleSizeGames: 24,
      statsQuality: 'verified',
      statsOriginNote: 'Datos simulados de referencia offline',
    };
  });

  for (const b of bench) {
    list.push({
      id: b.id,
      sport: 'football',
      name: b.name,
      shortName: b.short,
      teamId,
      teamName,
      teamShort,
      number: b.num,
      position: b.pos,
      availability: b.avail ?? 'bench',
      injuryNote: b.injuryNote,
      isKeyPlayer: false,
      impact: { offenseDelta: 0.08, defenseDelta: 0.04, usageShare: 0.06, assistShare: 0.06 },
      splits: makeFootballSplits(
        {
          minutes: 28,
          goals: b.goals,
          assists: b.assists,
          shots: b.shots,
          sot: +(b.shots * 0.45).toFixed(2),
          fc: 0.8,
          fd: 0.9,
          yc: 0.14,
          passes: 18,
        },
        0.18
      ),
      recentLogs: makeFootballLogs(oppSamples, b.shots, b.goals, b.assists, 0.8, 18),
      sampleSizeGames: 18,
      statsQuality: 'verified',
      statsOriginNote: 'Datos simulados de referencia offline',
    });
  }
  return list;
}

const madridPlayers = buildFootballTeamRoster(
  'rma',
  'Real Madrid',
  'RMA',
  true,
  [
    { id: 'rma-1', name: 'Thibaut Courtois', short: 'Courtois', num: 1, pos: 'POR', x: 50, y: 92, key: true, off: 0.01, def: 0.18, usage: 0.01, astShare: 0.01, goals: 0, assists: 0, shots: 0.02, sot: 0, fc: 0.05, fd: 0.2, yc: 0.04, passes: 29 },
    { id: 'rma-2', name: 'Dani Carvajal', short: 'Carvajal', num: 2, pos: 'LD', x: 82, y: 74, off: 0.06, def: 0.09, usage: 0.04, astShare: 0.08, goals: 0.08, assists: 0.16, shots: 0.75, sot: 0.25, fc: 1.35, fd: 1.1, yc: 0.28, passes: 54 },
    { id: 'rma-3', name: 'Antonio Rüdiger', short: 'Rüdiger', num: 22, pos: 'DFC', x: 63, y: 77, off: 0.04, def: 0.14, usage: 0.03, astShare: 0.02, goals: 0.07, assists: 0.03, shots: 0.65, sot: 0.22, fc: 1.1, fd: 0.6, yc: 0.22, passes: 66 },
    { id: 'rma-4', name: 'Éder Militão', short: 'Militão', num: 3, pos: 'DFC', x: 37, y: 77, off: 0.03, def: 0.13, usage: 0.03, astShare: 0.02, goals: 0.05, assists: 0.02, shots: 0.55, sot: 0.18, fc: 1.05, fd: 0.55, yc: 0.19, passes: 62 },
    { id: 'rma-5', name: 'Ferland Mendy', short: 'Mendy', num: 23, pos: 'LI', x: 18, y: 74, off: 0.03, def: 0.10, usage: 0.02, astShare: 0.04, goals: 0.02, assists: 0.08, shots: 0.35, sot: 0.1, fc: 1.25, fd: 0.85, yc: 0.21, passes: 51 },
    { id: 'rma-6', name: 'Federico Valverde', short: 'Valverde', num: 8, pos: 'MC', x: 70, y: 55, key: true, off: 0.16, def: 0.11, usage: 0.13, astShare: 0.16, goals: 0.22, assists: 0.24, shots: 2.35, sot: 0.92, fc: 1.15, fd: 1.05, yc: 0.18, passes: 64 },
    { id: 'rma-7', name: 'Aurélien Tchouaméni', short: 'Tchouaméni', num: 14, pos: 'MCD', x: 50, y: 60, off: 0.07, def: 0.15, usage: 0.05, astShare: 0.06, goals: 0.08, assists: 0.07, shots: 1.05, sot: 0.34, fc: 1.48, fd: 0.9, yc: 0.27, passes: 71 },
    { id: 'rma-8', name: 'Jude Bellingham', short: 'Bellingham', num: 5, pos: 'MCO', x: 35, y: 46, key: true, off: 0.28, def: 0.08, usage: 0.18, astShare: 0.22, goals: 0.44, assists: 0.29, shots: 2.85, sot: 1.28, fc: 1.32, fd: 2.45, yc: 0.24, passes: 52 },
    { id: 'rma-9', name: 'Rodrygo Goes', short: 'Rodrygo', num: 11, pos: 'ED', x: 79, y: 31, off: 0.19, def: 0.03, usage: 0.14, astShare: 0.17, goals: 0.34, assists: 0.22, shots: 2.4, sot: 1.05, fc: 0.65, fd: 1.65, yc: 0.09, passes: 36 },
    { id: 'rma-10', name: 'Kylian Mbappé', short: 'Mbappé', num: 9, pos: 'DC', x: 50, y: 20, key: true, off: 0.42, def: 0.02, usage: 0.26, astShare: 0.16, goals: 0.72, assists: 0.23, shots: 4.35, sot: 2.05, fc: 0.52, fd: 1.9, yc: 0.08, passes: 29 },
    { id: 'rma-11', name: 'Vinícius Júnior', short: 'Vinícius Jr', num: 7, pos: 'EI', x: 21, y: 28, key: true, off: 0.34, def: 0.03, usage: 0.21, astShare: 0.24, goals: 0.54, assists: 0.36, shots: 3.45, sot: 1.55, fc: 0.95, fd: 3.15, yc: 0.26, passes: 34 },
  ],
  [
    { id: 'rma-12', name: 'Eduardo Camavinga', short: 'Camavinga', num: 6, pos: 'MC', shots: 0.75, goals: 0.06, assists: 0.1 },
    { id: 'rma-13', name: 'Arda Güler', short: 'Güler', num: 15, pos: 'MCO', shots: 1.3, goals: 0.18, assists: 0.15 },
    { id: 'rma-14', name: 'Brahim Díaz', short: 'Brahim', num: 21, pos: 'ED', shots: 1.45, goals: 0.21, assists: 0.14 },
    { id: 'rma-15', name: 'David Alaba', short: 'Alaba', num: 4, pos: 'DFC', avail: 'out', injuryNote: 'Lesión muscular — baja confirmada', shots: 0.4, goals: 0.03, assists: 0.05 },
  ]
);

const barcaPlayers = buildFootballTeamRoster(
  'fcb',
  'FC Barcelona',
  'FCB',
  false,
  [
    { id: 'fcb-1', name: 'Marc-André ter Stegen', short: 'Ter Stegen', num: 1, pos: 'POR', x: 50, y: 92, off: 0.01, def: 0.16, usage: 0.01, astShare: 0.01, goals: 0, assists: 0, shots: 0.01, sot: 0, fc: 0.04, fd: 0.25, yc: 0.03, passes: 36 },
    { id: 'fcb-2', name: 'Jules Koundé', short: 'Koundé', num: 23, pos: 'LD', x: 82, y: 74, off: 0.06, def: 0.12, usage: 0.04, astShare: 0.09, goals: 0.06, assists: 0.15, shots: 0.68, sot: 0.2, fc: 0.95, fd: 0.85, yc: 0.16, passes: 67 },
    { id: 'fcb-3', name: 'Pau Cubarsí', short: 'Cubarsí', num: 2, pos: 'DFC', x: 63, y: 77, off: 0.03, def: 0.12, usage: 0.02, astShare: 0.04, goals: 0.02, assists: 0.04, shots: 0.35, sot: 0.1, fc: 0.88, fd: 0.65, yc: 0.15, passes: 78 },
    { id: 'fcb-4', name: 'Ronald Araújo', short: 'Araújo', num: 4, pos: 'DFC', x: 37, y: 77, key: true, off: 0.05, def: 0.16, usage: 0.03, astShare: 0.02, goals: 0.07, assists: 0.03, shots: 0.6, sot: 0.21, fc: 1.42, fd: 0.72, yc: 0.29, passes: 61 },
    { id: 'fcb-5', name: 'Alejandro Balde', short: 'Balde', num: 3, pos: 'LI', x: 18, y: 74, off: 0.06, def: 0.08, usage: 0.04, astShare: 0.10, goals: 0.04, assists: 0.16, shots: 0.58, sot: 0.18, fc: 0.9, fd: 1.2, yc: 0.14, passes: 53 },
    { id: 'fcb-6', name: 'Pedri González', short: 'Pedri', num: 8, pos: 'MC', x: 68, y: 55, key: true, off: 0.21, def: 0.07, usage: 0.12, astShare: 0.27, goals: 0.19, assists: 0.31, shots: 1.55, sot: 0.65, fc: 0.75, fd: 2.35, yc: 0.11, passes: 79 },
    { id: 'fcb-7', name: 'Frenkie de Jong', short: 'De Jong', num: 21, pos: 'MCD', x: 50, y: 61, off: 0.10, def: 0.11, usage: 0.06, astShare: 0.14, goals: 0.08, assists: 0.14, shots: 0.85, sot: 0.3, fc: 1.05, fd: 1.85, yc: 0.19, passes: 76 },
    { id: 'fcb-8', name: 'Dani Olmo', short: 'Dani Olmo', num: 20, pos: 'MCO', x: 36, y: 46, off: 0.20, def: 0.04, usage: 0.15, astShare: 0.19, goals: 0.36, assists: 0.24, shots: 2.55, sot: 1.12, fc: 0.85, fd: 1.75, yc: 0.12, passes: 45 },
    { id: 'fcb-9', name: 'Lamine Yamal', short: 'Lamine Yamal', num: 19, pos: 'ED', x: 80, y: 29, key: true, off: 0.33, def: 0.04, usage: 0.21, astShare: 0.30, goals: 0.39, assists: 0.44, shots: 3.35, sot: 1.38, fc: 0.68, fd: 2.6, yc: 0.09, passes: 44 },
    { id: 'fcb-10', name: 'Robert Lewandowski', short: 'Lewandowski', num: 9, pos: 'DC', x: 50, y: 19, key: true, off: 0.38, def: 0.02, usage: 0.24, astShare: 0.11, goals: 0.74, assists: 0.14, shots: 3.85, sot: 1.85, fc: 1.12, fd: 1.55, yc: 0.12, passes: 24 },
    { id: 'fcb-11', name: 'Raphinha', short: 'Raphinha', num: 11, pos: 'EI', x: 20, y: 29, key: true, off: 0.29, def: 0.05, usage: 0.19, astShare: 0.24, goals: 0.48, assists: 0.35, shots: 3.15, sot: 1.34, fc: 1.02, fd: 1.75, yc: 0.16, passes: 39 },
  ],
  [
    { id: 'fcb-12', name: 'Gavi Páez', short: 'Gavi', num: 6, pos: 'MC', shots: 0.95, goals: 0.09, assists: 0.12 },
    { id: 'fcb-13', name: 'Fermín López', short: 'Fermín', num: 16, pos: 'MCO', shots: 1.6, goals: 0.22, assists: 0.11 },
    { id: 'fcb-14', name: 'Ferran Torres', short: 'Ferran', num: 7, pos: 'DC', shots: 1.45, goals: 0.24, assists: 0.1 },
    { id: 'fcb-15', name: 'Marc Casadó', short: 'Casadó', num: 17, pos: 'MCD', avail: 'doubtful', injuryNote: 'Molestias en tobillo — duda', shots: 0.45, goals: 0.02, assists: 0.08 },
  ]
);

const arsenalPlayers = buildFootballTeamRoster(
  'ars',
  'Arsenal FC',
  'ARS',
  true,
  [
    { id: 'ars-1', name: 'David Raya', short: 'Raya', num: 22, pos: 'POR', x: 50, y: 92, off: 0.01, def: 0.16, usage: 0.01, astShare: 0.01, goals: 0, assists: 0, shots: 0.01, sot: 0, fc: 0.03, fd: 0.2, yc: 0.06, passes: 33 },
    { id: 'ars-2', name: 'Ben White', short: 'White', num: 4, pos: 'LD', x: 82, y: 74, off: 0.05, def: 0.12, usage: 0.04, astShare: 0.09, goals: 0.05, assists: 0.14, shots: 0.55, sot: 0.18, fc: 0.9, fd: 0.85, yc: 0.19, passes: 60 },
    { id: 'ars-3', name: 'William Saliba', short: 'Saliba', num: 2, pos: 'DFC', x: 63, y: 77, key: true, off: 0.04, def: 0.19, usage: 0.02, astShare: 0.02, goals: 0.05, assists: 0.02, shots: 0.45, sot: 0.15, fc: 0.85, fd: 0.7, yc: 0.14, passes: 74 },
    { id: 'ars-4', name: 'Gabriel Magalhães', short: 'Gabriel', num: 6, pos: 'DFC', x: 37, y: 77, off: 0.08, def: 0.15, usage: 0.05, astShare: 0.02, goals: 0.13, assists: 0.02, shots: 1.05, sot: 0.38, fc: 1.15, fd: 0.65, yc: 0.21, passes: 66 },
    { id: 'ars-5', name: 'Jurriën Timber', short: 'Timber', num: 12, pos: 'LI', x: 18, y: 74, off: 0.04, def: 0.11, usage: 0.03, astShare: 0.06, goals: 0.04, assists: 0.1, shots: 0.5, sot: 0.15, fc: 1.1, fd: 0.95, yc: 0.22, passes: 55 },
    { id: 'ars-6', name: 'Martin Ødegaard', short: 'Ødegaard', num: 8, pos: 'MC', x: 68, y: 49, key: true, off: 0.28, def: 0.06, usage: 0.16, astShare: 0.31, goals: 0.26, assists: 0.36, shots: 2.45, sot: 0.95, fc: 0.72, fd: 1.55, yc: 0.1, passes: 63 },
    { id: 'ars-7', name: 'Declan Rice', short: 'Rice', num: 41, pos: 'MCD', x: 50, y: 61, key: true, off: 0.12, def: 0.16, usage: 0.09, astShare: 0.14, goals: 0.14, assists: 0.18, shots: 1.55, sot: 0.54, fc: 1.22, fd: 1.15, yc: 0.2, passes: 68 },
    { id: 'ars-8', name: 'Mikel Merino', short: 'Merino', num: 23, pos: 'MC', x: 32, y: 52, off: 0.11, def: 0.09, usage: 0.08, astShare: 0.10, goals: 0.15, assists: 0.12, shots: 1.35, sot: 0.48, fc: 1.55, fd: 1.4, yc: 0.25, passes: 48 },
    { id: 'ars-9', name: 'Bukayo Saka', short: 'Saka', num: 7, pos: 'ED', x: 81, y: 29, key: true, off: 0.36, def: 0.05, usage: 0.23, astShare: 0.29, goals: 0.45, assists: 0.41, shots: 3.3, sot: 1.42, fc: 0.88, fd: 2.75, yc: 0.14, passes: 42 },
    { id: 'ars-10', name: 'Kai Havertz', short: 'Havertz', num: 29, pos: 'DC', x: 50, y: 20, off: 0.26, def: 0.05, usage: 0.17, astShare: 0.13, goals: 0.44, assists: 0.17, shots: 2.55, sot: 1.14, fc: 1.48, fd: 1.65, yc: 0.22, passes: 31 },
    { id: 'ars-11', name: 'Gabriel Martinelli', short: 'Martinelli', num: 11, pos: 'EI', x: 19, y: 29, off: 0.21, def: 0.04, usage: 0.16, astShare: 0.15, goals: 0.29, assists: 0.2, shots: 2.4, sot: 0.98, fc: 0.78, fd: 1.45, yc: 0.11, passes: 30 },
  ],
  [
    { id: 'ars-12', name: 'Leandro Trossard', short: 'Trossard', num: 19, pos: 'EI', shots: 1.65, goals: 0.24, assists: 0.15 },
    { id: 'ars-13', name: 'Gabriel Jesus', short: 'G. Jesus', num: 9, pos: 'DC', shots: 1.5, goals: 0.2, assists: 0.12 },
    { id: 'ars-14', name: 'Ethan Nwaneri', short: 'Nwaneri', num: 53, pos: 'MCO', shots: 1.1, goals: 0.14, assists: 0.09 },
  ]
);

const cityPlayers = buildFootballTeamRoster(
  'mci',
  'Manchester City',
  'MCI',
  false,
  [
    { id: 'mci-1', name: 'Ederson Moraes', short: 'Ederson', num: 31, pos: 'POR', x: 50, y: 92, off: 0.01, def: 0.14, usage: 0.01, astShare: 0.02, goals: 0, assists: 0.03, shots: 0, sot: 0, fc: 0.03, fd: 0.2, yc: 0.07, passes: 38 },
    { id: 'mci-2', name: 'Kyle Walker', short: 'Walker', num: 2, pos: 'LD', x: 82, y: 74, off: 0.04, def: 0.10, usage: 0.03, astShare: 0.07, goals: 0.02, assists: 0.11, shots: 0.5, sot: 0.14, fc: 0.92, fd: 0.78, yc: 0.18, passes: 66 },
    { id: 'mci-3', name: 'Rúben Dias', short: 'Rúben Dias', num: 3, pos: 'DFC', x: 63, y: 77, key: true, off: 0.03, def: 0.16, usage: 0.02, astShare: 0.02, goals: 0.03, assists: 0.02, shots: 0.45, sot: 0.12, fc: 0.88, fd: 0.65, yc: 0.17, passes: 79 },
    { id: 'mci-4', name: 'Manuel Akanji', short: 'Akanji', num: 25, pos: 'DFC', x: 37, y: 77, off: 0.03, def: 0.12, usage: 0.02, astShare: 0.03, goals: 0.04, assists: 0.04, shots: 0.42, sot: 0.13, fc: 0.85, fd: 0.6, yc: 0.15, passes: 75 },
    { id: 'mci-5', name: 'Joško Gvardiol', short: 'Gvardiol', num: 24, pos: 'LI', x: 18, y: 74, off: 0.09, def: 0.11, usage: 0.07, astShare: 0.08, goals: 0.14, assists: 0.09, shots: 1.25, sot: 0.45, fc: 0.9, fd: 0.8, yc: 0.16, passes: 68 },
    { id: 'mci-6', name: 'Mateo Kovačić', short: 'Kovačić', num: 8, pos: 'MCD', x: 50, y: 61, off: 0.08, def: 0.10, usage: 0.06, astShare: 0.12, goals: 0.1, assists: 0.12, shots: 1.05, sot: 0.35, fc: 1.25, fd: 1.5, yc: 0.22, passes: 74 },
    { id: 'mci-7', name: 'Bernardo Silva', short: 'B. Silva', num: 20, pos: 'MC', x: 67, y: 49, key: true, off: 0.19, def: 0.07, usage: 0.12, astShare: 0.24, goals: 0.21, assists: 0.29, shots: 1.65, sot: 0.68, fc: 0.95, fd: 1.95, yc: 0.16, passes: 64 },
    { id: 'mci-8', name: 'Kevin De Bruyne', short: 'De Bruyne', num: 17, pos: 'MCO', x: 35, y: 47, key: true, off: 0.31, def: 0.04, usage: 0.18, astShare: 0.36, goals: 0.28, assists: 0.48, shots: 2.75, sot: 1.08, fc: 0.68, fd: 1.25, yc: 0.11, passes: 59 },
    { id: 'mci-9', name: 'Phil Foden', short: 'Foden', num: 47, pos: 'ED', x: 80, y: 29, key: true, off: 0.29, def: 0.04, usage: 0.19, astShare: 0.22, goals: 0.42, assists: 0.26, shots: 3.1, sot: 1.32, fc: 0.6, fd: 1.7, yc: 0.09, passes: 46 },
    { id: 'mci-10', name: 'Erling Haaland', short: 'Haaland', num: 9, pos: 'DC', x: 50, y: 19, key: true, off: 0.48, def: 0.02, usage: 0.29, astShare: 0.09, goals: 0.88, assists: 0.14, shots: 4.55, sot: 2.25, fc: 0.95, fd: 1.4, yc: 0.1, passes: 16 },
    { id: 'mci-11', name: 'Jérémy Doku', short: 'Doku', num: 11, pos: 'EI', x: 20, y: 29, off: 0.17, def: 0.02, usage: 0.13, astShare: 0.21, goals: 0.18, assists: 0.26, shots: 1.9, sot: 0.72, fc: 0.72, fd: 2.45, yc: 0.12, passes: 33 },
  ],
  [
    { id: 'mci-12', name: 'Rodri Hernández', short: 'Rodri', num: 16, pos: 'MCD', avail: 'out', injuryNote: 'Lesión de rodilla — baja confirmada', shots: 1.3, goals: 0.16, assists: 0.2 },
    { id: 'mci-13', name: 'İlkay Gündoğan', short: 'Gündoğan', num: 19, pos: 'MC', shots: 1.25, goals: 0.15, assists: 0.18 },
    { id: 'mci-14', name: 'Savinho', short: 'Savinho', num: 26, pos: 'ED', shots: 1.45, goals: 0.14, assists: 0.22 },
  ]
);

// NBA Rosters (Golden State Warriors vs Boston Celtics + Denver Nuggets vs Dallas Mavericks)
function buildNbaRoster(
  teamId: string,
  teamName: string,
  teamShort: string,
  isHome: boolean,
  starters: Array<{
    id: string;
    name: string;
    short: string;
    num: number;
    pos: 'PG' | 'SG' | 'SF' | 'PF' | 'C';
    x: number;
    y: number;
    key?: boolean;
    avail?: PlayerProfile['availability'];
    injuryNote?: string;
    off: number;
    def: number;
    usage: number;
    astShare: number;
    min: number;
    pts: number;
    reb: number;
    ast: number;
    threes: number;
    stl: number;
    blk: number;
    tov: number;
  }>,
  bench: Array<{
    id: string;
    name: string;
    short: string;
    num: number;
    pos: string;
    avail?: PlayerProfile['availability'];
    injuryNote?: string;
    min: number;
    pts: number;
    reb: number;
    ast: number;
    threes: number;
    stl: number;
    blk: number;
    tov: number;
  }>
): PlayerProfile[] {
  const opps = isHome ? ['LAL', 'PHX', 'SAC', 'MIN', 'OKC'] : ['NYK', 'MIL', 'PHI', 'MIA', 'CLE'];
  const list: PlayerProfile[] = starters.map((p) => ({
    id: p.id,
    sport: 'nba',
    name: p.name,
    shortName: p.short,
    teamId,
    teamName,
    teamShort,
    number: p.num,
    position: p.pos,
    availability: p.avail ?? 'starter',
    injuryNote: p.injuryNote,
    isKeyPlayer: !!p.key,
    pitchCoord: { x: p.x, y: p.y },
    impact: {
      offenseDelta: p.off,
      defenseDelta: p.def,
      usageShare: p.usage,
      assistShare: p.astShare,
    },
    splits: makeNbaSplits({
      minutes: p.min,
      pts: p.pts,
      reb: p.reb,
      ast: p.ast,
      threes: p.threes,
      stl: p.stl,
      blk: p.blk,
      tov: p.tov,
    }),
    recentLogs: makeNbaLogs(opps, p.pts, p.reb, p.ast, p.threes),
    sampleSizeGames: 38,
    statsQuality: 'verified',
    statsOriginNote: 'Datos simulados de referencia offline',
  }));

  for (const b of bench) {
    list.push({
      id: b.id,
      sport: 'nba',
      name: b.name,
      shortName: b.short,
      teamId,
      teamName,
      teamShort,
      number: b.num,
      position: b.pos,
      availability: b.avail ?? 'bench',
      injuryNote: b.injuryNote,
      isKeyPlayer: false,
      impact: { offenseDelta: 1.1, defenseDelta: 0.8, usageShare: 0.14, assistShare: 0.12 },
      splits: makeNbaSplits({
        minutes: b.min,
        pts: b.pts,
        reb: b.reb,
        ast: b.ast,
        threes: b.threes,
        stl: b.stl,
        blk: b.blk,
        tov: b.tov,
      }),
      recentLogs: makeNbaLogs(opps, b.pts, b.reb, b.ast, b.threes),
      sampleSizeGames: 35,
      statsQuality: 'verified',
      statsOriginNote: 'Datos simulados de referencia offline',
    });
  }
  return list;
}

const gswPlayers = buildNbaRoster(
  'gsw',
  'Golden State Warriors',
  'GSW',
  true,
  [
    { id: 'gsw-30', name: 'Stephen Curry', short: 'S. Curry', num: 30, pos: 'PG', x: 50, y: 63, key: true, off: 6.4, def: 0.5, usage: 0.31, astShare: 0.29, min: 33.4, pts: 26.8, reb: 4.6, ast: 6.1, threes: 4.7, stl: 0.9, blk: 0.4, tov: 2.9 },
    { id: 'gsw-2', name: 'Brandin Podziemski', short: 'Podziemski', num: 2, pos: 'SG', x: 78, y: 71, off: 1.8, def: 1.1, usage: 0.17, astShare: 0.21, min: 27.2, pts: 10.6, reb: 5.2, ast: 3.9, threes: 1.5, stl: 1.0, blk: 0.2, tov: 1.4 },
    { id: 'gsw-22', name: 'Andrew Wiggins', short: 'Wiggins', num: 22, pos: 'SF', x: 20, y: 74, key: true, off: 2.4, def: 1.8, usage: 0.21, astShare: 0.11, min: 29.8, pts: 16.4, reb: 4.5, ast: 2.2, threes: 2.0, stl: 0.9, blk: 0.8, tov: 1.5 },
    { id: 'gsw-23', name: 'Draymond Green', short: 'D. Green', num: 23, pos: 'PF', x: 66, y: 84, key: true, off: 1.9, def: 3.6, usage: 0.13, astShare: 0.27, min: 28.4, pts: 8.8, reb: 6.4, ast: 5.9, threes: 1.1, stl: 1.1, blk: 1.0, tov: 2.4 },
    { id: 'gsw-32', name: 'Trayce Jackson-Davis', short: 'Jackson-Davis', num: 32, pos: 'C', x: 38, y: 87, off: 1.3, def: 1.9, usage: 0.14, astShare: 0.08, min: 22.6, pts: 9.2, reb: 6.8, ast: 1.8, threes: 0.0, stl: 0.6, blk: 1.2, tov: 1.0 },
  ],
  [
    { id: 'gsw-7', name: 'Buddy Hield', short: 'B. Hield', num: 7, pos: 'SG', min: 24.5, pts: 14.2, reb: 3.4, ast: 1.8, threes: 3.3, stl: 0.8, blk: 0.3, tov: 1.2 },
    { id: 'gsw-00', name: 'Jonathan Kuminga', short: 'Kuminga', num: 0, pos: 'PF', min: 25.8, pts: 15.6, reb: 4.7, ast: 2.1, threes: 0.9, stl: 0.9, blk: 0.5, tov: 1.7 },
    { id: 'gsw-5', name: 'Kevon Looney', short: 'Looney', num: 5, pos: 'C', min: 16.4, pts: 5.2, reb: 6.6, ast: 1.7, threes: 0.0, stl: 0.5, blk: 0.5, tov: 0.7 },
  ]
);

const bosPlayers = buildNbaRoster(
  'bos',
  'Boston Celtics',
  'BOS',
  false,
  [
    { id: 'bos-4', name: 'Jrue Holiday', short: 'J. Holiday', num: 4, pos: 'PG', x: 50, y: 63, key: true, off: 2.1, def: 3.2, usage: 0.17, astShare: 0.22, min: 31.2, pts: 12.6, reb: 4.5, ast: 4.4, threes: 1.9, stl: 1.1, blk: 0.6, tov: 1.4 },
    { id: 'bos-9', name: 'Derrick White', short: 'D. White', num: 9, pos: 'SG', x: 78, y: 71, key: true, off: 2.9, def: 2.8, usage: 0.20, astShare: 0.22, min: 33.0, pts: 16.8, reb: 4.3, ast: 4.7, threes: 3.3, stl: 1.0, blk: 1.1, tov: 1.6 },
    { id: 'bos-7', name: 'Jaylen Brown', short: 'J. Brown', num: 7, pos: 'SF', x: 20, y: 74, key: true, off: 4.1, def: 1.8, usage: 0.28, astShare: 0.19, min: 34.8, pts: 23.8, reb: 6.1, ast: 4.1, threes: 2.2, stl: 1.2, blk: 0.4, tov: 2.6 },
    { id: 'bos-0', name: 'Jayson Tatum', short: 'J. Tatum', num: 0, pos: 'PF', x: 66, y: 84, key: true, off: 5.8, def: 2.1, usage: 0.30, astShare: 0.27, min: 36.2, pts: 27.6, reb: 8.6, ast: 5.6, threes: 3.6, stl: 1.1, blk: 0.6, tov: 2.7 },
    { id: 'bos-8', name: 'Kristaps Porziņģis', short: 'Porziņģis', num: 8, pos: 'C', x: 38, y: 87, key: true, avail: 'doubtful', injuryNote: 'Gestión de carga — cuestionable', off: 3.5, def: 2.4, usage: 0.23, astShare: 0.10, min: 29.0, pts: 19.4, reb: 6.9, ast: 1.9, threes: 2.1, stl: 0.7, blk: 1.7, tov: 1.5 },
  ],
  [
    { id: 'bos-11', name: 'Payton Pritchard', short: 'Pritchard', num: 11, pos: 'PG', min: 26.8, pts: 14.5, reb: 3.6, ast: 3.4, threes: 3.4, stl: 0.9, blk: 0.1, tov: 1.1 },
    { id: 'bos-42', name: 'Al Horford', short: 'Horford', num: 42, pos: 'C', min: 26.2, pts: 8.8, reb: 6.2, ast: 2.6, threes: 1.8, stl: 0.6, blk: 1.0, tov: 0.8 },
    { id: 'bos-30', name: 'Sam Hauser', short: 'Hauser', num: 30, pos: 'SF', min: 20.4, pts: 8.6, reb: 3.2, ast: 1.0, threes: 2.4, stl: 0.5, blk: 0.2, tov: 0.4 },
  ]
);

const denPlayers = buildNbaRoster(
  'den',
  'Denver Nuggets',
  'DEN',
  true,
  [
    { id: 'den-27', name: 'Jamal Murray', short: 'J. Murray', num: 27, pos: 'PG', x: 50, y: 63, key: true, off: 3.8, def: 0.6, usage: 0.26, astShare: 0.27, min: 34.2, pts: 21.1, reb: 3.9, ast: 6.2, threes: 2.4, stl: 1.2, blk: 0.5, tov: 2.2 },
    { id: 'den-0', name: 'Christian Braun', short: 'C. Braun', num: 0, pos: 'SG', x: 78, y: 71, off: 1.6, def: 1.4, usage: 0.15, astShare: 0.09, min: 32.0, pts: 14.4, reb: 4.8, ast: 2.1, threes: 1.2, stl: 1.1, blk: 0.5, tov: 1.0 },
    { id: 'den-1', name: 'Michael Porter Jr.', short: 'Porter Jr.', num: 1, pos: 'SF', x: 20, y: 74, key: true, off: 2.9, def: 0.8, usage: 0.21, astShare: 0.08, min: 33.4, pts: 18.2, reb: 6.8, ast: 2.1, threes: 2.7, stl: 0.7, blk: 0.6, tov: 1.3 },
    { id: 'den-32', name: 'Aaron Gordon', short: 'A. Gordon', num: 32, pos: 'PF', x: 66, y: 84, key: true, off: 2.4, def: 2.3, usage: 0.17, astShare: 0.13, min: 31.8, pts: 14.2, reb: 6.2, ast: 3.2, threes: 1.0, stl: 0.8, blk: 0.6, tov: 1.4 },
    { id: 'den-15', name: 'Nikola Jokić', short: 'N. Jokić', num: 15, pos: 'C', x: 38, y: 87, key: true, off: 8.6, def: 2.0, usage: 0.31, astShare: 0.42, min: 36.4, pts: 29.2, reb: 12.8, ast: 9.8, threes: 1.9, stl: 1.5, blk: 0.8, tov: 3.2 },
  ],
  [
    { id: 'den-4', name: 'Russell Westbrook', short: 'Westbrook', num: 4, pos: 'PG', min: 24.0, pts: 11.8, reb: 4.6, ast: 5.9, threes: 1.0, stl: 1.3, blk: 0.4, tov: 2.6 },
    { id: 'den-8', name: 'Peyton Watson', short: 'P. Watson', num: 8, pos: 'SF', min: 22.5, pts: 8.4, reb: 3.6, ast: 1.3, threes: 0.8, stl: 0.7, blk: 1.3, tov: 0.8 },
  ]
);

const dalPlayers = buildNbaRoster(
  'dal',
  'Dallas Mavericks',
  'DAL',
  false,
  [
    { id: 'dal-77', name: 'Luka Dončić', short: 'L. Dončić', num: 77, pos: 'PG', x: 50, y: 63, key: true, off: 7.4, def: 0.4, usage: 0.35, astShare: 0.40, min: 37.0, pts: 29.6, reb: 8.4, ast: 8.7, threes: 3.6, stl: 1.5, blk: 0.5, tov: 3.7 },
    { id: 'dal-11', name: 'Kyrie Irving', short: 'K. Irving', num: 11, pos: 'SG', x: 78, y: 71, key: true, off: 4.8, def: 0.6, usage: 0.27, astShare: 0.24, min: 35.4, pts: 24.6, reb: 4.6, ast: 5.1, threes: 2.9, stl: 1.2, blk: 0.4, tov: 2.0 },
    { id: 'dal-31', name: 'Klay Thompson', short: 'K. Thompson', num: 31, pos: 'SF', x: 20, y: 74, off: 2.0, def: 0.4, usage: 0.19, astShare: 0.08, min: 27.6, pts: 14.0, reb: 3.4, ast: 1.9, threes: 3.1, stl: 0.7, blk: 0.4, tov: 1.2 },
    { id: 'dal-25', name: 'P.J. Washington', short: 'Washington', num: 25, pos: 'PF', x: 66, y: 84, off: 1.8, def: 2.1, usage: 0.16, astShare: 0.09, min: 31.4, pts: 13.2, reb: 7.6, ast: 2.1, threes: 1.5, stl: 1.2, blk: 1.1, tov: 1.5 },
    { id: 'dal-2', name: 'Dereck Lively II', short: 'Lively II', num: 2, pos: 'C', x: 38, y: 87, key: true, off: 1.7, def: 2.8, usage: 0.13, astShare: 0.10, min: 24.8, pts: 9.4, reb: 7.9, ast: 2.4, threes: 0.0, stl: 0.6, blk: 1.6, tov: 1.2 },
  ],
  [
    { id: 'dal-21', name: 'Daniel Gafford', short: 'Gafford', num: 21, pos: 'C', min: 21.4, pts: 11.8, reb: 6.4, ast: 1.2, threes: 0.0, stl: 0.5, blk: 1.5, tov: 1.0 },
    { id: 'dal-13', name: 'Naji Marshall', short: 'Marshall', num: 13, pos: 'SF', min: 24.0, pts: 10.6, reb: 4.1, ast: 2.3, threes: 0.9, stl: 1.0, blk: 0.3, tov: 1.1 },
  ]
);

const nowIso = new Date().toISOString();

export const SANDBOX_MATCHES: MatchRecord[] = [
  {
    id: 'sim-fb-1',
    sport: 'football',
    competition: 'LaLiga EA Sports',
    season: '2025/26',
    status: 'today',
    kickoffIso: new Date(Date.now() + 3.5 * 3600 * 1000).toISOString(),
    venue: 'Estadio Santiago Bernabéu, Madrid',
    homeTeam: {
      id: 'rma',
      name: 'Real Madrid',
      shortName: 'RMA',
      league: 'LaLiga EA Sports',
      formation: '4-3-3',
      record: '18G · 4E · 2P',
      formRecent: ['W', 'W', 'D', 'W', 'W'],
      restDays: 4,
      attackHome: 2.25,
      attackAway: 1.75,
      defenseHome: 0.85,
      defenseAway: 1.05,
      avgCorners: 6.2,
      avgYellowCards: 1.85,
    },
    awayTeam: {
      id: 'fcb',
      name: 'FC Barcelona',
      shortName: 'FCB',
      league: 'LaLiga EA Sports',
      formation: '4-2-3-1',
      record: '17G · 3E · 4P',
      formRecent: ['W', 'L', 'W', 'W', 'D'],
      restDays: 4,
      attackHome: 2.35,
      attackAway: 1.92,
      defenseHome: 0.96,
      defenseAway: 1.18,
      avgCorners: 5.9,
      avgYellowCards: 2.05,
    },
    lineupStatus: 'confirmed',
    homePlayers: madridPlayers,
    awayPlayers: barcaPlayers,
    h2hSummary: {
      played: 5,
      homeWins: 3,
      draws: 0,
      awayWins: 2,
      avgTotalPointsOrGoals: 3.6,
      lastMeetings: [
        { date: '2026-04-12', home: 'FC Barcelona', away: 'Real Madrid', score: '2 - 3' },
        { date: '2025-10-26', home: 'Real Madrid', away: 'FC Barcelona', score: '2 - 1' },
        { date: '2025-05-11', home: 'FC Barcelona', away: 'Real Madrid', score: '3 - 1' },
      ],
    },
    odds: [],
    dataOrigin: 'Simulador Matemático Offline (Escenario de referencia)',
    updatedAt: nowIso,
    isOfflineReference: true,
  },
  {
    id: 'sim-fb-2',
    sport: 'football',
    competition: 'Premier League',
    season: '2025/26',
    status: 'live',
    minuteOrClock: '64\'',
    kickoffIso: new Date(Date.now() - 75 * 60 * 1000).toISOString(),
    venue: 'Emirates Stadium, Londres',
    homeTeam: {
      id: 'ars',
      name: 'Arsenal FC',
      shortName: 'ARS',
      league: 'Premier League',
      formation: '4-3-3',
      record: '17G · 5E · 2P',
      formRecent: ['W', 'W', 'W', 'D', 'W'],
      restDays: 5,
      attackHome: 2.08,
      attackAway: 1.65,
      defenseHome: 0.78,
      defenseAway: 0.96,
      avgCorners: 6.8,
      avgYellowCards: 1.7,
    },
    awayTeam: {
      id: 'mci',
      name: 'Manchester City',
      shortName: 'MCI',
      league: 'Premier League',
      formation: '4-2-3-1',
      record: '16G · 4E · 4P',
      formRecent: ['W', 'D', 'L', 'W', 'W'],
      restDays: 3,
      attackHome: 2.22,
      attackAway: 1.88,
      defenseHome: 0.92,
      defenseAway: 1.12,
      avgCorners: 6.5,
      avgYellowCards: 1.8,
    },
    score: { home: 1, away: 1, periods: '1-0 al descanso' },
    lineupStatus: 'confirmed',
    homePlayers: arsenalPlayers,
    awayPlayers: cityPlayers,
    h2hSummary: {
      played: 5,
      homeWins: 2,
      draws: 2,
      awayWins: 1,
      avgTotalPointsOrGoals: 2.4,
      lastMeetings: [
        { date: '2026-03-02', home: 'Manchester City', away: 'Arsenal FC', score: '2 - 2' },
        { date: '2025-09-22', home: 'Arsenal FC', away: 'Manchester City', score: '1 - 0' },
      ],
    },
    odds: [],
    dataOrigin: 'Simulador Matemático Offline (Escenario de referencia)',
    updatedAt: nowIso,
    isOfflineReference: true,
  },
  {
    id: 'sim-nba-1',
    sport: 'nba',
    competition: 'NBA Regular Season',
    season: '2025-26',
    status: 'today',
    kickoffIso: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString(),
    venue: 'Chase Center, San Francisco',
    homeTeam: {
      id: 'gsw',
      name: 'Golden State Warriors',
      shortName: 'GSW',
      league: 'NBA Western',
      record: '24-14',
      formRecent: ['W', 'W', 'L', 'W', 'W'],
      restDays: 2,
      isBackToBack: false,
      offRating: 117.4,
      defRating: 111.8,
      pace: 100.4,
      homeCourtBoost: 2.7,
    },
    awayTeam: {
      id: 'bos',
      name: 'Boston Celtics',
      shortName: 'BOS',
      league: 'NBA Eastern',
      record: '28-10',
      formRecent: ['W', 'W', 'W', 'L', 'W'],
      restDays: 1,
      isBackToBack: true,
      offRating: 119.8,
      defRating: 110.2,
      pace: 97.6,
      homeCourtBoost: 2.8,
    },
    lineupStatus: 'provisional',
    homePlayers: gswPlayers,
    awayPlayers: bosPlayers,
    h2hSummary: {
      played: 4,
      homeWins: 2,
      draws: 0,
      awayWins: 2,
      avgTotalPointsOrGoals: 229.5,
      lastMeetings: [
        { date: '2026-01-20', home: 'Boston Celtics', away: 'Golden State Warriors', score: '112 - 118' },
        { date: '2025-11-06', home: 'Golden State Warriors', away: 'Boston Celtics', score: '115 - 121' },
      ],
    },
    odds: [],
    dataOrigin: 'Simulador Matemático Offline (Escenario de referencia)',
    updatedAt: nowIso,
    isOfflineReference: true,
  },
  {
    id: 'sim-nba-2',
    sport: 'nba',
    competition: 'NBA Regular Season',
    season: '2025-26',
    status: 'upcoming',
    kickoffIso: new Date(Date.now() + 26 * 3600 * 1000).toISOString(),
    venue: 'Ball Arena, Denver',
    homeTeam: {
      id: 'den',
      name: 'Denver Nuggets',
      shortName: 'DEN',
      league: 'NBA Western',
      record: '25-13',
      formRecent: ['W', 'W', 'W', 'W', 'L'],
      restDays: 2,
      isBackToBack: false,
      offRating: 118.2,
      defRating: 112.9,
      pace: 98.4,
      homeCourtBoost: 3.1,
    },
    awayTeam: {
      id: 'dal',
      name: 'Dallas Mavericks',
      shortName: 'DAL',
      league: 'NBA Western',
      record: '23-15',
      formRecent: ['L', 'W', 'W', 'D', 'W'] as unknown as ('W' | 'D' | 'L')[],
      restDays: 2,
      isBackToBack: false,
      offRating: 117.1,
      defRating: 113.4,
      pace: 99.6,
      homeCourtBoost: 2.5,
    },
    lineupStatus: 'confirmed',
    homePlayers: denPlayers,
    awayPlayers: dalPlayers,
    h2hSummary: {
      played: 4,
      homeWins: 3,
      draws: 0,
      awayWins: 1,
      avgTotalPointsOrGoals: 234.0,
      lastMeetings: [
        { date: '2026-02-14', home: 'Denver Nuggets', away: 'Dallas Mavericks', score: '124 - 117' },
      ],
    },
    odds: [],
    dataOrigin: 'Simulador Matemático Offline (Escenario de referencia)',
    updatedAt: nowIso,
    isOfflineReference: true,
  },
  {
    id: 'sim-fb-3',
    sport: 'football',
    competition: 'LaLiga EA Sports',
    season: '2025/26',
    status: 'finished',
    kickoffIso: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    venue: 'Estadio Metropolitano, Madrid',
    homeTeam: {
      id: 'atm',
      name: 'Atlético de Madrid',
      shortName: 'ATM',
      league: 'LaLiga EA Sports',
      formation: '4-4-2',
      record: '16G · 5E · 3P',
      formRecent: ['W', 'W', 'D', 'W', 'L'],
      restDays: 4,
      attackHome: 1.82,
      defenseHome: 0.72,
    },
    awayTeam: {
      id: 'ath',
      name: 'Athletic Club',
      shortName: 'ATH',
      league: 'LaLiga EA Sports',
      formation: '4-2-3-1',
      record: '13G · 7E · 4P',
      formRecent: ['D', 'W', 'W', 'D', 'L'],
      restDays: 4,
      attackAway: 1.24,
      defenseAway: 0.96,
    },
    score: { home: 2, away: 1, periods: 'Finalizado' },
    lineupStatus: 'confirmed',
    homePlayers: madridPlayers.slice(0, 11).map((p, idx) => ({ ...p, id: `atm-${idx}`, teamId: 'atm', teamName: 'Atlético de Madrid', teamShort: 'ATM' })),
    awayPlayers: barcaPlayers.slice(0, 11).map((p, idx) => ({ ...p, id: `ath-${idx}`, teamId: 'ath', teamName: 'Athletic Club', teamShort: 'ATH' })),
    h2hSummary: { played: 5, homeWins: 3, draws: 1, awayWins: 1, avgTotalPointsOrGoals: 2.6, lastMeetings: [] },
    odds: [],
    dataOrigin: 'Simulador Matemático Offline (Escenario de referencia)',
    updatedAt: nowIso,
    isOfflineReference: true,
  },
];

// Clean DAL formRecent just in case
SANDBOX_MATCHES[3].awayTeam.formRecent = ['L', 'W', 'W', 'L', 'W'];

export const SANDBOX_STANDINGS: StandingEntry[] = [
  // LaLiga
  { rank: 1, teamId: 'rma', teamName: 'Real Madrid', teamShort: 'RMA', league: 'LaLiga EA Sports', played: 24, won: 18, drawn: 4, lost: 2, goalsForOrPtsFor: 54, goalsAgainstOrPtsAgainst: 19, diff: 35, pointsOrWinPct: '58', form: ['W', 'W', 'D', 'W', 'W'], homeRecord: '10-2-0', awayRecord: '8-2-2' },
  { rank: 2, teamId: 'fcb', teamName: 'FC Barcelona', teamShort: 'FCB', league: 'LaLiga EA Sports', played: 24, won: 17, drawn: 3, lost: 4, goalsForOrPtsFor: 59, goalsAgainstOrPtsAgainst: 25, diff: 34, pointsOrWinPct: '54', form: ['W', 'L', 'W', 'W', 'D'], homeRecord: '10-1-1', awayRecord: '7-2-3' },
  { rank: 3, teamId: 'atm', teamName: 'Atlético de Madrid', teamShort: 'ATM', league: 'LaLiga EA Sports', played: 24, won: 16, drawn: 5, lost: 3, goalsForOrPtsFor: 43, goalsAgainstOrPtsAgainst: 18, diff: 25, pointsOrWinPct: '53', form: ['W', 'W', 'D', 'W', 'L'], homeRecord: '9-3-0', awayRecord: '7-2-3' },
  { rank: 4, teamId: 'ath', teamName: 'Athletic Club', teamShort: 'ATH', league: 'LaLiga EA Sports', played: 24, won: 13, drawn: 7, lost: 4, goalsForOrPtsFor: 38, goalsAgainstOrPtsAgainst: 22, diff: 16, pointsOrWinPct: '46', form: ['D', 'W', 'W', 'D', 'L'], homeRecord: '8-3-1', awayRecord: '5-4-3' },
  // Premier League
  { rank: 1, teamId: 'ars', teamName: 'Arsenal FC', teamShort: 'ARS', league: 'Premier League', played: 24, won: 17, drawn: 5, lost: 2, goalsForOrPtsFor: 51, goalsAgainstOrPtsAgainst: 18, diff: 33, pointsOrWinPct: '56', form: ['W', 'W', 'W', 'D', 'W'], homeRecord: '9-3-0', awayRecord: '8-2-2' },
  { rank: 2, teamId: 'mci', teamName: 'Manchester City', teamShort: 'MCI', league: 'Premier League', played: 24, won: 16, drawn: 4, lost: 4, goalsForOrPtsFor: 55, goalsAgainstOrPtsAgainst: 24, diff: 31, pointsOrWinPct: '52', form: ['W', 'D', 'L', 'W', 'W'], homeRecord: '9-2-1', awayRecord: '7-2-3' },
  // NBA Western
  { rank: 1, teamId: 'okc', teamName: 'Oklahoma City Thunder', teamShort: 'OKC', league: 'NBA', conference: 'Western', played: 38, won: 31, lost: 7, goalsForOrPtsFor: 118.4, goalsAgainstOrPtsAgainst: 105.6, diff: 12.8, pointsOrWinPct: '.816', form: ['W', 'W', 'W', 'W', 'L'], homeRecord: '17-2', awayRecord: '14-5' },
  { rank: 2, teamId: 'den', teamName: 'Denver Nuggets', teamShort: 'DEN', league: 'NBA', conference: 'Western', played: 38, won: 25, lost: 13, goalsForOrPtsFor: 118.2, goalsAgainstOrPtsAgainst: 112.9, diff: 5.3, pointsOrWinPct: '.658', form: ['W', 'W', 'W', 'W', 'L'], homeRecord: '15-5', awayRecord: '10-8' },
  { rank: 3, teamId: 'gsw', teamName: 'Golden State Warriors', teamShort: 'GSW', league: 'NBA', conference: 'Western', played: 38, won: 24, lost: 14, goalsForOrPtsFor: 117.4, goalsAgainstOrPtsAgainst: 111.8, diff: 5.6, pointsOrWinPct: '.632', form: ['W', 'W', 'L', 'W', 'W'], homeRecord: '14-5', awayRecord: '10-9' },
  { rank: 4, teamId: 'dal', teamName: 'Dallas Mavericks', teamShort: 'DAL', league: 'NBA', conference: 'Western', played: 38, won: 23, lost: 15, goalsForOrPtsFor: 117.1, goalsAgainstOrPtsAgainst: 113.4, diff: 3.7, pointsOrWinPct: '.605', form: ['L', 'W', 'W', 'L', 'W'], homeRecord: '13-6', awayRecord: '10-9' },
  // NBA Eastern
  { rank: 1, teamId: 'bos', teamName: 'Boston Celtics', teamShort: 'BOS', league: 'NBA', conference: 'Eastern', played: 38, won: 28, lost: 10, goalsForOrPtsFor: 119.8, goalsAgainstOrPtsAgainst: 110.2, diff: 9.6, pointsOrWinPct: '.737', form: ['W', 'W', 'W', 'L', 'W'], homeRecord: '16-4', awayRecord: '12-6' },
  { rank: 2, teamId: 'cle', teamName: 'Cleveland Cavaliers', teamShort: 'CLE', league: 'NBA', conference: 'Eastern', played: 38, won: 27, lost: 11, goalsForOrPtsFor: 117.9, goalsAgainstOrPtsAgainst: 110.8, diff: 7.1, pointsOrWinPct: '.711', form: ['W', 'L', 'W', 'W', 'W'], homeRecord: '16-3', awayRecord: '11-8' },
];

export const INITIAL_PREDICTION_HISTORY: LoggedPrediction[] = [
  {
    id: 'hist-1',
    createdAt: new Date(Date.now() - 8 * 86400000).toISOString(),
    sport: 'football',
    matchId: 'ref-fb-a',
    matchLabel: 'Liverpool vs Chelsea',
    market: 'Ambos Equipos Marcan',
    selection: 'Sí',
    predictedProb: 0.68,
    predictedValue: 2.9,
    status: 'won',
    actualValue: 3,
    resolvedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    isReferenceExample: true,
  },
  {
    id: 'hist-2',
    createdAt: new Date(Date.now() - 6 * 86400000).toISOString(),
    sport: 'nba',
    matchId: 'ref-nba-a',
    matchLabel: 'Lakers vs Suns',
    market: 'Puntos Jugador',
    selection: 'LeBron James +23.5 pts',
    predictedProb: 0.61,
    predictedValue: 25.4,
    status: 'won',
    actualValue: 27,
    resolvedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    isReferenceExample: true,
  },
  {
    id: 'hist-3',
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    sport: 'football',
    matchId: 'ref-fb-b',
    matchLabel: 'Inter vs Milan',
    market: 'Más/Menos Goles',
    selection: 'Más de 2.5 goles',
    predictedProb: 0.56,
    predictedValue: 2.68,
    status: 'lost',
    actualValue: 2,
    resolvedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
    isReferenceExample: true,
  },
  {
    id: 'hist-4',
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    sport: 'nba',
    matchId: 'ref-nba-b',
    matchLabel: 'Bucks vs Knicks',
    market: 'Ganador (Moneyline)',
    selection: 'New York Knicks',
    predictedProb: 0.64,
    predictedValue: 4.5,
    status: 'won',
    actualValue: 6,
    resolvedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    isReferenceExample: true,
  },
  {
    id: 'hist-5',
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    sport: 'football',
    matchId: 'ref-fb-c',
    matchLabel: 'Atlético vs Athletic',
    market: 'Resultado Final (1X2)',
    selection: 'Victoria Atlético',
    predictedProb: 0.53,
    predictedValue: 1.62,
    status: 'won',
    actualValue: 2,
    resolvedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    isReferenceExample: true,
  },
];
