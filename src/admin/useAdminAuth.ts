import { useState, useEffect } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabaseClient'

export function useAdminAuth() {
  const [session,  setSession]  = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setChecking(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  function signOut() { void supabase.auth.signOut() }

  return { session, checking, signOut, token: session?.access_token ?? '' }
}
