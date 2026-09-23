import { BarChart3, FlaskConical } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Pilot, Run } from '../api'
import { DataTable, Decision, Delta, Flow, HowTo, Section, fmt, money } from '../ui'

const tick = (v: number) => `${fmt(100 * v)}%`

export default function Pilots({ run }: { run: Run }) {
  const { pilots } = run
  const data = pilots.map((p, i) => ({ i: i + 1, prior: p.prior_mu, observed: p.base, p }))
  const cost = pilots.reduce((s, p) => s + p.cost, 0)
  const n = pilots.reduce((s, p) => s + p.n, 0)
  const by = (d: Pilot['decision']) => pilots.filter((p) => p.decision === d).length

  return (
    <>
      <HowTo>
        <b>Пилот</b> — маленькая реальная кампания на 60–200 абонентов, чтобы проверить гипотезу на этой аудитории, а не на истории.
        Всего {pilots.length} пилотов, {fmt(n)} абонентов, {money(cost)} ₽. Итог: масштабировать — <b>{by('scale')}</b>,
        отложить — <b>{by('hold')}</b>, отказаться — <b>{by('drop')}</b>. Пилоты идут через SMS; результат пересчитан к «базе» (÷ множитель канала),
        чтобы его можно было применить к любому каналу.
      </HowTo>

      <Section icon={BarChart3} title="Ожидание vs реальность"
        desc="Синий — что обещала история, оранжевый — что показал пилот. Большое расхождение = история для этой ячейки врёт">
        <div className="h-72">
          <ResponsiveContainer>
            <BarChart data={data} barGap={2} margin={{ top: 8, right: 8, bottom: 16, left: 4 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="i" stroke="var(--axis)" tick={{ fontSize: 11 }} tickLine={false}
                label={{ value: 'пилот №', position: 'insideBottom', offset: -8, fontSize: 12, fill: 'var(--axis)' }} />
              <YAxis stroke="var(--axis)" tick={{ fontSize: 11 }} width={52} tickFormatter={tick} />
              <ReferenceLine y={0} stroke="var(--axis)" />
              <Tooltip cursor={{ fill: 'var(--grid)', opacity: 0.5 }} content={({ payload }) => {
                const d = payload?.[0]?.payload as (typeof data)[number] | undefined
                return d ? (
                  <div className="flex flex-col gap-1 rounded-xl border border-border bg-overlay p-3 text-xs shadow-lg">
                    <span className="font-medium">Пилот №{d.i}</span>
                    <Flow from={[`${d.p.cur} · ${d.p.seg}`]} to={d.p.target} />
                    <span>история <Delta v={d.prior} /> → пилот <Delta v={d.observed} /> → итог <Delta v={d.p.post_mu} /></span>
                    <span className="text-muted">{d.p.n} аб. · {money(d.p.cost)} ₽</span>
                  </div>
                ) : null
              }} />
              <Legend verticalAlign="top" height={30} iconSize={9} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="prior" name="по истории" fill="var(--series-1)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="observed" name="по пилоту" fill="var(--series-2)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      <Section icon={FlaskConical} title="Журнал пилотов" desc="В порядке запуска: каждый следующий пилот агент выбирал по результатам предыдущих">
        <DataTable<Pilot & { i: number }> label="Пилоты" rows={pilots.map((p, i) => ({ ...p, i: i + 1 }))} rowKey={(p) => p.name}
          cols={[
            { key: 'i', label: '№', render: (p) => p.i, sort: (p) => p.i, num: true },
            { key: 'flow', label: 'Что проверяли', render: (p) => <Flow from={[`${p.cur} · ${p.seg}`]} to={p.target} />, sort: (p) => p.cur + p.seg },
            { key: 'n', label: 'Выборка', render: (p) => `${p.n} аб.`, sort: (p) => p.n, num: true },
            { key: 'cost', label: 'Стоимость, ₽', render: (p) => fmt(p.cost), sort: (p) => p.cost, num: true },
            { key: 'ratio', label: 'Наблюдаемый uplift', num: true, sort: (p) => p.ratio, render: (p) => <Delta v={p.ratio} />,
              hint: 'observed_lift_ratio от среды: относительный прирост ARPU выборки через SMS, с шумом ≈ 0.8/√n' },
            { key: 'total', label: 'Прирост выборки, ₽', num: true, sort: (p) => p.total, hint: 'observed_lift_total: абсолютный прирост ARPU по выборке пилота',
              render: (p) => <span style={{ color: p.total >= 0 ? 'var(--pos)' : 'var(--neg)' }}>{money(p.total)}</span> },
            { key: 'post', label: 'Оценка после', num: true, sort: (p) => p.post_mu ?? 0,
              hint: 'Итоговая оценка гипотезы μ ± σ после всех её пилотов',
              render: (p) => <span className="inline-flex items-center gap-1"><Delta v={p.post_mu} /><span className="text-xs text-muted">± {fmt(100 * (p.post_sd ?? 0), 1)}%</span></span> },
            { key: 'decision', label: 'Решение агента', render: (p) => <Decision d={p.decision} />, sort: (p) => p.decision,
              hint: 'Масштабировать — гипотеза в плане. Отложить — проходит порог, но в ячейке нашлось лучше или не хватило охвата. Отказаться — не проходит порог' },
          ]} />
      </Section>
    </>
  )
}
