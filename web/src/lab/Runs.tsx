import { ToggleButton, ToggleButtonGroup } from '@heroui/react'
import { History } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { lab, type LabRun } from '../api'
import { DataTable, HowTo, Picker, Section, TestChip, fmt, money } from '../ui'
import type { LabState } from './useLab'

type Row = { version: string } & LabRun
const TESTS = ['local_single', 'local_10', 'stress_10', 'harsh_0', 'harsh_50', 'llm_disabled']
const WORLD = { mock: 'мок', stress: 'стресс', harsh0: 'жёсткий 0', harsh50: 'жёсткий 0.5' }

export default function Runs({ s }: { s: LabState }) {
  const [rows, setRows] = useState<Row[]>([])
  const [ver, setVer] = useState('all')
  const [tests, setTests] = useState(new Set(TESTS))
  // перечитываем, когда какая-то версия дотестировалась
  const stamp = s.versions.map((v) => v.evaluated_at ?? '').join()
  useEffect(() => { lab.runs().then(setRows) }, [stamp])
  const shown = useMemo(() => rows.filter((r) => (ver === 'all' || r.version === ver) && tests.has(r.test)), [rows, ver, tests])
  const failed = shown.filter((r) => r.net <= 0 || r.invalid || r.crash || r.fallback).length

  return (
    <>
      <HowTo>
        Все прогоны агента всех версий: мир (мок, стресс или жёсткий — где история бесполезна), seed, был ли включён LLM, результат и служебные метрики.
        <b> Сбой</b> — прогон в минусе, с отброшенными кампаниями, падением или fallback. Лог прогона раскрывается в последней колонке.
      </HowTo>
      <Section icon={History} title={`Прогоны · ${shown.length}`} desc={`со сбоем: ${failed}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Picker label="Версия" value={ver} onChange={setVer} className="w-40"
              options={[['all', 'все версии'], ...s.versions.map((v): [string, string] => [v.id, v.id])]} />
            <ToggleButtonGroup aria-label="Тест" selectionMode="multiple" size="sm" selectedKeys={tests}
              onSelectionChange={(k) => setTests(new Set(k as Set<string>))}>
              {TESTS.map((t) => <ToggleButton key={t} id={t}>{t}</ToggleButton>)}
            </ToggleButtonGroup>
          </div>
        }>
        <DataTable<Row> label="Прогоны" rows={shown} pageSize={50} rowKey={(r) => `${r.version}-${r.test}-${r.seed}`}
          initialSort={{ column: 'version', direction: 'descending' }}
          cols={[
            { key: 'version', label: 'Версия', render: (r) => <b className="num">{r.version}</b>, sort: (r) => r.version },
            { key: 'test', label: 'Тест', render: (r) => r.test, sort: (r) => r.test },
            { key: 'world', label: 'Мир', render: (r) => `${WORLD[r.world]} · ${r.seed}`, sort: (r) => r.world + r.seed },
            { key: 'llm', label: 'LLM', render: (r) => (r.llm ? 'вкл' : 'выкл') },
            { key: 'net', label: 'Net', num: true, sort: (r) => r.net, render: (r) => <span style={{ color: r.net > 0 ? 'var(--pos)' : 'var(--neg)' }}>{money(r.net)}</span> },
            { key: 'pilots', label: 'Пилоты', num: true, sort: (r) => r.pilots, render: (r) => `${r.pilots} · ${money(r.pilot_cost)}` },
            { key: 'camps', label: 'Кампании', num: true, render: (r) => `${r.n_campaigns}${r.invalid ? ` (−${r.invalid})` : ''}` },
            { key: 'rt', label: 'Время', num: true, sort: (r) => r.runtime, render: (r) => `${fmt(r.runtime, 2)} с` },
            { key: 'ok', label: 'Статус', sort: (r) => Number(r.net > 0 && !r.invalid && !r.crash && !r.fallback), render: (r) =>
              r.crash ? <span className="text-xs text-danger">{r.crash}</span>
                : <TestChip passed={r.net > 0 && !r.invalid && !r.fallback} must /> },
            { key: 'log', label: 'Лог', render: (r) => (
              <details className="max-w-md">
                <summary className="cursor-pointer text-xs text-muted">{r.log.length} строк{r.fallback ? ' · fallback' : ''}</summary>
                <pre className="num mt-1 max-h-64 overflow-auto rounded-lg bg-default p-2 text-[11px] leading-relaxed whitespace-pre-wrap">{r.log.join('\n')}</pre>
              </details>
            ) },
          ]} />
      </Section>
    </>
  )
}
