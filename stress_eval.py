"""
Стресс-проверка: агент на ИСКАЖЁННЫХ мирах (эффекты ≠ истории), как на судействе.

    python stress_eval.py [--runs 10]
    python stress_eval.py --keep 0    # жёсткие миры: история бесполезна (0) или наполовину верна (0.5)
    python stress_eval.py --struct    # структурные миры: сдвиг эффекта общий на target и сегмент

Сравнивает наш агент с шаблоном, prior-only (без пилотов), оракулом (знает эффекты)
и ablation экспертов: только prior против full (prior + llm, если есть OPENROUTER_API_KEY или OPENAI_API_KEY).
"""

import functools
import json
import os
import sys

import numpy as np
import pandas as pd

import agent
import agent_template
from environment import make_environment
from mock_environment import CHANNELS, MAX_TOTAL_CONTACTS, TOTAL_BUDGET, _mock_fallback, _mock_impact_model
from scoring_core import score_campaign, score_campaigns, sanitize_campaigns

profile = pd.read_csv("customer_profile.csv")
dict_tariff = pd.read_csv("data/dict_tariff.csv")
history = pd.read_csv("data/change_tariff.csv")
COLS = ["filter_arpu_segment", "filter_data_segment", "filter_call_segment", "filter_current_tariff", "explicit_ids"]


def world(seed):
    rng = np.random.default_rng(1000 + seed)
    m = _mock_impact_model(history)
    m["arpu_change_pct"] = (m["arpu_change_pct"] * rng.uniform(0.5, 2, len(m))
                            + rng.normal(0, 0.3, len(m))).clip(-1, 3)
    return m


def harsh_world(seed, keep=0.0):
    """
    Жёсткий мир: эффекты перемешаны между переходами, keep — доля «правды истории».
    keep=0 — история бесполезна; там стратегия без пилотов получает ~1/15 оракула,
    как сказано в описании кейса (в world() — около половины).
    """
    rng = np.random.default_rng(2000 + seed)
    m = _mock_impact_model(history)
    shuffled = rng.permutation(m["arpu_change_pct"].values)
    m["arpu_change_pct"] = (keep * m["arpu_change_pct"] + (1 - keep) * shuffled
                            + rng.normal(0, 0.1, len(m))).clip(-1, 3)
    return m


def struct_world(seed, sd=0.2):
    """
    Структурный мир: история ошибается не по каждому переходу отдельно, а системно —
    общий сдвиг на target и на сегмент (например, tariff_8 на судействе привлекательнее).
    В world()/harsh_world() искажения независимы, и перенос знания между рукавами там бесполезен по построению.
    """
    rng = np.random.default_rng(3000 + seed)
    m = _mock_impact_model(history)
    t_shift = dict(zip(dict_tariff["tariff_plan_code"], rng.normal(0, sd, len(dict_tariff))))
    s_shift = dict(zip(["LOW", "MID", "HIGH"], rng.normal(0, sd / 2, 3)))
    m["arpu_change_pct"] = (m["arpu_change_pct"] * rng.uniform(0.75, 1.5, len(m))
                            + m["tariff_plan_code_to"].map(t_shift).fillna(0)
                            + m["arpu_segment"].astype(str).map(s_shift).fillna(0)
                            + rng.normal(0, 0.15, len(m))).clip(-1, 3)
    return m


class PriorOnly(agent.Agent):
    experts = ("prior",)  # эталоны не зовут LLM

    def _explore(self, env, cells, arms):
        pass


class ExpPrior(agent.Agent):
    experts = ("prior",)


def make_oracle(model):
    fc = model["conversion_rate"].median()

    class Oracle(agent.Agent):
        experts = ("prior",)

        def _explore(self, env, cells, arms):
            arms.clear()
            for (cur, seg), c in cells.items():
                seg_df = profile[(profile.current_tariff == cur) & (profile.arpu_segment == seg)]
                for t in dict_tariff["tariff_plan_code"]:
                    lift = score_campaign(seg_df, t, model, dict_tariff, fc, "sms", _mock_fallback)
                    arms[(cur, seg, t)] = {"mu": lift["expected_lift_per_customer"].sum() / c["S"] / 0.65,
                                           "var": 1e-12, "n": 1}
    return Oracle


def run(agent_cls, model, seed):
    env, internals = make_environment(profile, model, dict_tariff, CHANNELS, TOTAL_BUDGET,
                                      MAX_TOTAL_CONTACTS, _mock_fallback, seed=seed)
    camps = sanitize_campaigns(agent_cls().act(env), env.tariffs)[:10]
    df = pd.DataFrame(internals.executed_pilot_campaigns() + camps)
    for c in COLS:
        if c not in df.columns:
            df[c] = None
    return score_campaigns(df, profile, model, dict_tariff, profile["predicted_arpu"].sum(),
                           _mock_fallback)["net_arpu_gain"]


def check_never_empty():
    """Нет data/ и всё убыточно: агент всё равно обязан вернуть ≥1 валидную кампанию (must-have ТЗ)."""
    orig, agent._history = agent._history, lambda *a: pd.read_csv("нет_такого_файла.csv")
    m = _mock_impact_model(history)
    m["arpu_change_pct"] = -0.5
    env, _ = make_environment(profile, m, dict_tariff, CHANNELS, TOTAL_BUDGET, MAX_TOTAL_CONTACTS,
                              lambda *a: (-0.5, 0.1), seed=0)
    try:
        camps = sanitize_campaigns(agent.Agent().act(env), env.tariffs)
    finally:
        agent._history = orig
    assert 1 <= len(camps) <= 10, camps
    print(f"пессимистичный мир: {len(camps)} кампания(й), каналы {[c['channel'] for c in camps]}")


def check_time_limit():
    """Дедлайн уже прошёл: LLM и пилоты пропущены, план всё равно валиден."""
    orig, agent.TIME_LIMIT = agent.TIME_LIMIT, 0
    env, _ = make_environment(profile, _mock_impact_model(history), dict_tariff, CHANNELS, TOTAL_BUDGET,
                              MAX_TOTAL_CONTACTS, _mock_fallback, seed=0)
    try:
        a = agent.Agent()
        camps = sanitize_campaigns(a.act(env), env.tariffs)
    finally:
        agent.TIME_LIMIT = orig
    assert 1 <= len(camps) <= 10 and not any(l.startswith("pilot ") for l in a.log), a.log
    assert "llm skipped: time limit" in a.log and "explore stopped: time limit" in a.log, a.log
    print(f"дедлайн: 0 пилотов, {len(camps)} кампания(й)")


def check_llm():
    """LLM-эксперт: невалидные предложения отсеиваются, сбой API не ломает агента."""
    env, _ = make_environment(profile, _mock_impact_model(history), dict_tariff, CHANNELS, TOTAL_BUDGET,
                              MAX_TOTAL_CONTACTS, _mock_fallback, seed=0)
    cur, seg = profile.groupby(["current_tariff", "arpu_segment"]).size().idxmax()
    target = next(t for t in dict_tariff["tariff_plan_code"] if t != cur)
    canned = json.dumps({"arms": [{"cur": cur, "seg": seg, "target": target, "expected": 9},
                                  {"cur": cur, "seg": seg, "target": "tariff_404", "expected": 0.1},
                                  {"cur": "x", "seg": seg, "target": target, "expected": 0.1}]})
    saved = {k: os.environ.pop(k, None) for k in ("OPENAI_API_KEY", "OPENROUTER_API_KEY", "LLM_MODEL")}
    orig = agent._llm_call
    try:
        # провайдер: OpenRouter-ключ главнее OpenAI, явная модель главнее env
        os.environ.update(OPENAI_API_KEY="oa", OPENROUTER_API_KEY="or", LLM_MODEL="m/env")
        assert agent.llm_config() == ("https://openrouter.ai/api/v1", "or", "m/env")
        assert agent.llm_config("m/ui")[2] == "m/ui"
        del os.environ["OPENROUTER_API_KEY"]
        assert agent.llm_config()[1:] == ("oa", os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
        agent._llm_call = lambda prompt, model=None: canned
        a = agent.Agent()
        a.log = []
        _, arms = a._arms(env)
        llm = {k: v for k, v in arms.items() if "llm" in v["src"]}
        assert list(llm) == [(cur, seg, target)], llm
        arm = llm[(cur, seg, target)]
        assert "prior" in arm["src"] or arm["mu"] == agent.LLM_CLIP, arm  # expected=9 клипуется; prior главнее
        # privacy gateway: в промпт ушли только поля allowlist, отказ — с причиной, вызов в аудите
        rec = a.llm_audit[-1]
        assert {r["reason"] for r in rec["rejected"]} == {"unknown_tariff", "unknown_cell"}, rec["rejected"]
        assert set(rec["fields_sent"]) <= {"tariffs_csv", "cells", "cur", "seg", "n", *agent.LLM_FIELDS}, rec["fields_sent"]
        assert "ID_NUMBER" in rec["redacted_fields"] and "ID_NUMBER" not in rec["prompt"]
        try:
            agent.llm_proxy("t", {"ID_NUMBER": 1}, "", [], allowed={"cells"})
            raise AssertionError("поле вне allowlist ушло бы в LLM")
        except ValueError:
            pass

        def boom(prompt, model=None):
            raise OSError("API down")
        agent._llm_call = boom
        env, _ = make_environment(profile, _mock_impact_model(history), dict_tariff, CHANNELS, TOTAL_BUDGET,
                                  MAX_TOTAL_CONTACTS, _mock_fallback, seed=0)
        a = agent.Agent()
        camps = sanitize_campaigns(a.act(env), env.tariffs)
        assert 1 <= len(camps) <= 10 and any("llm skipped" in l for l in a.log), a.log
    finally:
        agent._llm_call = orig
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
    print("llm: невалидные предложения отсеяны, сбой API → план без LLM")


if __name__ == "__main__":
    check_never_empty()
    check_time_limit()
    check_llm()
    if not agent.llm_config()[1]:
        print("нет LLM-ключа: agent (full) = exp_prior")
    # ponytail: промпт одинаков на всех seed (профиль тот же) — один ответ LLM на прогон
    agent._llm_call = functools.lru_cache(agent._llm_call)
    runs = int(sys.argv[sys.argv.index("--runs") + 1]) if "--runs" in sys.argv else 10
    keep = float(sys.argv[sys.argv.index("--keep") + 1]) if "--keep" in sys.argv else None  # жёсткие миры
    rows = []
    for seed in range(runs):
        model = (struct_world(seed) if "--struct" in sys.argv
                 else world(seed) if keep is None else harsh_world(seed, keep))
        row = {"agent": run(agent.Agent, model, seed), "template": run(agent_template.Agent, model, seed),
               "prior_only": run(PriorOnly, model, seed), "oracle": run(make_oracle(model), model, seed),
               "exp_prior": run(ExpPrior, model, seed)}
        rows.append(row)
        print(f"seed {seed:2}: " + "  ".join(f"{k}={v:>12,.0f}" for k, v in row.items()))
    df = pd.DataFrame(rows)
    print("\n" + df.agg(["median", "min"]).T.map("{:,.0f}".format).to_string())
    print(f"agent > 0: {(df.agent > 0).sum()}/{runs}   agent/oracle: {df.agent.median() / df.oracle.median():.2f}")
    assert (df.agent > 0).all() and df.agent.median() > df.template.median(), "агент не лучше шаблона / уходит в минус"
