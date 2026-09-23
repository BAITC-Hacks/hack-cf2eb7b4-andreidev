"""
Агент тарифных кампаний: эксперты предлагают рукава → адаптивные пилоты (EI) → жадный план.

Ключевое наблюдение (из описания среды в пакете участника): эффект зависит только от ячейки
(current_tariff, arpu_segment), целевого тарифа и канала, причём канал лишь
умножает эффект. Поэтому гипотеза = ячейка × target, а один SMS-пилот даёт
оценку для всех каналов сразу (base = observed / multiplier).
"""

import json
import math
import os
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

NOISE_STD = 0.804   # шум на абонента, опубликован в документации пакета участника
PRIOR_STD = 0.25    # широкий: на судействе эффекты другие, чем в истории
ARMS_PER_CELL = 4
LCB_K = 0.5         # в план: mu - k*sigma > 0; 0 уходит в минус в пессимистичных мирах, 1 слишком робок
EI_STOP = 0.005     # хватит разведки, когда EI < 0.5% от стартового максимума
PILOT_CH = "sms"    # в 1.69 раза информативнее push на контакт
USE_FIT = True      # поправка prior: влезает ли трафик аудитории в пакет target
DATA_DIR = Path(__file__).parent / "data"
KEY = ["tariff_plan_code_from", "seg", "tariff_plan_code_to"]
LLM_PER_CELL = 2
LLM_CLIP = 0.5      # |base| из истории почти всегда < 0.35; больше — фантазия модели


def _history(data_dir=DATA_DIR):
    h = pd.read_csv(data_dir / "change_tariff.csv")
    h = h[h["AVG_ARPU_PREV_3M"] >= 100].copy()
    h["seg"] = pd.cut(h["AVG_ARPU_PREV_3M"], [-np.inf, 1000, 5000, np.inf],
                      labels=["LOW", "MID", "HIGH"]).astype(str)
    h["pct"] = ((h["AVG_ARPU_NEXT_3M"] - h["AVG_ARPU_PREV_3M"]) / h["AVG_ARPU_PREV_3M"]).clip(-1, 3)
    return h


def _fit_shift(h, profile, dict_tariff, data_dir=DATA_DIR):
    """
    Сдвиг mean pct по (from, seg, to): β × (доля аудитории ячейки, чей трафик влезает
    в пакет target − та же доля в истории перехода). β — внутри-переходная регрессия
    pct на «влезает», т.е. не путается с тем, какие переходы вообще популярны.
    """
    pkg = dict_tariff.set_index("tariff_plan_code")["Data_in_PKG"]
    usage = (pd.read_csv(data_dir / "traffic.csv", usecols=["ID_NUMBER", "DATA_VOLUME"])
             .groupby("ID_NUMBER")["DATA_VOLUME"].mean())
    h = h[h["ID_NUMBER"].isin(usage.index)].copy()
    h["fit"] = (h["ID_NUMBER"].map(usage) <= h["tariff_plan_code_to"].map(pkg)).astype(float)
    grp = h.groupby(KEY)
    d_fit, d_pct = h["fit"] - grp["fit"].transform("mean"), h["pct"] - grp["pct"].transform("mean")
    beta = float((d_fit * d_pct).sum() / (d_fit ** 2).sum())
    f_hist = grp["fit"].mean()

    dv = profile["DATA_VOLUME"]
    f_aud = {}
    for t, cap in pkg.items():
        fits = (dv <= cap).where(dv.notna()).astype(float)
        for (cur, seg), v in fits.groupby([profile["current_tariff"], profile["arpu_segment"]]).mean().items():
            f_aud[(cur, seg, t)] = v
    shift = {k: beta * (f_aud[k] - fh) for k, fh in f_hist.items() if k in f_aud and not np.isnan(f_aud[k])}
    return pd.Series(shift, dtype=float), beta


def _prior(h, shift=None):
    """base = shrunk (mean pct + сдвиг по трафику) × conversion share по (from, seg, to)."""
    g = h.groupby(KEY)["pct"].agg(["mean", "size"])
    if shift is not None:
        g["mean"] = g["mean"] + shift.reindex(g.index).fillna(0.0)
    g = g.reset_index()
    g["total"] = g.groupby(["tariff_plan_code_from", "seg"])["size"].transform("sum")
    g["base"] = g["mean"] * g["size"] / (g["size"] + 10) * g["size"] / g["total"]
    return {(r.tariff_plan_code_from, r.seg, r.tariff_plan_code_to): r.base for r in g.itertuples()}


def _llm_call(prompt):
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps({"model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"), "temperature": 0,
                         "response_format": {"type": "json_object"},
                         "messages": [{"role": "user", "content": prompt}]}).encode(),
        headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def _ei(mu, sd, best):
    z = (mu - best) / sd
    return sd * (z * 0.5 * (1 + math.erf(z / math.sqrt(2))) + math.exp(-z * z / 2) / math.sqrt(2 * math.pi))


class Agent:
    def act(self, env):
        self.log = []
        arms = {}
        try:
            cells, arms = self._arms(env)
            self._explore(env, cells, arms)
            plan = self._plan(env, cells, arms)
            try:
                self._expert_report(arms)
            except Exception as e:  # отчёт — только лог, план из-за него не теряем
                self.log.append(f"report skipped: {type(e).__name__}: {e}")
            if plan:
                return plan
        except Exception as e:  # ponytail: любой сбой → безопасный fallback, а не падение
            self.log.append(f"fallback: {type(e).__name__}: {e}")
        return self._fallback(env, arms)

    # --- гипотезы: портфель экспертов ------------------------------------
    experts = ("prior", "llm")  # heuristic (upsell по пакету) пробовали — хуже минимум, см. README

    def _arms(self, env):
        p = env.customer_profile
        cells = (p.groupby(["current_tariff", "arpu_segment"])
                 .agg(n=("ID_NUMBER", "size"), S=("predicted_arpu", "sum")))
        cells = {k: {"n": int(r.n), "S": float(r.S)} for k, r in cells.iterrows()}
        tariffs = list(env.tariffs["tariff_plan_code"])
        props = {}
        for name in self.experts:
            try:
                props[name] = getattr(self, f"_expert_{name}")(env, cells, tariffs)
                self.log.append(f"{name}: {len(props[name])} arms")
            except Exception as e:  # эксперт сломался — остальные работают
                self.log.append(f"{name} skipped: {type(e).__name__}: {e}")
        # реестр: один рукав на (cur, seg, target), src — кто его предложил;
        # mu — из истории, если она есть, иначе среднее догадок экспертов
        arms = {}
        for k in dict.fromkeys(k for pr in props.values() for k in pr):  # порядок важен: ничьи в EI
            src = {n for n, pr in props.items() if k in pr}
            mu = props["prior"][k] if "prior" in src else float(np.mean([props[n][k] for n in src]))
            arms[k] = {"mu": mu, "var": PRIOR_STD ** 2, "n": 0, "src": src, "obs": []}
        return cells, arms

    def _expert_prior(self, env, cells, tariffs):
        prior = {}
        try:
            h = _history()
            shift = None
            if USE_FIT:
                try:
                    shift, beta = _fit_shift(h, env.customer_profile, env.tariffs)
                    self.log.append(f"fit: beta={beta:.3f}, pairs={len(shift)}")
                except Exception as e:  # нет traffic.csv и т.п. — prior без поправки
                    self.log.append(f"fit skipped: {type(e).__name__}: {e}")
            prior = _prior(h, shift)
        except Exception as e:  # нет истории — рукава всё равно нужны, mu = 0
            self.log.append(f"history skipped: {type(e).__name__}: {e}")
        out = {}
        for (cur, seg) in cells:
            ranked = sorted((t for t in tariffs if t != cur),
                            key=lambda t: prior.get((cur, seg, t), 0.0), reverse=True)
            for t in ranked[:ARMS_PER_CELL]:
                out[(cur, seg, t)] = prior.get((cur, seg, t), 0.0)
        return out

    def _expert_llm(self, env, cells, tariffs):
        if not os.environ.get("OPENAI_API_KEY"):
            self.log.append("llm: нет OPENAI_API_KEY")
            return {}
        p = env.customer_profile
        med = p.groupby(["current_tariff", "arpu_segment"])[["ARPU_3m_avg", "DATA_VOLUME", "OUT_LOC_OFFNET_MIN"]].median()
        rows = [f"{cur},{seg},{c['n']},{med.loc[(cur, seg)].round(0).tolist()}" for (cur, seg), c in cells.items()]
        prompt = (
            "Ты аналитик телеком-оператора. Нужно выбрать, на какой тариф предлагать перейти "
            "абонентам каждой ячейки (текущий тариф × ARPU-сегмент), чтобы вырос ARPU.\n"
            "Тарифы (CSV):\n" + env.tariffs.to_csv(index=False) +
            "\nЯчейки: current_tariff,arpu_segment,n,[медиана ARPU_3m, DATA_VOLUME МБ, минуты на других операторов]\n"
            + "\n".join(rows) +
            f"\n\nДля каждой ячейки предложи до {LLM_PER_CELL} target-тарифов (не равных текущему) и оценку "
            "expected — ожидаемое относительное изменение ARPU всей ячейки с учётом того, что перейдёт лишь "
            "часть абонентов (типичные значения от -0.1 до 0.3). Ответ строго JSON: "
            '{"arms": [{"cur": "...", "seg": "...", "target": "...", "expected": 0.05}]}'
        )
        return self._parse_llm(_llm_call(prompt), cells, tariffs)

    @staticmethod
    def _parse_llm(text, cells, tariffs):
        out, per_cell = {}, {}
        for r in json.loads(text).get("arms", []):
            try:
                k = (str(r["cur"]), str(r["seg"]), str(r["target"]))
                mu = float(np.clip(float(r["expected"]), -LLM_CLIP, LLM_CLIP))
            except (KeyError, TypeError, ValueError):
                continue
            if k[:2] in cells and k[2] in tariffs and k[2] != k[0] and per_cell.get(k[:2], 0) < LLM_PER_CELL:
                out[k] = mu
                per_cell[k[:2]] = per_cell.get(k[:2], 0) + 1
        return out

    # --- адаптивные пилоты ----------------------------------------------
    def _arm_ei(self, cells, arms):
        out = {}
        for k, a in arms.items():
            cur, seg, _ = k
            best = max([0.0] + [b["mu"] for kk, b in arms.items() if kk[:2] == (cur, seg) and kk != k])
            out[k] = cells[(cur, seg)]["S"] * _ei(a["mu"], math.sqrt(a["var"]), best)
        return out

    def _explore(self, env, cells, arms):
        mult = env.channels[PILOT_CH]["conversion_multiplier"]
        cost = env.channels[PILOT_CH]["cost_per_contact"]
        ei0 = None
        while env.pilots_left > 0:
            ei = self._arm_ei(cells, arms)
            k = max(ei, key=ei.get)
            ei0 = ei0 or ei[k]
            if ei[k] < EI_STOP * ei0:
                break
            cur, seg, target = k
            n = int(np.clip(0.08 * cells[(cur, seg)]["n"], 60, 200))
            # резерв: на оставшиеся контакты должно хватить SMS в финальном плане
            if env.remaining_budget - n * cost < cost * (env.remaining_contacts - n):
                break
            try:
                res = env.run_pilot(target_tariff=target, channel=PILOT_CH, n_customers=n,
                                    filter_arpu_segment=seg, filter_current_tariff=cur)
            except (RuntimeError, ValueError):
                break
            a, m = arms[k], res["n_customers"]
            obs, noise_var = res["observed_lift_ratio"] / mult, (NOISE_STD / mult) ** 2 / m
            prec = 1 / a["var"] + 1 / noise_var
            a["mu"] = (a["mu"] / a["var"] + obs / noise_var) / prec
            a["var"], a["n"] = 1 / prec, a["n"] + m
            a.setdefault("obs", []).append(obs)
            self.log.append(f"pilot {cur}/{seg}->{target} n={m} obs={obs:.3f} post={a['mu']:.3f}±{math.sqrt(a['var']):.3f}")

    # --- финальный план -------------------------------------------------
    def _plan(self, env, cells, arms):
        ch = env.channels
        names = sorted(ch, key=lambda c: ch[c]["cost_per_contact"])  # push, sms, ads, call
        picks = []
        for (cur, seg), c in cells.items():
            # гипотеза без истории (только LLM) идёт в план лишь после пилота: догадке модели на слово не верим
            cand = [(a["mu"], a["var"], k[2]) for k, a in arms.items()
                    if k[:2] == (cur, seg) and ("prior" in a.get("src", ("prior",)) or a["n"])]
            if not cand:
                continue
            mu, var, target = max(cand)
            if mu - LCB_K * math.sqrt(var) > 0:
                picks.append({"cur": cur, "seg": seg, "target": target, "mu": mu, **c})

        # охват: сначала самые ценные на контакт
        picks.sort(key=lambda x: x["mu"] * x["S"] / x["n"], reverse=True)
        room, chosen = env.remaining_contacts, []
        for x in picks:
            if x["n"] <= room:
                chosen.append(x)
                room -= x["n"]
        self._chosen = chosen

        # канал: всем push, затем жадный апгрейд по Δnet/Δcost в рамках бюджета
        net = lambda x, c: x["mu"] * ch[c]["conversion_multiplier"] * x["S"] - ch[c]["cost_per_contact"] * x["n"]
        money = env.remaining_budget
        for x in chosen:
            x["ch"] = names[0]
        while True:
            best = None
            for x in chosen:
                for c in names[names.index(x["ch"]) + 1:]:
                    dcost = (ch[c]["cost_per_contact"] - ch[x["ch"]]["cost_per_contact"]) * x["n"]
                    dnet = net(x, c) - net(x, x["ch"])
                    if dnet > 0 and 0 < dcost <= money and (best is None or dnet / dcost > best[0]):
                        best = (dnet / dcost, x, c, dcost)
            if best is None:
                break
            _, x, c, dcost = best
            x["ch"], money = c, money - dcost

        # группировка: arpu × список тарифов выбирает ровно нужные ячейки
        groups = {}
        for x in chosen:
            groups.setdefault((x["seg"], x["target"], x["ch"]), []).append(x)
        campaigns = []
        for (seg, target, c), xs in groups.items():
            chunk, size = [], 0
            for x in sorted(xs, key=lambda x: x["cur"]) + [None]:
                if x is None or size + x["n"] > 5000:
                    if chunk:
                        v = sum(net(y, c) for y in chunk)
                        campaigns.append((v, v / size, {
                            "campaign_name": f"{seg}_{target}_{c}_{len(campaigns) + 1}",
                            "filter_arpu_segment": seg,
                            "filter_current_tariff": ";".join(y["cur"] for y in chunk),
                            "target_tariff": target, "channel": c}))
                    chunk, size = [], 0
                if x is not None:
                    chunk.append(x)
                    size += x["n"]
        top = sorted(campaigns, key=lambda t: t[0], reverse=True)[:10]
        return [camp for _, _, camp in sorted(top, key=lambda t: t[1], reverse=True)]

    def _expert_report(self, arms):
        """Кто из экспертов предложил пилотируемые и попавшие в план рукава — для логов и ablation."""
        planned = {(x["cur"], x["seg"], x["target"]) for x in self._chosen}
        for name in self.experts:
            mine = {k: a for k, a in arms.items() if name in a.get("src", ())}
            obs = [o for a in mine.values() for o in a.get("obs", [])]
            self.log.append(
                f"expert {name}: arms={len(mine)} pilots={len(obs)} "
                f"mean_obs={np.mean(obs) if obs else float('nan'):.3f} "
                f"hit={np.mean([o > 0 for o in obs]) if obs else float('nan'):.2f} "
                f"planned={len(planned & mine.keys())}")

    def _fallback(self, env, arms):
        tried = [(a["mu"] - LCB_K * math.sqrt(a["var"]), k) for k, a in arms.items() if a["n"]]
        if tried and max(tried)[0] > 0:
            cur, seg, target = max(tried)[1]
            return [{"campaign_name": "fallback", "filter_arpu_segment": seg,
                     "filter_current_tariff": cur, "target_tariff": target, "channel": "sms"}]
        # ТЗ требует ≥1 кампании. ponytail: бесплатный push на наименее убыточную ячейку,
        # худший случай — потеря |mu|·0.5·S одной ячейки
        p = env.customer_profile
        S = p.groupby(["current_tariff", "arpu_segment"])["predicted_arpu"].sum()
        pool = {k: a for k, a in arms.items() if a["n"]} or arms
        if pool:
            cur, seg, target = max(pool, key=lambda k: pool[k]["mu"] * S.get(k[:2], 0.0))
        else:  # arms пусты (сбой до гипотез): самая маленькая по ARPU ячейка, любой другой тариф
            cur, seg = S.idxmin()
            target = next(t for t in env.tariffs["tariff_plan_code"] if t != cur)
        return [{"campaign_name": "fallback_push", "filter_arpu_segment": seg,
                 "filter_current_tariff": cur, "target_tariff": target, "channel": "push"}]
