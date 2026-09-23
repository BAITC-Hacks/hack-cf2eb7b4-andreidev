import { Grid3x3, Table2, Wifi } from 'lucide-react'
import type { AudienceCell, Run } from '../api'
import { BarCell, DataTable, HowTo, Section, StackBar, fmt, money } from '../ui'

const SEGS = ['LOW', 'MID', 'HIGH']
const SEG_LABEL: Record<string, string> = { LOW: 'низкий', MID: 'средний', HIGH: 'высокий' }

export default function Audience({ run }: { run: Run }) {
  const { cells, dist } = run.audience
  const planned = new Map<string, string>()
  run.plan.forEach((c) => c.cells.forEach((x) => planned.set(x.cur + x.seg, c.target_tariff)))
  const byKey = new Map(cells.map((c) => [c.cur + c.seg, c]))
  const tariffs = [...new Set(cells.map((c) => c.cur))]
    .map((t) => [t, cells.filter((c) => c.cur === t).reduce((s, c) => s + c.S, 0)] as const)
    .sort((a, b) => b[1] - a[1])
  // последовательная шкала в лог-масштабе: Σ ARPU ячеек различается на порядки
  const logs = cells.map((c) => Math.log(c.S))
  const lo = Math.min(...logs), hi = Math.max(...logs)
  const step = (S: number) => 1 + Math.round((6 * (Math.log(S) - lo)) / (hi - lo || 1))
  const maxS = Math.max(...cells.map((c) => c.S))
  const total = cells.reduce((s, c) => s + c.n, 0)

  return (
    <>
      <HowTo>
        База разбита на <b>{cells.length} ячеек</b> «текущий тариф × ARPU-сегмент» — эффект кампании зависит только от ячейки,
        целевого тарифа и канала. Чем темнее клетка, тем больше суммарный ARPU (ценность). <b>Обведены</b> ячейки, попавшие в финальный план.
      </HowTo>
      <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
        <Section icon={Grid3x3} title="Карта ценности" desc={`${fmt(total)} абонентов · число в клетке — абоненты, цвет — Σ ARPU`}>
          <div className="overflow-x-auto">
            <div className="grid min-w-[380px] grid-cols-[148px_repeat(3,1fr)] gap-1 text-xs">
              <span />
              {SEGS.map((s) => (
                <span key={s} className="pb-1 text-center"><b>{s}</b> <span className="text-muted">{SEG_LABEL[s]} ARPU</span></span>
              ))}
              {tariffs.map(([t, sum]) => (
                <div key={t} className="contents">
                  <span className="flex items-center justify-between gap-2 pr-2">
                    <span className="num">{t}</span><span className="num text-xs whitespace-nowrap text-muted">{money(sum)}</span>
                  </span>
                  {SEGS.map((s) => {
                    const c = byKey.get(t + s)
                    if (!c) return <span key={s} className="h-9 rounded-md border border-dashed border-border" />
                    const k = step(c.S), target = planned.get(t + s)
                    return (
                      <span key={s}
                        title={`${t} · ${s}\n${fmt(c.n)} абонентов\nΣ ARPU ${money(c.S)}\nсредний ARPU ${fmt(c.arpu)}${target ? `\nв плане → ${target}` : ''}`}
                        className={`num relative flex h-9 cursor-default items-center justify-center rounded-md transition-transform hover:scale-[1.04]
                          ${target ? 'ring-2 ring-offset-1 ring-offset-surface ring-foreground' : ''}`}
                        style={{ background: `var(--seq-${k})`, color: k >= 5 ? '#fff' : '#0b0b0b' }}>
                        {fmt(c.n)}
                      </span>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            Σ ARPU: мало
            <span className="flex gap-0.5">{[1, 2, 3, 4, 5, 6, 7].map((k) => <span key={k} className="h-2.5 w-6 rounded-sm" style={{ background: `var(--seq-${k})` }} />)}</span>
            много
            <span className="ml-3 flex items-center gap-1.5"><span className="size-3 rounded-sm ring-2 ring-foreground" /> в плане</span>
          </div>
        </Section>

        <div className="flex flex-col gap-5">
          {(['data_segment', 'call_segment'] as const).map((col) => (
            <Section key={col} icon={Wifi}
              title={col === 'data_segment' ? 'Потребление интернета' : 'Потребление звонков'}
              desc="По ARPU-сегментам. На эффект не влияет — справочно для таргетинга">
              {SEGS.map((s) => {
                const row = dist[col][s] ?? {}
                return (
                  <div key={s} className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium">{s} ARPU</span>
                    <StackBar parts={Object.keys(row).map((k, i) => ({ label: k, value: row[k], color: `var(--series-${i + 1})` }))} />
                  </div>
                )
              })}
            </Section>
          ))}
        </div>
      </div>

      <Section icon={Table2} title="Все ячейки" desc="Сортировка по клику на заголовок">
        <DataTable<AudienceCell> label="Ячейки аудитории" rows={cells} rowKey={(c) => c.cur + c.seg} pageSize={20}
          initialSort={{ column: 'S', direction: 'descending' }}
          cols={[
            { key: 'cur', label: 'Текущий тариф', render: (c) => <span className="num">{c.cur}</span>, sort: (c) => c.cur },
            { key: 'seg', label: 'ARPU-сегмент', render: (c) => c.seg, sort: (c) => SEGS.indexOf(c.seg) },
            { key: 'n', label: 'Абоненты', render: (c) => fmt(c.n), sort: (c) => c.n, num: true },
            { key: 'arpu', label: 'Средний ARPU, ₽', render: (c) => fmt(c.arpu), sort: (c) => c.arpu, num: true, hint: 'Средний ARPU за 3 месяца' },
            { key: 'S', label: 'Ценность ячейки', num: true, sort: (c) => c.S,
              hint: 'Σ predicted_arpu по абонентам ячейки: относительный эффект кампании умножается на эту сумму',
              render: (c) => <BarCell value={c.S} max={maxS} label={money(c.S)} color="var(--seq-5)" /> },
            { key: 'plan', label: 'В плане', render: (c) => planned.get(c.cur + c.seg)
              ? <span className="num font-medium text-accent-soft-foreground">→ {planned.get(c.cur + c.seg)}</span>
              : <span className="text-muted">—</span>, sort: (c) => planned.get(c.cur + c.seg) ?? '' },
          ]} />
      </Section>
    </>
  )
}
