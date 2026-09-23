import { ToggleButton, ToggleButtonGroup } from '@heroui/react'
import { ListTree, ScatterChart as ScatterIcon } from 'lucide-react'
import { useState } from 'react'
import { CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import type { Arm, Run } from '../api'
import { BarCell, DataTable, Delta, Flow, HowTo, SRC, Section, SrcChips, StatusChip, armStatus, fmt, money, srcKey } from '../ui'

const one = <T,>(k: Iterable<unknown>) => [...k][0] as T
const tick = (v: number) => `${fmt(100 * v)}%`

export default function Hypotheses({ run }: { run: Run }) {
  const [expert, setExpert] = useState('all')
  const [status, setStatus] = useState('all')
  const k = run.limits.lcb_k
  const rows = run.arms.filter((a) => (expert === 'all' || a.src.includes(expert)) && (status === 'all' || armStatus(a) === status))
  const maxSd = Math.max(...run.arms.map((a) => a.post_sd), 0.01)
  const maxEi = Math.max(...run.arms.map((a) => a.ei), 1)
  const counts = { llm: run.arms.filter((a) => a.src.includes('llm')).length, piloted: run.arms.filter((a) => a.n).length }

  return (
    <>
      <HowTo>
        <b>Гипотеза</b> = «ячейке X предложить тариф Y». Эксперты (история переходов и LLM) предложили <b>{run.arms.length}</b> гипотез,
        из них LLM — {counts.llm}; пилотами проверено {counts.piloted}. Для каждой агент держит оценку эффекта <b>μ</b> и
        неопределённость <b>σ</b>. В план попадает только то, что с запасом выше нуля: <b>μ − {k}σ &gt; 0</b>.
      </HowTo>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">Эксперт</span>
        <ToggleButtonGroup aria-label="Эксперт" selectionMode="single" disallowEmptySelection size="sm"
          selectedKeys={[expert]} onSelectionChange={(s) => setExpert(one(s))}>
          <ToggleButton id="all">Все</ToggleButton>
          <ToggleButton id="prior">История</ToggleButton>
          <ToggleButton id="llm">LLM</ToggleButton>
          <ToggleButton id="feedback">База знаний</ToggleButton>
        </ToggleButtonGroup>
        <span className="ml-2 text-sm text-muted">Статус</span>
        <ToggleButtonGroup aria-label="Статус" selectionMode="single" disallowEmptySelection size="sm"
          selectedKeys={[status]} onSelectionChange={(s) => setStatus(one(s))}>
          {['all', 'в плане', 'проверена пилотом', 'без пилота'].map((s) => <ToggleButton key={s} id={s}>{s === 'all' ? 'Любой' : s}</ToggleButton>)}
        </ToggleButtonGroup>
        <span className="num ml-auto text-sm text-muted">{rows.length} из {run.arms.length}</span>
      </div>

      <Section icon={ScatterIcon} title="Эффект vs неопределённость"
        desc={`Каждая точка — гипотеза. Выше пунктира — проходит порог μ − ${k}σ > 0. Крупные точки — в финальном плане`}>
        <div className="h-80">
          <ResponsiveContainer>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 4 }}>
              <CartesianGrid stroke="var(--grid)" />
              <XAxis type="number" dataKey="post_sd" stroke="var(--axis)" tick={{ fontSize: 11 }} domain={[0, 'auto']} tickFormatter={tick}
                label={{ value: 'неопределённость σ', position: 'insideBottom', offset: -16, fontSize: 12, fill: 'var(--axis)' }} />
              <YAxis type="number" dataKey="post_mu" stroke="var(--axis)" tick={{ fontSize: 11 }} width={52} tickFormatter={tick}
                label={{ value: 'эффект μ', angle: -90, position: 'insideLeft', fontSize: 12, fill: 'var(--axis)' }} />
              <ReferenceLine y={0} stroke="var(--axis)" />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: maxSd, y: k * maxSd }]} stroke="var(--accent)" strokeDasharray="5 4" strokeWidth={2} />
              <Tooltip cursor={false} content={({ payload }) => {
                const a = payload?.[0]?.payload as Arm | undefined
                return a ? (
                  <div className="flex flex-col gap-1 rounded-xl border border-border bg-overlay p-3 text-xs shadow-lg">
                    <Flow from={[`${a.cur} · ${a.seg}`]} to={a.target} />
                    <span>эффект <Delta v={a.post_mu} /> ± {fmt(100 * a.post_sd, 1)}% · порог <Delta v={a.lcb} /></span>
                    <span className="text-muted">история {tick(a.prior_mu)} · пилот {a.n ? `${a.n} аб.` : 'нет'} · {armStatus(a)}</span>
                  </div>
                ) : null
              }} />
              <Legend verticalAlign="top" height={30} iconSize={9} wrapperStyle={{ fontSize: 12 }} />
              {(Object.keys(SRC) as (keyof typeof SRC)[]).map((s) => (
                <Scatter key={s} name={SRC[s].label} data={rows.filter((a) => srcKey(a.src) === s)} fill={SRC[s].color}
                  shape={(p: { cx?: number; cy?: number; payload?: Arm; fill?: string }) =>
                    <circle cx={p.cx} cy={p.cy} r={p.payload?.planned ? 7 : 4} fill={p.fill} fillOpacity={p.payload?.planned ? 1 : 0.75}
                      stroke="var(--surface)" strokeWidth={2} />} />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </Section>

      <Section icon={ListTree} title="Реестр гипотез" desc="По умолчанию — самые перспективные сверху. Наведи на ⓘ, чтобы понять колонку">
        <DataTable<Arm> label="Гипотезы" rows={rows} rowKey={(a) => a.cur + a.seg + a.target} pageSize={25}
          initialSort={{ column: 'post', direction: 'descending' }}
          cols={[
            { key: 'flow', label: 'Гипотеза', sort: (a) => a.cur + a.seg,
              render: (a) => <Flow from={[`${a.cur} · ${a.seg}`]} to={a.target} /> },
            { key: 'src', label: 'Кто предложил', render: (a) => <SrcChips src={a.src} />, sort: (a) => srcKey(a.src) },
            { key: 'prior', label: 'По истории', num: true, sort: (a) => a.prior_mu, render: (a) => <Delta v={a.prior_mu} />,
              hint: 'Априорная оценка до пилотов: средний Δ ARPU при таком переходе в исторических данных × доля перешедших' },
            { key: 'post', label: 'Итоговая оценка', num: true, sort: (a) => a.post_mu,
              hint: 'μ ± σ после пилотов (байесовское обновление). Относительный прирост ARPU ячейки',
              render: (a) => <span className="inline-flex items-center gap-1"><Delta v={a.post_mu} /><span className="text-xs text-muted">± {fmt(100 * a.post_sd, 1)}%</span></span> },
            { key: 'lcb', label: 'С запасом', num: true, sort: (a) => a.lcb, render: (a) => <Delta v={a.lcb} />,
              hint: `Консервативная оценка μ − ${k}σ. Если больше нуля — гипотеза может идти в план` },
            { key: 'n', label: 'Пилот', num: true, sort: (a) => a.n,
              render: (a) => (a.n ? `${a.n} аб.` : <span className="text-muted">—</span>), hint: 'Сколько абонентов проверено пилотом' },
            { key: 'ei', label: 'Ценность проверки', num: true, sort: (a) => a.ei,
              hint: 'Expected improvement × Σ ARPU ячейки: сколько в среднем можно выиграть, если проверить гипотезу ещё раз',
              render: (a) => <BarCell value={a.ei} max={maxEi} label={money(a.ei)} color="var(--series-2)" /> },
            { key: 'status', label: 'Статус', sort: armStatus, render: (a) => <StatusChip a={a} /> },
          ]} />
      </Section>
    </>
  )
}
