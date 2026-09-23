"""
Агент тарифных кампаний: prior из истории → адаптивные пилоты (EI) → жадный план.

Ключевое наблюдение (из описания среды в пакете участника): эффект зависит только от ячейки
(current_tariff, arpu_segment), целевого тарифа и канала, причём канал лишь
умножает эффект. Поэтому гипотеза = ячейка × target, а один SMS-пилот даёт
оценку для всех каналов сразу (base = observed / multiplier).
"""

import math
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
            if plan:
                return plan
        except Exception as e:  # ponytail: любой сбой → безопасный fallback, а не падение
            self.log.append(f"fallback: {type(e).__name__}: {e}")
        return self._fallback(env, arms)

    # --- гипотезы -------------------------------------------------------
    def _arms(self, env):
        p = env.customer_profile
        cells = (p.groupby(["current_tariff", "arpu_segment"])
                 .agg(n=("ID_NUMBER", "size"), S=("predicted_arpu", "sum")))
        cells = {k: {"n": int(r.n), "S": float(r.S)} for k, r in cells.iterrows()}
        prior = {}
        try:
            h = _history()
            shift = None
            if USE_FIT:
                try:
                    shift, beta = _fit_shift(h, p, env.tariffs)
                    self.log.append(f"fit: beta={beta:.3f}, pairs={len(shift)}")
                except Exception as e:  # нет traffic.csv и т.п. — prior без поправки
                    self.log.append(f"fit skipped: {type(e).__name__}: {e}")
            prior = _prior(h, shift)
        except Exception as e:
            self.log.append(f"prior skipped: {type(e).__name__}: {e}")
        tariffs = list(env.tariffs["tariff_plan_code"])
        arms = {}
        for (cur, seg) in cells:
            ranked = sorted((t for t in tariffs if t != cur),
                            key=lambda t: prior.get((cur, seg, t), 0.0), reverse=True)
            for t in ranked[:ARMS_PER_CELL]:
                arms[(cur, seg, t)] = {"mu": prior.get((cur, seg, t), 0.0), "var": PRIOR_STD ** 2, "n": 0}
        return cells, arms

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
            self.log.append(f"pilot {cur}/{seg}->{target} n={m} obs={obs:.3f} post={a['mu']:.3f}±{math.sqrt(a['var']):.3f}")

    # --- финальный план -------------------------------------------------
    def _plan(self, env, cells, arms):
        ch = env.channels
        names = sorted(ch, key=lambda c: ch[c]["cost_per_contact"])  # push, sms, ads, call
        picks = []
        for (cur, seg), c in cells.items():
            cand = [(a["mu"], a["var"], k[2]) for k, a in arms.items() if k[:2] == (cur, seg)]
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

    def _fallback(self, env, arms):
        tried = [(a["mu"] - LCB_K * math.sqrt(a["var"]), k) for k, a in arms.items() if a["n"]]
        if not tried or max(tried)[0] <= 0:
            return []
        cur, seg, target = max(tried)[1]
        return [{"campaign_name": "fallback", "filter_arpu_segment": seg,
                 "filter_current_tariff": cur, "target_tariff": target, "channel": "sms"}]
