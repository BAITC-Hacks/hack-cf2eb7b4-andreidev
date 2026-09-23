import { Alert, Button, Card, Chip, Skeleton } from '@heroui/react'
import { CircleCheck, Coins, Download, Play, Radar, TrendingUp, TriangleAlert, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { fetchRun, type Campaign, type Run, type User } from './api'
import { UserBadge } from './Auth'
import { armIndex, isRisky } from './tabs/Plan'
import { ChannelChip, DataTable, Flow, HowTo, Kpi, fmt, money } from './ui'

const SEGMENT: Record<string, string> = { LOW: 'Низкий чек · до 1 000', MID: 'Средний чек · 1 000–5 000', HIGH: 'Высокий чек · от 5 000' }
const net = (c: Campaign) => c.expected_gain - c.expected_cost

// Экран менеджера: одна кнопка → план кампаний простым языком → CSV. Параметры агента — по умолчанию.
export default function Manager({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [run, setRun] = useState<Run>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const go = () => {
    setLoading(true)
    setError(undefined)
    fetchRun({ seed: 42, world: 'mock', llm: true, model: '' }).then(setRun, (e) => setError(String(e))).finally(() => setLoading(false))
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"><Radar className="size-5" aria-hidden /></span>
            <div className="min-w-0">
              <div className="font-semibold leading-tight">Планировщик кампаний</div>
              <div className="truncate text-xs text-muted">кому и что предложить в следующем месяце</div>
            </div>
          </div>
          <UserBadge user={user} onSignOut={onSignOut} />
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
        <Card className="flex-row flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0 grow basis-72">
            <h1 className="text-xl font-semibold tracking-tight">{run ? 'План готов' : 'Сформировать план кампаний'}</h1>
            <p className="text-sm text-muted">
              Агент сам проверит гипотезы небольшими пилотами и предложит до 10 кампаний в рамках бюджета 100 000.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {run && (
              <Button variant="secondary" onPress={() => downloadCsv(run.plan)} className="h-10">
                <Download className="size-4" aria-hidden />Скачать план (CSV)
              </Button>
            )}
            <Button variant="primary" isPending={loading} onPress={go} className="h-10 px-4 font-semibold">
              {!loading && <Play className="size-4" aria-hidden />}{run ? 'Пересчитать' : 'Сформировать план'}
            </Button>
          </div>
        </Card>

        {error && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>Не удалось построить план</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {loading && !run && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">Агент проверяет гипотезы пилотами — обычно до минуты…</p>
            <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
            <Skeleton className="h-72 rounded-2xl" />
          </div>
        )}

        {run && <Result run={run} dim={loading} />}
      </main>
    </div>
  )
}

function Result({ run, dim }: { run: Run; dim: boolean }) {
  const { limits: l, plan } = run
  const arm = armIndex(run)
  const spent = l.total_budget - l.budget_after_pilots + plan.reduce((s, c) => s + c.expected_cost, 0)
  const reach = l.total_contacts - l.contacts_after_pilots + plan.reduce((s, c) => s + c.audience, 0)
  return (
    <div className={`rise flex flex-col gap-5 transition-opacity ${dim ? 'opacity-60' : ''}`}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi icon={TrendingUp} label="Прирост выручки" value={money(run.score.net_arpu_gain as number)}
          hint="за вычетом стоимости всех контактов" />
        <Kpi icon={Coins} label="Бюджет" value={money(spent)} meter={{ value: spent, max: l.total_budget }}
          hint={`из ${money(l.total_budget)}, включая пилоты`} />
        <Kpi icon={UsersRound} label="Охват" value={fmt(reach)} meter={{ value: reach, max: l.total_contacts }}
          hint={`абонентов из ${fmt(l.total_contacts)} возможных`} />
      </div>

      <HowTo>
        <b>Эффект</b> — сколько кампания добавит к выручке за вычетом стоимости контактов. <b>Проверено пилотом</b> — агент
        уже запускал такое предложение на небольшой группе и увидел рост; <b>есть риск</b> — результат менее надёжен.
      </HowTo>

      <DataTable label="План кампаний" rows={plan} rowKey={(c) => c.campaign_name}
        initialSort={{ column: 'net', direction: 'descending' }}
        cols={[
          { key: 'who', label: 'Кому', render: (c) => (
            <span className="flex flex-col">
              <span className="font-medium whitespace-nowrap">{SEGMENT[c.filter_arpu_segment] ?? (c.filter_arpu_segment || 'Все абоненты')}</span>
              <span className="text-xs text-muted">{fmt(c.audience)} абонентов</span>
            </span>
          ) },
          { key: 'offer', label: 'Текущий тариф → предложить', render: (c) => <Flow from={c.filter_current_tariff.split(';').filter(Boolean)} to={c.target_tariff} max={3} /> },
          { key: 'channel', label: 'Канал', render: (c) => <ChannelChip ch={c.channel} /> },
          { key: 'cost', label: 'Затраты', num: true, sort: (c) => c.expected_cost, render: (c) => money(c.expected_cost) },
          { key: 'net', label: 'Эффект', num: true, sort: net, render: (c) => <span className="font-semibold">{money(net(c))}</span> },
          { key: 'trust', label: 'Надёжность', render: (c) => isRisky(c, arm)
            ? <Chip size="sm" color="warning" variant="soft" className="gap-1 whitespace-nowrap"><TriangleAlert className="size-3" aria-hidden />есть риск</Chip>
            : <Chip size="sm" color="success" variant="soft" className="gap-1 whitespace-nowrap"><CircleCheck className="size-3" aria-hidden />проверено пилотом</Chip> },
        ]} />
    </div>
  )
}

// ponytail: CSV на клиенте — Blob + <a download>, без библиотек; все поля в кавычках (в тарифах есть «;»)
function downloadCsv(plan: Campaign[]) {
  const head = ['campaign_name', 'filter_arpu_segment', 'filter_current_tariff', 'target_tariff', 'channel', 'audience', 'expected_cost', 'expected_net']
  const rows = plan.map((c) => [c.campaign_name, c.filter_arpu_segment, c.filter_current_tariff, c.target_tariff, c.channel,
    c.audience, Math.round(c.expected_cost), Math.round(net(c))])
  const csv = [head, ...rows].map((r) => r.map((x) => `"${String(x).replaceAll('"', '""')}"`).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = `plan-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
