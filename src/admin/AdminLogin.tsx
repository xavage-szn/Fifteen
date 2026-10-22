import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Loader2, Lock, Eye, EyeOff } from 'lucide-react'

export default function AdminLogin() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (err) setError(err.message)
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4" style={{ background: 'var(--bg-gradient)' }}>
      <div
        className="w-full max-w-sm rounded-3xl p-8"
        style={{
          background:     'var(--glass-bg)',
          backdropFilter: 'blur(24px)',
          border:         '1px solid var(--glass-border)',
          boxShadow:      '0 8px 40px rgba(0,0,0,0.12)',
        }}
      >
        {/* Logo */}
        <div className="mb-6 flex flex-col items-center gap-2">
          <div
            className="flex size-12 items-center justify-center rounded-2xl"
            style={{ background: 'var(--accent)', boxShadow: '0 4px 16px rgba(82,179,110,0.30)' }}
          >
            <Lock className="size-5 text-white" />
          </div>
          <h1
            className="text-lg font-bold"
            style={{ fontFamily: "'Funny Samurai', sans-serif", color: 'var(--accent)', fontSize: 22 }}
          >
            fifteen admin
          </h1>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Sign in to access the console</p>
        </div>

        <form onSubmit={(e) => { void handleLogin(e) }} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full rounded-xl px-4 py-3 text-sm outline-none"
              style={{
                background: 'var(--glass-soft-bg)',
                border:     '1px solid var(--glass-soft-border)',
                color:      'var(--ink)',
              }}
              placeholder="admin@fifteen.app"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
              Password
            </label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full rounded-xl px-4 py-3 pr-11 text-sm outline-none"
                style={{
                  background: 'var(--glass-soft-bg)',
                  border:     '1px solid var(--glass-soft-border)',
                  color:      'var(--ink)',
                }}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPw(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--muted)' }}
              >
                {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(192,57,43,0.10)', color: 'var(--danger)', border: '1px solid rgba(192,57,43,0.25)' }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-bold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
