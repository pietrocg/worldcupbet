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
    // 2. Fetch the 2026 World Cup Matches
    // league=1 is World Cup. season=2026.
    const response = await fetch('https://v3.football.api-sports.io/fixtures?league=1&season=2026', {
      headers: {
        'x-apisports-key': process.env.API_FOOTBALL_KEY!,
      },
    });

    const data = await response.json();
    
    // If the 2026 schedule isn't published yet, exit gracefully without breaking.
    if (!data.response || data.response.length === 0) {
       return NextResponse.json({ 
        success: true, 
        message: 'No 2026 matches available in the API yet. Waiting for schedule release.' 
      });
    }

    // 3. Helper to match API name ("France") with our DB name ("🇫🇷 France")
    const getFullTeamName = (apiName: string) => {
      const match = TEAMS.find(t => t.name.includes(apiName));
      return match ? match.name : apiName; 
    };

    // 4. Format the data for Supabase
    const matchesToUpsert = data.response.map((fixture: any) => ({
      api_match_id: fixture.fixture.id,
      home_team: getFullTeamName(fixture.teams.home.name),
      away_team: getFullTeamName(fixture.teams.away.name),
      home_goals: fixture.goals.home ?? 0,
      away_goals: fixture.goals.away ?? 0,
      status: fixture.fixture.status.short, // 'NS', '1H', 'HT', '2H', 'FT', 'PEN', etc.
      stage: fixture.league.round, // e.g., 'Group Stage - 1' or 'Round of 16'
      updated_at: new Date().toISOString(),
    }));

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