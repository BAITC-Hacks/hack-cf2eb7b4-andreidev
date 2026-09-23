"""
Новые данные для кокпита: загрузка CSV и база знаний (прошлые пилоты и итоги кампаний).

- Базовые выгрузки (change_tariff, traffic, dict_tariff, customer_profile) пишутся в UPLOAD_DIR, `data/` не трогаем:
  сдача (agent.py + submission.csv) считается на исходных данных. Предыдущая версия файла остаётся в UPLOAD_DIR/prev.
- campaign_results — наблюдения на ЭТОЙ аудитории → Postgres (campaign_result) → Agent.feedback на следующем прогоне.

    python datasets.py   # self-check во временной схеме БД и временной папке
"""
import hashlib
import io
import os
import shutil
from datetime import datetime
from pathlib import Path

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

import agent
import db
import stress_eval as se
from mock_environment import CHANNELS

ROOT = Path(__file__).parent
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", ROOT / "uploads"))
BASE = {"change_tariff": "data/change_tariff.csv", "traffic": "data/traffic.csv",
        "dict_tariff": "data/dict_tariff.csv", "customer_profile": "customer_profile.csv"}
KINDS = (*BASE, "campaign_results")
FEEDBACK_COLS = ("cur", "seg", "target", "channel", "n", "lift_ratio")  # + необязательные world, source
TARIFF_COLS = {"change_tariff": ("tariff_plan_code_from", "tariff_plan_code_to"), "traffic": ("tariff_plan_code",),
               "customer_profile": ("current_tariff",), "campaign_results": ("cur", "target")}
SEGMENTS = {"LOW", "MID", "HIGH"}
MAX_ERRORS = 20


def path(kind):
    """Активный файл: загруженный, если есть, иначе исходный из пакета."""
    up = UPLOAD_DIR / BASE[kind]
    return up if up.exists() else ROOT / BASE[kind]


def validate(kind, df):
    """Ошибки CSV (до MAX_ERRORS). Пусто — можно принимать."""
    errs = []
    if df.empty:
        return ["файл пустой"]
    need = FEEDBACK_COLS if kind == "campaign_results" else tuple(pd.read_csv(path(kind), nrows=0).columns)
    missing = [c for c in need if c not in df.columns]
    if missing:
        return [f"нет колонок: {', '.join(missing)}"]

    def bad(mask, what):
        rows = list(df.index[mask][:5] + 2)  # +2: заголовок и нумерация с 1, как в Excel
        if len(rows):
            errs.append(f"{what}: {int(mask.sum())} строк, например {rows}")

    if kind != "campaign_results":  # числовые колонки текущего файла должны остаться числовыми
        sample = pd.read_csv(path(kind), nrows=1000)
        for c in sample.select_dtypes("number").columns:
            bad(pd.to_numeric(df[c], errors="coerce").isna() & df[c].notna(), f"{c}: не число")
    tariffs = set(se.dict_tariff["tariff_plan_code"])
    for c in TARIFF_COLS.get(kind, ()):
        bad(~df[c].isin(tariffs), f"{c}: тариф не из справочника")
    if kind == "dict_tariff":
        bad(df["tariff_plan_code"].duplicated(), "tariff_plan_code: дубль")
    if kind == "customer_profile":
        bad(df["ID_NUMBER"].duplicated(), "ID_NUMBER: дубль")
        bad(~df["arpu_segment"].isin(SEGMENTS), "arpu_segment: не LOW/MID/HIGH")
    if kind == "campaign_results":
        n, lift = pd.to_numeric(df["n"], errors="coerce"), pd.to_numeric(df["lift_ratio"], errors="coerce")
        bad(~df["seg"].isin(SEGMENTS), "seg: не LOW/MID/HIGH")
        bad(~df["channel"].isin(CHANNELS), f"channel: не из {', '.join(CHANNELS)}")
        bad(~(n > 0) | (n != n.round()), "n: не целое > 0")
        bad(~lift.between(-1, 3), "lift_ratio: не число в [-1, 3]")
        bad(df["cur"] == df["target"], "target совпадает с cur")
        if "world" in df:  # иначе длинная строка падает в БД (String(32)) с 500
            bad(~df["world"].fillna("mock").astype(str).str.fullmatch(r"mock|stress:\d{1,9}"), "world: не mock / stress:<seed>")
        if "source" in df:
            bad(~df["source"].fillna("campaign").isin(("campaign", "pilot")), "source: не campaign / pilot")
    return errs[:MAX_ERRORS]


def read(raw):
    try:
        return pd.read_csv(io.BytesIO(raw))
    except (ValueError, UnicodeDecodeError, pd.errors.ParserError) as e:
        raise ValueError([f"не CSV: {e}"]) from e


def save(kind, raw, user):
    """Принять CSV: ValueError(список ошибок) или число принятых строк. Базовые выгрузки сразу становятся активными."""
    df = read(raw)
    errs = validate(kind, df)
    if errs:
        raise ValueError(errs)
    if kind == "campaign_results":
        rows = save_feedback([{**r, "key": _row_key(r)} for r in _feedback_rows(df)], user)
    else:
        dest = UPLOAD_DIR / BASE[kind]
        if dest.parent.name == "data" and not dest.parent.exists():  # agent читает все три файла из одной папки
            shutil.copytree(ROOT / "data", dest.parent, ignore=shutil.ignore_patterns(dest.name, ".*"))
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            (UPLOAD_DIR / "prev").mkdir(exist_ok=True)
            dest.rename(UPLOAD_DIR / "prev" / f"{kind}-{datetime.now():%Y%m%d-%H%M%S-%f}.csv")
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(raw)
        tmp.replace(dest)
        activate()
        rows = len(df)
    with Session(db.engine) as s, s.begin():
        s.add(db.DatasetUpload(kind=kind, rows=rows, sha=hashlib.sha256(raw).hexdigest(), created_by=user))
    return rows


def _feedback_rows(df):
    df = df.assign(world=df["world"].fillna("mock") if "world" in df else "mock",
                   source=df["source"].fillna("campaign") if "source" in df else "campaign")
    return [{"world": str(r.world), "cur": r.cur, "seg": r.seg, "target": r.target, "channel": r.channel,
             "n": int(r.n), "lift_ratio": float(r.lift_ratio), "source": str(r.source)} for r in df.itertuples()]


def _row_key(r):
    return hashlib.sha1("|".join(str(r[c]) for c in ("world", *FEEDBACK_COLS, "source")).encode()).hexdigest()


def save_feedback(rows, user):
    """Вставка в базу знаний; строки с уже известным key пропускаются. Возвращает число новых."""
    if not rows:
        return 0
    with Session(db.engine) as s, s.begin():
        res = s.execute(insert(db.CampaignResult).values([{**r, "created_by": user} for r in rows])
                        .on_conflict_do_nothing(index_elements=["key"]).returning(db.CampaignResult.key))
        return len(res.all())  # rowcount у multi-values insert в psycopg = -1


def save_pilots(pilots, world, seed, user):
    """Пилоты прогона (`run_payload()["pilots"]`) → база знаний. Повторное сохранение того же прогона — no-op."""
    return save_feedback([{"key": f"{world}:{seed}:{p['name']}", "world": world, "cur": p["cur"], "seg": p["seg"],
                           "target": p["target"], "channel": p["channel"], "n": p["n"], "lift_ratio": p["ratio"],
                           "source": "pilot"} for p in pilots if p["ratio"] is not None], user)


def load_feedback(world):
    with Session(db.engine) as s:
        rows = s.scalars(select(db.CampaignResult).where(db.CampaignResult.world == world)).all()
    return tuple({c: getattr(r, c) for c in FEEDBACK_COLS} for r in rows)


def summary():
    with Session(db.engine) as s:
        last = {u.kind: u for u in s.scalars(select(db.DatasetUpload).order_by(db.DatasetUpload.id))}
        worlds = s.execute(select(db.CampaignResult.world, db.CampaignResult.source, func.count())
                           .group_by(db.CampaignResult.world, db.CampaignResult.source)).all()
    out = []
    for kind in KINDS:
        u = last.get(kind)
        row = {"kind": kind, "uploaded_by": u and u.created_by, "uploaded_at": u and u.created_at.isoformat()}
        if kind in BASE:
            with open(path(kind), "rb") as f:
                row |= {"source": "upload" if u else "original",  # копии оригиналов в UPLOAD_DIR/data — не загрузки
                        "rows": sum(1 for _ in f) - 1, "columns": list(pd.read_csv(path(kind), nrows=0).columns)}
        else:
            row |= {"source": "db", "rows": sum(c for *_, c in worlds), "columns": [*FEEDBACK_COLS, "world", "source"]}
        out.append(row)
    return {"datasets": out, "feedback": [{"world": w, "source": src, "rows": c} for w, src, c in worlds]}


def activate():
    """Подложить загруженные выгрузки агенту и стресс-мирам. Кэши server.py чистит сам."""
    if (UPLOAD_DIR / "data").exists():
        agent.DATA_DIR = UPLOAD_DIR / "data"
    se.profile, se.dict_tariff, se.history = (pd.read_csv(path(k)) for k in ("customer_profile", "dict_tariff",
                                                                               "change_tariff"))
    agent._train_prior_model.cache_clear()


if __name__ == "__main__":
    import tempfile

    from environment import make_environment
    from mock_environment import MAX_TOTAL_CONTACTS, TOTAL_BUDGET, _mock_fallback, _mock_impact_model

    db.use_schema("test_datasets")
    db.init()
    UPLOAD_DIR = Path(tempfile.mkdtemp())
    try:
        good = "cur,seg,target,channel,n,lift_ratio\ntariff_8,MID,tariff_9,sms,200,0.4\n"
        assert validate("campaign_results", read(good.encode())) == []
        errs = validate("campaign_results", read(b"cur,seg,target,channel,n,lift_ratio\n"
                                                 b"tariff_8,XXL,nope,fax,-3,9\n"))
        assert len(errs) == 5, errs
        assert validate("campaign_results", read(b"cur,seg\ntariff_8,MID\n"))[0].startswith("нет колонок")
        assert validate("campaign_results", read(good.replace("\n", ",world,source\n", 1)
                                                 .replace("0.4\n", "0.4,stress:3,pilot\n").encode())) == []
        errs = validate("campaign_results", read(good.replace("\n", ",world,source\n", 1)
                                                 .replace("0.4\n", f"0.4,{'w' * 40},{'s' * 20}\n").encode()))
        assert len(errs) == 2 and errs[0].startswith("world") and errs[1].startswith("source"), errs
        try:
            save("campaign_results", b"\xff\xfe\x00", "t")
            raise AssertionError("мусор принят")
        except ValueError:
            pass

        assert save("campaign_results", good.encode(), "t") == 1
        assert save("campaign_results", good.encode(), "t") == 0, "дубль строки"
        fb = load_feedback("mock")
        assert fb == ({"cur": "tariff_8", "seg": "MID", "target": "tariff_9", "channel": "sms", "n": 200,
                       "lift_ratio": 0.4},), fb
        assert load_feedback("stress:0") == ()

        bad = se.history.head(50).assign(tariff_plan_code_to="tariff_999")
        assert any("справочника" in e for e in validate("change_tariff", bad))
        assert "нет колонок" in validate("change_tariff", bad.drop(columns=["TIME_KEY"]))[0]

        # агент: наблюдение из базы знаний сдвигает апостериор рукава, которого у экспертов нет
        env, _ = make_environment(se.profile, _mock_impact_model(se.history), se.dict_tariff, CHANNELS,
                                  TOTAL_BUDGET, MAX_TOTAL_CONTACTS, _mock_fallback, seed=0)
        a = agent.Agent()
        a.experts = ("prior",)
        _, arms0 = a._arms(env)
        cur, seg, _t = next(iter(arms0))
        target = next(t for t in se.dict_tariff["tariff_plan_code"] if t != cur and (cur, seg, t) not in arms0)
        a.feedback = ({"cur": cur, "seg": seg, "target": target, "channel": "sms", "n": 400, "lift_ratio": 0.3},)
        _, arms = a._arms(env)
        arm = arms[(cur, seg, target)]
        assert arm["src"] == {"feedback"} and arm["n"] == 400 and arm["mu"] > 0.3, arm  # 0.3/0.65 ≈ 0.46
        assert any(line.startswith("feedback: 1 rows → 1 arms") for line in a.log), a.log

        # базовая выгрузка: копия справочника становится активной, исходный data/ не тронут
        dict_raw = (ROOT / BASE["dict_tariff"]).read_bytes()
        assert save("dict_tariff", dict_raw, "t") == len(se.dict_tariff)
        assert path("dict_tariff") == UPLOAD_DIR / BASE["dict_tariff"] and agent.DATA_DIR == UPLOAD_DIR / "data"
        assert (UPLOAD_DIR / "data" / "traffic.csv").exists()
        save("dict_tariff", dict_raw, "t")
        assert len(list((UPLOAD_DIR / "prev").glob("dict_tariff-*.csv"))) == 1
        s = summary()
        assert {d["kind"]: d["source"] for d in s["datasets"]}["dict_tariff"] == "upload", s
        assert s["feedback"] == [{"world": "mock", "source": "campaign", "rows": 1}], s
        print("ok: datasets — валидация, дедуп, feedback в агенте, активная выгрузка")
    finally:
        db.drop_schema()
        shutil.rmtree(UPLOAD_DIR)
