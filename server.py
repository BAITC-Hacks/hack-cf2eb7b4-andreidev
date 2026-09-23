"""
API для UI (web/): запускает агента в мок- или стресс-мире и отдаёт его внутреннее состояние.

    pip install fastapi uvicorn 'fastapi-users[sqlalchemy]' 'psycopg[binary]'
    docker compose up -d db            # Postgres: пользователи, сессии, лаборатория
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
from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import Body, Depends, FastAPI, HTTPException, Query

_env_file = Path(__file__).parent / ".env"
if _env_file.exists():  # ponytail: без python-dotenv, формат KEY=VALUE
    for line in _env_file.read_text().splitlines():
        k, _, v = line.partition("=")
        if k.strip() and not k.startswith("#"):
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

import agent  # noqa: E402
import auth  # noqa: E402
import db  # noqa: E402
import agent_template  # noqa: E402
import lab  # noqa: E402
import stress_eval as se  # noqa: E402  (грузит profile / dict_tariff / history)
from environment import make_environment  # noqa: E402
from mock_environment import CHANNELS, MAX_TOTAL_CONTACTS, TOTAL_BUDGET, _mock_fallback, _mock_impact_model  # noqa: E402
from scoring_core import score_campaigns, sanitize_campaigns  # noqa: E402

agent._llm_call = functools.lru_cache(agent._llm_call)  # промпт одинаков для всех seed
app = FastAPI(title="Beeline campaign cockpit")
db.init()
auth.bootstrap()
ANY, ANALYST, ADMIN = (auth.require(*r) for r in (db.ROLES, ("analyst", "admin"), ("admin",)))
app.include_router(auth.fastapi_users.get_auth_router(auth.backend), prefix="/api/auth", tags=["auth"])


@app.get("/api/me", response_model=auth.UserRead)
def api_me(user: db.User = Depends(auth.current_user)):
    return user


class Traced(agent.Agent):
    """Тот же агент; запоминает prior, реестр рукавов и снимки апостериора перед каждым пилотом (replay)."""

    def _explore(self, env, cells, arms):
        self.prior = {k: (a["mu"], a["var"]) for k, a in arms.items()}
        self.cells, self.arms, self.snaps = cells, arms, []
        run_pilot = env.run_pilot

        def traced(**kw):  # env.run_pilot — атрибут инстанса, агент вызывает его только с kwargs
            ei = self._scores  # то, по чему _explore только что выбрал пилот (EI или VOI − цена)
            self.snaps.append(({k: (a["mu"], math.sqrt(a["var"]), a["n"]) for k, a in arms.items()}, ei,
                               (kw["filter_current_tariff"], kw["filter_arpu_segment"], kw["target_tariff"])))
            return run_pilot(**kw)
        env.run_pilot = traced
        super()._explore(env, cells, arms)
        self.snaps.append(({k: (a["mu"], math.sqrt(a["var"]), a["n"]) for k, a in arms.items()}, {}, None))


def _f(x):
    x = float(x)
    return x if math.isfinite(x) else None


def _model(world, seed):
    return se.world(seed) if world == "stress" else _mock_impact_model(se.history)


# пресеты OpenRouter для селектора в UI; slug вне списка тоже принимается
MODELS = ("deepseek/deepseek-v4-flash", "google/gemini-3.8-flash", "openai/gpt-4o-mini",
          "anthropic/claude-haiku-4.5", "openai/gpt-5.4-mini", "moonshotai/kimi-k2.6")


@functools.lru_cache(maxsize=64)
def run_payload(seed=42, world="mock", llm=True, llm_model=None):
    model = _model(world, seed)
    env, internals = make_environment(se.profile, model, se.dict_tariff, CHANNELS, TOTAL_BUDGET,
                                      MAX_TOTAL_CONTACTS, _mock_fallback, seed=seed)
    a = Traced()
    a.model = llm_model
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
    lcb = agent._lcb

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

    replay = []
    snaps = getattr(a, "snaps", [])
    for i, (before, ei, k) in enumerate(snaps[:-1]):
        after = snaps[i + 1][0]
        top = sorted(ei, key=ei.get, reverse=True)[:5]
        replay.append({
            "i": i + 1, "cur": k[0], "seg": k[1], "target": k[2], "n": pilots[i]["n"] if i < len(pilots) else None,
            "obs": pilots[i]["base"] if i < len(pilots) else None, "ei": _f(ei.get(k, 0.0)),
            "top_ei": [{"cur": t[0], "seg": t[1], "target": t[2], "ei": _f(ei[t])} for t in top],
            "cell": sorted(({"target": t[2], "src": sorted(arms[t].get("src", ())), "planned": t in planned,
                             "before_mu": _f(before[t][0]), "before_sd": _f(before[t][1]),
                             "after_mu": _f(after[t][0]), "after_sd": _f(after[t][1])}
                            for t in before if t[:2] == k[:2]), key=lambda r: -(r["after_mu"] or 0)),
        })

    p = se.profile
    aud = (p.groupby(["current_tariff", "arpu_segment"])
           .agg(n=("ID_NUMBER", "size"), S=("predicted_arpu", "sum"), arpu=("ARPU_3m_avg", "mean"))
           .reset_index())
    dist = {col: {seg: {k: int(v) for k, v in row.items()}
                  for seg, row in pd.crosstab(p["arpu_segment"], p[col]).iterrows()}
            for col in ("data_segment", "call_segment")}

    return {
        "params": {"seed": seed, "world": world, "llm": llm, "llm_available": bool(agent.llm_config()[1]),
                   "model": agent.llm_config(llm_model)[2], "models": MODELS},
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
        "replay": replay,
        "llm_audit": a.llm_audit,
        "privacy": {"mode": agent.PRIVACY_MODE, "allowlist": list(agent.LLM_FIELDS), "k_min": agent.K_MIN,
                    "redacted_fields": agent.redacted_fields(se.profile.columns)},
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


@app.get("/api/run", dependencies=[Depends(ANY)])
def api_run(seed: int = 42, world: str = Query("mock", pattern="^(mock|stress)$"), llm: bool = True,
            model: str | None = Query(None, max_length=100, pattern=r"^[\w.\-/:]+$")):
    return run_payload(seed, world, llm, model)


@app.get("/api/strategies", dependencies=[Depends(ANALYST)])
def api_strategies(runs: int = Query(5, ge=1, le=10)):
    return strategies_payload(runs)


# --- лаборатория версий (lab.py) ---------------------------------------------
lab.ensure_baseline()
_SLIM = ("runs", "audit")


def _slim(v, cur):
    return {**{k: x for k, x in v.items() if k not in _SLIM}, "current": v["id"] == cur}


@app.get("/api/lab/versions", dependencies=[Depends(ADMIN)])
def lab_versions():
    cur = lab.current_id()
    return {"versions": [_slim(v, cur) for v in lab.versions()], "pending": lab._q.unfinished_tasks}


@app.get("/api/lab/versions/{vid}", dependencies=[Depends(ADMIN)])
def lab_version(vid: str):
    try:
        return {**lab.load(vid), "current": vid == lab.current_id()}
    except FileNotFoundError:
        raise HTTPException(404, f"нет версии {vid}")


@app.post("/api/lab/versions", dependencies=[Depends(ADMIN)])
def lab_create(body: dict = Body(...), user: db.User = Depends(ADMIN)):
    try:
        v = lab.create(body.get("parent_id"), body.get("changes") or {}, created_by="human", kind="manual", author=user.email,
                       hypothesis=str(body.get("hypothesis") or "")[:300])
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    lab.mark_evaluating(v["id"])
    lab.enqueue(lab.evaluate, v["id"])
    return v


@app.post("/api/lab/versions/{vid}/evaluate", dependencies=[Depends(ADMIN)])
def lab_evaluate(vid: str):
    lab.mark_evaluating(vid)
    lab.enqueue(lab.evaluate, vid)
    return {"queued": vid}


@app.post("/api/lab/versions/{vid}/remediate", dependencies=[Depends(ADMIN)])
def lab_remediate(vid: str, steps: int = Query(1, ge=1, le=3)):
    lab.enqueue(lab.remediate, vid, steps)
    return {"queued": vid, "steps": steps}


@app.post("/api/lab/versions/{vid}/promote", dependencies=[Depends(ADMIN)])
def lab_promote(vid: str):
    try:
        v = lab.promote(vid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    lab._apply(v["config"])  # этот процесс уже импортировал agent — подтягиваем новые константы
    run_payload.cache_clear()
    strategies_payload.cache_clear()
    return _slim(v, vid)


@app.get("/api/lab/targets", dependencies=[Depends(ADMIN)])
def lab_targets():
    return {"targets": lab.PATCH_TARGETS, "must": lab.MUST, "thresholds": lab.TH,
            "templates": {k: {"title": t["title"], "issues": t["issues"]} for k, t in lab.TEMPLATES.items()}}


@app.get("/api/lab/runs", dependencies=[Depends(ADMIN)])
def lab_runs():
    keep = ("test", "world", "seed", "llm", "net", "n_campaigns", "invalid", "crash", "runtime", "fallback", "pilots",
            "pilot_cost", "total_contacts", "log")
    return [{"version": v["id"], **{k: r.get(k) for k in keep}} for v in lab.versions() for r in v.get("runs", [])]


@app.get("/api/lab/audit", dependencies=[Depends(ADMIN)])
def lab_audit():
    with Session(db.engine) as s:
        return [r.data for r in s.scalars(select(db.LabAudit).order_by(db.LabAudit.id.desc()).limit(50))]


_dist = Path(__file__).parent / "web" / "dist"
if _dist.exists():  # ponytail: в docker фронт отдаёт сам API, в dev по-прежнему vite
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")


if __name__ == "__main__":
    r = run_payload(42, "mock", False)
    assert 1 <= len(r["plan"]) <= 10, r["plan"]
    spent = sum(p["cost"] for p in r["pilots"])
    assert abs(spent - (TOTAL_BUDGET - r["limits"]["budget_after_pilots"])) < 1e-6, spent
    keys = {(a["cur"], a["seg"], a["target"]) for a in r["arms"]}
    assert all((c["cur"], c["seg"], p["target_tariff"]) in keys for p in r["plan"] for c in p["cells"])
    assert all(p["cells"] for p in r["plan"]), "кампания без ячеек из _chosen"
    assert r["score"]["net_arpu_gain"] > 0, r["score"]
    assert len(r["replay"]) == len(r["pilots"]) and all(s["cell"] for s in r["replay"]), "replay: шаг на каждый пилот"
    assert "ID_NUMBER" in r["privacy"]["redacted_fields"]
    sub = pd.read_csv("submission.csv")["campaign_name"].tolist()
    print("plan == submission.csv:", [c["campaign_name"] for c in r["plan"]] == sub)
    print(f"ok: {len(r['arms'])} arms, {len(r['pilots'])} pilots, {len(r['plan'])} campaigns, "
          f"net={r['score']['net_arpu_gain']:,.0f}")
