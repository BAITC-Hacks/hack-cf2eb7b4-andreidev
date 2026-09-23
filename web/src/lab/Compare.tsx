import { ToggleButton, ToggleButtonGroup } from '@heroui/react'
import { GitCompare, LineChart as LineIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { lab, type Version } from '../api'
import { DataTable, DiffLine, HowTo, Section, fmt, money } from '../ui'
import { FAMILIES, worldNets, type Family, type LabState } from './useLab'
import { FamilyToggle } from './Versions'

const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)']

export default function Compare({ s }: { s: LabState }) {
  const tested = s.versions.filter((v) => v.metrics && 'stress' in v.metrics)
  const [ids, setIds] = useState<string[]>([])
  const [full, setFull] = useState<Record<string, Version>>({})
  const [fam, setFam] = useState<Family>('harsh_0')
  // по умолчанию: текущая версия в agent.py + последняя протестированная
  useEffect(() => {
    if (ids.length || tested.length < 1) return
    const cur = tested.find((v) => v.current) ?? tested[0]
    setIds([...new Set([cur.id, tested.at(-1)!.id])])
  }, [tested.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    ids.filter((id) => !full[id]).forEach((id) => lab.version(id).then((v) => setFull((f) => ({ ...f, [id]: v }))))
  }, [ids]) // eslint-disable-line react-hooks/exhaustive-deps

  const vs = ids.map((id) => full[id]).filter(Boolean) as Version[]
  const base = vs[0]
  const nets = vs.map((v) => worldNets(v, fam))
  const seeds = [...new Set(nets.flatMap((n) => Object.keys(n).map(Number)))].sort((a, b) => a - b)
  const data = seeds.map((seed) => Object.fromEntries([['seed', seed], ...vs.map((v, i) => [v.id, nets[i][seed]])]))

  type Row = Version & { m: Extract<Version['metrics'], { stress: unknown }> }
  const rows = vs.map((v) => ({ ...v, m: v.metrics })) as Row[]
  const codes = (v?: Version) => new Set((v?.issues ?? []).map((i) => i.code))

  return (
    <>
      <HowTo>
        Выбери 2–3 протестированные версии. Первая выбранная — <b>база сравнения</b>: для остальных показаны появившиеся и исчезнувшие
        issues и изменённые настройки. На графике — чистый результат по каждому миру выбранного семейства. Главное — <b>жёсткие
        миры keep 0</b>: история в них бесполезна, как в боевой среде. Линия, которая везде выше и не опускается ниже нуля, лучше.
      </HowTo>
      <Section icon={GitCompare} title="Версии для сравнения" desc={`Выбрано ${ids.length} из 3`}>
        <ToggleButtonGroup aria-label="Версии" selectionMode="multiple" size="sm" className="flex-wrap"
          selectedKeys={ids} onSelectionChange={(k) => setIds([...ids.filter((x) => (k as Set<string>).has(x)), ...[...(k as Set<string>)].filter((x) => !ids.includes(x))].slice(-3))}>
          {tested.map((v) => <ToggleButton key={v.id} id={v.id}>{v.id}{v.current ? ' ★' : ''}</ToggleButton>)}
        </ToggleButtonGroup>
        {!tested.length && <p className="text-sm text-muted">Нет протестированных версий — запусти матрицу на экране «Версии».</p>}
      </Section>

      {vs.length > 0 && (
        <>
          <Section icon={LineIcon} title="Распределение результата по мирам" desc="net по каждому seed; пунктир — ноль"
            action={<FamilyToggle value={fam} onChange={setFam} />}>
            <div className="h-72">
              <ResponsiveContainer>
                <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis dataKey="seed" stroke="var(--axis)" tick={{ fontSize: 11 }} tickFormatter={(x) => `мир ${x}`} />
                  <YAxis stroke="var(--axis)" tick={{ fontSize: 11 }} width={64} tickFormatter={(x) => money(x)} />
                  <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="4 4" />
                  <Tooltip formatter={(x) => money(Number(x))} labelFormatter={(x) => `мир ${x}`} />
                  <Legend verticalAlign="top" height={28} iconSize={9} wrapperStyle={{ fontSize: 12 }} />
                  {vs.map((v, i) => <Line key={v.id} dataKey={v.id} stroke={COLORS[i]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Section>

          <DataTable<Row> label="Сравнение версий" rows={rows} rowKey={(v) => v.id}
            cols={[
              { key: 'id', label: 'Версия', render: (v) => <span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: COLORS[ids.indexOf(v.id)] }} /><b className="num">{v.id}</b></span> },
              ...FAMILIES.map((f) => ({ key: f.key, label: `Медиана · ${f.label}`, num: true,
                render: (v: Row) => <span className="flex flex-col items-end"><span>{money(v.m[f.key]?.median)}</span><span className="text-xs text-muted">мин {money(v.m[f.key]?.min)}</span></span> })),
              { key: 'neg', label: 'Прогонов в минусе', num: true, render: (v) => v.m.negative_runs },
              { key: 'hit', label: 'Пилотов в плюс', num: true, hint: 'Эффективность разведки: доля пилотов с положительным uplift', render: (v) => (v.m.pilot_hit_rate == null ? '—' : `${fmt(100 * v.m.pilot_hit_rate)}%`) },
              { key: 'p2p', label: 'Пилот → план', num: true, hint: 'Доля пилотированных гипотез, дошедших до финального плана', render: (v) => `${fmt(100 * v.m.pilot_to_plan)}%` },
              { key: 'pc', label: 'Цена разведки', num: true, render: (v) => money(v.m.pilot_cost_mean) },
              { key: 'div', label: 'Разнообразие', num: true, hint: 'Уникальных пар «тариф × канал» в плане (среднее)', render: (v) => fmt(v.m.diversity, 1) },
              { key: 'iss', label: 'Issues', render: (v) => {
                if (v.id === base.id) return <span className="text-xs">{v.issues.length} (база)</span>
                const a = codes(v), b = codes(base)
                const plus = [...a].filter((c) => !b.has(c)), minus = [...b].filter((c) => !a.has(c))
                return <span className="flex flex-col text-xs">
                  {plus.map((c) => <span key={c} style={{ color: 'var(--neg)' }}>+ {c}</span>)}
                  {minus.map((c) => <span key={c} style={{ color: 'var(--pos)' }}>− {c}</span>)}
                  {!plus.length && !minus.length && <span className="text-muted">без изменений</span>}
                </span>
              } },
              { key: 'diff', label: 'Изменено (agent.py)', render: (v) => {
                if (v.id === base.id) return <span className="text-xs text-muted">—</span>
                const d = Object.keys(v.config).filter((k) => v.config[k] !== base.config[k]).map((k) => ({ key: k, from: base.config[k], to: v.config[k] }))
                return d.length ? <span className="flex flex-col gap-0.5">{d.map((x) => <DiffLine key={x.key} d={x} />)}</span> : <span className="text-xs text-muted">идентичны</span>
              } },
            ]} />
        </>
      )}
    </>
  )
}
