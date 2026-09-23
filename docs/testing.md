# Проверка

Все команды запускаются из корня репо: пакет среды лежит рядом с нашими файлами (в git не коммитится).

## Сдача
```bash
python local_eval.py              # «Статус: PASS», net ≈ 4.4M, «Пилотов проведено: 20 из 20», нет строк «отброшена»
python local_eval.py --runs 10    # мок: 10/10 прогонов в плюс, net ≈ 4.2–4.7M
python make_submission.py         # воспроизводимый submission.csv; git diff должен быть пуст
```

## Стенд устойчивости (`stress_eval.py`)
```bash
python stress_eval.py [--runs 10]    # искажённые миры: сравнение с шаблоном, prior-only и оракулом
python stress_eval.py --keep 0       # жёсткие миры: история бесполезна (0) или наполовину верна (0.5)
python stress_eval.py --struct       # миры с системной ошибкой истории (сдвиг на target и сегмент)
python stress_eval.py --prior-cv     # CatBoost-prior против группового среднего: K-fold по ID
python stress_eval.py --prior-debug  # важности признаков, крупнейшие сдвиги μ и их SHAP-причины
```
Что показали эти прогоны — [experiments.md](experiments.md), CatBoost-prior — [catboost.md](catboost.md).

## Self-check'и кокпита
Нужен Postgres (`docker compose up -d db`). Каждый работает во временной схеме БД и не трогает рабочие данные.
```bash
python3 server.py          # API без запуска сервера
python3 auth.py            # вход и роли
python3 datasets.py        # загрузка и валидация CSV, база знаний
python3 lab.py             # validate, детекторы, gate, round-trip констант, быстрая матрица
python3 security_check.py  # доступ по ролям, сессии, лимит входа, загрузки, заголовки; exit 1 при провале
```
Что проверяет `security_check.py` — [../SECURITY.md](../SECURITY.md).
