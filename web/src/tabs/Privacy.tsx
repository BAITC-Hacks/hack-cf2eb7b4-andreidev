import { Accordion, Card, Chip } from '@heroui/react'
import { EyeOff, FileSearch, Filter, ListChecks, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { lab, type AuditRec, type Run } from '../api'
import { HowTo, Section, fmt } from '../ui'

const MODES: Record<string, string> = {
  aggregate_only: 'медианы полей allowlist по ячейкам, ячейки меньше K_MIN — без статистик',
  synthetic_only: 'медианы с шумом ±20%, размеры ячеек округлены до 50',
  debug_safe: 'ни одного числа об абонентах: только ключи ячеек и справочник тарифов',
}

export default function Privacy({ run }: { run: Run }) {
  const { privacy: p, llm_audit } = run
  const [labAudit, setLabAudit] = useState<AuditRec[]>([])
  useEffect(() => { lab.audit().then(setLabAudit, () => setLabAudit([])) }, [])
  if (!p) return <HowTo>Бэкенд запущен со старым <code>server.py</code> — перезапусти uvicorn, чтобы увидеть privacy gateway.</HowTo>
  const guarantees = [
    { icon: EyeOff, title: 'Сырые данные не отправляются', text: `${p.redacted_fields.length} полей профиля, включая ID_NUMBER, скрыты всегда` },
    { icon: Filter, title: 'Только агрегаты', text: `в LLM уходят ячейки «тариф × сегмент» и медианы ${p.allowlist.length} полей` },
    { icon: ListChecks, title: 'Allowlist до вызова', text: 'поле вне allowlist → запрос отклоняется до отправки' },
    { icon: FileSearch, title: 'Аудит каждого промпта', text: 'промпт, ответ, принятое и отклонённое с причинами' },
  ]
  return (
    <>
      <HowTo>
        Любой вызов LLM идёт через <b>privacy gateway</b> в <code>agent.py</code>: сырые данные → агрегация и редакция → безопасный JSON →
        запрос к LLM → валидация ответа. Режим сейчас: <b>{p.mode}</b>, то есть {MODES[p.mode] ?? p.mode}. Ниже — все запросы этого прогона и
        запросы авто-ремедиации из лаборатории.
      </HowTo>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {guarantees.map((g) => (
          <Card key={g.title} className="gap-2 p-4">
            <span className="grid size-8 place-items-center rounded-lg bg-accent-soft"><g.icon className="size-4 text-accent-soft-foreground" aria-hidden /></span>
            <span className="font-medium">{g.title}</span>
            <span className="text-sm text-muted">{g.text}</span>
          </Card>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section icon={ShieldCheck} title="Allowlist: что может увидеть модель" desc={`Статистики только для ячеек от ${p.k_min} абонентов`}>
          <div className="flex flex-wrap gap-1.5">
            {['cur', 'seg', 'n', ...p.allowlist, 'tariffs_csv'].map((f) => <Chip key={f} size="sm" color="success" variant="soft" className="num">{f}</Chip>)}
          </div>
        </Section>
        <Section icon={EyeOff} title="Скрытые поля" desc="Никогда не попадают в промпт">
          <div className="flex flex-wrap gap-1.5">
            {p.redacted_fields.map((f) => <Chip key={f} size="sm" variant="soft" className="num line-through decoration-muted">{f}</Chip>)}
          </div>
        </Section>
      </div>
      <Section icon={FileSearch} title="Prompt inspector" desc={`${llm_audit.length} запросов в этом прогоне · ${labAudit.length} в ремедиации`}>
        {!llm_audit.length && !labAudit.length && (
          <p className="text-sm text-muted">
            {run.params.llm ? 'LLM не вызывался: нет OPENAI_API_KEY или эксперт выключен.' : 'LLM-эксперт выключен в параметрах запуска.'}
          </p>
        )}
        <Accordion variant="surface" className="-mx-1">
          {[...llm_audit, ...labAudit].map((r, i) => (
            <Accordion.Item key={i} id={String(i)}>
              <Accordion.Heading>
                <Accordion.Trigger className="text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <b>{r.task}</b><code className="num text-xs text-muted">{r.prompt_sha}</code>
                    {r.model && <code className="num text-xs text-muted">{r.model}</code>}
                    <Chip size="sm" variant="soft">{r.mode}</Chip>
                    {r.error ? <Chip size="sm" color="danger" variant="soft">ошибка</Chip>
                      : <Chip size="sm" color="success" variant="soft">принято {r.parsed.length} · отклонено {r.rejected.length}</Chip>}
                    {r.latency != null && <span className="num text-xs text-muted">{fmt(r.latency, 1)} с</span>}
                    {r.parent_id && <span className="num text-xs text-muted">для {r.parent_id}</span>}
                  </span>
                  <Accordion.Indicator />
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body className="flex flex-col gap-3"><Inspect r={r} /></Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      </Section>
    </>
  )
}

function Inspect({ r }: { r: AuditRec }) {
  const [instruction, ctx] = r.prompt.split('\n\nКонтекст (JSON):\n')
  let pretty = ctx
  try { pretty = JSON.stringify(JSON.parse(ctx), null, 1) } catch { /* показываем как есть */ }
  return (
    <>
      <Block title="1. Безопасный контекст (safe JSON)" hint={`поля: ${r.fields_sent.join(', ')}`}>{pretty}</Block>
      <Block title="2. Инструкция модели">{instruction}</Block>
      <Block title="3. Ответ модели">{r.error ?? r.response ?? '—'}</Block>
      <Block title={`4. Принято после валидации · ${r.parsed.length}`}>{r.parsed.map((x) => JSON.stringify(x)).join('\n') || '—'}</Block>
      <Block title={`5. Отклонено · ${r.rejected.length}`}>{r.rejected.map((x) => `${x.reason}: ${JSON.stringify(x.row)}`).join('\n') || '—'}</Block>
    </>
  )
}

function Block({ title, hint, children }: { title: string; hint?: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium">{title}{hint && <span className="ml-2 font-normal text-muted">{hint}</span>}</span>
      <pre className="num max-h-72 overflow-auto rounded-lg bg-default p-3 text-[11px] leading-relaxed whitespace-pre-wrap">{children}</pre>
    </div>
  )
}
