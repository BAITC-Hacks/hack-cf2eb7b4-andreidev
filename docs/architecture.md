# Архитектура

```
пакет среды (env, data/) ──▶ agent.py ──▶ план кампаний ──▶ make_submission.py ──▶ submission.csv
                                       │  ▲
                        агрегаты ячеек ▼  │ до 2 target на ячейку
                                 LLM (OpenRouter / OpenAI, опционально)

web/ (React) ──/api──▶ server.py (FastAPI) ──▶ agent.py в мок- или стресс-мире
                            │                  lab.py: версии настроек, матрица тестов, gate
                            ▼
                        Postgres (db.py, auth.py): пользователи, сессии, версии, аудит LLM
```

Две независимые части:
- **Агент** — `agent.py` + `submission.csv`. Агент получает среду (`Agent.act(env)`), читает историю из `data/`, проводит пилоты через `env.run_pilot` и возвращает план. От БД, сервера и UI не зависит.
- **Campaign Cockpit** — сервер, БД и фронтенд, чтобы видеть, что агент делает и почему, загружать новые данные и улучшать настройки агента в лаборатории. Агенту не нужен.

## Поток данных агента
1. `make_submission.py` / `local_eval.py` (пакет среды) строят среду из `customer_profile.csv` и `data/`.
2. `Agent.act(env)`: prior из `data/change_tariff.csv` → эксперты предлагают рукава → адаптивные пилоты → жадный план ≤ 10 кампаний. Подробно — [agent.md](agent.md).
3. План валидирует и скорит `scoring_core.py`, `make_submission.py` пишет `submission.csv`.

## Модули

### Наши файлы
| Файл | Назначение |
|---|---|
| `agent.py` | агент: prior, эксперты (история, LLM), EI-пилоты, LCB-отбор, план, fallback, privacy gateway для LLM |
| `stress_eval.py` | локальный стенд: искажённые, структурные и жёсткие миры, CV CatBoost-prior. Агенту не нужен |
| `lab.py` | лаборатория версий настроек агента: матрица тестов, детекторы, ремедиация, gate, promote — [lab.md](lab.md) |
| `server.py` | FastAPI: прогон агента с трассировкой (`Traced`), стратегии, данные, лаборатория, Swagger — [cockpit.md](cockpit.md) |
| `auth.py` | вход и роли на fastapi-users, bootstrap пользователей, CLI `add` |
| `db.py` | модели SQLAlchemy и схема Postgres |
| `datasets.py` | загрузка и валидация CSV, база знаний — [data.md](data.md) |
| `security_check.py` | security-проверка API — [../SECURITY.md](../SECURITY.md) |
| `Dockerfile`, `docker-compose.yml` | образ API + собранного фронта, Postgres 17 |

### Пакет среды (не в git)
`environment.py`, `mock_environment.py`, `scoring_core.py`, `local_eval.py`, `make_submission.py`, `agent_template.py`, `customer_profile.csv`, `feature_dictionary.csv`, `tariff_dictionary.csv`, `data/` (`change_tariff.csv`, `traffic.csv`, `arpu_monthly.csv`, `dict_tariff.csv`). Лежит в корне репо рядом с нашими файлами.

### Фронтенд `web/src`
| Файл | Назначение |
|---|---|
| `App.tsx` | кокпит analyst/admin: навигация по вкладкам, панель запуска, hash-роутинг (`#plan` и т. п.) |
| `Manager.tsx` | упрощённый экран менеджера: «Сформировать план» → таблица → CSV |
| `Auth.tsx` | форма входа |
| `Guide.tsx` | помощник при первом входе и вкладка «Документация» (`#docs`) |
| `api.ts` | типы ответов API и fetch-обёртки |
| `ui.tsx` | общие компоненты |
| `tabs/` | экраны кокпита: `Command` (командный центр), `Rules` (как считается), `Audience` → `Hypotheses` → `Pilots` → `Plan` (конвейер агента), `Strategies`, `Privacy`, `Data` |
| `lab/` | экраны лаборатории: `Versions`, `Compare`, `Runs`, `Issues`, `Fixes`; состояние — `useLab.ts` |
