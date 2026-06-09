'use server'

import { supabase } from '@/lib/supabase'
import { TEAMS, Team } from '@/lib/constants'
import { revalidatePath } from 'next/cache'

export async function joinGame(formData: FormData) {
  const name = formData.get('name') as string
  if (!name) return

  // 1. Insert new player
  const { error: insertError } = await supabase
    .from('players')
    .insert([{ name }])
    
  if (insertError) throw new Error(insertError.message)

  // 2. Fetch ALL players (we need everyone to re-run the draft)
  const { data: players, error: fetchError } = await supabase
    .from('players')
    .select('*')
    .order('created_at', { ascending: true })

  if (fetchError || !players) throw new Error('Failed to fetch players')

  // 3. The "Shifting Sands" Algorithm
  const sortedTeams = [...TEAMS].sort((a, b) => b.powerScore - a.powerScore)
  
  // Initialize buckets
  const buckets = players.map(p => ({
    id: p.id,
    name: p.name,
    teams: [] as Team[],
    totalPowerScore: 0
  }))

  // Distribute teams greedily
  for (const team of sortedTeams) {
    // Crucial: Tie-breaker logic (using ID) to prevent "flicker" on identical scores
    buckets.sort((a, b) => {
      if (a.totalPowerScore === b.totalPowerScore) {
        return a.id.localeCompare(b.id)
      }
      return a.totalPowerScore - b.totalPowerScore
    })
    
    buckets[0].teams.push(team)
    buckets[0].totalPowerScore += team.powerScore
  }

  // 4. Update everyone's teams in Supabase
  // Using Promise.all since the player count is small (12-30 max)
  await Promise.all(
    buckets.map(bucket => 
      supabase
        .from('players')
        .update({ assigned_teams: bucket.teams })
        .eq('id', bucket.id)
    )
  )

  // 5. Instantly refresh the UI
  revalidatePath('/')
}

// Add this below your joinGame function in actions.ts

export async function removePlayer(formData: FormData) {
  const id = formData.get('id') as string
  if (!id) return

  // 1. Delete the player from Supabase
  const { error: deleteError } = await supabase
    .from('players')
    .delete()
    .eq('id', id)
    
  if (deleteError) throw new Error(deleteError.message)

  // 2. Fetch the REMAINING players
  const { data: players, error: fetchError } = await supabase
    .from('players')
    .select('*')
    .order('created_at', { ascending: true })

  if (fetchError) throw new Error('Failed to fetch players')

  // 3. If there are still players left, RE-RUN the algorithm
  if (players && players.length > 0) {
    const sortedTeams = [...TEAMS].sort((a, b) => b.powerScore - a.powerScore)
    
    const buckets = players.map(p => ({
      id: p.id,
      teams: [] as Team[],
      totalPowerScore: 0
    }))

    for (const team of sortedTeams) {
      buckets.sort((a, b) => {
        if (a.totalPowerScore === b.totalPowerScore) return a.id.localeCompare(b.id)
        return a.totalPowerScore - b.totalPowerScore
      })
      buckets[0].teams.push(team)
      buckets[0].totalPowerScore += team.powerScore
    }

    // Update the remaining players with their new teams
    await Promise.all(
      buckets.map(bucket => 
        supabase
          .from('players')
          .update({ assigned_teams: bucket.teams })
          .eq('id', bucket.id)
      )
    )
  }

  // 4. Instantly refresh the UI
  revalidatePath('/')
}