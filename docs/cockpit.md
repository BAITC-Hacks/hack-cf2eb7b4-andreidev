# UI: Campaign Cockpit

Веб-интерфейс, в котором видно, что агент делает и почему. `server.py` (FastAPI) запускает агента в мок- или стресс-мире и отдаёт его внутреннее состояние: prior и posterior рукавов, пилоты, план, скоринг. `agent.py` при этом не меняется. `web/` — React 19 + HeroUI v3 + Vite 8.

## Запуск
Для разработки:
```bash
pip install fastapi uvicorn "fastapi-users[sqlalchemy]" "psycopg[binary]"   # только для UI, в сдачу не входит
docker compose up -d db                 # Postgres на :5432 — пользователи, сессии, лаборатория
uvicorn server:app --port 8000          # из корня репо; OPENROUTER_API_KEY / LLM_MODEL (или OPENAI_API_KEY) берутся из .env
cd web && npm i && npm run dev          # http://localhost:5173, /api проксируется на :8000
```

Или одной командой в Docker (API и собранный фронт на одном порту):
```bash
docker compose up --build               # http://localhost:8000; ключи LLM из .env, данные — в томе pgdata
```
Пакет организаторов (`data/`, `environment.py`, `mock_environment.py`, `scoring_core.py`, `customer_profile.csv` и т. д.) должен лежать в корне репо: в git его нет, в образ он попадает из рабочей копии. Переменные окружения — [configuration.md](configuration.md).

## Экраны
Экраны повторяют конвейер агента (1 Аудитория → 2 Гипотезы → 3 Пилоты → 4 Финальный план), плюс Командный центр, «Как считается», Стратегии (вклад экспертов и ablation на стресс-мирах), Privacy (что видит LLM, prompt inspector), Логи и [Данные](data.md). В «Пилотах» есть пошаговый replay разведки. Экран можно открыть по ссылке `#hypotheses`, `#plan` и т. п.

При первом входе в каждую роль открывается помощник: что это за система, как работает агент и шаги для этой роли. Повторно он открывается кнопкой «?» рядом с пользователем. У кнопок и переключателей есть тултипы, документация по возможностям лежит на вкладке `#docs` (у менеджера — «Как это работает»).

Swagger с описанием всех эндпоинтов: http://localhost:8000/api/docs (в dev — http://localhost:5173/api/docs). Войти прямо там: `POST /api/auth/login` → «Try it out», дальше запросы идут с cookie сессии.

## Роли и вход
Вход — [fastapi-users](https://fastapi-users.github.io/fastapi-users/): cookie `session`, токены сессий в Postgres (выход их отзывает). Вид выбирается по роли, URL один.

| Роль | Что видит | API |
|---|---|---|
| `manager` | простой экран: «Сформировать план» → таблица кампаний (кому / что / канал / затраты / эффект / надёжность) → CSV | `/api/run` |
| `analyst` | весь кокпит, без лаборатории | + `/api/strategies`, `/api/data`, `/api/feedback/run` |
| `admin` | кокпит + [лаборатория версий](lab.md) | + `/api/lab/*`, загрузка базовых выгрузок |

При пустой таблице пользователей сервер заводит их из `AUTH_USERS="email:пароль:роль,..."`. Если переменной нет и `AUTH_DEMO=1` (так по умолчанию в `docker compose`), заводятся демо-пользователи (пароль равен роли); без обеих сервер не стартует:

| email | пароль | роль |
|---|---|---|
| `manager@cockpit.demo` | `manager` | manager |
| `analyst@cockpit.demo` | `analyst` | analyst |
| `admin@cockpit.demo` | `admin` | admin |

**Для стенда задайте свои**: `AUTH_USERS`, `AUTH_SECRET` и `AUTH_DEMO=0` в `.env`. Вход ограничен 10 неудачными попытками с IP за 5 минут (429), manager выбирает модель LLM только из пресетов. Подробно о защите и чек-лист выкладки — [SECURITY.md](../SECURITY.md). Завести пользователя или сменить пароль и роль:
```bash
python3 auth.py add boss@corp.ru 'пароль' manager
```
Публичной регистрации нет: роли раздаёт admin.

## Хранилище
Всё состояние UI лежит в Postgres (`db.py`, таблицы создаются при старте). Строка подключения — `DATABASE_URL`, `DB_SCHEMA` разводит стенды по схемам.

| Таблица | Что хранит |
|---|---|
| `user`, `accesstoken` | пользователи и сессии (fastapi-users) |
| `lab_version` | версии лаборатории |
| `lab_audit` | журнал действий и аудит LLM-ремедиации |
| `llm_cache` | кэш ответов LLM по хэшу промпта |
| `template_net` | результаты шаблонной стратегии по seed (кэш для матрицы лаборатории) |
| `campaign_result` | [база знаний](data.md#база-знаний) |
| `dataset_upload` | журнал загрузок CSV |

Агент, `local_eval.py` и `make_submission.py` от БД не зависят. Файлами остаются только `agent.py` (promote правит его константы) и `submission.csv`. Перенести старую папку `lab/` в БД: `python3 db.py import-lab lab`.
