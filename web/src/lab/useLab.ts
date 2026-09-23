import { useCallback, useEffect, useState } from 'react'
import { lab, type Version } from '../api'

// Общее состояние лаборатории: список версий + выбранная версия. Пока что-то тестируется — опрос раз в 2 с.
export function useLab(enabled = true) {
  const [data, setData] = useState<{ versions: Version[]; pending: number }>()
  const [error, setError] = useState<string>()
  const [sel, setSel] = useState<string>()
  const refresh = useCallback(() => lab.versions().then((d) => { setData(d); setError(undefined) }, (e) => setError(String(e))), [])
  useEffect(() => { if (enabled) refresh() }, [refresh, enabled])
  const versions = data?.versions ?? []
  const busy = !!data && (data.pending > 0 || versions.some((v) => v.status === 'evaluating'))
  useEffect(() => {
    if (!busy) return
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [busy, refresh])
  // действие → сразу обновить список, дальше подхватит опрос
  const act = useCallback((p: Promise<unknown>) => p.then(refresh, (e) => setError(String(e))), [refresh])
  const selected = versions.find((v) => v.id === sel) ?? versions.find((v) => v.current) ?? versions.at(-1)
  return { versions, pending: data?.pending ?? 0, busy, error, loaded: !!data, refresh, act, selected, setSel }
}
export type LabState = ReturnType<typeof useLab>

// Полная версия (с runs) — перечитывается, когда версия дотестировалась
export function useVersion(v: Version | undefined) {
  const [full, setFull] = useState<Version>()
  const stamp = v ? `${v.id}:${v.status}:${v.evaluated_at ?? ''}` : ''
  useEffect(() => {
    if (!v) return
    let live = true
    lab.version(v.id).then((f) => live && setFull(f))
    return () => { live = false }
  }, [stamp]) // eslint-disable-line react-hooks/exhaustive-deps
  return full?.id === v?.id ? full : undefined
}

// Семейства миров, как WORLDS в lab.py; первое — главное для gate (история бесполезна, как в боевой среде)
export const FAMILIES = [
  { test: 'harsh_0', key: 'harsh0', label: 'Жёсткие · keep 0' },
  { test: 'harsh_50', key: 'harsh50', label: 'Жёсткие · keep 0.5' },
  { test: 'stress_10', key: 'stress', label: 'Стресс' },
] as const
export type Family = (typeof FAMILIES)[number]['test']

export const worldNets = (v: Version | undefined, test: Family) =>
  Object.fromEntries((v?.runs ?? []).filter((r) => r.test === test).map((r) => [r.seed, r.net])) as Record<number, number>
