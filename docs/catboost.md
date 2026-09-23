# CatBoost-prior

Опциональный ML-prior для агента: вместо группового среднего истории μ рукава считает модель CatBoost по признакам абонентов **аудитории**. **По умолчанию выключен** (`PRIOR_MODEL = "hist"`): он не прошёл gate лаборатории (см. [результаты](#результаты-почему-выключен)). Код — `agent.py`, секция `# --- CatBoost-prior`.

## Зачем
Обычный prior (`hist`) — среднее `pct` по переходу `(from, seg, to)` из `data/change_tariff.csv`. Но история и аудитория — разные выборки ([experiments.md](experiments.md#что-показали-данные)): в аудитории больше HIGH-абонентов, у них выше ARPU и другой трафик. Групповое среднее этого не видит.

Идея CatBoost-prior: выучить `pct` на уровне **абонента** (ARPU, трафик, параметры тарифов) и усреднить предсказания по реальным строкам аудитории ячейки. Так prior учитывает, *кто* сидит в ячейке сейчас, а не кто сидел в истории.

## Как устроено
1. **Обучение** (`fit_prior_model`, раз на процесс — `_train_prior_model` под `lru_cache`).
   - Строки: история `change_tariff.csv` (`hist_rows`), target — `pct` абонента.
   - Трафик: `traffic.csv`, среднее за 3 последних месяца до перехода — так же, как 3m-средние в профиле аудитории. Колонки — пересечение `traffic.csv` и профиля (`usage_cols`).
   - Признаки (`_features`, одна функция для train и inference): from/to/seg и `key` как категориальные, `arpu`, трафик, цена и пакеты тарифов from/to и их разница, `fit_from`/`fit_to` (влезает ли трафик в пакет), `use_to`/`over_to`.
   - `CatBoostRegressor`: RMSE, 500 итераций, lr 0.05, depth 6, l2 8, `random_seed=42`. Около 2 с.
2. **Инференс** (`model_prior`). Строки аудитории (`profile_rows`, ARPU < 100 отброшены — в истории их нет) × target, которые встречались в истории этой ячейки. По каждому `(from, seg, to)`:
   - `model_mean` — среднее предсказаний (по строкам или с весом `predicted_arpu`, `PRIOR_WEIGHT`);
   - `ood` — доля строк вне диапазона признаков train;
   - `worse_fit` — target дороже и в среднем хуже по fit, чем текущий.
3. **Смешивание с историей** (`model_mu`), зависит от режима:

| `PRIOR_MODEL` | μ рукава |
|---|---|
| `hist` (по умолчанию) | `mean · n/(n+10)` — только история, catboost даже не импортируется |
| `catboost_shift` | модель сдвигает групповое среднее к своему: `(model_mean − λ·u) · n/(n+10)` |
| `catboost_full` | `α(n)·model_mean + (1−α)·hist_s − λ·u`, где `α(n) = PRIOR_ALPHA_MAX · n/(n+PRIOR_ALPHA_K)` |

   `u = 1/√(n+1) + ood` — неуверенность, `λ = RISK_LAMBDA`. **Guardrails** в `catboost_full`: при `n < SUPPORT_MIN`, `ood > 0.5` или `worse_fit` модель может только **понизить** μ относительно истории.
4. Дальше всё как обычно: μ × доля переходов → top-`ARMS_PER_CELL` рукавов → пилоты → план ([agent.md](agent.md#алгоритм)).

**Безопасность отказа.** Нет пакета `catboost` или `traffic.csv`, ошибка обучения — агент пишет в лог `model skipped: …` и молча возвращается к `hist` (с поправкой `USE_FIT`). План при этом строится всегда.

## Параметры
| Константа | По умолчанию | Смысл | Границы в лаборатории |
|---|---|---|---|
| `PRIOR_MODEL` | `hist` | режим prior | `hist` / `catboost_shift` / `catboost_full` |
| `PRIOR_ALPHA_MAX` | 0.7 | `full`: вес модели при большой истории перехода | 0–1 |
| `PRIOR_ALPHA_K` | 30 | `full`: скорость роста α с n | — |
| `RISK_LAMBDA` | 0.0 | штраф μ за неуверенность | 0–0.5 |
| `PRIOR_WEIGHT` | `rows` | `arpu` — усреднение с весом ARPU | `rows` / `arpu` |
| `SUPPORT_MIN` | 10 | меньше переходов — только понижение μ | — |

## Как запустить
Зависимость уже в `requirements.txt` (`pip install -r requirements.txt`). Константы живут в `agent.py`, переменной окружения для них нет. Три способа:

**1. Разово, не меняя файлов** — подменить константу перед запуском:
```bash
python3 -c "import agent, runpy, sys; agent.PRIOR_MODEL='catboost_full'; sys.argv=['local_eval.py']; runpy.run_path('local_eval.py', run_name='__main__')"
python3 -c "import agent, runpy, sys; agent.PRIOR_MODEL='catboost_full'; sys.argv=['stress_eval.py']; runpy.run_path('stress_eval.py', run_name='__main__')"
```
Посмотреть, что модель реально работала, — строки `model …` в логе агента:
```bash
python3 -c "
import agent, mock_environment as m
agent.PRIOR_MODEL = 'catboost_full'
a = agent.Agent(); a.act(m.make_mock_env(seed=42)[0])
print('\n'.join(l for l in a.log if l.startswith('model')))"
# model catboost_full: arms=451 |Δμ|>0.02: 204 mean|Δμ|=0.029 guard=215 weight=rows
# model uncertain tariff_12/HIGH/tariff_9: n=1 ood=0.01 u=0.72 hist=-0.016 model=-0.153 mu=-0.019
```

**2. Через лабораторию (правильный путь)** — создать версию с `PRIOR_MODEL` и прогнать матрицу тестов и gate ([lab.md](lab.md)). В UI: вкладка «Версии» (роль admin). Через API:
```bash
curl -c cookies -X POST localhost:8000/api/auth/login -d 'username=admin@cockpit.demo&password=admin'
curl -b cookies -X POST localhost:8000/api/lab/versions -H 'Content-Type: application/json' \
  -d '{"parent_id": "v001", "changes": {"PRIOR_MODEL": "catboost_full", "RISK_LAMBDA": 0.1}}'
```
Если версия пройдёт gate, promote перепишет константы в `agent.py` и пересоберёт `submission.csv`.

**3. Вручную** — поменять `PRIOR_MODEL = "hist"` в `agent.py`. После этого `submission.csv` перестанет совпадать с закоммиченным.

## Диагностика
```bash
python stress_eval.py                # среди self-check'ов — check_prior_model: схема train = inference, нет утечек, единицы совпадают, hist не изменился
python stress_eval.py --prior-cv     # 5 фолдов по ID: модель против группового среднего по строкам и по группам
python stress_eval.py --prior-debug  # важности признаков, топ сдвигов μ_full − μ_hist и их SHAP-причины
```
`--prior-cv` сравнивает варианты `hist`, `shift`, `full`, `full λ=0.1`, `full arpu`: RMSE/MAE/знак по отложенным абонентам и Spearman, pairwise, precision@3, regret@1 внутри ячеек — так, как ранжирует рукава `_expert_prior`.

## Результаты: почему выключен
Все три режима, без LLM, матрица `lab.py`.
- **`--prior-cv`.** По строкам модель точнее группового среднего (RMSE 0.93 против 0.97, знак 66% против 63%), по группам Spearman 0.75–0.76 против 0.74. Но внутри ячейки, где prior выбирает target, выигрыша нет: pairwise 0.79–0.80 против 0.80, regret@1 0.021–0.023 против 0.019.
- **`--prior-debug`.** Главный признак — `arpu` (30% важности), то есть модель выучила возврат к среднему. HIGH-аудитория богаче HIGH-истории, поэтому модель делает HIGH пессимистичнее. Отладка же нашла утечку домена: 43% LOW-аудитории имеют ARPU < 100, а история такие строки отбрасывает. Теперь они исключены и при инференсе.
- **Ablation на 30 мирах `keep=0`:** `hist` 3.91M, `catboost_shift` 0.95M, `catboost_full` 1.98M, `full` + λ=0.1 1.08M; стресс-миры 6.79M против 4.8–5.2M. Причина — в выборе кандидатов, а не в μ: в крупнейшей ячейке `tariff_8/HIGH` (треть ARPU) модель опускает три слабоположительных target истории ниже 0, и top-4 заполняют пары без истории (μ = 0), которые везде убыточны. Если кандидатов брать из истории, а μ из модели, `keep=0` возвращается к baseline (6.75M против 6.76M на 10 мирах, худший мир −0.02M против −0.68M), но стресс-миры всё ещё 5.97M против 6.79M.
- **Оговорка.** Правда во всех локальных мирах — групповые средние *истории*, поэтому выигрыш от сдвига аудитории они показать не могут по построению.

## Когда включать
Когда появятся данные, где правда зависит от состава аудитории, — например, итоги реальных кампаний в [базе знаний](data.md#база-знаний). Тогда: версия в лаборатории → матрица → gate. Начинать с `catboost_full` и `RISK_LAMBDA > 0`: guardrails не дают модели завышать μ там, где истории мало.
