
import { createClient } from '@supabase/supabase-js'
import { watchedFetch } from './writeWatch'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 🚨 fetch は lib/writeWatch の watchedFetch（自分が書き込んだら、その話題の数字をすぐ数え直す・2026-10-18）。要求の中身は変えない
export const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { fetch: watchedFetch } })
