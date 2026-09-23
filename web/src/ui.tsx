import { Button, Card, Chip, Meter, Table, Tooltip } from '@heroui/react'
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, Bell, Brain, CircleCheck, Database, CircleDashed, CircleSlash, CircleX, History, Info,
  LoaderCircle, Megaphone, MessageSquare, Pause, Phone, Rocket, TrendingUp, type LucideIcon,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { SortDescriptor } from 'react-aria-components'
import type { Arm, Issue, VersionStatus } from './api'

// ---------- форматирование ----------
export const fmt = (x: number | null | undefined, d = 0) =>
  x == null ? '—' : x.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d })
export const money = (x: number | null | undefined) =>
  x == null ? '—' : Math.abs(x) >= 1e6 ? `${fmt(x / 1e6, 2)} млн` : Math.abs(x) >= 1e3 ? `${fmt(x / 1e3, 1)} тыс` : fmt(x)
/** Относительный эффект (0.052) → «+5,2%» */
export const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${x > 0 ? '+' : ''}${fmt(100 * x, d)}%`)

// ---------- словари ----------
export const SRC = {
  prior: { label: 'История', long: 'prior по истории переходов', color: 'var(--series-1)', icon: History },
  llm: { label: 'LLM', long: 'предложил LLM-эксперт', color: 'var(--series-2)', icon: Brain },
  both: { label: 'История + LLM', long: 'предложили оба эксперта', color: 'var(--series-3)', icon: TrendingUp },
  feedback: { label: 'База знаний', long: 'наблюдения прошлых пилотов и кампаний', color: 'var(--series-4)', icon: Database },
} as const
type SrcId = keyof typeof SRC
// база знаний важнее того, кто предложил: рукав с прошлыми наблюдениями окрашен как feedback
export const srcKey = (src: string[]): SrcId => (src.includes('feedback') ? 'feedback' : src.length > 1 ? 'both' : (src[0] as SrcId) ?? 'prior')

export const CHANNEL: Record<string, { label: string; icon: LucideIcon }> = {
  push: { label: 'Push', icon: Bell },
  sms: { label: 'SMS', icon: MessageSquare },
  digital_ads: { label: 'Digital-реклама', icon: Megaphone },
  call: { label: 'Звонок', icon: Phone },
}

export const armStatus = (a: Arm) => (a.planned ? 'в плане' : a.n ? 'проверена пилотом' : 'без пилота')

const DECISION = {
  scale: { label: 'Масштабировать', color: 'success', icon: ArrowUpRight },
  hold: { label: 'Отложить', color: 'warning', icon: Pause },
  drop: { label: 'Отказаться', color: 'danger', icon: CircleSlash },
} as const

// ---------- атомы ----------
export function Delta({ v, d = 1 }: { v: number | null | undefined; d?: number }) {
  if (v == null) return <span className="text-muted">—</span>
  const Icon = v >= 0 ? ArrowUpRight : ArrowDownRight
  return (
    <span className="num inline-flex items-center gap-0.5 font-medium" style={{ color: v >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
      <Icon className="size-3.5" aria-hidden />{pct(v, d)}
    </span>
  )
}

export function BarCell({ value, max, label, color = 'var(--series-1)' }: { value: number; max: number; label: ReactNode; color?: string }) {
  return (
    <span className="flex min-w-24 flex-col items-end gap-1">
      <span className="num">{label}</span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-default">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, (100 * value) / (max || 1)))}%`, background: color }} />
      </span>
    </span>
  )
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <Tooltip delay={150}>
      <Tooltip.Trigger aria-label="Пояснение" className="inline-flex cursor-help text-muted hover:text-foreground">
        <Info className="size-3.5" aria-hidden />
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-72 text-xs leading-relaxed">{children}</Tooltip.Content>
    </Tooltip>
  )
}

/** Тултип на самом контроле. Ребёнок — кнопка/переключатель HeroUI (RAC сам вешает hover и focus) */
export function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip delay={300}>
      {children}
      <Tooltip.Content className="max-w-72 text-xs leading-relaxed">{tip}</Tooltip.Content>
    </Tooltip>
  )
}

export function SrcChips({ src }: { src: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {src.map((s) => {
        const m = SRC[s as SrcId]
        return (
          <Chip key={s} size="sm" variant="soft" className="gap-1">
            <m.icon className="size-3" style={{ color: m.color }} aria-hidden />{m.label}
          </Chip>
        )
      })}
    </span>
  )
}

export function Decision({ d }: { d: keyof typeof DECISION }) {
  const m = DECISION[d]
  return <Chip size="sm" color={m.color} variant="soft" className="gap-1"><m.icon className="size-3" aria-hidden />{m.label}</Chip>
}

const VSTATUS: Record<VersionStatus, { label: string; color: 'default' | 'accent' | 'success' | 'warning' | 'danger'; icon: LucideIcon }> = {
  draft: { label: 'draft', color: 'default', icon: CircleDashed },
  evaluating: { label: 'тестируется', color: 'warning', icon: LoaderCircle },
  candidate: { label: 'candidate', color: 'accent', icon: CircleCheck },
  failed: { label: 'failed', color: 'danger', icon: CircleX },
  promoted: { label: 'promoted', color: 'success', icon: Rocket },
}
export function VersionStatusChip({ s }: { s: VersionStatus }) {
  const m = VSTATUS[s]
  return (
    <Chip size="sm" color={m.color} variant="soft" className="gap-1">
      <m.icon className={`size-3 ${s === 'evaluating' ? 'animate-spin' : ''}`} aria-hidden />{m.label}
    </Chip>
  )
}

export function TestChip({ passed, must }: { passed: boolean; must?: boolean }) {
  return (
    <Chip size="sm" color={passed ? 'success' : must ? 'danger' : 'warning'} variant="soft" className="gap-1">
      {passed ? <CircleCheck className="size-3" aria-hidden /> : <CircleX className="size-3" aria-hidden />}{passed ? 'pass' : 'fail'}
    </Chip>
  )
}

export const SEVERITY = { high: { label: 'высокая', color: 'danger' }, medium: { label: 'средняя', color: 'warning' }, low: { label: 'низкая', color: 'default' } } as const
export function SeverityChip({ s }: { s: Issue['severity'] }) {
  return <Chip size="sm" color={SEVERITY[s].color} variant="soft">{SEVERITY[s].label}</Chip>
}

/** «LCB_K: 0.5 → 0.75» */
export function DiffLine({ d }: { d: { key: string; from: unknown; to: unknown } }) {
  const show = (x: unknown) => (typeof x === 'string' ? (x ? `«${x.length > 40 ? x.slice(0, 40) + '…' : x}»` : '«»') : String(x))
  return (
    <span className="num inline-flex flex-wrap items-center gap-1 text-xs">
      <span className="font-semibold">{d.key}</span>
      <span className="text-muted line-through">{show(d.from)}</span>
      <ArrowRight className="size-3 text-muted" aria-hidden />
      <span className="rounded bg-accent-soft px-1 text-accent-soft-foreground">{show(d.to)}</span>
    </span>
  )
}

export function ChannelChip({ ch }: { ch: string }) {
  const m = CHANNEL[ch] ?? { label: ch, icon: Megaphone }
  return <Chip size="sm" variant="secondary" className="gap-1 whitespace-nowrap"><m.icon className="size-3 shrink-0" aria-hidden />{m.label}</Chip>
}

export function StatusChip({ a }: { a: Arm }) {
  if (a.planned) return <Chip size="sm" color="accent" variant="soft" className="gap-1"><CircleCheck className="size-3" aria-hidden />в плане</Chip>
  return <Chip size="sm" variant="soft">{armStatus(a)}</Chip>
}

/** «tariff_1, tariff_12 → tariff_8» */
export function Flow({ from, to, max = 4 }: { from: string[]; to: string; max?: number }) {
  const rest = from.length - max
  return (
    <span className={`flex items-center gap-1 text-sm ${from.length > 1 ? 'flex-wrap' : ''}`}>
      {from.slice(0, max).map((t) => <span key={t} className="num rounded-md bg-default px-1.5 py-0.5 text-xs whitespace-nowrap">{t}</span>)}
      {rest > 0 && <span className="text-xs text-muted" title={from.slice(max).join(', ')}>+{rest}</span>}
      <ArrowRight className="mx-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <span className="num rounded-md bg-accent px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-accent-foreground">{to}</span>
    </span>
  )
}

// ---------- блоки ----------
export function Kpi({ icon: Icon, label, value, hint, meter }: {
  icon: LucideIcon; label: string; value: ReactNode; hint?: ReactNode; meter?: { value: number; max: number }
}) {
  return (
    <Card className="gap-2 p-4">
      <span className="flex items-center gap-2 text-xs font-medium text-muted">
        <span className="grid size-6 place-items-center rounded-md bg-default"><Icon className="size-3.5" aria-hidden /></span>
        {label}
      </span>
      <span className="num text-2xl font-semibold tracking-tight">{value}</span>
      {meter && (
        <Meter aria-label={label} value={meter.value} maxValue={meter.max} size="sm" color="accent">
          <Meter.Track><Meter.Fill /></Meter.Track>
        </Meter>
      )}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </Card>
  )
}

export function Section({ icon: Icon, title, desc, children, action, className }: {
  icon?: LucideIcon; title: string; desc?: ReactNode; children: ReactNode; action?: ReactNode; className?: string
}) {
  return (
    <Card className={`gap-4 p-5 ${className ?? ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          {Icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-default"><Icon className="size-4" aria-hidden /></span>}
          <div className="min-w-0">
            <h3 className="font-semibold">{title}</h3>
            {desc && <p className="text-sm text-muted">{desc}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}

/** «Как читать этот экран» — один абзац над содержимым вкладки */
export function HowTo({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-border bg-surface/60 px-4 py-3 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-accent-soft-foreground" aria-hidden />
      <div className="text-muted [&_b]:font-medium [&_b]:text-foreground">{children}</div>
    </div>
  )
}

// ---------- таблица ----------
export type Col<T> = {
  key: string; label: string; render: (r: T) => ReactNode
  sort?: (r: T) => number | string; num?: boolean; hint?: ReactNode
}

// ponytail: одна таблица на все экраны; сортировка и «показать ещё» на клиенте — строк максимум ~300
export function DataTable<T>({ label, rows, cols, rowKey, initialSort, pageSize = 1000 }: {
  label: string; rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string; initialSort?: SortDescriptor; pageSize?: number
}) {
  const [sort, setSort] = useState<SortDescriptor | undefined>(initialSort)
  const [limit, setLimit] = useState(pageSize)
  const sorted = useMemo(() => {
    const c = cols.find((c) => c.key === sort?.column)
    if (!c?.sort) return rows
    const k = c.sort, dir = sort!.direction === 'descending' ? -1 : 1
    return [...rows].sort((a, b) => (k(a) > k(b) ? dir : k(a) < k(b) ? -dir : 0))
  }, [rows, cols, sort])
  const shown = sorted.slice(0, limit)
  const head = (c: Col<T>) => (
    <span className={`inline-flex items-center gap-1 ${c.num ? 'justify-end' : ''}`}>{c.label}{c.hint && <Hint>{c.hint}</Hint>}</span>
  )
  return (
    <div className="flex flex-col gap-2">
      <Table variant="secondary">
        <Table.ScrollContainer>
          <Table.Content aria-label={label} sortDescriptor={sort} onSortChange={setSort}>
            <Table.Header>
              {cols.map((c, i) => (
                <Table.Column key={c.key} id={c.key} isRowHeader={i === 0} allowsSorting={!!c.sort}
                  className={`whitespace-nowrap ${c.num ? 'text-right' : ''}`}>
                  {({ sortDirection }) => c.sort
                    ? <Table.SortableColumnHeader sortDirection={sortDirection}>{head(c)}</Table.SortableColumnHeader>
                    : head(c)}
                </Table.Column>
              ))}
            </Table.Header>
            <Table.Body>
              {shown.map((r) => (
                <Table.Row key={rowKey(r)} id={rowKey(r)}>
                  {cols.map((c) => (
                    <Table.Cell key={c.key} className={c.num ? 'num text-right whitespace-nowrap' : undefined}>{c.render(r)}</Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {sorted.length > limit && (
        <Button size="sm" variant="ghost" className="self-center" onPress={() => setLimit(limit + pageSize)}>
          Показать ещё {Math.min(pageSize, sorted.length - limit)} из {sorted.length - limit}
        </Button>
      )}
    </div>
  )
}

// Горизонтальная стек-полоса (доли), 2px зазор между сегментами; легенда всегда рядом
export function StackBar({ parts, unit = '' }: { parts: { label: string; value: number; color: string }[]; unit?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full">
        {parts.filter((p) => p.value > 0).map((p) => (
          <div key={p.label} title={`${p.label}: ${fmt(p.value)}${unit}`} style={{ width: `${(100 * p.value) / total}%`, background: p.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: p.color }} />
            {p.label} <span className="num text-foreground">{fmt(p.value)}{unit}</span> · {fmt((100 * p.value) / total)}%
          </span>
        ))}
      </div>
    </div>
  )
}
