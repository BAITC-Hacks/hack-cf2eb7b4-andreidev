"""
Postgres: пользователи и сессии (fastapi-users) + лаборатория версий.
Агент, local_eval.py и make_submission.py от БД не зависят — только server.py и lab.py.

    python db.py import-lab [lab]   # разовый перенос старых файлов lab/ в БД
"""
import json
import math
import os
import re
import sys
from pathlib import Path

from fastapi_users_db_sqlalchemy import SQLAlchemyBaseUserTableUUID
from fastapi_users_db_sqlalchemy.access_token import SQLAlchemyBaseAccessTokenTableUUID
from sqlalchemy import JSON, CheckConstraint, DateTime, Float, Integer, String, Text, create_engine, func, text
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

ROLES = ("manager", "analyst", "admin")
URL = os.environ.get("DATABASE_URL", "postgresql://cockpit:cockpit@localhost:5432/cockpit").replace(
    "postgresql://", "postgresql+psycopg://", 1)
SQLITE = URL.startswith("sqlite")  # десктоп-сборка: один файл, без схем
ASYNC_URL = URL.replace("sqlite://", "sqlite+aiosqlite://", 1) if SQLITE else URL
insert = (sqlite if SQLITE else postgresql).insert  # on_conflict_* у обоих диалектов одинаковый
JSONB = JSON().with_variant(postgresql.JSONB(), "postgresql")


def _clean(o):  # JSONB не принимает NaN/inf — в файлах они жили, в БД становятся null
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


def _dumps(o):
    return json.dumps(_clean(o), ensure_ascii=False, default=lambda x: _clean(float(x)))


class Base(DeclarativeBase):
    pass


class User(SQLAlchemyBaseUserTableUUID, Base):
    role: Mapped[str] = mapped_column(String(16), default="manager")
    __table_args__ = (CheckConstraint(f"role IN {ROLES}", name="user_role"),)


class AccessToken(SQLAlchemyBaseAccessTokenTableUUID, Base):
    pass


class LabVersion(Base):  # версия — тот же dict, что раньше лежал в lab/versions/vNNN.json
    __tablename__ = "lab_version"
    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    data: Mapped[dict] = mapped_column(JSONB)


class LabAudit(Base):
    __tablename__ = "lab_audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict] = mapped_column(JSONB)


class LlmCache(Base):
    __tablename__ = "llm_cache"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    response: Mapped[str] = mapped_column(Text)


class TemplateNet(Base):
    __tablename__ = "template_net"
    seed: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    data: Mapped[dict] = mapped_column(JSONB)


class CampaignResult(Base):
    """База знаний: наблюдение на аудитории (пилот прогона или итог кампании из CRM) → Agent.feedback."""
    __tablename__ = "campaign_result"
    key: Mapped[str] = mapped_column(String(200), primary_key=True)  # дедуп: {world}:{seed}:{pilot} или sha1 строки CSV
    world: Mapped[str] = mapped_column(String(32), index=True)  # mock | stress:<seed> — эффекты разных миров не смешиваем
    cur: Mapped[str] = mapped_column(String(32))
    seg: Mapped[str] = mapped_column(String(8))
    target: Mapped[str] = mapped_column(String(32))
    channel: Mapped[str] = mapped_column(String(16))
    n: Mapped[int] = mapped_column(Integer)
    lift_ratio: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(16))  # pilot | campaign
    created_by: Mapped[str] = mapped_column(String(320))
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())


class DatasetUpload(Base):
    __tablename__ = "dataset_upload"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    rows: Mapped[int] = mapped_column(Integer)
    sha: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(String(320))
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())


def use_schema(schema):
    """Все таблицы — в схеме DB_SCHEMA (второй стенд api-lab, самопроверки). Процессы-воркеры наследуют через env."""
    global SCHEMA, engine, async_engine, async_session
    assert re.fullmatch(r"\w+", schema), schema
    os.environ["DB_SCHEMA"] = SCHEMA = schema
    kw = {"connect_args": {"timeout": 30, "check_same_thread": False} if SQLITE else {"options": f"-c search_path={schema}"},
          "pool_pre_ping": True, "json_serializer": _dumps}
    engine = create_engine(URL, **kw)
    async_engine = create_async_engine(ASYNC_URL, **kw)
    async_session = async_sessionmaker(async_engine, expire_on_commit=False)


use_schema(os.environ.get("DB_SCHEMA", "public"))


def init():
    # ponytail: create_all без миграций; Alembic, когда схема начнёт меняться на живых данных
    if not SQLITE:
        with engine.begin() as c:
            c.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"'))
    Base.metadata.create_all(engine)


def drop_schema():
    if SQLITE:
        return Base.metadata.drop_all(engine)
    with engine.begin() as c:
        c.execute(text(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))


def upsert(model, **row):
    pk = [c.name for c in model.__table__.primary_key]
    with Session(engine) as s, s.begin():
        s.execute(insert(model).values(**row).on_conflict_do_update(index_elements=pk, set_={k: v for k, v in row.items() if k not in pk}))


def import_lab(d):
    d = Path(d)
    for p in sorted((d / "versions").glob("v*.json")):
        v = json.loads(p.read_text())
        upsert(LabVersion, id=v["id"], data=v)
    for p in (d / "llm_cache").glob("*.txt"):
        upsert(LlmCache, key=p.stem, response=p.read_text())
    if (d / "template.json").exists():
        for seed, r in json.loads((d / "template.json").read_text()).items():
            upsert(TemplateNet, seed=int(seed), data=r)
    if (d / "audit.jsonl").exists():
        with Session(engine) as s, s.begin():
            s.add_all(LabAudit(data=json.loads(line)) for line in (d / "audit.jsonl").read_text().splitlines() if line.strip())


if __name__ == "__main__":
    if sys.argv[1:2] == ["import-lab"]:
        init()
        import_lab(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).parent / "lab")
        with Session(engine) as s:
            print("lab_version:", s.query(LabVersion).count(), "llm_cache:", s.query(LlmCache).count(),
                  "template_net:", s.query(TemplateNet).count(), "lab_audit:", s.query(LabAudit).count())
    else:
        use_schema("test_db")
        init()
        try:
            upsert(LabVersion, id="v001", data={"x": float("nan"), "y": [1.5, float("inf")]})
            upsert(LabVersion, id="v001", data={"x": 2})
            with Session(engine) as s:
                assert s.get(LabVersion, "v001").data == {"x": 2}
            upsert(LabVersion, id="v002", data={"x": float("nan"), "y": [1.5, float("inf")]})
            with Session(engine) as s:
                assert s.get(LabVersion, "v002").data == {"x": None, "y": [1.5, None]}
            print("ok: db upsert + NaN→null")
        finally:
            drop_schema()
