"""
API для UI (web/): запускает агента в мок- или стресс-мире и отдаёт его внутреннее состояние.

    pip install fastapi uvicorn
    uvicorn server:app --port 8000
    python3 server.py                  # self-check без сервера

В сдачу не входит; agent.py не меняет — только наблюдает через подкласс.
"""

import functools
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, Query

_env_file = Path(__file__).parent / ".env"
if _env_file.exists():  # ponytail: без python-dotenv, формат KEY=VALUE
    for line in _env_file.read_text().splitlines():
        k, _, v = line.partition("=")
        if k.strip() and not k.startswith("#"):
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

import agent  # noqa: E402
import agent_template  # noqa: E402
import stress_eval as se  # noqa: E402  (грузит profile / dict_tariff / history)
from environment import make_environment  # noqa: E402
from mock_environment import CHANNELS, MAX_TOTAL_CONTACTS, TOTAL_BUDGET, _mock_fallback, _mock_impact_model  # noqa: E402
from scoring_core import score_campaigns, sanitize_campaigns  # noqa: E402

agent._llm_call = functools.lru_cache(agent._llm_call)  # промпт одинаков для всех seed
app = FastAPI(title="Beeline campaign cockpit")


class Traced(agent.Agent):
    """Тот же агент; запоминает prior и реестр рукавов, чтобы UI мог их показать."""

    def _explore(self, env, cells, arms):
        self.prior = {k: (a["mu"], a["var"]) for k, a in arms.items()}
        self.cells, self.arms = cells, arms
        super()._explore(env, cells, arms)


def _f(x):
    x = float(x)
    return x if math.isfinite(x) else None


def _model(world, seed):
    return se.world(seed) if world == "stress" else _mock_impact_model(se.history)


@functools.lru_cache(maxsize=64)
def run_payload(seed=42, world="mock", llm=True):
    model = _model(world, seed)
    env, internals = make_environment(se.profile, model, se.dict_tariff, CHANNELS, TOTAL_BUDGET,
                                      MAX_TOTAL_CONTACTS, _mock_fallback, seed=seed)
    a = Traced()
    if not llm:
        a.experts = ("prior",)
    camps = sanitize_campaigns(a.act(env), env.tariffs)[:10]
    pilots_raw = internals.executed_pilot_campaigns()

    df = pd.DataFrame(pilots_raw + camps)
    for c in se.COLS:
        if c not in df.columns:
            df[c] = None
    score = score_campaigns(df, se.profile, model, se.dict_tariff, se.profile["predicted_arpu"].sum(), _mock_fallback)

    arms, prior = getattr(a, "arms", {}), getattr(a, "prior", {})
    cells = getattr(a, "cells", {})
    chosen = getattr(a, "_chosen", [])
    planned = {(x["cur"], x["seg"], x["target"]) for x in chosen}
    ei = a._arm_ei(cells, arms) if arms else {}
    lcb = lambda m: m["mu"] - agent.LCB_K * math.sqrt(m["var"])  # noqa: E731

    arm_rows = [{
        "cur": k[0], "seg": k[1], "target": k[2], "src": sorted(m.get("src", ())),
        "prior_mu": _f(prior.get(k, (m["mu"], m["var"]))[0]), "prior_sd": _f(math.sqrt(prior.get(k, (0, m["var"]))[1])),
        "post_mu": _f(m["mu"]), "post_sd": _f(math.sqrt(m["var"])), "lcb": _f(lcb(m)),
        "n": int(m["n"]), "obs": [_f(o) for o in m.get("obs", [])], "ei": _f(ei.get(k, 0.0)),
        "planned": k in planned,
    } for k, m in arms.items()]

    pilots = []
    for r, c in zip(env.pilot_history, pilots_raw):
        k = (c["filter_current_tariff"], c["filter_arpu_segment"], r["target_tariff"])
        m = arms.get(k)
        decision = "scale" if k in planned else "hold" if m and lcb(m) > 0 else "drop"
        pilots.append({
            "name": r["pilot"], "cur": k[0], "seg": k[1], "target": k[2], "channel": r["channel"],
            "n": int(r["n_customers"]), "cost": _f(r["cost"]),
            "ratio": _f(r["observed_lift_ratio"]), "total": _f(r["observed_lift_total"]),
            "base": _f(r["observed_lift_ratio"] / CHANNELS[r["channel"]]["conversion_multiplier"]),
            "prior_mu": _f(prior[k][0]) if k in prior else None,
            "post_mu": _f(m["mu"]) if m else None, "post_sd": _f(math.sqrt(m["var"])) if m else None,
            "decision": decision,
        })

    detail = {d["name"]: d for d in score["campaigns_detail"]}
    plan = []
    for c in camps:
        ch = CHANNELS[c["channel"]]
        curs = str(c.get("filter_current_tariff") or "").split(";")
        xs = [x for x in chosen if x["seg"] == c.get("filter_arpu_segment") and x["target"] == c["target_tariff"]
              and x.get("ch") == c["channel"] and x["cur"] in curs]
        cell_rows = [{"cur": x["cur"], "seg": x["seg"], "n": x["n"], "S": _f(x["S"]), "mu": _f(x["mu"]),
                      "gain": _f(x["mu"] * ch["conversion_multiplier"] * x["S"])} for x in xs]
        n = sum(x["n"] for x in xs)
        d = detail.get(c["campaign_name"], {})
        plan.append({**{k: c.get(k) for k in ("campaign_name", "filter_arpu_segment", "filter_current_tariff",
                                              "target_tariff", "channel")},
                     "audience": n, "expected_gain": _f(sum(r["gain"] for r in cell_rows)),
                     "expected_cost": _f(n * ch["cost_per_contact"]), "cells": cell_rows,
                     "actual_gross": _f(d.get("gross_lift", 0.0)), "actual_cost": _f(d.get("cost", 0.0)),
                     "actual_contacts": int(d.get("n_contacts", 0)),
                     "caps": [k for k in ("capped_at_campaign_limit", "capped_at_reach_budget",
                                          "capped_at_money_budget") if d.get(k)]})

    p = se.profile
    aud = (p.groupby(["current_tariff", "arpu_segment"])
           .agg(n=("ID_NUMBER", "size"), S=("predicted_arpu", "sum"), arpu=("ARPU_3m_avg", "mean"))
           .reset_index())
    dist = {col: {seg: {k: int(v) for k, v in row.items()}
                  for seg, row in pd.crosstab(p["arpu_segment"], p[col]).iterrows()}
            for col in ("data_segment", "call_segment")}

    return {
        "params": {"seed": seed, "world": world, "llm": llm, "llm_available": bool(os.environ.get("OPENAI_API_KEY"))},
        "limits": {"total_budget": TOTAL_BUDGET, "total_contacts": MAX_TOTAL_CONTACTS, "total_pilots": 20,
                   "budget_after_pilots": _f(env.remaining_budget), "contacts_after_pilots": int(env.remaining_contacts),
                   "pilots_left": int(env.pilots_left), "lcb_k": agent.LCB_K},
        "channels": CHANNELS,
        "tariffs": se.dict_tariff[["tariff_plan_code", "price_tariff", "Data_in_PKG"]].to_dict("records"),
        "audience": {"cells": [{"cur": r.current_tariff, "seg": r.arpu_segment, "n": int(r.n), "S": _f(r.S),
                                "arpu": _f(r.arpu)} for r in aud.itertuples()], "dist": dist},
        "arms": arm_rows,
        "pilots": pilots,
        "plan": plan,
        "score": {k: (_f(v) if isinstance(v, (int, float, np.number)) else v)
                  for k, v in score.items() if k != "campaigns_detail"},
        "log": a.log,
    }


@functools.lru_cache(maxsize=8)
def strategies_payload(runs=5):
    names = {"agent": lambda m: agent.Agent, "без LLM": lambda m: se.ExpPrior, "без пилотов": lambda m: se.PriorOnly,
             "шаблон": lambda m: agent_template.Agent, "оракул": se.make_oracle}
    rows = []
    for seed in range(runs):
        model = se.world(seed)
        rows.append({"seed": seed, **{n: _f(se.run(mk(model), model, seed)) for n, mk in names.items()}})
    df = pd.DataFrame(rows)
    return {"rows": rows, "summary": [{"name": n, "median": _f(df[n].median()), "min": _f(df[n].min()),
                                       "positive": int((df[n] > 0).sum())} for n in names]}


@app.get("/api/run")
def api_run(seed: int = 42, world: str = Query("mock", pattern="^(mock|stress)$"), llm: bool = True):
    return run_payload(seed, world, llm)


@app.get("/api/strategies")
def api_strategies(runs: int = Query(5, ge=1, le=10)):
    return strategies_payload(runs)


if __name__ == "__main__":
    r = run_payload(42, "mock", False)
    assert 1 <= len(r["plan"]) <= 10, r["plan"]
    spent = sum(p["cost"] for p in r["pilots"])
    assert abs(spent - (TOTAL_BUDGET - r["limits"]["budget_after_pilots"])) < 1e-6, spent
    keys = {(a["cur"], a["seg"], a["target"]) for a in r["arms"]}
    assert all((c["cur"], c["seg"], p["target_tariff"]) in keys for p in r["plan"] for c in p["cells"])
    assert all(p["cells"] for p in r["plan"]), "кампания без ячеек из _chosen"
    assert r["score"]["net_arpu_gain"] > 0, r["score"]
    sub = pd.read_csv("submission.csv")["campaign_name"].tolist()
    print("plan == submission.csv:", [c["campaign_name"] for c in r["plan"]] == sub)
    print(f"ok: {len(r['arms'])} arms, {len(r['pilots'])} pilots, {len(r['plan'])} campaigns, "
          f"net={r['score']['net_arpu_gain']:,.0f}")
