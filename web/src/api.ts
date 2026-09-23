// Формы ответов server.py. Числа могут быть null (inf/nan на бэке).
export type Arm = {
  cur: string; seg: string; target: string; src: string[]
  prior_mu: number; prior_sd: number; post_mu: number; post_sd: number; lcb: number
  n: number; obs: number[]; ei: number; planned: boolean
}
export type Pilot = {
  name: string; cur: string; seg: string; target: string; channel: string; n: number; cost: number
  ratio: number; total: number; base: number; prior_mu: number | null; post_mu: number | null
  post_sd: number | null; decision: 'scale' | 'hold' | 'drop'
}
export type PlanCell = { cur: string; seg: string; n: number; S: number; mu: number; gain: number }
export type Campaign = {
  campaign_name: string; filter_arpu_segment: string; filter_current_tariff: string
  target_tariff: string; channel: string; audience: number; expected_gain: number; expected_cost: number
  cells: PlanCell[]; actual_gross: number; actual_cost: number; actual_contacts: number; caps: string[]
}
export type AudienceCell = { cur: string; seg: string; n: number; S: number; arpu: number }
export type Channel = { cost_per_contact: number; conversion_multiplier: number }
export type Run = {
  params: { seed: number; world: World; llm: boolean; llm_available: boolean }
  limits: {
    total_budget: number; total_contacts: number; total_pilots: number
    budget_after_pilots: number; contacts_after_pilots: number; pilots_left: number; lcb_k: number
  }
  channels: Record<string, Channel>
  tariffs: { tariff_plan_code: string; price_tariff: number; Data_in_PKG: number }[]
  audience: { cells: AudienceCell[]; dist: Record<'data_segment' | 'call_segment', Record<string, Record<string, number>>> }
  arms: Arm[]
  pilots: Pilot[]
  plan: Campaign[]
  score: Record<string, number | string | null>
  log: string[]
  replay: ReplayStep[]
  llm_audit: AuditRec[]
  // нет у старого server.py
  privacy?: { mode: string; allowlist: string[]; k_min: number; redacted_fields: string[] }
}
// Replay: состояние апостериора ячейки до и после каждого пилота
export type ReplayStep = {
  i: number; cur: string; seg: string; target: string; n: number | null; obs: number | null; ei: number
  top_ei: { cur: string; seg: string; target: string; ei: number }[]
  cell: { target: string; src: string[]; planned: boolean; before_mu: number; before_sd: number; after_mu: number; after_sd: number }[]
}
// Запись privacy gateway: что ушло в LLM, что вернулось, что отброшено
export type AuditRec = {
  task: string; mode: string; fields_sent: string[]; redacted_fields: string[]; prompt: string; prompt_sha: string
  response: string | null; error: string | null; latency: number | null
  parsed: Record<string, unknown>[]; rejected: { row: unknown; reason: string }[]; parent_id?: string; at?: string
}
export type Strategies = {
  rows: ({ seed: number } & Record<string, number>)[]
  summary: { name: string; median: number; min: number; positive: number }[]
}
export type World = 'mock' | 'stress'
export type RunParams = { seed: number; world: World; llm: boolean }

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json()
}

// старый server.py (uvicorn без --reload) не отдаёт replay/llm_audit — пустые списки вместо падения UI
export const fetchRun = (p: RunParams) => get<Run>(`/api/run?seed=${p.seed}&world=${p.world}&llm=${p.llm}`)
  .then((r) => ({ ...r, replay: r.replay ?? [], llm_audit: r.llm_audit ?? [] }))
export const fetchStrategies = (runs: number) => get<Strategies>(`/api/strategies?runs=${runs}`)

// ---------- лаборатория версий (lab.py) ----------
export type VersionStatus = 'draft' | 'evaluating' | 'candidate' | 'failed' | 'promoted'
export type Stats = { median?: number; min?: number; max?: number; positive?: number; n?: number } & Record<string, number | undefined>
export type Test = { name: string; title: string; must: boolean; passed: boolean; stats: Stats; detail: string }
export type Issue = { code: string; severity: 'high' | 'medium' | 'low'; title: string; evidence: string; metric: number | null; templates: string[] }
export type Metrics = {
  stress: Stats; harsh0?: Stats; harsh50?: Stats; local: Stats; negative_runs: number; invalid: number; pilots_mean: number; pilot_cost_mean: number
  pilot_hit_rate: number | null; pilot_to_plan: number; diversity: number; overlap: number; runtime_max: number
  expert_share: Record<'prior' | 'llm', number>; llm_used: boolean
}
export type LabCampaign = { name: string; channel: string; target: string; seg: string; n: number; gross: number; cost: number }
export type LabRun = {
  test: string; world: 'mock' | 'stress' | 'harsh0' | 'harsh50'; seed: number; llm: boolean; net: number; n_campaigns: number; invalid: number
  crash: string | null; runtime: number; fallback: boolean; pilots: number; pilot_cost: number; total_contacts: number
  log: string[]; campaigns?: LabCampaign[]; pilot_obs?: number[]
}
export type Version = {
  id: string; parent_id: string | null; created_by: 'human' | 'template' | 'llm' | 'system'; kind: 'baseline' | 'manual' | 'auto'
  created_at: string; commit_hash: string | null; prompt_hash: string; config_hash: string
  config: Record<string, number | string | boolean>; diff: { key: string; from: unknown; to: unknown }[]
  status: VersionStatus; promoted: boolean; promoted_at: string | null; current: boolean; rejected_changes: string[]
  hypothesis: string; rationale: string; expected_benefit: string; issues_addressed: string[]; template: string | null
  tests: Test[]; metrics: Metrics | Record<string, never>; issues: Issue[]
  gate: { passed: boolean; reasons: string[]; vs: string | null } | null
  error?: string; evaluated_at?: string; runs?: LabRun[]; audit?: AuditRec[]
}
export type Target = {
  type: 'float' | 'int' | 'bool' | 'choice' | 'str'; group: string; desc: string
  min?: number; max?: number; choices?: string[]; max_len?: number
}
export type Targets = {
  targets: Record<string, Target>; must: string[]; thresholds: Record<string, number>
  templates: Record<string, { title: string; issues: string[] }>
}

const post = <T,>(url: string, body?: unknown) => get<T>(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
})
export const lab = {
  versions: () => get<{ versions: Version[]; pending: number }>('/api/lab/versions'),
  version: (id: string) => get<Version>(`/api/lab/versions/${id}`),
  targets: () => get<Targets>('/api/lab/targets'),
  runs: () => get<({ version: string } & LabRun)[]>('/api/lab/runs'),
  audit: () => get<AuditRec[]>('/api/lab/audit'),
  create: (parent_id: string, changes: Record<string, unknown>, hypothesis: string) =>
    post<Version>('/api/lab/versions', { parent_id, changes, hypothesis }),
  evaluate: (id: string) => post(`/api/lab/versions/${id}/evaluate`),
  remediate: (id: string, steps = 1) => post(`/api/lab/versions/${id}/remediate?steps=${steps}`),
  promote: (id: string) => post<Version>(`/api/lab/versions/${id}/promote`),
}
