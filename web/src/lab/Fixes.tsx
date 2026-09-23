import { Button, Card, Chip } from '@heroui/react'
import { Brain, FileCode, Wrench } from 'lucide-react'
import { DiffLine, HowTo, VersionStatusChip, money } from '../ui'
import type { LabState } from './useLab'
import { WHO } from './Versions'

export default function Fixes({ s, open }: { s: LabState; open: (id: string) => void }) {
  const fixes = s.versions.filter((v) => v.created_by === 'llm' || v.created_by === 'template').reverse()
  const byId = new Map(s.versions.map((v) => [v.id, v]))
  return (
    <>
      <HowTo>
        Все предложения авто-ремедиации. Патч может трогать только <b>разрешённые зоны</b> <code>agent.py</code>: константы,
        флаги эвристик, веса экспертов, коэффициенты скоринга, промпт. <b>Принят</b> — прошёл gate (candidate или promoted),
        <b> отклонён</b> — не прошёл, причины указаны.
      </HowTo>
      {!fixes.length && <Card className="p-5 text-sm text-muted">Пока нет предложений — нажми «Авто-исправить» на экране «Версии» или «Issues».</Card>}
      <div className="flex flex-col gap-4">
        {fixes.map((v) => {
          const p = v.parent_id ? byId.get(v.parent_id) : undefined
          const med = (x?: typeof v) => (x?.metrics && 'stress' in x.metrics ? x.metrics.stress.median : undefined)
          const d = med(v) != null && med(p) != null ? med(v)! - med(p)! : undefined
          const accepted = v.status === 'candidate' || v.status === 'promoted'
          return (
            <Card key={v.id} className="gap-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-default">
                  {v.created_by === 'llm' ? <Brain className="size-4" style={{ color: 'var(--series-2)' }} aria-hidden /> : <Wrench className="size-4" aria-hidden />}
                </span>
                <span className="num font-semibold">{v.parent_id} → {v.id}</span>
                <Chip size="sm" variant="soft">{WHO[v.created_by]}</Chip>
                <VersionStatusChip s={v.status} />
                {v.status !== 'evaluating' && v.status !== 'draft' && (
                  <Chip size="sm" color={accepted ? 'success' : 'danger'} variant="soft">{accepted ? 'принят' : 'отклонён'}</Chip>
                )}
                {d != null && <span className="num ml-auto text-sm" style={{ color: d >= 0 ? 'var(--pos)' : 'var(--neg)' }}>медиана {d >= 0 ? '+' : ''}{money(d)}</span>}
              </div>
              <p className="font-medium">{v.hypothesis}</p>
              <div className="grid gap-3 text-sm md:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1 text-xs text-muted"><FileCode className="size-3" aria-hidden />agent.py</span>
                  {v.diff.map((x) => <DiffLine key={x.key} d={x} />)}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">Ожидаемый эффект</span>
                  <span>{v.expected_benefit || '—'}</span>
                  {v.issues_addressed.length > 0 && <span className="num text-xs text-muted">{v.issues_addressed.join(', ')}</span>}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">Результат gate</span>
                  <span>{v.gate ? (v.gate.passed ? 'пройден' : v.gate.reasons.join('; ')) : 'ещё тестируется'}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onPress={() => open(v.id)}>Открыть карточку версии</Button>
              </div>
            </Card>
          )
        })}
      </div>
    </>
  )
}
