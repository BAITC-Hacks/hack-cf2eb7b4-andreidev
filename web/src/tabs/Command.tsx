import { Compass, Rocket, Scale } from 'lucide-react'
import type { Run } from '../api'
import { ChannelChip, Delta, Flow, HowTo, Section, SrcChips, StackBar, fmt, money } from '../ui'

export default function Command({ run }: { run: Run }) {
  const { plan, arms, limits: l } = run
  const top = [...plan].sort((a, b) => b.expected_gain - b.expected_cost - (a.expected_gain - a.expected_cost))
  const best = Math.max(...top.map((c) => c.expected_gain - c.expected_cost), 1)
  const next = [...arms].filter((a) => a.ei > 0).sort((a, b) => b.ei - a.ei).slice(0, 5)
  const pilotContacts = l.total_contacts - l.contacts_after_pilots
  const planContacts = plan.reduce((s, c) => s + c.audience, 0)
  const pilotCost = l.total_budget - l.budget_after_pilots
  const planCost = plan.reduce((s, c) => s + c.expected_cost, 0)

  return (
    <>
      <HowTo>
        Агент уже провёл пилоты и собрал план. Слева — <b>кампании к запуску</b> в порядке ожидаемого чистого эффекта
        (прирост ARPU минус стоимость контактов). Справа — как распределены ресурсы и <b>куда пошёл бы следующий пилот</b>.
      </HowTo>
      <div className="grid gap-5 lg:grid-cols-5">
        <Section icon={Rocket} title="Запустить прямо сейчас" desc="Кампании плана по ожидаемому чистому эффекту" className="lg:col-span-3">
          <ol className="flex flex-col gap-2">
            {top.map((c, i) => {
              const net = c.expected_gain - c.expected_cost
              return (
                <li key={c.campaign_name} className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-default/50">
                  <span className="num grid size-7 place-items-center rounded-lg bg-accent-soft text-xs font-semibold text-accent-soft-foreground">{i + 1}</span>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{c.filter_arpu_segment} ARPU</span>
                      <ChannelChip ch={c.channel} />
                      <span className="text-xs text-muted">{fmt(c.audience)} абонентов</span>
                    </div>
                    <Flow from={c.filter_current_tariff.split(';')} to={c.target_tariff} />
                  </div>
                  <div className="flex w-28 flex-col items-end gap-1">
                    <span className="num text-sm font-semibold">{money(net)}</span>
                    <span className="h-1 w-full overflow-hidden rounded-full bg-default">
                      <span className="block h-full rounded-full bg-accent" style={{ width: `${(100 * net) / best}%` }} />
                    </span>
                  </div>
                </li>
              )
            })}
          </ol>
        </Section>

        <div className="flex flex-col gap-5 lg:col-span-2">
          <Section icon={Scale} title="Разведка vs эксплуатация" desc="Сколько ресурсов ушло на пилоты, а сколько на план">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">Контакты</span>
              <StackBar parts={[
                { label: 'пилоты', value: pilotContacts, color: 'var(--series-2)' },
                { label: 'план', value: planContacts, color: 'var(--accent)' },
                { label: 'свободно', value: Math.max(l.total_contacts - pilotContacts - planContacts, 0), color: 'var(--seq-0)' },
              ]} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">Бюджет, ₽</span>
              <StackBar parts={[
                { label: 'пилоты', value: pilotCost, color: 'var(--series-2)' },
                { label: 'план', value: planCost, color: 'var(--accent)' },
                { label: 'свободно', value: Math.max(l.total_budget - pilotCost - planCost, 0), color: 'var(--seq-0)' },
              ]} />
            </div>
          </Section>

          <Section icon={Compass} title="Следующий пилот" desc="Где ещё можно выиграть от проверки: наибольший expected improvement">
            <ul className="flex flex-col divide-y divide-border">
              {next.map((a) => (
                <li key={a.cur + a.seg + a.target} className="flex flex-col gap-1.5 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="num truncate text-sm">
                      {a.cur} · {a.seg} <span className="text-muted">→</span> <b className="text-accent-soft-foreground">{a.target}</b>
                    </span>
                    <span className="num text-xs whitespace-nowrap text-muted">EI {money(a.ei)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <SrcChips src={a.src} />
                    <span className="inline-flex items-center gap-1">оценка <Delta v={a.post_mu} /> ± {fmt(100 * a.post_sd, 1)}%</span>
                  </div>
                </li>
              ))}
              {!next.length && <li className="py-2 text-sm text-muted">Неопределённость исчерпана: EI ≈ 0 везде</li>}
            </ul>
          </Section>
        </div>
      </div>
    </>
  )
}
