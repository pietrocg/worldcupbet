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
    // 2. Use the WC2026 API to fetch matches for World Cup 2026.
    const WC_KEY = process.env.STATS_API_KEY;
    const apiBase = 'https://api.wc2026api.com';

    const headers: Record<string,string> = {};
    if (WC_KEY) headers['Authorization'] = `Bearer ${WC_KEY}`;

    // GET /matches — returns all tournament matches; support optional filters via query
    const res = await fetch(`${apiBase}/matches`, { headers });
    const payload = await res.json();

    if (!res.ok) {
      console.error('Upstream error:', payload);
      return NextResponse.json({ success: false, message: 'Upstream WC2026 API error', details: payload }, { status: 502 });
    }

    // Normalize payload shapes (API may return an array or wrap it in { data: [...] } / { matches: [...] })
    let allMatches: any[] = [];
    if (Array.isArray(payload)) {
      allMatches = payload;
    } else if (payload && Array.isArray(payload.data)) {
      allMatches = payload.data;
    } else if (payload && Array.isArray(payload.matches)) {
      allMatches = payload.matches;
    } else if (payload && Array.isArray(payload.response)) {
      allMatches = payload.response;
    }

    if (!allMatches || allMatches.length === 0) {
      console.error('Unexpected or empty matches payload from WC2026 API:', payload);
      return NextResponse.json({ success: true, message: 'No 2026 matches available from WC2026 API yet.', payloadShape: Object.keys(payload || {}) });
    }

    // 3. Helper to match API name ("France") with our DB name ("🇫🇷 France")
    const getFullTeamName = (apiName: string) => {
      const match = TEAMS.find(t => t.name.includes(apiName));
      return match ? match.name : apiName; 
    };

    // 4. Format the data for Supabase
    const mapPhaseToStatus = (phase?: string, status?: string) => {
      if (phase) {
        switch (phase) {
          case 'PRE': return 'NS';
          case '1H': return '1H';
          case 'HT': return 'HT';
          case '2H': return '2H';
          case 'ET1':
          case 'ET2': return 'AET';
          case 'PEN':
          case 'FT_PEN': return 'PEN';
          default: return status === 'completed' ? 'FT' : 'NS';
        }
      }
      if (status === 'scheduled') return 'NS';
      if (status === 'live') return '1H';
      if (status === 'completed') return 'FT';
      return status ?? 'NS';
    };

    const matchesToUpsert = allMatches.map((m: any) => ({
      api_match_id: m.id,
      home_team: getFullTeamName(m.home_team || m.home_team_name || ''),
      away_team: getFullTeamName(m.away_team || m.away_team_name || ''),
      home_goals: (m.home_score ?? m.home_score_current) ?? 0,
      away_goals: (m.away_score ?? m.away_score_current) ?? 0,
      status: mapPhaseToStatus(m.phase, m.status),
      stage: m.round || m.group_name || null,
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