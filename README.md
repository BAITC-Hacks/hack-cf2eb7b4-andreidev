# Агент тарифных кампаний Beeline

`agent.py`: портфель экспертов (история + LLM) предлагает гипотезы → адаптивные пилоты → жадный план под лимиты. pandas/numpy + stdlib. Без LLM-ключа (`OPENROUTER_API_KEY` / `OPENAI_API_KEY`) детерминирован.

**Назначение.** Решение кейса «Beeline Tariff Marketing Campaigns»: агент сам проводит пилоты на аудитории и отдаёт план до 10 кампаний (кому, какой тариф, какой канал), чтобы чистый прирост ARPU был максимальным при лимитах бюджета, охвата и числа пилотов. Пользователь — аналитик маркетинга. Для него есть веб-интерфейс Campaign Cockpit: видно, почему агент принял каждое решение. Для менеджера — упрощённый экран «сформировать план → CSV».

## Быстрый старт (проверка с чистого клона)
Требования: Python 3.13 (на нём проверено), для UI — Node 22 или Docker.

1. **Положить пакет участника в корень репо.** Пакет выдают организаторы кейса, в git он не коммитится (`.gitignore`). Нужны файлы: `local_eval.py`, `make_submission.py`, `environment.py`, `mock_environment.py`, `scoring_core.py`, `customer_profile.csv`, `feature_dictionary.csv`, `tariff_dictionary.csv` и папка `data/` (`change_tariff.csv`, `traffic.csv`, `arpu_monthly.csv`, `dict_tariff.csv`).
2. **Установить зависимости агента:**
   ```bash
   pip install -r requirements.txt
   ```
3. **Проверить основной сценарий** (must-have из ТЗ):
   ```bash
   python local_eval.py              # ожидается «Статус: PASS», net ≈ 4.4M, «Пилотов проведено: 20 из 20», нет строк «отброшена»
   python local_eval.py --runs 10    # устойчивость: все 10 прогонов в плюс
   python make_submission.py         # пересобирает submission.csv; должен совпасть с закоммиченным (git diff пуст)
   ```
4. **UI (по желанию):** `docker compose up --build` → http://localhost:8000, вход `manager@cockpit.demo` / `manager` → «Сформировать план». Подробнее — [docs/cockpit.md](docs/cockpit.md).

LLM-ключ не обязателен: без него LLM-эксперт выключается, и агент работает на истории и пилотах.

## Архитектура
```
пакет организатора (env, data/) ──▶ agent.py ──▶ план кампаний ──▶ make_submission.py ──▶ submission.csv
                                       │  ▲
                        агрегаты ячеек ▼  │ до 2 target на ячейку
                                 LLM (OpenRouter / OpenAI, опционально)

web/ (React) ──/api──▶ server.py (FastAPI) ──▶ agent.py в мок- или стресс-мире
                            │                  lab.py: версии настроек, матрица тестов, gate
                            ▼
                        Postgres (db.py, auth.py): пользователи, сессии, версии, аудит LLM
```
- `agent.py` — сдаваемый агент (`Agent.act(env)`). От БД и UI не зависит.
- `stress_eval.py` — локальный стенд: искажённые и жёсткие миры для проверки устойчивости.
- `lab.py` — лаборатория версий настроек агента (цикл самоулучшения с gate).
- `server.py`, `auth.py`, `db.py`, `web/` — Campaign Cockpit: API, роли, хранилище, фронтенд.

Все модули и поток данных — [docs/architecture.md](docs/architecture.md).

## Технологии
- **Агент:** Python, pandas, numpy, stdlib (`urllib` для LLM); CatBoost — только в опциональном режиме `PRIOR_MODEL=catboost_*`. Байесовские апостериоры, expected improvement для выбора пилотов, LCB-отбор и жадный план.
- **LLM:** OpenAI-совместимый API — OpenRouter (по умолчанию `openai/gpt-4o-mini`) или OpenAI (`gpt-4o-mini`).
- **Бэкенд UI:** FastAPI, Uvicorn, fastapi-users (SQLAlchemy), psycopg, PostgreSQL 17.
- **Фронтенд:** React 19, HeroUI v3, Vite 8, TypeScript.
- **Запуск:** Docker, Docker Compose.

## Документация
| Документ | О чём |
|---|---|
| [Архитектура](docs/architecture.md) | модули, поток данных, файлы пакета организатора, структура фронтенда |
| [Как работает агент](docs/agent.md) | ключевое наблюдение, prior, эксперты, EI-пилоты, план, fallback, честная игра |
| [Настройки](docs/configuration.md) | переменные окружения и константы `agent.py` |
| [Данные и эксперименты](docs/experiments.md) | что показали данные, стресс-миры, ablation, отброшенные идеи |
| [Проверка](docs/testing.md) | `local_eval`, `stress_eval`, self-check'и кокпита |
| [Campaign Cockpit](docs/cockpit.md) | запуск UI, экраны, роли и вход, хранилище |
| [Новые данные](docs/data.md) | база знаний, CSV итогов кампаний, базовые выгрузки |
| [Лаборатория версий](docs/lab.md) | матрица тестов, детекторы, ремедиация, gate, promote, privacy gateway |
| [Безопасность](SECURITY.md) | защита API и UI, чек-лист выкладки |

## Сторонние компоненты
Код в репозитории разработан во время соревновательной части. Использованы:
- **пакет участника от организаторов** (в git не входит): среда `environment.py` / `mock_environment.py`, `scoring_core.py`, `local_eval.py`, `make_submission.py`, синтетические данные;
- **open-source библиотеки** по их лицензиям: pandas, numpy (BSD), CatBoost (Apache 2.0), FastAPI, fastapi-users, Uvicorn (MIT / BSD), SQLAlchemy, psycopg (MIT / LGPL), React, Vite, HeroUI (MIT), PostgreSQL (PostgreSQL License). Полный список фронтенда — в `web/package.json`;
- **внешняя модель:** `gpt-4o-mini` через OpenAI или OpenRouter — только как эксперт-источник гипотез; в неё уходят агрегаты по ячейкам, без строк абонентов;
- **AI-ассистенты** при разработке (разрешено п. 5.4.12 Положения).
