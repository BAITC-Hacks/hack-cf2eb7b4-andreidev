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
}
export type Strategies = {
  rows: ({ seed: number } & Record<string, number>)[]
  summary: { name: string; median: number; min: number; positive: number }[]
}
export type World = 'mock' | 'stress'
export type RunParams = { seed: number; world: World; llm: boolean }

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json()
}

export const fetchRun = (p: RunParams) => get<Run>(`/api/run?seed=${p.seed}&world=${p.world}&llm=${p.llm}`)
export const fetchStrategies = (runs: number) => get<Strategies>(`/api/strategies?runs=${runs}`)
