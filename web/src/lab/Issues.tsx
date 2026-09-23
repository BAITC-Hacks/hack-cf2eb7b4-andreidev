import { Button, Card, Chip } from '@heroui/react'
import { Bug, CircleCheck, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { lab, type Targets } from '../api'
import { HowTo, SeverityChip, VersionStatusChip } from '../ui'
import type { LabState } from './useLab'

export default function Issues({ s }: { s: LabState }) {
  const v = s.selected
  const [t, setT] = useState<Targets>()
  useEffect(() => { lab.targets().then(setT) }, [])
  const parent = s.versions.find((x) => x.id === v?.parent_id)
  const resolved = (parent?.issues ?? []).filter((i) => !v?.issues.some((j) => j.code === i.code))

  return (
    <>
      <HowTo>
        Детекторы читают результаты всех прогонов матрицы и ищут <b>инженерные проблемы</b>, а не просто низкие числа.
        У каждой проблемы есть <b>доказательство</b> и шаблоны патчей, которые её адресуют. «Исправить» запускает один шаг
        авто-ремедиации: LLM через privacy gateway выбирает ограниченный патч (без ключа выбирается шаблон), получается новая версия,
        она проходит матрицу и gate.
      </HowTo>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Версия:</span>
        <select value={v?.id} onChange={(e) => s.setSel(e.target.value)} aria-label="Версия"
          className="num h-9 rounded-lg border border-border bg-surface px-2.5 text-sm">
          {s.versions.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.status}</option>)}
        </select>
        {v && <VersionStatusChip s={v.status} />}
        {v && v.issues.length > 0 && (
          <Button size="sm" variant="primary" className="ml-auto" isDisabled={v.status === 'evaluating' || s.pending > 0}
            onPress={() => s.act(lab.remediate(v.id, 1))}>
            <Wand2 className="size-3.5" aria-hidden />Исправить (1 шаг)
          </Button>
        )}
      </div>

      {v && !v.tests.length && <Card className="p-5 text-sm text-muted">Версия не тестировалась — issues появятся после матрицы тестов.</Card>}
      {v && v.tests.length > 0 && !v.issues.length && (
        <Card className="flex-row items-center gap-3 p-5 text-sm"><CircleCheck className="size-5 text-success" aria-hidden />Детекторы ничего не нашли.</Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {v?.issues.map((i) => (
          <Card key={i.code} className="gap-3 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-8 place-items-center rounded-lg bg-default"><Bug className="size-4" aria-hidden /></span>
              <span className="font-semibold">{i.title}</span>
              <SeverityChip s={i.severity} />
            </div>
            <code className="num text-xs text-muted">{i.code}</code>
            <p className="rounded-xl bg-default/60 px-3 py-2 text-sm"><span className="text-muted">Доказательство: </span>{i.evidence}</p>
            {i.templates.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted">Патчи:</span>
                {i.templates.map((id) => <Chip key={id} size="sm" variant="soft">{t?.templates[id]?.title ?? id}</Chip>)}
              </div>
            )}
          </Card>
        ))}
      </div>

      {resolved.length > 0 && (
        <p className="text-sm text-muted">
          По сравнению с {parent!.id} ушли: {resolved.map((i) => <b key={i.code} className="num mr-2 font-medium" style={{ color: 'var(--pos)' }}>{i.code}</b>)}
        </p>
      )}
    </>
  )
}
