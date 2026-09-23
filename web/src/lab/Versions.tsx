import { Alert, Button, Card, Chip, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react'
import { FlaskConical, GitBranch, Play, Rocket, SlidersHorizontal, Sparkles, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { lab, type Target, type Targets, type Test, type Version, type VersionStatus } from '../api'
import { DataTable, DiffLine, HowTo, Section, TestChip, VersionStatusChip, fmt, money } from '../ui'
import { FAMILIES, worldNets, useVersion, type Family, type LabState } from './useLab'

const STATUSES: VersionStatus[] = ['draft', 'evaluating', 'candidate', 'failed', 'promoted']
export const WHO = { human: 'человек', template: 'шаблон', llm: 'LLM', system: 'система' } as const

export default function Versions({ s }: { s: LabState }) {
  const [filter, setFilter] = useState<Set<VersionStatus>>(new Set(STATUSES))
  const v = s.selected
  return (
    <>
      <HowTo>
        <b>Версия</b> — набор разрешённых настроек поверх <code>agent.py</code>: константы, флаги эвристик и дополнение к промпту.
        Каждая версия проходит одну и ту же <b>матрицу тестов</b>. Авто-патч получает статус <b>candidate</b>, только если прошёл gate
        против родителя: must-have тесты пройдены, медиана в <b>жёстких мирах</b> (история бесполезна, как на судействе) не упала,
        в стресс-мирах и мирах keep 0.5 упала не больше чем на 3%, худший из жёстких миров не стал хуже. <b>Promote</b> записывает
        настройки в <code>agent.py</code> и пересобирает <code>submission.csv</code>.
      </HowTo>
      {s.error && <Alert status="danger"><Alert.Content><Alert.Title>Лаборатория</Alert.Title><Alert.Description>{s.error}</Alert.Description></Alert.Content></Alert>}
      <div className="grid gap-5 xl:grid-cols-[minmax(300px,1fr)_2fr]">
        <Section icon={GitBranch} title="Lineage" desc="baseline → патчи → promoted"
          action={
            <ToggleButtonGroup aria-label="Статус" selectionMode="multiple" size="sm" selectedKeys={filter}
              onSelectionChange={(k) => setFilter(new Set(k as Set<VersionStatus>))} className="flex-wrap">
              {STATUSES.map((st) => <ToggleButton key={st} id={st}>{st === 'evaluating' ? 'тест' : st}</ToggleButton>)}
            </ToggleButtonGroup>
          }>
          <Tree versions={s.versions} sel={v?.id} onSel={s.setSel} filter={filter} />
        </Section>
        {v ? <StrategyCard v={v} s={s} /> : <Card className="p-5 text-sm text-muted">Версий пока нет</Card>}
      </div>
      {v && <NewVersion parent={v} s={s} />}
    </>
  )
}

function Tree({ versions, sel, onSel, filter }: { versions: Version[]; sel?: string; onSel: (id: string) => void; filter: Set<VersionStatus> }) {
  const kids = useMemo(() => {
    const m = new Map<string | null, Version[]>()
    for (const v of versions) m.set(v.parent_id, [...(m.get(v.parent_id) ?? []), v])
    return m
  }, [versions])
  const rows: { v: Version; depth: number }[] = []
  const walk = (id: string | null, depth: number) => (kids.get(id) ?? []).forEach((v) => { rows.push({ v, depth }); walk(v.id, depth + 1) })
  walk(null, 0)
  return (
    <ol className="flex flex-col gap-1">
      {rows.map(({ v, depth }) => {
        const m = v.metrics && 'stress' in v.metrics ? v.metrics.harsh0?.median : undefined
        return (
          <li key={v.id} style={{ paddingLeft: depth * 18 }} className={filter.has(v.status) ? '' : 'opacity-35'}>
            <button type="button" onClick={() => onSel(v.id)} aria-current={v.id === sel ? 'true' : undefined}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors
                focus-visible:outline-2 focus-visible:outline-focus ${v.id === sel ? 'bg-accent-soft' : 'hover:bg-default'}`}>
              {depth > 0 && <span className="text-muted" aria-hidden>└→</span>}
              <span className="num text-sm font-semibold">{v.id}</span>
              <VersionStatusChip s={v.status} />
              {v.current && <Rocket className="size-3.5 text-accent-soft-foreground" aria-label="сейчас в agent.py" />}
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{v.kind === 'baseline' ? 'baseline' : v.diff.map((d) => d.key).join(', ')}</span>
              <span className="num text-xs" title="медиана в жёстких мирах (keep 0)">{m == null ? '' : money(m)}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function StrategyCard({ v, s }: { v: Version; s: LabState }) {
  const full = useVersion(v)
  const parent = useVersion(s.versions.find((x) => x.id === v.parent_id))
  const [steps, setSteps] = useState('1')
  const [fam, setFam] = useState<Family>('harsh_0')
  const mine = worldNets(full, fam), theirs = worldNets(parent, fam)
  const delta = Object.keys(mine).map(Number).filter((k) => k in theirs).map((seed) => ({ seed, d: mine[seed] - theirs[seed] }))
  const wins = delta.filter((x) => x.d > 0).length, loses = delta.filter((x) => x.d < 0).length

  return (
    <Card className="gap-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="num text-xl font-semibold">{v.id}</h3>
            <VersionStatusChip s={v.status} />
            {v.current && <Chip size="sm" color="success" variant="soft" className="gap-1"><Rocket className="size-3" aria-hidden />сейчас в agent.py</Chip>}
            <Chip size="sm" variant="soft">{v.kind} · {WHO[v.created_by]}</Chip>
          </div>
          <p className="text-sm">{v.hypothesis || '—'}</p>
          <p className="num text-xs text-muted">
            parent {v.parent_id ?? '—'} · commit {v.commit_hash ?? '—'} · prompt {v.prompt_hash} · config {v.config_hash}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" isDisabled={v.status === 'evaluating'} onPress={() => s.act(lab.evaluate(v.id))}>
            <Play className="size-3.5" aria-hidden />Прогнать тесты
          </Button>
          <ToggleButtonGroup aria-label="Шагов ремедиации" selectionMode="single" disallowEmptySelection size="sm"
            selectedKeys={[steps]} onSelectionChange={(k) => setSteps(String([...k][0]))}>
            {['1', '2', '3'].map((x) => <ToggleButton key={x} id={x}>{x}</ToggleButton>)}
          </ToggleButtonGroup>
          <Button size="sm" variant="secondary" isDisabled={v.status === 'evaluating'} onPress={() => s.act(lab.remediate(v.id, Number(steps)))}>
            <Wand2 className="size-3.5" aria-hidden />Авто-исправить
          </Button>
          <Button size="sm" variant="primary" isDisabled={v.status !== 'candidate'} onPress={() => s.act(lab.promote(v.id))}>
            <Rocket className="size-3.5" aria-hidden />Promote
          </Button>
        </div>
      </div>
      {s.pending > 0 && <p className="text-xs text-muted">В очереди задач: {s.pending}. Матрица — около 10 секунд на версию.</p>}

      <div className="grid gap-4 md:grid-cols-3">
        <Fact title="Почему выбрана">{v.rationale || '—'}</Fact>
        <Fact title="Ожидаемый эффект">{v.expected_benefit || '—'}</Fact>
        <Fact title="Что изменено от родителя">
          {v.diff.length ? <span className="flex flex-col gap-1">{v.diff.map((d) => <DiffLine key={d.key} d={d} />)}</span> : 'ничего — это baseline'}
          {v.rejected_changes.length > 0 && <span className="mt-1 block text-xs text-danger">отклонено: {v.rejected_changes.join('; ')}</span>}
        </Fact>
      </div>

      {v.gate && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${v.gate.passed ? 'border-success/40' : 'border-danger/40'}`}>
          <b>Benchmark gate {v.gate.vs ? `против ${v.gate.vs}` : '(родитель не оценён — только must-have)'}:</b>{' '}
          {v.gate.passed ? 'пройден' : v.gate.reasons.join('; ')}
        </div>
      )}
      {v.error && <pre className="num overflow-x-auto rounded-xl bg-default p-3 text-xs text-danger">{v.error}</pre>}

      {v.tests.length > 0 ? (
        <DataTable<Test> label="Матрица тестов" rows={v.tests} rowKey={(t) => t.name}
          cols={[
            { key: 'title', label: 'Тест', render: (t) => (
              <span className="flex min-w-56 flex-col">
                <span className="font-medium">{t.title}</span>
                <span className="text-xs text-muted">{t.detail.split('\n')[0]}</span>
                {t.stats.median == null && Object.keys(t.stats).length > 0 && <span className="num text-xs text-muted">{statLine(t)}</span>}
              </span>
            ) },
            { key: 'must', label: 'Must-have', render: (t) => (t.must ? 'да' : '—') },
            { key: 'ok', label: 'Итог', render: (t) => <TestChip passed={t.passed} must={t.must} />, sort: (t) => Number(t.passed) },
            { key: 'med', label: 'Медиана', num: true, render: (t) => (t.stats.median == null ? '—' : t.name === 'runtime' ? `${fmt(t.stats.median, 2)} с` : money(t.stats.median)) },
            { key: 'mm', label: 'Мин / макс', num: true, render: (t) => (t.stats.min == null || t.name === 'runtime' ? '—' : `${money(t.stats.min)} / ${money(t.stats.max)}`) },
            { key: 'pos', label: 'В плюс', num: true, render: (t) => (t.stats.positive == null ? '—' : `${t.stats.positive}/${t.stats.n}`) },
          ]} />
      ) : v.status !== 'evaluating' && <p className="text-sm text-muted">Версия ещё не тестировалась — нажми «Прогнать тесты».</p>}

      {v.metrics && 'stress' in v.metrics && (
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Fact title="Пилотов (среднее)">{fmt(v.metrics.pilots_mean, 1)} · {money(v.metrics.pilot_cost_mean)}</Fact>
          <Fact title="Пилотов в плюс">{v.metrics.pilot_hit_rate == null ? '—' : `${fmt(100 * v.metrics.pilot_hit_rate)}%`}</Fact>
          <Fact title="Отброшенных кампаний">{v.metrics.invalid}</Fact>
          <Fact title="Время прогона (макс)">{fmt(v.metrics.runtime_max, 2)} с</Fact>
        </div>
      )}

      {delta.length > 0 && (
        <Section icon={FlaskConical} title={`Где выигрывает и где проигрывает относительно ${v.parent_id}`}
          desc={`Δ net по мирам: лучше в ${wins}, хуже в ${loses}, без изменений в ${delta.length - wins - loses}`} className="border border-border shadow-none"
          action={<FamilyToggle value={fam} onChange={setFam} />}>
          <div className="h-48">
            <ResponsiveContainer>
              <BarChart data={delta} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="seed" stroke="var(--axis)" tick={{ fontSize: 11 }} tickFormatter={(x) => `мир ${x}`} />
                <YAxis stroke="var(--axis)" tick={{ fontSize: 11 }} width={64} tickFormatter={(x) => money(x)} />
                <ReferenceLine y={0} stroke="var(--axis)" />
                <Tooltip cursor={{ fill: 'var(--grid)', opacity: 0.4 }} formatter={(x) => money(Number(x))} labelFormatter={(x) => `мир ${x}`} />
                <Bar dataKey="d" name="Δ net" radius={[4, 4, 0, 0]}>
                  {delta.map((x) => <Cell key={x.seed} fill={x.d >= 0 ? 'var(--pos)' : 'var(--neg)'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}
    </Card>
  )
}

export function FamilyToggle({ value, onChange }: { value: Family; onChange: (f: Family) => void }) {
  return (
    <ToggleButtonGroup aria-label="Семейство миров" selectionMode="single" disallowEmptySelection size="sm"
      selectedKeys={[value]} onSelectionChange={(k) => onChange([...k][0] as Family)}>
      {FAMILIES.map((f) => <ToggleButton key={f.test} id={f.test}>{f.label}</ToggleButton>)}
    </ToggleButtonGroup>
  )
}

const statLine = (t: Test) =>
  Object.entries(t.stats).map(([k, x]) => `${k}: ${fmt(x, k.includes('cost') ? 0 : 2)}`).join(' · ') || '—'

function Fact({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-default/60 px-3 py-2.5">
      <span className="text-xs font-medium text-muted">{title}</span>
      <span className="text-sm">{children}</span>
    </div>
  )
}

// Policy engine: новая версия = родитель + изменённые разрешённые настройки
function NewVersion({ parent, s }: { parent: Version; s: LabState }) {
  const [targets, setTargets] = useState<Targets>()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [hyp, setHyp] = useState('')
  const [err, setErr] = useState<string>()
  useEffect(() => { lab.targets().then(setTargets) }, [])
  useEffect(() => { setDraft({}); setErr(undefined) }, [parent.id])
  if (!targets) return null
  const changed = Object.fromEntries(Object.entries(draft).filter(([k, x]) => x !== parent.config[k]))
  const groups = Object.entries(targets.targets).reduce<Record<string, [string, Target][]>>((m, e) => ({ ...m, [e[1].group]: [...(m[e[1].group] ?? []), e] }), {})
  const submit = () => {
    setErr(undefined)
    lab.create(parent.id, changed, hyp).then((v) => { s.setSel(v.id); setDraft({}); setHyp(''); s.refresh() }, (e) => setErr(String(e)))
  }
  return (
    <Section icon={SlidersHorizontal} title={`Новая версия от ${parent.id} · policy engine`}
      desc="Можно менять только разрешённые зоны. Значения клипуются по границам, новая версия сразу уходит в матрицу тестов"
      action={
        <Button size="sm" variant="primary" isDisabled={!Object.keys(changed).length} onPress={submit}>
          <Sparkles className="size-3.5" aria-hidden />Создать и протестировать ({Object.keys(changed).length})
        </Button>
      }>
      {err && <p className="text-sm text-danger">{err}</p>}
      <input value={hyp} onChange={(e) => setHyp(e.target.value)} placeholder="Гипотеза: что должно улучшиться и почему"
        className="h-10 rounded-xl border border-border bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-focus" />
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(groups).map(([g, items]) => (
          <fieldset key={g} className="flex flex-col gap-3">
            <legend className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{g}</legend>
            {items.map(([k, t]) => {
              const cur = k in draft ? draft[k] : parent.config[k]
              const set = (x: unknown) => setDraft({ ...draft, [k]: x })
              const dirty = k in changed
              return (
                <label key={k} className="flex flex-col gap-1 text-sm">
                  <span className="flex items-center justify-between gap-2">
                    <span className={`num text-xs font-semibold ${dirty ? 'text-accent-soft-foreground' : ''}`}>{k}{dirty && ' •'}</span>
                    {t.min != null && <span className="num text-xs text-muted">{t.min}…{t.max}</span>}
                  </span>
                  {t.type === 'bool' ? (
                    <Switch isSelected={Boolean(cur)} onChange={set} aria-label={k}><Switch.Control><Switch.Thumb /></Switch.Control></Switch>
                  ) : t.type === 'choice' ? (
                    <select value={String(cur)} onChange={(e) => set(e.target.value)} className={FIELD}>
                      {t.choices!.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  ) : t.type === 'str' ? (
                    <textarea value={String(cur)} maxLength={t.max_len} onChange={(e) => set(e.target.value)} rows={2} className={`${FIELD} h-auto py-2`} />
                  ) : (
                    <input type="number" value={String(cur)} min={t.min} max={t.max} step={t.type === 'int' ? 1 : 0.01}
                      onChange={(e) => set(e.target.value === '' ? cur : Number(e.target.value))} className={`${FIELD} num`} />
                  )}
                  <span className="text-xs text-muted">{t.desc}</span>
                </label>
              )
            })}
          </fieldset>
        ))}
      </div>
    </Section>
  )
}
const FIELD = 'h-9 rounded-lg border border-border bg-surface px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-focus'
