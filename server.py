"""
API для UI (web/): запускает агента в мок- или стресс-мире и отдаёт его внутреннее состояние.

    pip install fastapi uvicorn 'fastapi-users[sqlalchemy]' 'psycopg[binary]'
    docker compose up -d db            # Postgres: пользователи, сессии, лаборатория
    uvicorn server:app --port 8000
    python3 server.py                  # self-check без сервера

Агенту не нужен; agent.py не меняет — только наблюдает через подкласс.
"""

import functools
import math
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session
from typing import Literal

from fastapi import Body, Depends, FastAPI, File, HTTPException, Path as PathParam, Query, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

_env_file = Path(os.environ.get("ENV_FILE", Path(__file__).parent / ".env"))  # десктоп: .env в каталоге данных
if _env_file.exists():  # ponytail: без python-dotenv, формат KEY=VALUE
    for line in _env_file.read_text().splitlines():
        k, _, v = line.partition("=")
        if k.strip() and not k.startswith("#"):
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

import agent  # noqa: E402
import auth  # noqa: E402
import db  # noqa: E402
import agent_template  # noqa: E402
import datasets  # noqa: E402
import lab  # noqa: E402
import stress_eval as se  # noqa: E402  (грузит profile / dict_tariff / history)
from environment import make_environment  # noqa: E402
from mock_environment import CHANNELS, MAX_TOTAL_CONTACTS, TOTAL_BUDGET, _mock_fallback, _mock_impact_model  # noqa: E402
from scoring_core import score_campaigns, sanitize_campaigns  # noqa: E402

agent._llm_call = functools.lru_cache(agent._llm_call)  # промпт одинаков для всех seed
API_DOC = """
API кокпита: запускает агента тарифных кампаний в мок- или стресс-мире и отдаёт его внутреннее состояние
(prior/posterior рукавов, пилоты, план, скоринг), плюс лабораторию версий агента.

**Вход.** `POST /api/auth/login` → «Try it out», `username` = email, `password` → ответ 204 ставит cookie `session`,
дальше все запросы из этой страницы идут с ним. `POST /api/auth/logout` отзывает сессию.

| Роль | Доступ |
|---|---|
| `manager` | `/api/me`, `/api/run` |
| `analyst` | + `/api/strategies`, `/api/data` (итоги кампаний), `/api/feedback/run` |
| `admin` | + `/api/lab/*`, загрузка базовых выгрузок в `/api/data/{kind}` |

Без входа — 401, не хватает роли — 403.
"""
TAGS = [{"name": "auth", "description": "Вход и выход (fastapi-users, cookie `session`)."},
        {"name": "agent", "description": "Прогон агента и сравнение стратегий."},
        {"name": "data", "description": "Новые данные: загрузка CSV и база знаний из пилотов и итогов кампаний."},
        {"name": "lab", "description": "Лаборатория версий агента: правки констант, оценка, промоут. Только admin."}]
app = FastAPI(title="Campaign Cockpit", version="1.0", description=API_DOC, openapi_tags=TAGS,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")  # под /api — проксирует vite
db.init()
auth.bootstrap()
if datasets.UPLOAD_DIR.exists():  # загруженные ранее выгрузки переживают рестарт
    datasets.activate()
ANY, ANALYST, ADMIN = (auth.require(*r) for r in (db.ROLES, ("analyst", "admin"), ("admin",)))
auth_router = auth.fastapi_users.get_auth_router(auth.backend)
for r in auth_router.routes:  # названия fastapi-users («Auth:Cookie.Login») → по-русски
    r.summary, r.description = {
        "/login": ("Вход", "Форма: `username` = email, `password`. 204 ставит cookie `session`, 400 — неверные данные."),
        "/logout": ("Выход", "Отзывает текущую сессию и стирает cookie."),
    }[r.path]
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])

LOGIN_MAX, LOGIN_WINDOW = 10, 300  # неудачных входов с одного IP за 5 минут → 429
_login_fails: dict[str, list[float]] = {}


@app.middleware("http")
async def guard(request: Request, call_next):
    """Лимит неудачных входов + заголовки против clickjacking и MIME-sniffing."""
    # ponytail: счётчик в памяти процесса; за прокси без X-Forwarded-For все клиенты — один IP; Redis при нескольких воркерах
    login = request.method == "POST" and request.url.path == "/api/auth/login"
    if login:
        ip, now = request.client.host if request.client else "?", time.monotonic()
        fails = [t for t in _login_fails.pop(ip, ()) if now - t < LOGIN_WINDOW]
        if fails:
            _login_fails[ip] = fails
        if len(fails) >= LOGIN_MAX:
            return JSONResponse({"detail": "слишком много попыток входа, повторите через несколько минут"}, 429)
    resp = await call_next(request)
    if login and resp.status_code == 400:
        _login_fails.setdefault(ip, []).append(now)
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    return resp


@app.get("/api/me", response_model=auth.UserRead, tags=["auth"], summary="Текущий пользователь")
def api_me(user: db.User = Depends(auth.current_user)):
    """Email и роль вошедшего пользователя. Любая роль."""
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


def world_key(world, seed):
    """Мир для базы знаний: мок один на все seed, стресс-миры разные — их наблюдения не смешиваем."""
    return "mock" if world == "mock" else f"{world}:{seed}"


def _model(world, seed):
    return se.world(seed) if world == "stress" else _mock_impact_model(se.history)


# пресеты OpenRouter для селектора в UI; slug вне списка принимается от analyst и admin
MODELS = ("deepseek/deepseek-v4-flash", "google/gemini-3.8-flash", "openai/gpt-4o-mini",
          "anthropic/claude-haiku-4.5", "openai/gpt-5.4-mini", "moonshotai/kimi-k2.6")


@functools.lru_cache(maxsize=64)
def run_payload(seed=42, world="mock", llm=True, llm_model=None, feedback=True):
    model = _model(world, seed)
    env, internals = make_environment(se.profile, model, se.dict_tariff, CHANNELS, TOTAL_BUDGET,
                                      MAX_TOTAL_CONTACTS, _mock_fallback, seed=seed)
    a = Traced()
    a.model = llm_model
    a.feedback = datasets.load_feedback(world_key(world, seed)) if feedback else ()
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
                   "model": agent.llm_config(llm_model)[2], "models": MODELS,
                   "feedback": feedback, "feedback_rows": len(a.feedback)},
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


# --- схема ответа /api/run: только для Swagger, ответ не фильтрует; self-check валидирует её на живом run_payload
class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


Num = float | None  # _f: NaN/inf → null


class Params(_M):
    seed: int
    world: str
    llm: bool = Field(description="LLM-эксперт запрошен")
    llm_available: bool = Field(description="на сервере есть ключ LLM")
    model: str | None = Field(description="модель, которую реально взял агент")
    models: list[str] = Field(description="пресеты для селектора")
    feedback: bool = Field(description="база знаний запрошена")
    feedback_rows: int = Field(description="сколько прошлых наблюдений этого мира учёл агент")


class Limits(_M):
    total_budget: float
    total_contacts: int
    total_pilots: int
    budget_after_pilots: Num = Field(description="бюджет, оставшийся на план после пилотов")
    contacts_after_pilots: int
    pilots_left: int
    lcb_k: float = Field(description="k в правиле плана μ − k·σ > 0")


class Channel(_M):
    cost_per_contact: float
    conversion_multiplier: float


class Tariff(_M):
    tariff_plan_code: str
    price_tariff: float
    Data_in_PKG: float = Field(description="пакет данных, ГБ")


class AudienceCell(_M):
    cur: str = Field(description="текущий тариф")
    seg: str = Field(description="ARPU-сегмент")
    n: int = Field(description="абонентов в ячейке")
    S: Num = Field(description="Σ predicted_arpu ячейки")
    arpu: Num = Field(description="средний ARPU за 3 мес.")


class Audience(_M):
    cells: list[AudienceCell]
    dist: dict[str, dict[str, dict[str, int]]] = Field(description="{data_segment|call_segment: {seg: {значение: число}}}")


class Arm(_M):
    """Гипотеза «ячейка → target» и её гауссов апостериор."""
    cur: str
    seg: str
    target: str
    src: list[str] = Field(description="кто предложил: prior, llm, feedback (база знаний)")
    prior_mu: Num
    prior_sd: Num
    post_mu: Num
    post_sd: Num
    lcb: Num = Field(description="нижняя граница, по которой рукав идёт в план")
    n: int = Field(description="абонентов в пилотах этого рукава")
    obs: list[Num] = Field(description="наблюдённые эффекты пилотов")
    ei: Num = Field(description="expected improvement × Σ ARPU в конце разведки")
    planned: bool


class Pilot(_M):
    name: str
    cur: str
    seg: str
    target: str
    channel: str
    n: int
    cost: Num
    ratio: Num = Field(description="observed_lift_ratio от среды")
    total: Num = Field(description="observed_lift_total от среды")
    base: Num = Field(description="ratio без множителя канала")
    prior_mu: Num = None
    post_mu: Num = None
    post_sd: Num = None
    decision: Literal["scale", "hold", "drop"] = Field(description="в плане / проходит LCB, но не в плане / отброшен")


class PlanCell(_M):
    cur: str
    seg: str
    n: int
    S: Num
    mu: Num
    gain: Num = Field(description="μ × множитель канала × S")


class Campaign(_M):
    campaign_name: str
    filter_arpu_segment: str | None
    filter_current_tariff: str | None = Field(description="тарифы через «;»")
    target_tariff: str
    channel: str
    audience: int
    expected_gain: Num = Field(description="прогноз агента")
    expected_cost: Num
    cells: list[PlanCell]
    actual_gross: Num = Field(description="прирост по скорингу среды")
    actual_cost: Num
    actual_contacts: int
    caps: list[str] = Field(description="какие лимиты обрезали кампанию при скоринге")


class Score(_M):
    """Итог `scoring_core.score_campaigns` по пилотам и плану."""
    team_id: str | None
    baseline_total_arpu: Num
    gross_arpu_lift: Num
    total_cost: Num
    net_arpu_gain: Num = Field(description="главная метрика: прирост ARPU − затраты")
    total_arpu_after: Num
    growth_vs_baseline_pct: Num
    status: str
    n_campaigns: Num = Field(description="вместе с пилотами")
    total_contacts: Num
    unique_customers_targeted: Num
    coverage_pct: Num
    avg_gain_per_customer: Num
    roi: Num
    risk_score_pct: Num
    budget_used_pct: Num


class TopEi(_M):
    cur: str
    seg: str
    target: str
    ei: Num


class ReplayArm(_M):
    target: str
    src: list[str]
    planned: bool
    before_mu: Num
    before_sd: Num
    after_mu: Num
    after_sd: Num


class ReplayStep(_M):
    """Шаг разведки: какой пилот выбран, по какому EI, и как сдвинулся апостериор его ячейки."""
    i: int
    cur: str
    seg: str
    target: str
    n: int | None
    obs: Num
    ei: Num
    top_ei: list[TopEi] = Field(description="5 лучших кандидатов на этом шаге")
    cell: list[ReplayArm] = Field(description="все рукава ячейки до и после пилота")


class LlmCall(_M):
    task: str
    model: str | None
    mode: str
    fields_sent: list[str]
    redacted_fields: list[str]
    prompt: str
    prompt_sha: str
    response: str | None
    error: str | None
    latency: float | None = Field(description="секунды")
    parsed: list[dict] = Field(description="принятые предложения: cur, seg, target, expected, used, clipped")
    rejected: list[dict] = Field(description="отклонённые: row, reason")


class Privacy(_M):
    mode: str
    allowlist: list[str] = Field(description="поля, которые можно отправить в LLM")
    k_min: int = Field(description="минимальный размер ячейки для отправки")
    redacted_fields: list[str]


class RunOut(_M):
    params: Params
    limits: Limits
    channels: dict[str, Channel]
    tariffs: list[Tariff]
    audience: Audience
    arms: list[Arm]
    pilots: list[Pilot]
    plan: list[Campaign] = Field(description="финальный план, ≤10 кампаний")
    score: Score
    log: list[str]
    replay: list[ReplayStep] = Field(description="по шагу на каждый пилот")
    llm_audit: list[LlmCall] = Field(description="все вызовы LLM (пусто без LLM)")
    privacy: Privacy


@app.get("/api/run", tags=["agent"], summary="Прогон агента",
         responses={200: {"model": RunOut}})
def api_run(seed: int = Query(42, description="seed среды: выборка пилотов и, для `stress`, искажение эффектов"),
            world: str = Query("mock", pattern="^(mock|stress)$",
                               description="`mock` — эффекты из истории, `stress` — искажённый мир из `stress_eval`"),
            llm: bool = Query(True, description="включить LLM-эксперта (нужен ключ OpenRouter/OpenAI на сервере)"),
            model: str | None = Query(None, max_length=100, pattern=r"^[\w.\-/:]+$",
                                      description=f"slug модели OpenRouter; пресеты: {', '.join(MODELS)}"),
            feedback: bool = Query(True, description="учесть базу знаний: прошлые пилоты и итоги кампаний этого мира"),
            user: db.User = Depends(ANY)):
    """Запускает агента и возвращает его состояние: `arms` (prior/posterior рукавов), `pilots`, `replay`
    (снимок перед каждым пилотом), `plan` (≤10 кампаний), `score`, `log`, `llm_audit`, `privacy`.
    Результат кешируется по параметрам. Любая роль; manager — только модели из пресетов (платные вызовы)."""
    if model and user.role == "manager" and model not in MODELS:
        raise HTTPException(403, "manager может выбрать только модель из пресетов")
    return run_payload(seed, world, llm, model, feedback)


@app.get("/api/strategies", dependencies=[Depends(ANALYST)], tags=["agent"], summary="Сравнение стратегий")
def api_strategies(runs: int = Query(5, ge=1, le=10, description="число стресс-миров (seed 0…runs−1)")):
    """Net-выигрыш агента, агента без LLM, без пилотов, шаблона и оракула на стресс-мирах: строки по seed
    и сводка (медиана, минимум, число миров в плюс). Долгий первый вызов, дальше кеш. analyst, admin."""
    return strategies_payload(runs)


# --- новые данные (datasets.py) ----------------------------------------------
MAX_UPLOAD = 50 * 2 ** 20


def _data_changed():
    run_payload.cache_clear()
    strategies_payload.cache_clear()


@app.get("/api/data", dependencies=[Depends(ANALYST)], tags=["data"], summary="Датасеты и база знаний")
def api_data():
    """Активные датасеты (исходный файл пакета или загрузка, строк, кто и когда загрузил) и число наблюдений
    в базе знаний по мирам. analyst, admin."""
    return datasets.summary()


@app.post("/api/data/{kind}", tags=["data"], summary="Загрузить CSV")
async def api_data_upload(kind: str = PathParam(description=f"одно из: {', '.join(datasets.KINDS)}"),
                          file: UploadFile = File(description="CSV с заголовком"),
                          user: db.User = Depends(ANALYST)):
    """`campaign_results` — итоги кампаний (колонки `cur, seg, target, channel, n, lift_ratio`, необязательные
    `world`, `source`) → база знаний, analyst и admin. Базовые выгрузки (`change_tariff`, `traffic`, `dict_tariff`,
    `customer_profile`) меняют мир для всех — только admin; колонки должны совпадать с текущим файлом.
    422 — список ошибок валидации, ничего не записано."""
    if kind not in datasets.KINDS:
        raise HTTPException(404, f"нет датасета {kind}")
    if kind != "campaign_results" and user.role != "admin":
        raise HTTPException(403, "базовые выгрузки загружает только admin")
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, f"файл больше {MAX_UPLOAD // 2 ** 20} МБ")
    try:
        rows = datasets.save(kind, raw, user.email)
    except ValueError as e:
        raise HTTPException(422, e.args[0])
    _data_changed()
    return {"kind": kind, "rows": rows}


@app.post("/api/feedback/run", tags=["data"], summary="Сохранить пилоты прогона")
def api_feedback_run(seed: int = Query(42), world: str = Query("mock", pattern="^(mock|stress)$"),
                     llm: bool = Query(True), model: str | None = Query(None, max_length=100, pattern=r"^[\w.\-/:]+$"),
                     feedback: bool = Query(True), user: db.User = Depends(ANALYST)):
    """Пилоты прогона с этими параметрами (тот же кэш, что `/api/run`) → база знаний его мира. Следующий прогон
    стартует с их апостериором и тратит пилоты на другие гипотезы. Повторное сохранение — no-op. analyst, admin."""
    added = datasets.save_pilots(run_payload(seed, world, llm, model, feedback)["pilots"], world_key(world, seed),
                                 seed, user.email)
    _data_changed()
    return {"world": world_key(world, seed), "added": added}


# --- лаборатория версий (lab.py) ---------------------------------------------
lab.ensure_baseline()
_SLIM = ("runs", "audit")


def _slim(v, cur):
    return {**{k: x for k, x in v.items() if k not in _SLIM}, "current": v["id"] == cur}


@app.get("/api/lab/versions", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Список версий")
def lab_versions():
    """Все версии агента без прогонов и аудита; `current` — активная, `pending` — задач в очереди оценки."""
    cur = lab.current_id()
    return {"versions": [_slim(v, cur) for v in lab.versions()], "pending": lab._q.unfinished_tasks}


def _load(vid):
    try:
        return lab.load(vid)
    except FileNotFoundError:
        raise HTTPException(404, f"нет версии {vid}")


@app.get("/api/lab/versions/{vid}", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Версия целиком")
def lab_version(vid: str):
    """Конфиг, прогоны тестов и аудит версии `vid` (например `v001`). 404, если нет."""
    return {**_load(vid), "current": vid == lab.current_id()}


@app.post("/api/lab/versions", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Создать версию")
def lab_create(body: dict = Body(..., examples=[{"parent_id": "v001", "changes": {"LCB_K": 0.7},
                                                 "hypothesis": "строже LCB — меньше минусовых кампаний"}]),
               user: db.User = Depends(ADMIN)):
    """Новая версия от `parent_id` с правками констант `changes` (допустимые ключи и границы — `GET /api/lab/targets`)
    и сразу ставит её в очередь оценки. 400 — невалидные правки или нет изменений."""
    try:
        v = lab.create(body.get("parent_id"), body.get("changes") or {}, created_by="human", kind="manual", author=user.email,
                       hypothesis=str(body.get("hypothesis") or "")[:300])
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    lab.mark_evaluating(v["id"])
    lab.enqueue(lab.evaluate, v["id"])
    return v


@app.post("/api/lab/versions/{vid}/evaluate", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Переоценить")
def lab_evaluate(vid: str):
    """Ставит версию в очередь на повторный прогон тестов; результат — в `GET /api/lab/versions/{vid}`. 404, если нет."""
    _load(vid)
    lab.mark_evaluating(vid)
    lab.enqueue(lab.evaluate, vid)
    return {"queued": vid}


@app.post("/api/lab/versions/{vid}/remediate", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Автопочинка")
def lab_remediate(vid: str, steps: int = Query(1, ge=1, le=3, description="сколько шагов починки подряд")):
    """В фоне: предлагает дочернюю версию, исправляющую провалы `vid`, и оценивает её; прошла gate — следующий шаг от неё."""
    _load(vid)
    lab.enqueue(lab.remediate, vid, steps)
    return {"queued": vid, "steps": steps}


@app.post("/api/lab/versions/{vid}/promote", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Сделать активной")
def lab_promote(vid: str):
    """Записывает константы версии в `agent.py`, пересобирает `submission.csv`, применяет их в этом процессе и сбрасывает
    кеш прогонов. 400 — версия не в статусе `candidate`, 404 — нет версии."""
    _load(vid)
    try:
        v = lab.promote(vid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    lab._apply(v["config"])  # этот процесс уже импортировал agent — подтягиваем новые константы
    run_payload.cache_clear()
    strategies_payload.cache_clear()
    return _slim(v, vid)


@app.get("/api/lab/targets", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Что можно править")
def lab_targets():
    """Правимые константы агента с типом и границами, обязательные тесты, пороги и шаблоны проблем."""
    return {"targets": lab.PATCH_TARGETS, "must": lab.MUST, "thresholds": lab.TH,
            "templates": {k: {"title": t["title"], "issues": t["issues"]} for k, t in lab.TEMPLATES.items()}}


@app.get("/api/lab/runs", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Прогоны тестов")
def lab_runs():
    """Плоский список прогонов всех версий: тест, мир, seed, net, число кампаний, падения, время."""
    keep = ("test", "world", "seed", "llm", "net", "n_campaigns", "invalid", "crash", "runtime", "fallback", "pilots",
            "pilot_cost", "total_contacts", "log")
    return [{"version": v["id"], **{k: r.get(k) for k in keep}} for v in lab.versions() for r in v.get("runs", [])]


@app.get("/api/lab/audit", dependencies=[Depends(ADMIN)], tags=["lab"], summary="Журнал действий")
def lab_audit():
    """Последние 50 записей аудита лаборатории, новые первыми."""
    with Session(db.engine) as s:
        return [r.data for r in s.scalars(select(db.LabAudit).order_by(db.LabAudit.id.desc()).limit(50))]


_dist = Path(__file__).parent / "web" / "dist"
if _dist.exists():  # ponytail: в docker фронт отдаёт сам API, в dev по-прежнему vite
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")


if __name__ == "__main__":
    r = run_payload(42, "mock", False, feedback=False)
    assert 1 <= len(r["plan"]) <= 10, r["plan"]
    spent = sum(p["cost"] for p in r["pilots"])
    assert abs(spent - (TOTAL_BUDGET - r["limits"]["budget_after_pilots"])) < 1e-6, spent
    keys = {(a["cur"], a["seg"], a["target"]) for a in r["arms"]}
    assert all((c["cur"], c["seg"], p["target_tariff"]) in keys for p in r["plan"] for c in p["cells"])
    assert all(p["cells"] for p in r["plan"]), "кампания без ячеек из _chosen"
    assert r["score"]["net_arpu_gain"] > 0, r["score"]
    assert len(r["replay"]) == len(r["pilots"]) and all(s["cell"] for s in r["replay"]), "replay: шаг на каждый пилот"
    assert "ID_NUMBER" in r["privacy"]["redacted_fields"]
    from fastapi.testclient import TestClient
    spec = TestClient(app).get("/api/openapi.json").json()
    assert {p["name"]: p.get("description") for p in spec["paths"]["/api/run"]["get"]["parameters"]}["world"], "swagger"
    assert spec["paths"]["/api/auth/login"]["post"]["summary"] == "Вход", "swagger: login"
    RunOut.model_validate(r)  # схема /api/run в Swagger совпадает с реальным ответом (extra="forbid")
    sub = pd.read_csv("submission.csv")["campaign_name"].tolist()
    print("plan == submission.csv:", [c["campaign_name"] for c in r["plan"]] == sub)
    print(f"ok: {len(r['arms'])} arms, {len(r['pilots'])} pilots, {len(r['plan'])} campaigns, "
          f"net={r['score']['net_arpu_gain']:,.0f}")
