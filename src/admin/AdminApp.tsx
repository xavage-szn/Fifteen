import { Loader2 } from 'lucide-react'
import { useAdminAuth } from './useAdminAuth'
import AdminLogin from './AdminLogin'
import AdminDashboard from './AdminDashboard'

export default function AdminApp() {
  const { session, checking, signOut, token } = useAdminAuth()

  if (checking) {
    return (
      <div className="flex min-h-dvh items-center justify-center" style={{ background: 'var(--bg-gradient)' }}>
        <Loader2 className="size-8 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    )
  }

  if (!session) return <AdminLogin />
  return <AdminDashboard token={token} onSignOut={signOut} />
}
