import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';
import { TEAMS } from '@/lib/constants';

export async function GET(request: Request) {
  // 1. Security Check
  // Allows Vercel Cron (Bearer header) OR manual browser testing (?secret=...)
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');
  const authHeader = request.headers.get('authorization');

  if (
    secret !== process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    // 2. Use TheStatsAPI to fetch competition -> season -> matches for 2026.
    const STATS_KEY = process.env.STATS_API_KEY;
    if (!STATS_KEY) {
      return NextResponse.json({ success: false, message: 'Missing STATS_API_KEY env var' }, { status: 500 });
    }

    const apiBase = 'https://api.thestatsapi.com/api';

    // 2a. Find the FIFA World Cup competition id
    const compRes = await fetch(`${apiBase}/football/competitions?search=World%20Cup`, {
      headers: { Authorization: `Bearer ${STATS_KEY}` },
    });
    const compJson = await compRes.json();
    const comps = compJson.data || [];
    const worldCup = comps.find((c: any) => /world cup/i.test(c.name));
    if (!worldCup) {
      return NextResponse.json({ success: false, message: 'FIFA World Cup competition not found in TheStatsAPI' }, { status: 404 });
    }

    // 2b. Find the season ID for 2026
    const seasonsRes = await fetch(`${apiBase}/football/competitions/${worldCup.id}/seasons`, {
      headers: { Authorization: `Bearer ${STATS_KEY}` },
    });
    const seasonsJson = await seasonsRes.json();
    const seasons = seasonsJson.data || [];
    const season = seasons.find((s: any) => s.start_year === 2026 || s.end_year === 2026 || (s.year && s.year.includes('2026')) );
    if (!season) {
      return NextResponse.json({ success: true, message: 'No 2026 season found for FIFA World Cup yet.' });
    }

    // 2c. Fetch paginated matches for the competition season
    let page = 1;
    const perPage = 200;
    let allMatches: any[] = [];
    while (true) {
      const mRes = await fetch(`${apiBase}/football/matches?competition_id=${worldCup.id}&season_id=${season.id}&page=${page}&per_page=${perPage}`, {
        headers: { Authorization: `Bearer ${STATS_KEY}` },
      });
      const mJson = await mRes.json();
      const dataMatches = mJson.data || [];
      allMatches = allMatches.concat(dataMatches);
      const meta = mJson.meta;
      if (!meta || !meta.pagination || (meta.pagination.current_page >= meta.pagination.total_pages)) break;
      page += 1;
    }

    if (!allMatches || allMatches.length === 0) {
      return NextResponse.json({ success: true, message: 'No 2026 matches available in TheStatsAPI yet. Waiting for schedule release.' });
    }

    // 3. Helper to match API name ("France") with our DB name ("🇫🇷 France")
    const getFullTeamName = (apiName: string) => {
      const match = TEAMS.find(t => t.name.includes(apiName));
      return match ? match.name : apiName; 
    };

    // 4. Format the data for Supabase
    const matchesToUpsert = allMatches.map((match: any) => {
      // Extract numeric id when possible (e.g., mt_12345 -> 12345) for legacy numeric column
      const idDigits = (match.id || '').match(/(\d+)/);
      const apiId = idDigits ? Number(idDigits[0]) : match.id;

      return {
        api_match_id: apiId,
        home_team: getFullTeamName(match.home_team?.name || ''),
        away_team: getFullTeamName(match.away_team?.name || ''),
        home_goals: (match.score && match.score.home) ?? 0,
        away_goals: (match.score && match.score.away) ?? 0,
        status: match.status, // 'scheduled', 'live', 'finished', etc.
        stage: match.stage_name ?? (match.matchday ? `Matchday ${match.matchday}` : null),
        updated_at: new Date().toISOString(),
      };
    });

    // 5. Upsert into Supabase (If the match ID exists, update it. If not, insert it)
    const { error } = await supabaseAdmin
      .from('matches')
      .upsert(matchesToUpsert, { onConflict: 'api_match_id' });

    if (error) throw error;

    return NextResponse.json({ 
      success: true, 
      message: `Successfully synced ${matchesToUpsert.length} matches!` 
    });
    
  } catch (error: any) {
    console.error('Sync Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}