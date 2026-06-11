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
    // Normalize string: remove diacritics, strip non-alphanumerics, lowercase
    const normalize = (s?: string) => {
      if (!s) return '';
      // Remove combining diacritics (NFD form) then strip non-alphanumeric
      const noDiacritics = s.normalize ? s.normalize('NFD').replace(/\p{M}/gu, '') : s;
      return noDiacritics.replace(/[^a-zA-Z0-9 ]/g, '').trim().toLowerCase();
    };

    // Manual aliases for API name variants that don't naturally match our TEAMS names
    const NAME_ALIASES: Record<string, string> = {
      'korea republic': 'south korea',
      'korea': 'south korea',
      'republic of korea': 'south korea',
      'bosnia-herzegovina': 'bosnia and herzegovina',
      'bosnia and herzegovina': 'bosnia and herzegovina',
      'bosnia': 'bosnia and herzegovina',
      'usa': 'united states',
      'united states of america': 'united states',
      'u.s.a.': 'united states',
      'cote divoire': 'ivory coast',
      "côte d'ivoire": 'ivory coast',
      'ivory coast': 'ivory coast',
      'cabo verde': 'cape verde',
      'cape verde': 'cape verde',
      'congo dr': 'dr congo',
      'dr congo': 'dr congo',
      'democratic republic of the congo': 'dr congo',
      'iran islamic republic': 'iran',
      'iran, islamic republic of': 'iran',
      'ir iran': 'iran',
      'turkey': 'turkiye',
      'türkiye': 'turkiye',
      'curacao': 'curacao',
      'czech republic': 'czechia'
    };

    // Build a normalized alias map so keys like "Bosnia-Herzegovina" (hyphenated)
    // map correctly after normalization.
    const NORMALIZED_ALIASES: Record<string, string> = {};
    for (const k of Object.keys(NAME_ALIASES)) {
      NORMALIZED_ALIASES[normalize(k)] = NAME_ALIASES[k];
    }

    // Try to match the API team name to our `TEAMS` entries (which include emoji flags).
    // Use aliases and code fallbacks to cover common variants.
    const getFullTeamName = (apiName: string, apiCode?: string) => {
      const targetRaw = (apiName || '').trim();
      if (!targetRaw) return apiName;
      const target = normalize(targetRaw);

      // Alias lookup (using normalized alias keys)
      if (NORMALIZED_ALIASES[target]) {
        const alias = NORMALIZED_ALIASES[target];
        for (const t of TEAMS) {
          const cand = normalize(t.name);
          if (cand.includes(alias)) return t.name;
        }
      }

      // First pass: exact or inclusion match on normalized names
      for (const t of TEAMS) {
        const cand = normalize(t.name);
        if (cand === target || cand.includes(target) || target.includes(cand)) {
          return t.name;
        }
      }

      // Fallback: try matching by code if provided (common codes like USA, KOR, MEX)
      if (apiCode) {
        const code = apiCode.trim().toLowerCase();
        for (const t of TEAMS) {
          const cand = normalize(t.name);
          if (cand.includes(code)) return t.name;
        }
      }

      return apiName;
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
      home_team: getFullTeamName(m.home_team || m.home_team_name || '', m.home_team_code || m.home_team_iso2 || m.home_code),
      away_team: getFullTeamName(m.away_team || m.away_team_name || '', m.away_team_code || m.away_team_iso2 || m.away_code),
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