import { Button } from '@heroui/react'
import { BarChart3, ChevronLeft, ChevronRight, Database, FlaskConical, Footprints } from 'lucide-react'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Pilot, Run } from '../api'
import { DataTable, Decision, Delta, Flow, HowTo, Section, SrcChips, Tip, fmt, money } from '../ui'

const tick = (v: number) => `${fmt(100 * v)}%`

export default function Pilots({ run, onSave }: { run: Run; onSave: () => Promise<{ world: string; added: number }> }) {
  const { pilots } = run
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string>()
  const save = () => {
    setSaving(true)
    onSave().then((r) => setSaved(r.added ? `+${r.added} в базу знаний «${r.world}»` : 'уже в базе знаний'), (e) => setSaved(String(e)))
      .finally(() => setSaving(false))
  }
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

      {run.replay.length > 0 && <Replay run={run} />}

      <Section icon={FlaskConical} title="Журнал пилотов" desc="В порядке запуска: каждый следующий пилот агент выбирал по результатам предыдущих"
        action={
          <div className="flex items-center gap-2">
            {saved && <span className="text-sm text-muted">{saved}</span>}
            <Tip tip="Следующий прогон этого мира стартует с этих наблюдений и потратит пилоты на другие гипотезы">
              <Button size="sm" variant="secondary" isPending={saving} isDisabled={!pilots.length} onPress={save}>
                {!saving && <Database className="size-4" aria-hidden />}Сохранить в базу знаний
              </Button>
            </Tip>
          </div>
        }>
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

// Пошаговый replay разведки: что выбрал EI, что показал пилот, как сдвинулся апостериор ячейки
function Replay({ run }: { run: Run }) {
  const steps = run.replay
  const [i, setI] = useState(0)
  const st = steps[i]
  const last = i === steps.length - 1
  const planned = run.arms.filter((a) => a.planned)
  return (
    <Section icon={Footprints} title="Replay разведки" desc="Шаг за шагом: какую гипотезу агент выбрал по EI, что показал пилот и как изменилась оценка"
      action={
        <div className="flex items-center gap-2">
          <Tip tip="Предыдущий пилот"><Button size="sm" variant="ghost" isIconOnly aria-label="Назад" isDisabled={i === 0} onPress={() => setI(i - 1)}><ChevronLeft className="size-4" /></Button></Tip>
          <input type="range" min={0} max={steps.length - 1} value={i} onChange={(e) => setI(Number(e.target.value))}
            aria-label="Шаг replay" className="w-40 accent-[var(--accent)] sm:w-64" />
          <Tip tip="Следующий пилот"><Button size="sm" variant="ghost" isIconOnly aria-label="Вперёд" isDisabled={last} onPress={() => setI(i + 1)}><ChevronRight className="size-4" /></Button></Tip>
          <span className="num w-14 text-right text-sm">{st.i} / {steps.length}</span>
        </div>
      }>
      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-xl bg-default/60 p-3">
            <span className="text-xs text-muted">Пилот №{st.i}: гипотеза с максимальным EI × Σ ARPU</span>
            <Flow from={[`${st.cur} · ${st.seg}`]} to={st.target} />
            <span className="text-sm">{st.n} аб. через SMS → наблюдали <Delta v={st.obs} /> · EI {money(st.ei)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Кандидаты по EI на этом шаге</span>
            {st.top_ei.map((t) => {
              const chosen = t.cur === st.cur && t.seg === st.seg && t.target === st.target
              return (
                <span key={t.cur + t.seg + t.target} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-sm ${chosen ? 'bg-accent-soft' : ''}`}>
                  <Flow from={[`${t.cur} · ${t.seg}`]} to={t.target} />
                  <span className="num text-xs">{money(t.ei)}</span>
                </span>
              )
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Оценки гипотез ячейки {st.cur} · {st.seg}: до пилота → после</span>
          {st.cell.map((c) => (
            <div key={c.target} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-sm ${c.target === st.target ? 'bg-accent-soft' : ''}`}>
              <span className="num w-20 font-medium">{c.target}</span>
              <SrcChips src={c.src} />
              <span className="ml-auto inline-flex items-center gap-1">
                <Delta v={c.before_mu} /><span className="text-xs text-muted">± {fmt(100 * c.before_sd, 1)}%</span>
                <span className="text-muted">→</span>
                <Delta v={c.after_mu} /><span className="text-xs text-muted">± {fmt(100 * c.after_sd, 1)}%</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      {last && (
        <p className="rounded-xl border border-border px-4 py-3 text-sm">
          <b>Итог разведки.</b> В план прошли {planned.length} гипотез, у которых нижняя граница μ − {run.limits.lcb_k}σ &gt; 0 и которые лучшие в своей ячейке.
          Непроверенные догадки LLM в план не допускаются. Детали — на экране «Финальный план».
        </p>
      )}
    </Section>
  )
}
