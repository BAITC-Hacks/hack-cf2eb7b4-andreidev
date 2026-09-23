"""
Стресс-проверка: агент на ИСКАЖЁННЫХ мирах (эффекты ≠ истории), как в боевой среде.

    python stress_eval.py [--runs 10]
    python stress_eval.py --keep 0    # жёсткие миры: история бесполезна (0) или наполовину верна (0.5)
    python stress_eval.py --struct    # структурные миры: сдвиг эффекта общий на target и сегмент
    python stress_eval.py --prior-cv     # CatBoost-prior против группового среднего: K-fold по ID, ранжирующие метрики
    python stress_eval.py --prior-debug  # важности признаков, крупнейшие сдвиги μ и их SHAP-причины

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
    как сказано в описании среды (в world() — около половины).
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
    общий сдвиг на target и на сегмент (например, tariff_8 в боевой среде привлекательнее).
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
    """Нет data/ и всё убыточно: агент всё равно обязан вернуть ≥1 валидную кампанию (обязательное требование)."""
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


def _prior_data():
    h = agent._history()
    cols = agent.usage_cols(profile.columns)
    return h, cols, agent.hist_rows(h, agent._usage(cols))


def check_prior_model():
    """CatBoost-prior: схема train = inference, нет утечки target и будущего, единицы совпадают, hist не изменился."""
    h, cols, rows = _prior_data()
    # режим hist: prior побитово тот же, что до появления модели
    g = h.groupby(agent.KEY)["pct"].agg(["mean", "size"])
    total = g.groupby(level=[0, 1])["size"].transform("sum")
    old = (g["mean"] * g["size"] / (g["size"] + 10) * g["size"] / total).to_dict()
    new = agent._prior(h)
    assert new.keys() == old.keys() and max(abs(new[k] - old[k]) for k in old) < 1e-12, "hist prior изменился"
    try:
        import catboost  # noqa: F401
    except ImportError:
        print("prior model: catboost не установлен — проверен только режим hist")
        return
    x_tr = agent._features(rows, cols, dict_tariff)
    x_in = agent._features(agent.profile_rows(profile, cols).assign(tariff_plan_code_to="tariff_9"), cols, dict_tariff)
    assert list(x_tr.columns) == list(x_in.columns), "колонки train ≠ inference"
    bad = [c for c in x_tr.columns if x_tr[c].dtype.kind != x_in[c].dtype.kind]
    assert not bad, f"типы train ≠ inference: {bad}"
    leak = [c for c in x_tr.columns if any(s in c.upper() for s in ("NEXT", "PCT"))]
    assert not leak, f"признаки из target: {leak}"
    months = pd.to_datetime(pd.read_csv("data/traffic.csv", usecols=["time_key"])["time_key"])
    assert months.max() < pd.to_datetime(history["TIME_KEY"]).min(), "трафик после перехода"
    a, b = rows[list(cols)].mean(), profile[list(cols)].mean()  # не медиана: у LTE в истории она ≈ 0
    both = (a > 0) & (b > 0)
    ratio = (b[both] / a[both])
    assert ratio.between(0.1, 10).all(), f"единицы history ≠ profile: {ratio[~ratio.between(0.1, 10)].to_dict()}"
    print(f"prior model: схема {x_tr.shape[1]} признаков совпадает, утечек нет, "
          f"средние трафика profile/history {ratio.min():.2f}–{ratio.max():.2f}, hist prior не изменился")


def _cell_metrics(pred, truth):
    """Внутри ячейки (from, seg): pairwise accuracy, precision@3, regret top-1 — по тому, как ранжирует _expert_prior."""
    pw, pk, rg = [], [], []
    for _, t in truth.groupby(level=[0, 1]):
        if len(t) < 2:
            continue
        p = pred.reindex(t.index)
        i, j = np.triu_indices(len(t), 1)
        dt, dp = t.values[i] - t.values[j], p.values[i] - p.values[j]
        pw += list(np.sign(dt[dt != 0]) == np.sign(dp[dt != 0]))
        k = min(3, len(t))
        pk.append(len(set(p.nlargest(k).index) & set(t.nlargest(k).index)) / k)
        rg.append(t.max() - t[p.idxmax()])
    return np.mean(pw), np.mean(pk), np.mean(rg)


def prior_cv(folds=5, min_rows=5):
    """
    K-fold по ID (строка = абонент). Модель и hist-статистики — на train-фолде, отложенные строки
    идут в тот же model_prior/model_mu как «аудитория»; правда — средние pct по (from, seg, to) на них.
    """
    h, cols, rows = _prior_data()
    fold = np.random.default_rng(0).permutation(len(rows)) % folds
    variants = {"hist": None, "shift": ("catboost_shift", "rows", 0.0), "full": ("catboost_full", "rows", 0.0),
                "full λ=0.1": ("catboost_full", "rows", 0.1), "full arpu": ("catboost_full", "arpu", 0.0)}
    out = {v: [] for v in variants}
    row_m = {"hist": [], "model": []}
    lam = agent.RISK_LAMBDA
    for f in range(folds):
        tr, te = rows[fold != f], rows[fold == f]
        fit = agent.fit_prior_model(tr, cols, dict_tariff)
        g = tr.groupby(agent.KEY)["pct"].agg(["mean", "size"])
        conv = g["size"] / g.groupby(level=[0, 1])["size"].transform("sum")
        hist_s = g["mean"] * g["size"] / (g["size"] + 10)
        # по строкам: групповое среднее train против модели
        y = te["pct"].values
        p_hist = pd.MultiIndex.from_frame(te[agent.KEY]).map(hist_s.to_dict().get)
        p_hist = np.nan_to_num(np.array(p_hist, dtype=float))
        p_mod = fit[0].predict(agent._features(te, cols, dict_tariff))
        for name, p in (("hist", p_hist), ("model", p_mod)):
            row_m[name].append((np.sqrt(np.mean((p - y) ** 2)), np.mean(np.abs(p - y)), np.mean(np.sign(p) == np.sign(y))))
        truth = te.groupby(agent.KEY)["pct"].agg(["mean", "size"])
        truth = truth[truth["size"] >= min_rows]["mean"]
        for v, cfg in variants.items():
            if cfg is None:
                mu = hist_s
            else:
                agent.RISK_LAMBDA = cfg[2]
                mp = agent.model_prior(fit, te, g.index, cols, dict_tariff, weight=cfg[1])
                mu = agent.model_mu(tr, mp, cfg[0])[2]["mu"]
            mu = mu.reindex(g.index).fillna(hist_s)
            t = truth[truth.index.isin(mu.index)]
            sp = mu.reindex(t.index).rank().corr(t.rank())
            base = mu * conv  # так ранжирует _expert_prior
            out[v].append((sp, *_cell_metrics(base, (t * conv.reindex(t.index)))))
        agent.RISK_LAMBDA = lam
    print("по строкам (отложенные абоненты):")
    print(pd.DataFrame({k: np.mean(v, axis=0) for k, v in row_m.items()}, index=["RMSE", "MAE", "sign"]).T.round(4).to_string())
    print(f"\nпо группам (from, seg, to) с ≥{min_rows} отложенными строками; внутри ячеек — по μ×conversion, как _expert_prior:")
    print(pd.DataFrame({k: np.mean(v, axis=0) for k, v in out.items()},
                       index=["spearman", "pairwise", "prec@3", "regret@1"]).T.round(4).to_string())


def prior_debug(top=20):
    """Важности признаков, крупнейшие сдвиги μ_full − μ_hist на аудитории и что их двигает (SHAP)."""
    from catboost import Pool
    agent.PRIOR_MODEL = "catboost_full"
    a, h = agent.Agent(), agent._history()
    a._model_prior(type("Env", (), {"customer_profile": profile, "tariffs": dict_tariff})(), h)
    print("\n".join(a.log))
    cols = agent.usage_cols(profile.columns)
    model = agent._train_prior_model(dict_tariff.to_csv(index=False), cols)[0]
    print("\nPredictionValuesChange, топ-15:")
    print(model.get_feature_importance(prettified=True).head(15).to_string(index=False))
    g = a.prior_table.assign(d=lambda x: x["mu"] - x["hist_s"])
    rows = agent.profile_rows(profile, cols)
    for title, part in (("рост", g.nlargest(top, "d")), ("падение", g.nsmallest(top, "d"))):
        print(f"\nтоп-{top}, {title} μ_full − μ_hist:")
        for k, r in part.iterrows():
            x = agent._features(rows[(rows["tariff_plan_code_from"] == k[0]) & (rows["seg"] == k[1])]
                                .assign(tariff_plan_code_to=k[2]), cols, dict_tariff)
            shap = model.get_feature_importance(Pool(x, cat_features=agent.CAT), type="ShapValues")[:, :-1].mean(axis=0)
            why = ", ".join(f"{x.columns[i]} {shap[i]:+.3f}" for i in np.argsort(-np.abs(shap))[:3])
            print(f"  {'/'.join(k):32} n={r['size']:<4} Δ={r.d:+.3f} hist={r.hist_s:+.3f} model={r.model_mean:+.3f} "
                  f"u={r.u:.2f} ood={r.ood:.2f} Δprice={r.d_price:+.0f} guard={r.guard} | {why}")


if __name__ == "__main__":
    if "--prior-cv" in sys.argv:
        sys.exit(prior_cv())
    if "--prior-debug" in sys.argv:
        sys.exit(prior_debug())
    check_never_empty()
    check_time_limit()
    check_llm()
    check_prior_model()
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
