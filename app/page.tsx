import { supabaseAdmin } from '@/lib/supabase-server'
import { joinGame, removePlayer } from './actions'
import { Team } from '@/lib/constants'

// --- TYPES ---
interface Player {
  id: string
  name: string
  assigned_teams: Team[]
}

interface Match {
  api_match_id: number
  home_team: string
  away_team: string
  home_goals: number
  away_goals: number
  status: string
  stage: string
  match_number?: number
  kickoff_utc?: string
}

// --- SCORING & ELIMINATION ENGINE ---
function calculateTeamStats(teamName: string, matches: Match[]) {
  let points = 0;
  let goals = 0;
  let isEliminated = false;

  const teamMatches = matches.filter(m => 
    m.home_team === teamName || m.away_team === teamName
  );

  const finishedMatches = teamMatches.filter(m => ['FT', 'AET', 'PEN'].includes(m.status));
  let groupGamesPlayed = 0;

  finishedMatches.forEach(m => {
    const isHome = m.home_team === teamName;
    const teamGoals = isHome ? m.home_goals : m.away_goals;
    const oppGoals = isHome ? m.away_goals : m.home_goals;
    const isGroup = m.stage.toLowerCase().includes('group');

    if (isGroup) groupGamesPlayed++;
    goals += teamGoals;

    if (teamGoals > oppGoals) {
      points += isGroup ? 3 : 5; // 3 for group win, 5 for KO win
    } else if (teamGoals === oppGoals && isGroup) {
      points += 1; // 1 for group draw
    } else if (!isGroup) {
      // If they lost or drew a knockout match (and lost pens), they are eliminated
      // API-Football handles penalty wins usually by updating the advancing team, but for simplicity, losing a KO match triggers this
      isEliminated = true; 
    }
  });

  // Check for Group Stage Elimination (Played 3 games, but not in any KO fixtures)
  if (!isEliminated && groupGamesPlayed >= 3) {
    const inKnockouts = teamMatches.some(m => !m.stage.toLowerCase().includes('group'));
    if (!inKnockouts) isEliminated = true;
  }

  return { points, goals, isEliminated };
}

// --- MAIN PAGE ---
export default async function Home() {
  const isDraftOpen = process.env.NEXT_PUBLIC_DRAFT_OPEN === 'true'

  const [playersRes, matchesRes] = await Promise.all([
    supabaseAdmin.from('players').select('*').order('created_at', { ascending: true }),
    supabaseAdmin.from('matches').select('*')
  ])
  
  const rawPlayers = (playersRes.data || []) as Player[];
  const matches = (matchesRes.data || []) as Match[];

  // If matches are missing kickoff times, try to fetch them from the WC2026 API
  try {
    const needKickoff = matches.some(m => !m.kickoff_utc && ['NS','1H','2H','HT'].includes(m.status || ''));
    if (needKickoff) {
      const STATS_KEY = process.env.STATS_API_KEY;
      const apiBase = 'https://api.wc2026api.com';
      const headers: Record<string,string> = {};
      if (STATS_KEY) headers['Authorization'] = `Bearer ${STATS_KEY}`;

      const resp = await fetch(`${apiBase}/matches`, { headers });
      if (resp.ok) {
        const payload = await resp.json();
        const arr = Array.isArray(payload) ? payload : (payload.data || payload.matches || payload.response || []);
        const kickoffMap: Record<number,string> = {};
        for (const am of arr) {
          if (am && typeof am.id !== 'undefined') {
            kickoffMap[Number(am.id)] = am.kickoff_utc || am.kickoff || '';
          }
        }

        for (const m of matches) {
          if (!m.kickoff_utc && kickoffMap[m.api_match_id]) {
            m.kickoff_utc = kickoffMap[m.api_match_id];
          }
        }
      }
    }
  } catch (err) {
    // don't block page render on upstream errors
    console.error('Kickoff fetch failed', err);
  }

  // 1. Process Leaderboard Data
  const leaderboard = rawPlayers.map(player => {
    let totalPoints = 0;
    let totalGoals = 0;

    const teamStats = player.assigned_teams?.map(team => {
      const stats = calculateTeamStats(team.name, matches);
      totalPoints += stats.points;
      totalGoals += stats.goals;
      return { ...team, ...stats };
    }) || [];

    return { ...player, totalPoints, totalGoals, teamStats };
  }).sort((a, b) => b.totalPoints - a.totalPoints || b.totalGoals - a.totalGoals);

  // Helper to find who owns a team
  const normalize = (s?: string) => {
    if (!s) return '';
    return s.replace(/[^a-zA-Z0-9 ]/g, '').trim().toLowerCase();
  };

  // Helper to find who owns a team. Handles emoji in stored team names
  // and assigned_teams being either objects or strings.
  const getOwner = (teamName: string) => {
    const target = normalize(teamName);
    for (const p of rawPlayers) {
      const assigned = p.assigned_teams || [];
      for (const t of assigned) {
        const candidate = typeof t === 'string' ? t : (t?.name || '');
        const candNorm = normalize(candidate);
        if (!candNorm) continue;
        if (candNorm === target || candNorm.includes(target) || target.includes(candNorm)) {
          return p.name;
        }
      }
    }
    return 'Unknown';
  };

  const formatKickoff = (kickoff?: string, stage?: string) => {
    if (!kickoff) return stage ? stage.replace('Group Stage - ', 'Game ') : '';
    try {
      const d = new Date(kickoff);
      if (Number.isNaN(d.getTime())) return stage ? stage.replace('Group Stage - ', 'Game ') : '';
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return stage ? stage.replace('Group Stage - ', 'Game ') : '';
    }
  }

  // 2. Process Matches (Watchlist & Recent)
  // Prefer sorting by kickoff time when available; fall back to match_number or api id.
  const parseKickoff = (m: Match) => {
    if (m.kickoff_utc) {
      const t = Date.parse(m.kickoff_utc);
      if (!Number.isNaN(t)) return t;
    }
    return null as number | null;
  };

  const matchesSorted = [...matches].sort((a, b) => {
    const aTime = parseKickoff(a) ?? (a.match_number ?? a.api_match_id ?? 0);
    const bTime = parseKickoff(b) ?? (b.match_number ?? b.api_match_id ?? 0);
    return (aTime as number) - (bTime as number);
  });

  const now = Date.now();
  const upcomingStatuses = ['NS', '1H', '2H', 'HT'];
  const activeMatches = matchesSorted
    .filter(m => upcomingStatuses.includes(m.status) && ((parseKickoff(m) ?? Infinity) >= now))
    .slice(0, 4);

  const recentMatches = matchesSorted
    .filter(m => ['FT', 'AET', 'PEN'].includes(m.status))
    .slice(-4)
    .reverse();

  // 3. Prize Pool Math
  const totalPot = rawPlayers.length * 10;
  const fixedPrizes = 30; // 3rd, Golden Boot, Wooden Spoon = £10 each
  const remainingPot = totalPot > fixedPrizes ? totalPot - fixedPrizes : 0;
  const prizes = {
    first: (remainingPot * 0.66).toFixed(2),
    second: (remainingPot * 0.34).toFixed(2),
    third: "10.00",
    special: "10.00"
  };

  const goldenBootWinner = [...leaderboard].sort((a, b) => b.totalGoals - a.totalGoals)[0];
  const woodenSpoonWinner = leaderboard[leaderboard.length - 1];

  return (
    <main className="min-h-screen bg-gray-950 text-white p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        
        {/* HEADER */}
        <div className="flex justify-between items-end border-b border-gray-800 pb-4 mb-8">
          <div>
            <h1 className="text-4xl font-bold mb-2 tracking-tight">
              {isDraftOpen ? "🏆 The Draft" : "🏆 World Cup Stakes"}
            </h1>
            <p className="text-gray-400">
              {isDraftOpen ? "As more players join, the teams change to balance them out. You can bet more times to get more teams." : "The tournament is live. The teams are set now."}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-mono text-green-400">Total Pot: £{totalPot.toFixed(2)}</div>
            <div className="text-sm text-gray-500">{rawPlayers.length} Players Locked In</div>
          </div>
        </div>

        {/* --- MODE 1: DRAFT LOBBY --- */}
        {isDraftOpen && (
          <>
            <form action={joinGame} className="flex gap-4 mb-12 bg-gray-900 p-4 rounded-lg border border-gray-800 shadow-lg">
              <input 
                type="text" 
                name="name" 
                placeholder="Enter your name..." 
                required
                className="flex-1 bg-gray-950 border border-gray-700 rounded px-4 py-2 focus:outline-none focus:border-blue-500"
              />
              <button 
                type="submit" 
                className="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded font-semibold transition"
              >
                Join & Re-Draft
              </button>
            </form>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {leaderboard.map((player) => {
                const totalScore = player.assigned_teams?.reduce((acc, team) => acc + team.powerScore, 0) || 0;
                
                return (
                  <div key={player.id} className="relative bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition shadow-lg">
                    
                    {/* REMOVE BUTTON */}
                    <form action={removePlayer} className="absolute top-4 right-4">
                      <input type="hidden" name="id" value={player.id} />
                      <button 
                        type="submit" 
                        className="text-gray-600 hover:text-red-500 transition"
                        title="Remove Player"
                      >
                        ✕
                      </button>
                    </form>

                    <div className="flex justify-between items-center mb-4 border-b border-gray-800 pb-2 pr-6">
                      <h2 className="text-xl font-bold">{player.name}</h2>
                      <span className="text-xs bg-gray-800 px-2 py-1 rounded text-gray-400">
                        {totalScore} Power Pts
                      </span>
                    </div>
                    
                    <ul className="space-y-2">
                      {player.assigned_teams?.map((team) => (
                        <li key={team.name} className="flex justify-between items-center text-sm">
                          <span>{team.name}</span>
                          <span className="text-gray-500 text-xs">Rank: {team.fifaRank}</span>
                        </li>
                      ))}
                    </ul>
                    
                    <div className="mt-4 pt-4 border-t border-gray-800 text-xs text-gray-500 text-center">
                      {player.assigned_teams?.length || 0} Teams Assigned
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* --- MODE 2: LIVE TOURNAMENT --- */}
        {!isDraftOpen && (
          <div className="space-y-8">
            
            {/* TOP ROW: RECENT & WATCHLIST */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              {/* RECENT RESULTS */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-lg">
                <h2 className="text-xl font-bold mb-4 text-green-400 flex items-center gap-2">🏁 Recent Results</h2>
                {recentMatches.length === 0 ? (
                  <p className="text-gray-500 text-sm">No matches finished yet.</p>
                ) : (
                  <div className="space-y-3">
                    {recentMatches.map(match => (
                      <div key={match.api_match_id} className="bg-gray-950 p-3 rounded border border-gray-800 flex justify-between items-center text-sm">
                        <div className="flex-1 text-right border-r border-gray-800 pr-4">
                          <div className="font-bold">{match.home_team}</div>
                          <div className="text-xs text-gray-500">{getOwner(match.home_team)}</div>
                        </div>
                        <div className="px-4 font-mono font-bold text-lg text-yellow-500">
                          {match.home_goals} - {match.away_goals}
                        </div>
                        <div className="flex-1 text-left border-l border-gray-800 pl-4">
                          <div className="font-bold">{match.away_team}</div>
                          <div className="text-xs text-gray-500">{getOwner(match.away_team)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* WATCHLIST */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-lg">
                <h2 className="text-xl font-bold mb-4 text-blue-400 flex items-center gap-2">📺 Next Up / Live</h2>
                {activeMatches.length === 0 ? (
                  <p className="text-gray-500 text-sm">No upcoming matches scheduled.</p>
                ) : (
                  <div className="space-y-3">
                    {activeMatches.map(match => (
                      <div key={match.api_match_id} className="bg-gray-950 p-3 rounded border border-gray-800 flex justify-between items-center text-sm">
                        <div className="flex-1 text-right border-r border-gray-800 pr-4">
                          <div className="font-bold">{match.home_team}</div>
                          <div className="text-xs text-gray-500">{getOwner(match.home_team)}</div>
                        </div>
                        <div className="px-4 text-xs font-bold text-gray-500 uppercase text-center min-w-[110px]">
                          {formatKickoff(match.kickoff_utc, match.stage)}
                        </div>
                        <div className="flex-1 text-left border-l border-gray-800 pl-4">
                          <div className="font-bold">{match.away_team}</div>
                          <div className="text-xs text-gray-500">{getOwner(match.away_team)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* THE PAYOUT DASHBOARD */}
            {rawPlayers.length > 0 && (
              <div className="bg-gradient-to-r from-gray-900 to-gray-800 border border-gray-700 rounded-xl p-6 shadow-xl">
                <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-white">💰 Projected Payouts</h2>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div className="bg-gray-950 p-4 rounded-lg border border-yellow-600 shadow-inner">
                    <div className="text-yellow-500 text-sm font-bold">🏆 1st Place</div>
                    <div className="text-2xl font-mono text-white">£{prizes.first}</div>
                    <div className="text-gray-400 text-sm mt-1 truncate">{leaderboard[0]?.name || '-'}</div>
                  </div>
                  <div className="bg-gray-950 p-4 rounded-lg border border-gray-400 shadow-inner">
                    <div className="text-gray-400 text-sm font-bold">🥈 2nd Place</div>
                    <div className="text-2xl font-mono text-white">£{prizes.second}</div>
                    <div className="text-gray-400 text-sm mt-1 truncate">{leaderboard[1]?.name || '-'}</div>
                  </div>
                  <div className="bg-gray-950 p-4 rounded-lg border border-orange-700 shadow-inner">
                    <div className="text-orange-600 text-sm font-bold">🥉 3rd Place</div>
                    <div className="text-2xl font-mono text-white">£{prizes.third}</div>
                    <div className="text-gray-400 text-sm mt-1 truncate">{leaderboard[2]?.name || '-'}</div>
                  </div>
                  <div className="bg-gray-950 p-4 rounded-lg border border-blue-800 shadow-inner">
                    <div className="text-blue-500 text-sm font-bold">⚽ Golden Boot</div>
                    <div className="text-2xl font-mono text-white">£{prizes.special}</div>
                    <div className="text-gray-400 text-sm mt-1 truncate">{goldenBootWinner?.name || '-'}</div>
                  </div>
                  <div className="bg-gray-950 p-4 rounded-lg border border-stone-600 shadow-inner">
                    <div className="text-stone-400 text-sm font-bold">🥄 Wooden Spoon</div>
                    <div className="text-2xl font-mono text-white">£{prizes.special}</div>
                    <div className="text-gray-400 text-sm mt-1 truncate">{woodenSpoonWinner?.name || '-'}</div>
                  </div>
                </div>
              </div>
            )}

            {/* LEADERBOARD */}
            <div>
              <h2 className="text-xl font-bold mb-4 flex items-center gap-2">📊 Live Standings</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {leaderboard.map((player, index) => (
                  <div key={player.id} className={`bg-gray-900 border rounded-xl p-5 transition-all shadow-lg ${index === 0 ? 'border-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.2)]' : index === 1 ? 'border-gray-400' : index === 2 ? 'border-orange-700' : 'border-gray-800'}`}>
                    <div className="flex justify-between items-center mb-4 border-b border-gray-800 pb-2">
                      <h2 className="text-xl font-bold flex items-center gap-2">
                        <span className="text-gray-500 text-sm">#{index + 1}</span> {player.name}
                      </h2>
                      <div className="text-right">
                        <div className="font-bold text-lg text-green-400">{player.totalPoints} pts</div>
                        <div className="text-xs text-gray-500">{player.totalGoals} goals (tie)</div>
                      </div>
                    </div>
                    
                    <ul className="space-y-2">
                      {player.teamStats.map((team) => (
                        <li key={team.name} className={`flex justify-between items-center text-sm ${team.isEliminated ? 'opacity-40' : ''}`}>
                          <span className={team.isEliminated ? 'line-through' : ''}>
                            {team.name} {team.isEliminated && '💀'}
                          </span>
                          <span className="text-gray-400 font-mono">
                            <span className="text-green-500 mr-2">{team.points > 0 ? `+${team.points}` : ' 0'}</span>
                            <span className="text-xs">({team.goals}G)</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
            
          </div>
        )}
        
      </div>
    </main>
  )
}