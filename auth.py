"""
Вход и роли на fastapi-users: cookie `session` + токены в Postgres (logout их отзывает).
manager — простой экран плана; analyst — весь кокпит; admin — кокпит + лаборатория.

    python auth.py add <email> <пароль> <manager|analyst|admin>   # завести / сменить пароль и роль
    python auth.py                                                 # self-check во временной схеме
"""
import os
import sys
import uuid

from fastapi import Depends, HTTPException
from fastapi_users import BaseUserManager, FastAPIUsers, UUIDIDMixin, schemas
from fastapi_users.authentication import AuthenticationBackend, CookieTransport
from fastapi_users.authentication.strategy.db import DatabaseStrategy
from fastapi_users.password import PasswordHelper
from fastapi_users_db_sqlalchemy import SQLAlchemyUserDatabase
from fastapi_users_db_sqlalchemy.access_token import SQLAlchemyAccessTokenDatabase
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import db

SECRET = os.environ.get("AUTH_SECRET", "dev-secret-change-me")
WEEK = 7 * 24 * 3600


class UserRead(schemas.BaseUser[uuid.UUID]):
    role: str
# UserUpdate без role и users-router не подключён: иначе PATCH /users/me дал бы менеджеру сделать себя admin


async def get_session():
    async with db.async_session() as s:
        yield s


async def get_user_db(s=Depends(get_session)):
    yield SQLAlchemyUserDatabase(s, db.User)


async def get_token_db(s=Depends(get_session)):
    yield SQLAlchemyAccessTokenDatabase(s, db.AccessToken)


class UserManager(UUIDIDMixin, BaseUserManager[db.User, uuid.UUID]):
    reset_password_token_secret = SECRET
    verification_token_secret = SECRET


async def get_user_manager(user_db=Depends(get_user_db)):
    yield UserManager(user_db)


backend = AuthenticationBackend(
    name="cookie",
    # ponytail: cookie_secure=False — стенд по http; True при выкладке за HTTPS
    transport=CookieTransport(cookie_name="session", cookie_max_age=WEEK, cookie_secure=False, cookie_samesite="lax"),
    get_strategy=lambda token_db=Depends(get_token_db): DatabaseStrategy(token_db, lifetime_seconds=WEEK),
)
fastapi_users = FastAPIUsers[db.User, uuid.UUID](get_user_manager, [backend])
current_user = fastapi_users.current_user(active=True)


def require(*roles):
    async def dep(user: db.User = Depends(current_user)):
        if user.role not in roles:
            raise HTTPException(403, f"недоступно для роли {user.role}")
        return user
    return dep


def add_user(email, password, role):
    if role not in db.ROLES:
        raise ValueError(f"роль {role!r} — нужна одна из {db.ROLES}")
    email = email.strip().lower()
    with Session(db.engine) as s, s.begin():
        u = s.scalar(select(db.User).where(func.lower(db.User.email) == email)) or db.User(email=email)
        u.hashed_password, u.role, u.is_superuser, u.is_active = PasswordHelper().hash(password), role, role == "admin", True
        s.add(u)


def bootstrap():
    """Пустая таблица → пользователи из AUTH_USERS="email:пароль:роль,..." или демо-набор (только при AUTH_DEMO=1)."""
    with Session(db.engine) as s:
        if s.scalar(select(func.count()).select_from(db.User)):
            return
    spec = os.environ.get("AUTH_USERS", "").strip()
    if not spec and os.environ.get("AUTH_DEMO") != "1":  # пароль = роль нельзя завести на выкладке случайно
        raise RuntimeError("auth: пустая таблица пользователей — задайте AUTH_USERS или AUTH_DEMO=1 для демо-входа")
    rows = [(x.split(":", 1)[0], *x.split(":", 1)[1].rsplit(":", 1)) for x in spec.split(",") if x.strip()] if spec \
        else [(f"{r}@cockpit.demo", r, r) for r in db.ROLES]
    if not spec:
        print("WARNING auth: AUTH_USERS не задан — заведены демо-пользователи <роль>@cockpit.demo с паролем = роль")
    for email, pw, role in rows:
        add_user(email, pw, role)


if __name__ == "__main__":
    if sys.argv[1:2] == ["add"] and len(sys.argv) == 5:
        db.init()
        add_user(*sys.argv[2:])
        print("ok:", sys.argv[2], sys.argv[4])
        sys.exit()
    db.use_schema("test_auth")
    db.drop_schema()
    os.environ.pop("AUTH_USERS", None)
    os.environ["AUTH_DEMO"] = "1"
    from fastapi.testclient import TestClient
    import server  # поднимает схему, демо-пользователей и baseline лаборатории

    try:
        c = TestClient(server.app)
        assert c.get("/api/run").status_code == 401
        assert c.post("/api/auth/login", data={"username": "manager@cockpit.demo", "password": "нет"}).status_code == 400

        def login(role):
            c.cookies.clear()
            r = c.post("/api/auth/login", data={"username": f"{role.upper()}@cockpit.demo", "password": role})
            assert r.status_code == 204, r.text
            return c.get("/api/me").json()

        assert login("manager")["role"] == "manager"
        assert c.get("/api/lab/versions").status_code == 403 and c.get("/api/strategies").status_code == 403
        assert login("analyst")["role"] == "analyst" and c.get("/api/lab/versions").status_code == 403
        assert login("admin")["role"] == "admin" and c.get("/api/lab/versions").json()["versions"][0]["id"] == "v001"
        assert c.post("/api/auth/logout").status_code == 204 and c.get("/api/me").status_code == 401
        add_user("admin@cockpit.demo", "new", "manager")  # смена роли и пароля
        assert c.post("/api/auth/login", data={"username": "admin@cockpit.demo", "password": "new"}).status_code == 204
        assert c.get("/api/me").json()["role"] == "manager"
        try:
            add_user("x@cockpit.demo", "x", "root")
            raise AssertionError("роль root принята")
        except ValueError:
            pass
        print("ok: 401 без входа, 400 на неверный пароль, роли manager/analyst/admin, logout отзывает сессию")
    finally:
        db.drop_schema()
