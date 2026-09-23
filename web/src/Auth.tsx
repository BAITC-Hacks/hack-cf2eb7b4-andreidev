import { Alert, Button, Card, Form, Input, Label, Spinner, TextField } from '@heroui/react'
import { LogOut, Radar } from 'lucide-react'
import { useEffect, useState } from 'react'
import { login, logout, me, type User } from './api'
import App from './App'
import Manager from './Manager'

const ROLE_LABEL = { manager: 'Менеджер', analyst: 'Аналитик', admin: 'Администратор' } as const

// Вход решает, какой интерфейс показать: менеджеру — простой план, аналитику и админу — кокпит
export default function Root() {
  const [user, setUser] = useState<User | null>()
  useEffect(() => {
    me().then(setUser, () => setUser(null))
    const out = () => setUser(null)
    window.addEventListener('unauthorized', out)
    return () => window.removeEventListener('unauthorized', out)
  }, [])
  const signOut = () => logout().finally(() => setUser(null))

  if (user === undefined) return <div className="grid min-h-dvh place-items-center bg-background"><Spinner aria-label="Загрузка" /></div>
  if (!user) return <Login onIn={setUser} />
  return user.role === 'manager' ? <Manager user={user} onSignOut={signOut} /> : <App user={user} onSignOut={signOut} />
}

function Login({ onIn }: { onIn: (u: User) => void }) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError(undefined)
    login(String(f.get('email')), String(f.get('password')))
      .then((ok) => (ok ? me().then(onIn) : setError('Неверный email или пароль')))
      .catch((e) => setError(`Сервер не ответил: ${e}`))
      .finally(() => setBusy(false))
  }
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm gap-5 p-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground"><Radar className="size-5" aria-hidden /></span>
          <div>
            <h1 className="font-semibold leading-tight">Campaign Cockpit</h1>
            <p className="text-sm text-muted">Вход в планировщик кампаний</p>
          </div>
        </div>
        <Form onSubmit={submit} className="flex flex-col gap-4">
          <TextField name="email" type="email" isRequired autoComplete="username" autoFocus>
            <Label>Email</Label>
            <Input placeholder="manager@cockpit.demo" />
          </TextField>
          <TextField name="password" type="password" isRequired autoComplete="current-password">
            <Label>Пароль</Label>
            <Input />
          </TextField>
          {error && (
            <Alert status="danger">
              <Alert.Content><Alert.Title>{error}</Alert.Title></Alert.Content>
            </Alert>
          )}
          <Button type="submit" variant="primary" isPending={busy} className="h-10 font-semibold">Войти</Button>
        </Form>
      </Card>
    </main>
  )
}

export function UserBadge({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 text-right">
        <div className="truncate text-sm font-medium">{user.email}</div>
        <div className="text-xs text-muted">{ROLE_LABEL[user.role]}</div>
      </div>
      <Button isIconOnly variant="ghost" aria-label="Выйти" onPress={onSignOut}><LogOut className="size-4" aria-hidden /></Button>
    </div>
  )
}
