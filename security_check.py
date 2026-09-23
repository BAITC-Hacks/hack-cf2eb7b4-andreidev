"""
Security-проверка API: доступ по ролям, сессии, лимит входа, загрузки, параметры, лаборатория, заголовки.
Что и почему проверяется — SECURITY.md.

    docker compose up -d db
    python3 security_check.py     # схема БД sec_test (удаляется в конце), LLM выключен, exit 1 при провале
"""
import os
import sys
import time
from pathlib import Path

os.environ.update(DB_SCHEMA="sec_test", OPENAI_API_KEY="", OPENROUTER_API_KEY="", AUTH_DEMO="1")
os.environ.pop("AUTH_USERS", None)
os.chdir(Path(__file__).parent)
import db  # noqa: E402

db.drop_schema()
from fastapi.testclient import TestClient  # noqa: E402
import server  # noqa: E402

R = []


def check(name, ok, detail=""):
    R.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def client():
    return TestClient(server.app, raise_server_exceptions=False)


def login(role):
    c = client()
    r = c.post("/api/auth/login", data={"username": f"{role}@cockpit.demo", "password": role})
    assert r.status_code == 204, r.text
    return c


try:
    anon = client()
    spec = anon.get("/api/openapi.json").json()
    # маршруты без побочных эффектов тяжелее 403 — проверяем только доступ, не выполнение
    cheap = [("get", "/api/me"), ("get", "/api/data"), ("get", "/api/lab/versions"), ("get", "/api/lab/versions/v001"),
             ("get", "/api/lab/targets"), ("get", "/api/lab/runs"), ("get", "/api/lab/audit")]
    routes = [(m, p) for p, ops in spec["paths"].items() for m in ops if not p.startswith("/api/auth/")]
    fill = lambda p: p.replace("{vid}", "v001").replace("{kind}", "campaign_results")  # noqa: E731

    # 1. без cookie — 401 везде
    bad = [(m, p, s) for m, p in routes if (s := getattr(anon, m)(fill(p)).status_code) != 401]
    check("401 без входа на всех маршрутах", not bad, str(bad))

    # 2. матрица ролей: чужие маршруты → 403 до выполнения
    need = {"/api/me": "manager", "/api/run": "manager", "/api/strategies": "analyst", "/api/data": "analyst",
            "/api/data/{kind}": "analyst", "/api/feedback/run": "analyst"}
    rank = {"manager": 0, "analyst": 1, "admin": 2}
    sess = {r: login(r) for r in rank}
    leaks = []
    for m, p in routes:
        lvl = rank[need.get(p, "admin")]
        for role, c in sess.items():
            if rank[role] < lvl:
                s = getattr(c, m)(fill(p)).status_code
                if s != 403:
                    leaks.append((role, m, p, s))
    check("403 для недостаточной роли (матрица роль×маршрут)", not leaks, str(leaks))
    for m, p in cheap:
        s = getattr(sess["admin"], m)(p).status_code
        check(f"admin {m.upper()} {p} → 200", s == 200, str(s))

    # 3. сессии
    forged = client()
    forged.cookies.set("session", "A" * 43)
    check("поддельный cookie → 401", forged.get("/api/me").status_code == 401)
    c = login("manager")
    tok = c.cookies.get("session")
    c.post("/api/auth/logout")
    old = client()
    old.cookies.set("session", tok)
    check("cookie после logout → 401", old.get("/api/me").status_code == 401)
    s = client().post("/api/auth/login", data={"username": "nobody@x.ru", "password": "x"}).status_code
    check("неизвестный email → 400 (как неверный пароль)", s == 400, str(s))

    # 4. перебор пароля
    bf = client()
    codes = [bf.post("/api/auth/login", data={"username": "admin@cockpit.demo", "password": f"guess{i}"}).status_code
             for i in range(30)]
    check("перебор пароля ограничен (есть 429 за 30 попыток)", 429 in codes, f"коды: {sorted(set(codes))}")

    # 5. загрузка CSV (analyst)
    a = sess["analyst"]
    up = lambda kind, body, name="x.csv": a.post(f"/api/data/{kind}", files={"file": (name, body, "text/csv")})  # noqa: E731
    head = b"cur,seg,target,channel,n,lift_ratio"
    cases = {
        "не CSV (бинарный мусор)": up("campaign_results", b"\x00\xff\xfe" * 100).status_code,
        "пустой файл": up("campaign_results", b"").status_code,
        "длинный world (>32)": up("campaign_results", head + b",world\ntariff_8,MID,tariff_9,sms,200,0.4," + b"w" * 100 + b"\n").status_code,
        "длинный source (>16)": up("campaign_results", head + b",source\ntariff_8,MID,tariff_9,sms,200,0.4," + b"s" * 100 + b"\n").status_code,
        "формула в cur": up("campaign_results", head + b"\n=cmd|' /C calc'!A0,MID,tariff_9,sms,200,0.4\n").status_code,
        "kind=../x": a.post("/api/data/..%2Fx", files={"file": ("x.csv", b"a\n1\n")}).status_code,
        "базовая выгрузка от analyst": up("dict_tariff", b"tariff_plan_code\nx\n").status_code,
        "50 МБ + 1": up("campaign_results", b"a" * (50 * 2 ** 20 + 1)).status_code,
    }
    for k, s in cases.items():
        check(f"upload: {k} → 4xx", 400 <= s < 500, str(s))

    # 6. /api/run: инъекции в параметрах (тяжёлые прогоны — только пара)
    m = sess["manager"]
    for q, name in [("model=a%20b", "пробел в model"), ("model=" + "x" * 101, "model > 100"), ("world=prod", "world вне enum"),
                    ("seed=abc", "seed не число")]:
        s = m.get(f"/api/run?llm=false&feedback=false&{q}").status_code
        check(f"run: {name} → 422", s == 422, str(s))
    t = time.time()
    s = m.get("/api/run?llm=true&feedback=false&model=openai/o1-pro&seed=123456").status_code
    check("run: manager не может выбрать произвольную (дорогую) модель", s == 403, f"{s}, {time.time() - t:.1f} c")
    s = m.get(f"/api/run?llm=false&feedback=false&seed={2 ** 70}").status_code
    check("run: огромный seed не роняет сервер (не 500)", s != 500, str(s))

    # 7. лаборатория
    ad = sess["admin"]
    s = ad.post("/api/lab/versions", json={"parent_id": "v001", "changes": {"__import__('os')": 1, "evil": 1}}).status_code
    check("lab: чужие ключи → 400", s == 400, str(s))
    for path in ("/api/lab/versions/v999/evaluate", "/api/lab/versions/v999/remediate"):
        s = ad.post(path).status_code
        check(f"lab: {path} несуществующей версии → 404", s == 404, str(s))
    import lab
    src = open("agent.py").read()
    evil = '"\n#x\r\\"; import os; os.system("id") #'
    clean, _ = lab.validate({"LLM_PROMPT_EXTRA": evil})
    new = lab.set_constants(src, clean)
    check("lab: строка LLM_PROMPT_EXTRA не выходит из литерала",
          lab.read_constants(new)["LLM_PROMPT_EXTRA"] == clean["LLM_PROMPT_EXTRA"] and new.count("\n") == src.count("\n"))

    # 8. заголовки
    h = anon.get("/api/me").headers
    check("X-Frame-Options / nosniff", h.get("x-frame-options") == "DENY" and h.get("x-content-type-options") == "nosniff",
          str({k: h.get(k) for k in ("x-frame-options", "x-content-type-options")}))

    # 9. пустая таблица пользователей без AUTH_USERS и AUTH_DEMO → старт падает, демо-паролей нет
    import auth
    db.drop_schema()
    db.use_schema("sec_test_empty")
    db.init()
    os.environ.pop("AUTH_DEMO")
    try:
        auth.bootstrap()
        check("без AUTH_USERS/AUTH_DEMO демо-пользователи не заводятся", False, "bootstrap прошёл")
    except RuntimeError:
        check("без AUTH_USERS/AUTH_DEMO демо-пользователи не заводятся", True)
finally:
    db.drop_schema()

fails = [n for n, ok in R if not ok]
print(f"\n{len(R) - len(fails)}/{len(R)} passed")
sys.exit(1 if fails else 0)
