import { Accordion, Card, Chip } from '@heroui/react'
import { CircleCheck, FlaskConical, Lightbulb, Scale, TriangleAlert } from 'lucide-react'
import type { Arm, Campaign, Run } from '../api'
import { CHANNEL, ChannelChip, Delta, Flow, HowTo, SrcChips, fmt, money } from '../ui'

const CAPS: Record<string, string> = {
  capped_at_campaign_limit: 'обрезано лимитом 5000 на кампанию',
  capped_at_reach_budget: 'обрезано общим лимитом охвата',
  capped_at_money_budget: 'обрезано денежным бюджетом',
}

/** Хоть одна ячейка кампании не подтверждена пилотом или её нижняя граница ниже нуля */
export const isRisky = (c: Campaign, arm: Map<string, Arm>) =>
  c.cells.some((x) => { const a = arm.get(x.cur + x.seg + c.target_tariff); return !a || !a.n || a.post_mu - a.post_sd < 0 })
export const armIndex = (run: Run) => new Map(run.arms.map((a) => [a.cur + a.seg + a.target, a]))

export default function Plan({ run }: { run: Run }) {
  const arm = armIndex(run)
  const total = run.plan.reduce((s, c) => s + c.expected_gain - c.expected_cost, 0)
  return (
    <>
      <HowTo>
        Итоговый ответ агента — <b>{run.plan.length} кампаний</b> (максимум 10), ожидаемый чистый эффект <b>{money(total)}</b>.
        Каждая кампания = ARPU-сегмент + список текущих тарифов → целевой тариф + канал. Раскрой «Почему выбрана»,
        чтобы увидеть цепочку: <b>гипотеза → пилот → решение</b> и отклонённые альтернативы.
      </HowTo>
      <div className="grid gap-5 xl:grid-cols-2">
        {run.plan.map((c, i) => <CampaignCard key={c.campaign_name} i={i + 1} c={c} run={run} arm={arm} />)}
      </div>
    </>
  )
}

function Step({ icon: Icon, title, children }: { icon: typeof Lightbulb; title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[24px_1fr] gap-2">
      <span className="grid size-6 place-items-center rounded-md bg-default"><Icon className="size-3.5 text-muted" aria-hidden /></span>
      <div><div className="text-xs font-medium text-muted">{title}</div><div className="text-sm">{children}</div></div>
    </div>
  )
}

function CampaignCard({ i, c, run, arm }: { i: number; c: Campaign; run: Run; arm: Map<string, Arm> }) {
  const k = run.limits.lcb_k
  const arms = c.cells.map((x) => arm.get(x.cur + x.seg + c.target_tariff))
  const risky = isRisky(c, arm)
  const ch = run.channels[c.channel]
  const channels = Object.entries(run.channels).sort((a, b) => a[1].cost_per_contact - b[1].cost_per_contact)
  const net = c.expected_gain - c.expected_cost

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-start gap-3">
        <span className="num grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-accent-foreground">{i}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{c.filter_arpu_segment} ARPU → {c.target_tariff}</span>
            <ChannelChip ch={c.channel} />
            {risky
              ? <Chip size="sm" color="warning" variant="soft" className="gap-1"><TriangleAlert className="size-3" aria-hidden />есть риск</Chip>
              : <Chip size="sm" color="success" variant="soft" className="gap-1"><CircleCheck className="size-3" aria-hidden />подтверждено пилотом</Chip>}
          </div>
          <div className="num truncate text-xs text-muted">{c.campaign_name}</div>
        </div>
      </div>

      <Flow from={c.filter_current_tariff.split(';')} to={c.target_tariff} max={8} />

      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-default/60 p-3 sm:grid-cols-4">
        {[
          ['Аудитория', `${fmt(c.audience)} аб.`],
          ['Ожидаемый прирост', money(c.expected_gain)],
          ['Затраты', `${money(c.expected_cost)} ₽`],
          ['Чистый эффект', money(net)],
        ].map(([t, v], j) => (
          <div key={t}>
            <dt className="text-xs text-muted">{t}</dt>
            <dd className={`num font-semibold ${j === 3 ? 'text-accent-soft-foreground' : ''}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        Факт в симуляции: <span className="num font-medium text-foreground">{money(c.actual_gross - c.actual_cost)}</span>
        · {fmt(c.actual_contacts)} контактов
        {c.caps.map((x) => <Chip key={x} size="sm" color="warning" variant="soft">{CAPS[x] ?? x}</Chip>)}
      </div>

      <Accordion variant="surface" className="-mx-1">
        <Accordion.Item id="why">
          <Accordion.Heading>
            <Accordion.Trigger className="text-sm font-medium">Почему выбрана<Accordion.Indicator /></Accordion.Trigger>
          </Accordion.Heading>
          <Accordion.Panel>
            <Accordion.Body className="flex flex-col gap-4">
              {c.cells.map((x, j) => {
                const a = arms[j]
                const alts = run.arms.filter((b) => b.cur === x.cur && b.seg === x.seg && b.target !== c.target_tariff)
                  .sort((p, q) => q.post_mu - p.post_mu)
                return (
                  <div key={x.cur} className="flex flex-col gap-2.5 rounded-xl border border-border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="num text-sm font-semibold">{x.cur} · {x.seg}</span>
                      <span className="text-xs text-muted">{fmt(x.n)} аб. · Σ ARPU {money(x.S)} · вклад {money(x.gain)}</span>
                    </div>
                    {a ? (
                      <>
                        <Step icon={Lightbulb} title="1. Гипотеза">
                          <span className="inline-flex flex-wrap items-center gap-1.5"><SrcChips src={a.src} /> по истории <Delta v={a.prior_mu} /></span>
                        </Step>
                        <Step icon={FlaskConical} title="2. Пилот">
                          {a.n
                            ? <span className="inline-flex flex-wrap items-center gap-1.5">{a.n} аб., результат {a.obs.map((o, q) => <Delta key={q} v={o} />)} → оценка <Delta v={a.post_mu} /> ± {fmt(100 * a.post_sd, 1)}%</span>
                            : <span className="text-muted">не проводился — в плане по истории</span>}
                        </Step>
                        <Step icon={Scale} title="3. Решение">
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            порог μ − {k}σ = <Delta v={a.lcb} /> &gt; 0 → в план; канал {CHANNEL[c.channel]?.label ?? c.channel} (×{fmt(ch.conversion_multiplier, 2)})
                          </span>
                        </Step>
                      </>
                    ) : <span className="text-sm text-muted">Fallback-кампания: гипотеза не найдена</span>}
                    {alts.length > 0 && (
                      <div className="flex flex-col gap-1 border-t border-border pt-2">
                        <span className="text-xs font-medium text-muted">Отклонённые альтернативы</span>
                        {alts.map((b) => (
                          <div key={b.target} className="grid grid-cols-[72px_72px_1fr] items-center gap-2 text-xs">
                            <span className="num">{b.target}</span>
                            <Delta v={b.post_mu} />
                            <span className="text-muted">
                              {b.lcb <= 0 ? 'не проходит порог' : 'хуже выбранного'}{!b.n && !b.src.includes('prior') ? ' · LLM без пилота' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              <p className="text-xs leading-relaxed text-muted">
                Каналы: все ячейки стартуют с самого дешёвого ({channels[0][0]}), затем жадно апгрейдятся по Δэффект/Δстоимость, пока хватает бюджета
                ({channels.map(([n, v]) => `${CHANNEL[n]?.label ?? n}: ${v.cost_per_contact} ₽, ×${fmt(v.conversion_multiplier, 2)}`).join('; ')}).
                Охват заполняется по убыванию ценности на контакт.
              </p>
            </Accordion.Body>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Card>
  )
}
