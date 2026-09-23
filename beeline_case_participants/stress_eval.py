"""
Стресс-проверка: агент на ИСКАЖЁННЫХ мирах (эффекты ≠ истории), как на судействе.

    python stress_eval.py [--runs 10]

Сравнивает наш агент с шаблоном, prior-only (без пилотов) и оракулом (знает эффекты).
"""

import math
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


class PriorOnly(agent.Agent):
    def _explore(self, env, cells, arms):
        pass


def make_oracle(model):
    fc = model["conversion_rate"].median()

    class Oracle(agent.Agent):
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


if __name__ == "__main__":
    runs = int(sys.argv[sys.argv.index("--runs") + 1]) if "--runs" in sys.argv else 10
    rows = []
    for seed in range(runs):
        model = world(seed)
        row = {"agent": run(agent.Agent, model, seed), "template": run(agent_template.Agent, model, seed),
               "prior_only": run(PriorOnly, model, seed), "oracle": run(make_oracle(model), model, seed)}
        rows.append(row)
        print(f"seed {seed:2}: " + "  ".join(f"{k}={v:>12,.0f}" for k, v in row.items()))
    df = pd.DataFrame(rows)
    print("\nмедиана:\n" + df.median().map("{:,.0f}".format).to_string())
    print(f"agent > 0: {(df.agent > 0).sum()}/{runs}   agent/oracle: {df.agent.median() / df.oracle.median():.2f}")
    assert (df.agent > 0).all() and df.agent.median() > df.template.median(), "агент не лучше шаблона / уходит в минус"
