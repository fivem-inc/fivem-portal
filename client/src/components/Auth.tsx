import { useState, useEffect } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import type { User } from '@supabase/supabase-js'
import { AuthContext } from '../contexts/AuthContext' // AuthContextをインポート

export default function Auth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchUser = async () => {
      const { data, error } = await supabase.auth.getUser()
      if (error) {
        console.error('Error fetching user:', error)
      } else {
        setUser(data.user)
      }
      setLoading(false)
    }

    fetchUser()

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => {
      authListener.subscription.unsubscribe()
    }
  }, [])

  if (loading) {
    return <div>Loading...</div>
  }

  if (!user) {
    return <Navigate to="/" />
  }

  return (
    <AuthContext.Provider value={{ user }}>
      <Outlet />
    </AuthContext.Provider>
  )
}