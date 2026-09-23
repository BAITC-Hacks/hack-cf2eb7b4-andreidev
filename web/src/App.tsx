import { Alert, Button, Card, Chip, NumberField, Skeleton, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react'
import {
  Coins, FlaskConical, Gauge, Lightbulb, ListChecks, Megaphone, Play, Radar, ScrollText, Swords, Users, UsersRound,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchRun, type Run, type RunParams, type World } from './api'
import { Kpi, fmt, money } from './ui'
import Command from './tabs/Command'
import Audience from './tabs/Audience'
import Hypotheses from './tabs/Hypotheses'
import Pilots from './tabs/Pilots'
import Strategies from './tabs/Strategies'
import Plan from './tabs/Plan'

type TabId = 'command' | 'audience' | 'hypotheses' | 'pilots' | 'plan' | 'strategies' | 'logs'
// step — место экрана в конвейере агента: аудитория → гипотезы → пилоты → план
const TABS: { id: TabId; step?: number; label: string; sub: string; icon: LucideIcon; count?: (r: Run) => number }[] = [
  { id: 'command', label: 'Командный центр', sub: 'Что делать прямо сейчас', icon: Gauge },
  { id: 'audience', step: 1, label: 'Аудитория', sub: 'Кого можно таргетировать', icon: Users, count: (r) => r.audience.cells.length },
  { id: 'hypotheses', step: 2, label: 'Гипотезы', sub: 'Что предложили эксперты', icon: Lightbulb, count: (r) => r.arms.length },
  { id: 'pilots', step: 3, label: 'Пилоты', sub: 'Что показала проверка', icon: FlaskConical, count: (r) => r.pilots.length },
  { id: 'plan', step: 4, label: 'Финальный план', sub: 'Кампании и объяснения', icon: ListChecks, count: (r) => r.plan.length },
  { id: 'strategies', label: 'Стратегии', sub: 'Эксперты и ablation', icon: Swords },
  { id: 'logs', label: 'Логи', sub: 'Сырой лог агента', icon: ScrollText },
]

export default function App() {
  const [params, setParams] = useState<RunParams>({ seed: 42, world: 'mock', llm: true })
  const [run, setRun] = useState<Run>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  // вкладка живёт в #hash — можно дать ссылку на конкретный экран
  const [tab, setTabState] = useState<TabId>(() => (TABS.some((t) => t.id === location.hash.slice(1)) ? location.hash.slice(1) as TabId : 'command'))
  const setTab = (t: TabId) => { history.replaceState(null, '', `#${t}`); setTabState(t) }

  const go = useCallback((p: RunParams) => {
    setLoading(true)
    setError(undefined)
    fetchRun(p).then(setRun, (e) => setError(String(e))).finally(() => setLoading(false))
  }, [])
  useEffect(() => go(params), []) // eslint-disable-line react-hooks/exhaustive-deps

  const current = TABS.find((t) => t.id === tab)!

  return (
    <div className="min-h-dvh bg-background lg:pl-64">
      {/* боковая навигация — шаги конвейера агента */}
      <aside className="border-b border-border bg-surface lg:fixed lg:inset-y-0 lg:left-0 lg:w-64 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-3 px-5 py-4">
          <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground"><Radar className="size-5" aria-hidden /></span>
          <div>
            <div className="font-semibold leading-tight">Campaign Cockpit</div>
            <div className="text-xs text-muted">тарифные кампании · AI-агент</div>
          </div>
        </div>
        <nav aria-label="Экраны" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
          {TABS.map((t) => {
            const active = t.id === tab
            return (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={active ? 'page' : undefined}
                className={`group flex shrink-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150
                  focus-visible:outline-2 focus-visible:outline-focus
                  ${active ? 'bg-accent-soft' : 'hover:bg-default'}`}>
                <span className={`grid size-8 shrink-0 place-items-center rounded-lg transition-colors
                  ${active ? 'bg-accent text-accent-foreground' : 'bg-default text-muted group-hover:text-foreground'}`}>
                  <t.icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`flex items-center gap-1.5 text-sm font-medium whitespace-nowrap ${active ? 'text-accent-soft-foreground' : ''}`}>
                    {t.step && <span className="num text-xs text-muted">{t.step}.</span>}{t.label}
                  </span>
                  <span className="hidden text-xs text-muted lg:block">{t.sub}</span>
                </span>
                {run && t.count && <span className="num hidden text-xs text-muted lg:inline">{t.count(run)}</span>}
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted uppercase">
              {current.step ? `Шаг ${current.step} из 4` : 'Обзор'}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">{current.label}</h1>
          </div>
          <Controls params={params} setParams={setParams} loading={loading} llmAvailable={run?.params.llm_available ?? true}
            onRun={() => go(params)} />
        </header>

        {error && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>Бэкенд не ответил</Alert.Title>
              <Alert.Description>{error}. Запусти: <code>uvicorn server:app --port 8000</code></Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {!run && !error && <LoadingState />}
        {run && (
          <div key={tab + run.params.seed + run.params.world + run.params.llm}
            className={`rise flex flex-col gap-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {tab === 'command' && <><Summary run={run} /><Command run={run} /></>}
            {tab === 'audience' && <Audience run={run} />}
            {tab === 'hypotheses' && <Hypotheses run={run} />}
            {tab === 'pilots' && <Pilots run={run} />}
            {tab === 'plan' && <Plan run={run} />}
            {tab === 'strategies' && <Strategies run={run} />}
            {tab === 'logs' && (
              <Card className="p-0">
                <pre className="num overflow-x-auto p-5 text-xs leading-relaxed">{run.log.join('\n')}</pre>
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// Панель запуска: все контролы одной высоты (40px) в одной «капсуле»
function Controls({ params, setParams, loading, llmAvailable, onRun }: {
  params: RunParams; setParams: (p: RunParams) => void; loading: boolean; llmAvailable: boolean; onRun: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-1.5 shadow-sm">
      <div className="flex h-10 items-center gap-2 rounded-xl bg-default pl-3">
        <span className="text-xs font-medium text-muted">Seed</span>
        <NumberField aria-label="Seed" className="w-36" minValue={0} value={params.seed}
          onChange={(v) => setParams({ ...params, seed: Number.isFinite(v) ? v : 0 })}>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input className="num min-w-12 text-center" />
            <NumberField.IncrementButton />
          </NumberField.Group>
        </NumberField>
      </div>
      <ToggleButtonGroup aria-label="Мир" selectionMode="single" disallowEmptySelection
        selectedKeys={[params.world]} onSelectionChange={(k) => setParams({ ...params, world: [...k][0] as World })}>
        <ToggleButton id="mock" className="h-10">Мок</ToggleButton>
        <ToggleButton id="stress" className="h-10">Стресс-мир</ToggleButton>
      </ToggleButtonGroup>
      <Switch isSelected={params.llm && llmAvailable} isDisabled={!llmAvailable}
        onChange={(llm) => setParams({ ...params, llm })}
        className="flex h-10 cursor-pointer flex-row items-center gap-2 rounded-xl bg-default px-3">
        <Switch.Control><Switch.Thumb /></Switch.Control>
        <span className="text-sm font-medium whitespace-nowrap">LLM-эксперт</span>
      </Switch>
      <Button variant="primary" isPending={loading} onPress={onRun} className="h-10 px-4 font-semibold">
        {!loading && <Play className="size-4" aria-hidden />}Запустить агента
      </Button>
    </div>
  )
}

function Summary({ run }: { run: Run }) {
  const { limits: l, plan, score, params } = run
  const pilotCost = l.total_budget - l.budget_after_pilots
  const planCost = plan.reduce((s, c) => s + c.expected_cost, 0)
  const expNet = plan.reduce((s, c) => s + c.expected_gain - c.expected_cost, 0)
  const pilotContacts = l.total_contacts - l.contacts_after_pilots
  const planContacts = plan.reduce((s, c) => s + c.audience, 0)
  const net = score.net_arpu_gain as number
  return (
    <div className="grid gap-4 xl:grid-cols-[1.3fr_2fr]">
      <Card className="relative gap-4 overflow-hidden p-6">
        <div className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-accent opacity-10 blur-3xl" />
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" color={net > 0 ? 'success' : 'danger'} variant="soft">{net > 0 ? 'PASS' : 'FAIL'}</Chip>
          <Chip size="sm" variant="soft">{params.world === 'mock' ? 'Мок-мир' : 'Стресс-мир'} · seed {params.seed}</Chip>
          <Chip size="sm" variant="soft">{params.llm ? 'с LLM' : 'без LLM'}</Chip>
        </div>
        <div>
          <p className="text-sm text-muted">Чистый прирост ARPU в симуляции</p>
          <p className="num text-5xl font-semibold tracking-tight text-accent-soft-foreground">{money(net)}</p>
        </div>
        <dl className="grid grid-cols-3 gap-3 text-sm">
          {[
            ['Прогноз агента', money(expNet)],
            ['К baseline', `+${fmt(score.growth_vs_baseline_pct as number, 2)}%`],
            ['ROI', `${fmt(score.roi as number, 1)}×`],
          ].map(([k, v]) => (
            <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="num font-medium">{v}</dd></div>
          ))}
        </dl>
      </Card>
      <div className="grid grid-cols-2 gap-4">
        <Kpi icon={Coins} label="Бюджет" value={money(pilotCost + planCost)} meter={{ value: pilotCost + planCost, max: l.total_budget }}
          hint={`из ${money(l.total_budget)} · разведка ${money(pilotCost)}`} />
        <Kpi icon={UsersRound} label="Охват" value={fmt(pilotContacts + planContacts)} meter={{ value: pilotContacts + planContacts, max: l.total_contacts }}
          hint={`из ${fmt(l.total_contacts)} контактов · пилоты ${fmt(pilotContacts)}`} />
        <Kpi icon={FlaskConical} label="Пилоты" value={`${l.total_pilots - l.pilots_left} / ${l.total_pilots}`}
          meter={{ value: l.total_pilots - l.pilots_left, max: l.total_pilots }} hint="адаптивный выбор по EI" />
        <Kpi icon={Megaphone} label="Кампании" value={`${plan.length} / 10`} meter={{ value: plan.length, max: 10 }}
          hint={`${fmt(planContacts)} абонентов в плане`} />
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">Агент считает: эксперты предлагают гипотезы, идут пилоты… (с LLM до минуты)</p>
      <div className="grid gap-4 xl:grid-cols-[1.3fr_2fr]">
        <Skeleton className="h-52 rounded-2xl" />
        <div className="grid grid-cols-2 gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      </div>
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  )
}
