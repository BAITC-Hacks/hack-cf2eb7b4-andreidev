import { Card, Chip, Meter, NumberField } from '@heroui/react'
import { Calculator, Megaphone, Percent, Trophy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Run } from '../api'
import { CHANNEL, HowTo, Section, fmt, money } from '../ui'

const ORDER = ['push', 'sms', 'digital_ads', 'call']
const LEVEL: Record<string, string> = { push: 'низкая', sms: 'средняя', digital_ads: 'выше среднего', call: 'высокая' }
const price = (c: number) => (c === 0 ? 'бесплатно' : `${fmt(c)} у.е.`)
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${fmt(Math.abs(x), 1)}`

export default function Rules({ run }: { run: Run }) {
  const s = run.score as Record<string, number>
  const pilotCost = run.limits.total_budget - run.limits.budget_after_pilots

  // средний predicted_arpu по ARPU-сегментам: S — сумма прогноза в ячейке
  const segs = Object.values(run.audience.cells.reduce<Record<string, { seg: string; n: number; S: number }>>((m, c) => {
    const g = (m[c.seg] ??= { seg: c.seg, n: 0, S: 0 })
    g.n += c.n; g.S += c.S
    return m
  }, {})).map((g) => ({ seg: g.seg, arpu: g.S / g.n })).sort((a, b) => a.arpu - b.arpu)
  const nAll = run.audience.cells.reduce((t, c) => t + c.n, 0)

  const [arpu, setArpu] = useState(() => Math.round(s.baseline_total_arpu / nAll))
  const [delta, setDelta] = useState(10)
  const [conv, setConv] = useState(20)

  // та же формула, что в scoring_core.score_campaign: Δ% × min(1, конверсия × множитель) × ARPU − цена контакта
  const channels = ORDER.filter((k) => run.channels[k]).map((k) => {
    const ch = run.channels[k]
    const lift = (delta / 100) * Math.min(1, (conv / 100) * ch.conversion_multiplier)
    return { k, ch, net: arpu * lift - ch.cost_per_contact, breakEven: lift > 0 ? ch.cost_per_contact / lift : Infinity }
  })
  const best = channels.reduce((b, c) => (c.net > b.net ? c : b))
  const maxMult = Math.max(...channels.map((c) => c.ch.conversion_multiplier))

  return (
    <>
      <HowTo>
        Побеждает тот, чей <b>чистый результат</b> больше. В зачёт идут <b>и пилоты, и финальные кампании</b>:
        пилотные контакты тоже реальные и тоже стоят денег. Ниже цифры текущего прогона агента.
      </HowTo>

      <Section icon={Calculator} title="Чистый результат" desc="Прирост ARPU минус затраты на коммуникацию">
        <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <Term label="Прирост ARPU" value={money(s.gross_arpu_lift)}
            note="по уникальным абонентам: каждый считается один раз, по лучшей для него кампании" />
          <Op>−</Op>
          <Term label="Затраты" value={money(s.total_cost)}
            note={`контакты × стоимость канала · из них пилоты ${money(pilotCost)}`} />
          <Op>=</Op>
          <Term label="Чистый результат" value={money(s.net_arpu_gain)} accent
            note={s.net_arpu_gain > 0 ? 'больше нуля: кампания в плюсе (PASS)' : 'не больше нуля: кампании не окупились (FAIL)'} />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-default/60 px-4 py-3 text-sm">
          <span><span className="text-muted">Если ничего не делать: </span>
            <span className="num font-medium">{fmt(s.baseline_total_arpu)}</span>
            <span className="text-muted"> (сумма predicted_arpu)</span></span>
          <span><span className="text-muted">С планом агента: </span>
            <span className="num font-medium">{fmt(s.total_arpu_after)}</span>{' '}
            <span className="num font-medium" style={{ color: s.net_arpu_gain >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
              ({s.net_arpu_gain >= 0 ? '+' : ''}{fmt(s.growth_vs_baseline_pct, 2)}%)
            </span></span>
        </div>
      </Section>

      <Section icon={Percent} title="Эффект — это процент, а не сумма"
        desc={`Одна и та же кампания даёт +${delta}% к ARPU абонента, поэтому на дорогом абоненте она приносит больше`}>
        <ul className="flex flex-col gap-2">
          {segs.map((g) => (
            <li key={g.seg} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 text-sm">
              <span className="font-medium">{g.seg}</span>
              <span className="h-2 overflow-hidden rounded-full bg-default">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${(100 * g.arpu) / segs.at(-1)!.arpu}%` }} />
              </span>
              <span className="num text-right whitespace-nowrap">
                <span className="text-muted">ARPU {fmt(g.arpu)} → </span>
                <span className="font-semibold">+{fmt((g.arpu * delta) / 100)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section icon={Megaphone} title="Каналы: цена против силы"
        desc="Множитель умножает вероятность перехода. Подставьте своего абонента и посмотрите, какой канал окупается"
        action={
          <div className="flex flex-wrap gap-2">
            <Field label="ARPU абонента" value={arpu} set={setArpu} />
            <Field label="Прирост ARPU, %" value={delta} set={setDelta} />
            <Field label="Конверсия, %" value={conv} set={setConv} max={100} />
          </div>
        }>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {channels.map(({ k, ch, net, breakEven }) => {
            const m = CHANNEL[k]
            const isBest = k === best.k && best.net > 0
            return (
              <Card key={k} variant="secondary" className={`gap-3 p-4 ${isBest ? 'ring-2 ring-accent' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-semibold">
                    <span className="grid size-8 place-items-center rounded-lg bg-default"><m.icon className="size-4" aria-hidden /></span>
                    {m.label}
                  </span>
                  {isBest && <Chip size="sm" color="success" variant="soft" className="gap-1"><Trophy className="size-3" aria-hidden />выгоднее</Chip>}
                </div>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-xs text-muted">Контакт</dt><dd className="num font-medium">{price(ch.cost_per_contact)}</dd></div>
                  <div><dt className="text-xs text-muted">Эффективность</dt><dd className="font-medium">{LEVEL[k] ?? '—'} <span className="num text-muted">×{fmt(ch.conversion_multiplier, 2)}</span></dd></div>
                </dl>
                <Meter aria-label={`Эффективность ${m.label}`} value={ch.conversion_multiplier} maxValue={maxMult} size="sm" color="accent">
                  <Meter.Track><Meter.Fill /></Meter.Track>
                </Meter>
                <div className="border-t border-border pt-3">
                  <p className="text-xs text-muted">Чистый эффект на один контакт</p>
                  <p className="num text-xl font-semibold" style={{ color: net >= 0 ? 'var(--pos)' : 'var(--neg)' }}>{signed(net)}</p>
                  <p className="text-xs text-muted">
                    {ch.cost_per_contact === 0 ? 'окупается всегда: контакт бесплатный'
                      : Number.isFinite(breakEven) ? <>окупается при ARPU от <span className="num text-foreground">{fmt(breakEven)}</span></>
                      : 'не окупается при нулевом приросте'}
                  </p>
                </div>
              </Card>
            )
          })}
        </div>
      </Section>
    </>
  )
}

function Term({ label, value, note, accent }: { label: string; value: string; note: string; accent?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 rounded-xl border p-4 ${accent ? 'border-accent bg-accent-soft' : 'border-border'}`}>
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className={`num text-3xl font-semibold tracking-tight ${accent ? 'text-accent-soft-foreground' : ''}`}>{value}</span>
      <span className="text-xs text-muted">{note}</span>
    </div>
  )
}

const Op = ({ children }: { children: ReactNode }) => (
  <span className="grid place-items-center text-2xl font-light text-muted" aria-hidden>{children}</span>
)

function Field({ label, value, set, max }: { label: string; value: number; set: (v: number) => void; max?: number }) {
  return (
    <div className="flex h-10 items-center gap-2 rounded-xl bg-default pl-3">
      <span className="text-xs font-medium whitespace-nowrap text-muted">{label}</span>
      <NumberField aria-label={label} className="w-40" minValue={0} maxValue={max} value={value}
        onChange={(v) => set(Number.isFinite(v) ? v : 0)}>
        <NumberField.Group>
          <NumberField.DecrementButton />
          <NumberField.Input className="num min-w-12 text-center" />
          <NumberField.IncrementButton />
        </NumberField.Group>
      </NumberField>
    </div>
  )
}
