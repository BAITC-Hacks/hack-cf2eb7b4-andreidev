import { Alert, Button, Chip } from '@heroui/react'
import { Database, FileUp } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchData, uploadData, type DataKind, type DataSummary, type Role } from '../api'
import { DataTable, HowTo, Picker, Section, fmt } from '../ui'

const KIND: Record<DataKind, { label: string; hint: string; admin?: boolean }> = {
  campaign_results: { label: 'Итоги кампаний', hint: 'cur, seg, target, channel, n, lift_ratio (+ world, source) → база знаний' },
  customer_profile: { label: 'Аудитория', hint: 'новая база абонентов, те же колонки, что в customer_profile.csv', admin: true },
  change_tariff: { label: 'История смен тарифа', hint: 'из неё строится prior', admin: true },
  traffic: { label: 'Трафик', hint: 'потребление по месяцам, поправка prior на пакет', admin: true },
  dict_tariff: { label: 'Справочник тарифов', hint: 'цены и пакеты', admin: true },
}
const SOURCE = { original: 'из пакета', upload: 'загружен', db: 'Postgres' } as const

export default function Data({ role, onChanged }: { role: Role; onChanged: () => void }) {
  const [data, setData] = useState<DataSummary>()
  const [kind, setKind] = useState<DataKind>('campaign_results')
  const [file, setFile] = useState<File>()
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>()
  const [ok, setOk] = useState<string>()
  const load = useCallback(() => { fetchData().then(setData, (e) => setErrors([String(e)])) }, [])
  useEffect(load, [load])

  const upload = () => {
    if (!file) return
    setBusy(true)
    setErrors(undefined)
    setOk(undefined)
    uploadData(kind, file)
      .then((r) => { setOk(`${KIND[kind].label}: принято строк — ${fmt(r.rows)}`); load(); onChanged() },
        (e: Error) => setErrors((e.cause as string[] | undefined) ?? [e.message]))
      .finally(() => setBusy(false))
  }
  const kinds = (Object.keys(KIND) as DataKind[]).filter((k) => !KIND[k].admin || role === 'admin')
  const kb = data?.feedback ?? []

  return (
    <>
      <HowTo>
        История описывает <b>другую выборку</b>, а пилоты и итоги кампаний — эту же аудиторию. Всё, что попало в
        <b> базу знаний</b>, агент учитывает на старте следующего прогона как уже проведённые пилоты: уверенные гипотезы
        не перепроверяет и тратит пилоты на новые. Сохранить пилоты прогона — кнопка на экране «Пилоты».
        Базовые выгрузки меняет только администратор; сдача (<code>agent.py</code> + <code>submission.csv</code>) всегда считается на исходных данных.
      </HowTo>

      <Section icon={FileUp} title="Загрузить CSV" desc={KIND[kind].hint}>
        <div className="flex flex-wrap items-center gap-2">
          <Picker label="Что загружаем" value={kind} onChange={(v) => setKind(v as DataKind)} className="w-56"
            options={kinds.map((k) => [k, KIND[k].label])} />
          <input type="file" accept=".csv,text/csv" aria-label="CSV-файл" onChange={(e) => setFile(e.target.files?.[0])}
            className="text-sm file:mr-3 file:h-10 file:cursor-pointer file:rounded-xl file:border-0 file:bg-default file:px-3 file:text-sm" />
          <Button variant="primary" isDisabled={!file} isPending={busy} onPress={upload} className="h-10">Загрузить</Button>
        </div>
        {ok && <Alert status="success"><Alert.Content><Alert.Title>{ok}</Alert.Title></Alert.Content></Alert>}
        {errors && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>Файл не принят — ничего не записано</Alert.Title>
              <Alert.Description><ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Section>

      <Section icon={Database} title="База знаний"
        desc="Наблюдения по мирам: мок один на все seed, у каждого стресс-мира своя база — эффекты разных миров не смешиваются">
        {kb.length ? (
          <div className="flex flex-wrap gap-2">
            {kb.map((r) => (
              <Chip key={r.world + r.source} variant="soft">
                <span className="num">{r.world}</span> · {r.source === 'pilot' ? 'пилоты' : 'кампании'} · <span className="num">{fmt(r.rows)}</span>
              </Chip>
            ))}
          </div>
        ) : <p className="text-sm text-muted">Пусто: агент стартует только с истории и LLM.</p>}
      </Section>

      <DataTable label="Датасеты" rows={data?.datasets ?? []} rowKey={(d) => d.kind} cols={[
        { key: 'kind', label: 'Датасет', render: (d) => <span className="font-medium">{KIND[d.kind].label}</span> },
        { key: 'source', label: 'Источник', render: (d) => <Chip size="sm" variant="soft" color={d.source === 'upload' ? 'accent' : 'default'}>{SOURCE[d.source]}</Chip> },
        { key: 'rows', label: 'Строк', num: true, render: (d) => fmt(d.rows), sort: (d) => d.rows },
        { key: 'cols', label: 'Колонок', num: true, render: (d) => d.columns.length },
        { key: 'by', label: 'Последняя загрузка', render: (d) => d.uploaded_at ? `${new Date(d.uploaded_at).toLocaleString('ru')} · ${d.uploaded_by}` : '—' },
      ]} />
    </>
  )
}
