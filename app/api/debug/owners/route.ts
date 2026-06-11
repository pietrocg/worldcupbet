import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-server'

function normalize(s?: string) {
  if (!s) return ''
  const noDiacritics = s.normalize ? s.normalize('NFD').replace(/\p{M}/gu, '') : s
  return noDiacritics.replace(/[^a-zA-Z0-9 ]/g, '').trim().toLowerCase()
}

export async function GET() {
  try {
    const [{ data: players }, { data: matches }] = await Promise.all([
      supabaseAdmin.from('players').select('id,name,assigned_teams'),
      supabaseAdmin.from('matches').select('*').order('updated_at', { ascending: false }).limit(50)
    ])

    const playersSafe = players || []

    const getOwner = (teamName: string) => {
      const target = normalize(teamName)
      for (const p of playersSafe) {
        const assigned = p.assigned_teams || []
        for (const t of assigned) {
          const candidate = typeof t === 'string' ? t : (t?.name || '')
          const candNorm = normalize(candidate)
          if (!candNorm) continue
          if (candNorm === target || candNorm.includes(target) || target.includes(candNorm)) {
            return p.name
          }
        }
      }
      return null
    }

    const sample = (matches || []).slice(0, 30).map((m: any) => ({
      api_match_id: m.api_match_id ?? m.id,
      home_team: m.home_team,
      away_team: m.away_team,
      owner_home: getOwner(m.home_team),
      owner_away: getOwner(m.away_team),
      raw_match: m
    }))

    return NextResponse.json({ players: playersSafe, sample })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || String(err) }, { status: 500 })
  }
}
