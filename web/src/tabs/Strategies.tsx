import { Button, Card, ToggleButton, ToggleButtonGroup } from '@heroui/react'
import { FlaskRound, Trophy } from 'lucide-react'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fetchStrategies, type Run, type Strategies as S } from '../api'
import { DataTable, Delta, HowTo, SRC, Section, Tip, fmt, money } from '../ui'

const NOTES: Record<string, string> = {
  agent: 'полный агент: история + LLM, пилоты, порог',
  'без LLM': 'только эксперт-история',
  'без пилотов': 'план сразу по истории, без проверки',
  шаблон: 'agent_template.py организаторов',
  оракул: 'знает истинные эффекты — потолок',
}

export default function Strategies({ run }: { run: Run }) {
  const [runs, setRuns] = useState('3')
  const [res, setRes] = useState<S>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string>()

  // вклад экспертов в этом прогоне — то же, что _expert_report в agent.py, плюс доля ожидаемого эффекта плана
  const armOf = new Map(run.arms.map((a) => [a.cur + a.seg + a.target, a]))
  const planGain = run.plan.flatMap((c) => c.cells.map((x) => ({ gain: x.gain, arm: armOf.get(x.cur + x.seg + c.target_tariff) })))
  const totalGain = planGain.reduce((s, x) => s + x.gain, 0) || 1
  const experts = (['prior', 'llm'] as const).map((e) => {
    const mine = run.arms.filter((a) => a.src.includes(e))
    const obs = mine.flatMap((a) => a.obs)
    return {
      e, arms: mine.length, piloted: mine.filter((a) => a.n).length,
      mean: obs.length ? obs.reduce((s, o) => s + o, 0) / obs.length : null,
      hit: obs.length ? obs.filter((o) => o > 0).length / obs.length : null,
      planned: mine.filter((a) => a.planned).length,
      share: planGain.filter((x) => x.arm?.src.includes(e)).reduce((s, x) => s + x.gain, 0) / totalGain,
    }
  })

  const load = () => {
    setLoading(true)
    setErr(undefined)
    fetchStrategies(Number(runs)).then(setRes, (e) => setErr(String(e))).finally(() => setLoading(false))
  }
  const oracle = res?.summary.find((x) => x.name === 'оракул')?.median || 1

  return (
    <>
      <HowTo>
        Агент — это <b>портфель экспертов</b>: каждый предлагает гипотезы, а пилоты сами решают, чьи идеи работают.
        Сверху — вклад каждого эксперта в текущем прогоне. Снизу — <b>ablation</b>: тот же агент без LLM, без пилотов,
        шаблон организаторов и «оракул», знающий правду, на искажённых мирах, похожих на судейскую среду.
      </HowTo>

      <div className="grid gap-5 md:grid-cols-2">
        {experts.map((x) => {
          const m = SRC[x.e]
          return (
            <Card key={x.e} className="gap-4 p-5">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg" style={{ background: `color-mix(in oklch, ${m.color} 15%, transparent)` }}>
                  <m.icon className="size-4" style={{ color: m.color }} aria-hidden />
                </span>
                <div>
                  <div className="font-semibold">Эксперт «{m.label}»</div>
                  <div className="text-xs text-muted">{x.e === 'prior' ? 'Оценки из истории переходов тарифов' : run.params.llm ? 'Один вызов модели: тарифы + ячейки → гипотезы' : 'Выключен в параметрах запуска'}</div>
                </div>
                <div className="ml-auto text-right">
                  <div className="num text-2xl font-semibold">{fmt(100 * x.share)}%</div>
                  <div className="text-xs text-muted">ожидаемого эффекта плана</div>
                </div>
              </div>
              <dl className="grid grid-cols-4 gap-3 border-t border-border pt-3 text-sm">
                {[
                  ['Гипотез', fmt(x.arms)],
                  ['Проверено', fmt(x.piloted)],
                  ['Средний пилот', <Delta key="d" v={x.mean} />],
                  ['Hit rate', x.hit == null ? '—' : `${fmt(100 * x.hit)}%`],
                ].map(([k, v]) => (
                  <div key={String(k)}><dt className="text-xs text-muted">{k}</dt><dd className="num font-medium">{v}</dd></div>
                ))}
              </dl>
            </Card>
          )
        })}
      </div>

      <Section icon={FlaskRound} title="Сравнение стратегий на стресс-мирах"
        desc="Эффекты мока искажены (× U(0.5, 2) + N(0, 0.3)). Бэкенд считает ≈ 20 с на мир"
        action={
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Миров</span>
            <ToggleButtonGroup aria-label="Число миров" selectionMode="single" disallowEmptySelection size="sm"
              selectedKeys={[runs]} onSelectionChange={(k) => setRuns(String([...k][0]))}>
              {['1', '3', '5', '10'].map((r) => <ToggleButton key={r} id={r}>{r}</ToggleButton>)}
            </ToggleButtonGroup>
            <Tip tip="Прогнать агента, шаблон, prior-only и оракула на выбранном числе стресс-миров (≈ 20 с на мир)">
              <Button size="sm" variant="primary" isPending={loading} onPress={load}>Сравнить</Button>
            </Tip>
          </div>
        }>
        {err && <span className="text-sm text-danger">{err}</span>}
        {!res && !loading && (
          <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted">
            <Trophy className="size-6" aria-hidden />
            Выбери число миров и нажми «Сравнить»
          </div>
        )}
        {loading && !res && <div className="py-10 text-center text-sm text-muted">Прогоняю {runs} мир(а) × 5 стратегий…</div>}
        {res && (
          <>
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={res.summary} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 8 }}>
                  <CartesianGrid stroke="var(--grid)" horizontal={false} />
                  <XAxis type="number" stroke="var(--axis)" tick={{ fontSize: 11 }} tickFormatter={(v) => money(v)} />
                  <YAxis type="category" dataKey="name" stroke="var(--axis)" tick={{ fontSize: 12 }} width={96} />
                  <ReferenceLine x={0} stroke="var(--axis)" />
                  <Tooltip cursor={{ fill: 'var(--grid)', opacity: 0.5 }} formatter={(v) => money(Number(v))} />
                  <Bar dataKey="median" name="медиана net" radius={[0, 4, 4, 0]} barSize={20}>
                    {res.summary.map((s) => <Cell key={s.name} fill={s.name === 'agent' ? 'var(--accent)' : 'var(--seq-2)'} />)}
                    {/* подпись всегда правее и нуля, и конца бара — у отрицательного бара она не налезает на ось */}
                    <LabelList dataKey="median" content={({ x, y, width, height, value }) => (
                      <text x={Math.max(Number(x), Number(x) + Number(width)) + 6} y={Number(y) + Number(height) / 2} dy={4}
                        fontSize={11} fill="var(--axis)">{money(Number(value))}</text>
                    )} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <DataTable<S['summary'][number]> label="Сводка стратегий" rows={res.summary} rowKey={(s) => s.name}
              cols={[
                { key: 'name', label: 'Стратегия', render: (s) => <span className="flex flex-col"><b>{s.name}</b><span className="text-xs text-muted">{NOTES[s.name]}</span></span> },
                { key: 'median', label: 'Медиана net', render: (s) => money(s.median), sort: (s) => s.median, num: true, hint: 'Медианный чистый прирост ARPU по мирам' },
                { key: 'min', label: 'Худший мир', render: (s) => money(s.min), sort: (s) => s.min, num: true, hint: 'Минимум по мирам — устойчивость' },
                { key: 'pos', label: 'В плюс', render: (s) => `${s.positive} / ${res.rows.length}`, num: true },
                { key: 'vs', label: 'От потолка', render: (s) => `${fmt((100 * s.median) / oracle)}%`, num: true, hint: 'Медиана стратегии / медиана оракула' },
              ]} />
          </>
        )}
      </Section>
    </>
  )
}
