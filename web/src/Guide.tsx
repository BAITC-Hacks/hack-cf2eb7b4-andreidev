import { Button, Card, Modal } from '@heroui/react'
import {
  ArrowRight, BookOpen, Boxes, CircleHelp, Cog, FlaskConical, GitBranch, Lightbulb, ListChecks, Play, Radar, Route,
  ShieldCheck, SlidersHorizontal, Terminal, Users, type LucideIcon,
} from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import type { Role } from './api'
import { Section, Tip } from './ui'

// Всё про «как этим пользоваться» — в одном файле: тексты как данные, сверху два компонента (Help и Docs)

// ---------- общие куски ----------
const PIPELINE: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Users, title: 'Аудитория', text: 'абоненты разбиты на 63 ячейки «текущий тариф × сегмент ARPU»' },
  { icon: Lightbulb, title: 'Гипотезы', text: 'эксперты (история переходов и LLM) предлагают, на какой тариф переводить каждую ячейку' },
  { icon: FlaskConical, title: 'Пилоты', text: 'до 20 маленьких проверок на 60–200 абонентов — туда, где больше всего можно узнать' },
  { icon: ListChecks, title: 'План', text: 'до 10 кампаний под бюджет и охват: только то, что уверенно в плюсе' },
]

function Pipeline() {
  return (
    <ol className="grid gap-2 sm:grid-cols-2">
      {PIPELINE.map((p, i) => (
        <li key={p.title} className="flex gap-3 rounded-xl bg-default/60 p-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><p.icon className="size-4" aria-hidden /></span>
          <span className="text-sm"><b className="font-medium">{i + 1}. {p.title}</b><span className="block text-muted">{p.text}</span></span>
        </li>
      ))}
    </ol>
  )
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {items.map((x, i) => (
        <li key={i} className="flex gap-3">
          <span className="num grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-soft-foreground">{i + 1}</span>
          <span className="pt-0.5">{x}</span>
        </li>
      ))}
    </ol>
  )
}

const MODES: { name: string; text: ReactNode }[] = [
  { name: 'Seed', text: 'Номер случайного сценария. Один seed — один и тот же результат, удобно сравнивать настройки. Смените seed, чтобы проверить устойчивость.' },
  { name: 'Мок', text: 'Учебный мир организаторов: эффекты совпадают с историей переходов. Быстро и предсказуемо — для знакомства и демо.' },
  { name: 'Стресс-мир', text: 'Эффекты искажены (× U(0.5, 2) + шум N(0, 0.3)) — история верна лишь частично, ближе к судейской среде. Показывает, насколько агент полагается на пилоты, а не на прошлое.' },
  { name: 'LLM-эксперт', text: 'Добавляет гипотезы от языковой модели. В LLM уходят только агрегаты по ячейкам. Без ключа API переключатель неактивен, агент работает на истории.' },
  { name: 'Модель', text: 'Любой slug OpenRouter (или пресет из списка). Пусто — модель по умолчанию из настроек сервера.' },
]

// ---------- помощник (визард) ----------
type Step = { roles?: Role[]; icon: LucideIcon; title: string; body: ReactNode }
const STEPS: Step[] = [
  {
    icon: Radar, title: 'Что это',
    body: <>
      <p><b>Campaign Cockpit</b> — AI-агент, который решает, <b>кому</b> из абонентов и <b>какой тариф</b> предложить, через какой канал
        (push, SMS, digital-реклама, звонок), чтобы вырос ARPU.</p>
      <p>Агент сам проверяет гипотезы небольшими пилотами и укладывается в лимиты: бюджет, охват, не больше 10 кампаний.</p>
    </>,
  },
  { icon: Route, title: 'Как работает агент', body: <><p>Каждый запуск проходит четыре шага:</p><Pipeline /></> },
  {
    roles: ['manager'], icon: Play, title: 'Ваш сценарий',
    body: <Steps items={[
      <>Нажмите <b>«Сформировать план»</b> — агент считает до минуты.</>,
      <>Посмотрите таблицу: <b>кому</b>, <b>что предложить</b>, <b>канал</b>, <b>затраты</b> и <b>эффект</b>.</>,
      <>Колонка <b>«Надёжность»</b>: «проверено пилотом» — можно запускать, «есть риск» — стоит обсудить с аналитиком.</>,
      <>Нажмите <b>«Скачать план (CSV)»</b> и передайте его в запуск кампаний.</>,
    ]} />,
  },
  {
    roles: ['analyst', 'admin'], icon: SlidersHorizontal, title: 'Режимы запуска',
    body: <>
      <p>Панель вверху справа задаёт, в каком мире и с какими экспертами запускать агента:</p>
      <dl className="flex flex-col gap-2">
        {MODES.map((m) => <div key={m.name}><dt className="font-medium">{m.name}</dt><dd className="text-muted">{m.text}</dd></div>)}
      </dl>
    </>,
  },
  {
    roles: ['analyst', 'admin'], icon: BookOpen, title: 'Как читать экраны',
    body: <Steps items={[
      <><b>Командный центр</b> — итог: чистый прирост, бюджет, охват и что делать прямо сейчас.</>,
      <><b>Шаги 1–4</b> в меню повторяют конвейер: аудитория → гипотезы → пилоты (с пошаговым replay) → финальный план.</>,
      <><b>Как считается</b> — формулы эффекта и стоимости, можно подставить свои числа.</>,
      <><b>Стратегии</b> — вклад экспертов и сравнение на стресс-мирах, <b>Privacy</b> — что именно видит LLM, <b>Логи</b> — сырой лог.</>,
      <>У заголовков колонок и кнопок есть подсказки — наведите курсор.</>,
    ]} />,
  },
  {
    roles: ['admin'], icon: GitBranch, title: 'Лаборатория',
    body: <>
      <p>Цикл улучшения агента без правки кода руками:</p>
      <Steps items={[
        <><b>Версия</b> — набор разрешённых настроек поверх <code>agent.py</code>.</>,
        <><b>Прогнать тесты</b> — матрица: мок, стресс-миры, жёсткие миры, проверки LLM и лимитов (~10 с).</>,
        <><b>Issues</b> — детекторы находят проблемы с доказательствами.</>,
        <><b>Авто-исправить</b> — LLM или шаблон предлагают патч, он проходит <b>gate</b> против родителя → <b>candidate</b>.</>,
        <><b>Promote</b> — настройки записываются в <code>agent.py</code>, <code>submission.csv</code> пересобирается.</>,
      ]} />
    </>,
  },
]

const seen = (role: Role) => { try { return localStorage.getItem(`onboarded:${role}`) === '1' } catch { return true } }
const markSeen = (role: Role) => { try { localStorage.setItem(`onboarded:${role}`, '1') } catch { /* приватный режим — покажем снова */ } }

/** Кнопка «?» + визард. Сам открывается при первом входе в роль */
export function Help({ role, onDocs }: { role: Role; onDocs: () => void }) {
  const steps = STEPS.filter((s) => !s.roles || s.roles.includes(role))
  const [open, setOpen] = useState(() => !seen(role))
  const [i, setI] = useState(0)
  const close = () => { markSeen(role); setOpen(false); setI(0) }
  const s = steps[i]
  const last = i === steps.length - 1
  return (
    <>
      <Tip tip="Помощник: что это за система и с чего начать">
        <Button isIconOnly variant="ghost" aria-label="Помощник" onPress={() => setOpen(true)}><CircleHelp className="size-4" aria-hidden /></Button>
      </Tip>
      <Modal.Backdrop isOpen={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog aria-label="Помощник">
            <Modal.Header className="flex-row items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground"><s.icon className="size-5" aria-hidden /></span>
              <div>
                <p className="num text-xs text-muted">Шаг {i + 1} из {steps.length}</p>
                <Modal.Heading>{s.title}</Modal.Heading>
              </div>
            </Modal.Header>
            <Modal.Body key={i} className="rise flex flex-col gap-3 text-sm leading-relaxed [&_b]:font-medium">{s.body}</Modal.Body>
            <Modal.Footer className="flex-wrap items-center">
              <span className="mr-auto flex gap-1.5" aria-hidden>
                {steps.map((_, j) => <span key={j} className={`h-1.5 rounded-full transition-all ${j === i ? 'w-5 bg-accent' : 'w-1.5 bg-default'}`} />)}
              </span>
              {!last && <Button variant="ghost" onPress={close}>Пропустить</Button>}
              {i > 0 && <Button variant="secondary" onPress={() => setI(i - 1)}>Назад</Button>}
              {last
                ? <>
                    <Button variant="secondary" onPress={() => { close(); onDocs() }}><BookOpen className="size-4" aria-hidden />Документация</Button>
                    <Button variant="primary" onPress={close}>Начать</Button>
                  </>
                : <Button variant="primary" onPress={() => setI(i + 1)}>Далее<ArrowRight className="size-4" aria-hidden /></Button>}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}

// ---------- документация ----------
export type DocTab = { id: string; label: string; sub: string; icon: LucideIcon; lab?: boolean }

// Абзац на каждый экран кокпита; label/sub/icon берутся из TABS в App.tsx
const SCREEN: Record<string, string> = {
  command: 'Итог прогона: чистый прирост ARPU, прогноз агента, ROI, расход бюджета и охвата, топ кампаний и что делать прямо сейчас.',
  rules: 'Как среда считает эффект и стоимость кампании: формулы, множители каналов, лимиты. Можно подставить свои числа.',
  audience: 'Кого можно таргетировать: ячейки «тариф × сегмент», их размер и суммарный ARPU — где лежит основная ценность.',
  hypotheses: 'Все рукава (ячейка → целевой тариф): кто предложил, оценка эффекта до и после пилотов, попали ли в план. Фильтры по эксперту и статусу.',
  pilots: 'Какие пилоты провёл агент, что они показали и решение «масштабировать / отложить / отказаться». Replay — разведка шаг за шагом.',
  plan: 'Финальные кампании: фильтры, целевой тариф, канал, аудитория, затраты, ожидаемый эффект и объяснение, почему кампания в плане.',
  strategies: 'Вклад каждого эксперта и ablation: агент против шаблона, prior-only и оракула на стресс-мирах.',
  privacy: 'Privacy gateway: какие поля и агрегаты уходят в LLM, аудит вызовов и prompt inspector.',
  logs: 'Сырой лог агента — всё, что он печатал во время прогона.',
  versions: 'Дерево версий (lineage), карточка версии с тестами и метриками, кнопки тестов, авто-исправления и promote, создание своей версии.',
  compare: 'Две-три версии рядом: метрики по семействам миров и diff настроек.',
  runs: 'Все запуски матрицы тестов с фильтром по тесту.',
  issues: 'Проблемы выбранной версии, найденные детекторами, с доказательствами. Отсюда можно запустить авто-исправление.',
  fixes: 'Версии, которые предложили LLM или шаблон: гипотеза, патч и прошёл ли он gate.',
}

const ROLES: [string, string, string][] = [
  ['Менеджер', 'Одна кнопка «Сформировать план» → таблица кампаний простым языком → CSV', 'получить готовый план'],
  ['Аналитик', 'Весь кокпит: режимы запуска, шаги конвейера, стратегии, privacy, логи', 'понять и проверить решения агента'],
  ['Администратор', 'Кокпит + лаборатория версий', 'улучшать агента и выкатывать настройки'],
]

const GLOSSARY: [string, string][] = [
  ['Ячейка', 'Группа абонентов с одинаковыми текущим тарифом и сегментом ARPU (LOW / MID / HIGH). Эффект кампании зависит только от ячейки, целевого тарифа и канала.'],
  ['Рукав (гипотеза)', 'Пара «ячейка → целевой тариф». У рукава есть оценка эффекта μ и неопределённость σ.'],
  ['Prior', 'Оценка эффекта по истории переходов (data/change_tariff.csv) — до любых пилотов.'],
  ['Posterior', 'Оценка после пилотов: prior, уточнённый наблюдениями по формуле Байеса.'],
  ['Пилот', 'Маленькая проверка рукава на 60–200 абонентах через SMS. Один пилот даёт оценку сразу для всех каналов.'],
  ['EI', 'Expected improvement — сколько в среднем даст знание об этом рукаве. Пилот получает рукав с максимальным EI × ARPU ячейки.'],
  ['LCB', 'Нижняя граница уверенности μ − 0.5σ. В план идёт только то, у чего LCB > 0.'],
  ['ARPU', 'Средняя выручка на абонента в месяц. Цель — чистый прирост ARPU.'],
  ['Net (эффект)', 'Прирост выручки минус стоимость контактов.'],
  ['Baseline', 'Выручка без кампаний — от неё считается рост в процентах.'],
  ['Шаблон / оракул', 'Шаблон — простое решение организаторов. Оракул знает настоящие эффекты: потолок, до которого можно дорасти.'],
  ['Стресс-мир', 'Мок с искажёнными эффектами: история верна лишь частично.'],
  ['Жёсткий мир, keep', 'Эффекты перемешаны между переходами; keep — какая доля правды осталась в истории. keep=0 — история бесполезна, как на судействе.'],
  ['Gate', 'Правило приёма версии в лаборатории: must-have тесты пройдены, медианы не упали, худший мир не стал хуже.'],
]

type Doc = { id: string; icon: LucideIcon; title: string; roles?: Role[]; body: (p: { tabs: DocTab[]; onOpen?: (id: string) => void }) => ReactNode }
const EXPERT: Role[] = ['analyst', 'admin']

const DOCS: Doc[] = [
  {
    id: 'about', icon: Radar, title: 'Что это и для кого',
    body: () => <>
      <p>Campaign Cockpit подбирает тарифные кампании: какой группе абонентов какой тариф предложить и через какой канал,
        чтобы вырос ARPU, и всё это в пределах бюджета, охвата и не больше 10 кампаний по 5 000 абонентов. Внутри работает
        AI-агент <code>agent.py</code>, а интерфейс показывает, что он делает и почему.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted"><tr><th className="py-1.5 pr-4 font-medium">Роль</th><th className="py-1.5 pr-4 font-medium">Что видит</th><th className="py-1.5 font-medium">Зачем</th></tr></thead>
          <tbody>{ROLES.map(([r, w, z]) => <tr key={r} className="border-t border-border"><td className="py-2 pr-4 font-medium whitespace-nowrap">{r}</td><td className="py-2 pr-4">{w}</td><td className="py-2 text-muted">{z}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="text-muted">Роли раздаёт администратор, публичной регистрации нет.</p>
    </>,
  },
  {
    id: 'how', icon: Route, title: 'Как работает агент',
    body: () => <>
      <Pipeline />
      <Steps items={[
        <><b>Prior.</b> По истории переходов для каждой тройки «тариф, сегмент → целевой тариф» считается ожидаемый эффект.
          Он намеренно неуверенный (σ = 0.25): история — другая выборка, чем текущая аудитория.</>,
        <><b>Эксперты.</b> История даёт 4 лучших целевых тарифа на ячейку, LLM — до 2 своих. Непроверенная догадка LLM
          в план не попадает: сначала пилот.</>,
        <><b>Адаптивные пилоты.</b> Следующим проверяется рукав с максимальным EI × ARPU ячейки. После пилота оценка
          обновляется, разведка останавливается, когда кончились пилоты, выгода от новых мала или подходит лимит времени.</>,
        <><b>План.</b> В каждой ячейке — лучший целевой тариф, если μ − 0.5σ &gt; 0. Ячейки заполняют охват по убыванию ценности,
          каналы жадно апгрейдятся с push на более дорогие, пока хватает бюджета. Ячейки группируются в ≤ 10 кампаний.</>,
        <><b>Fallback.</b> При любой ошибке или пустом плане — одна безопасная кампания, а не падение.</>,
      ]} />
    </>,
  },
  {
    id: 'modes', icon: SlidersHorizontal, title: 'Режимы и параметры запуска', roles: EXPERT,
    body: () => <>
      <dl className="grid gap-3 sm:grid-cols-[140px_1fr]">
        {MODES.map((m) => <Fragment key={m.name}><dt className="font-medium">{m.name}</dt><dd className="text-muted">{m.text}</dd></Fragment>)}
      </dl>
      <p><b>Когда что выбирать:</b> знакомство и демо — Мок, seed 42. Проверка надёжности — Стресс-мир на нескольких seed.
        Вклад LLM — один и тот же seed с переключателем LLM и без. Менеджер всегда получает Мок, seed 42, LLM по умолчанию.</p>
    </>,
  },
  {
    id: 'scenarios', icon: Play, title: 'Сценарии по шагам',
    body: () => <div className="grid gap-4 lg:grid-cols-3">
      {([
        ['Менеджер: получить план', [
          'Нажать «Сформировать план» (до минуты).', 'Проверить колонку «Надёжность».', 'Скачать CSV и передать в запуск.',
        ]],
        ['Аналитик: проверить план', [
          'Выбрать мир и seed, нажать «Запустить агента».', 'Командный центр: итог и что делать.',
          'Пилоты → replay: почему агент проверял именно это.', 'Финальный план: объяснение каждой кампании.',
          'Стресс-мир на 3–5 seed: устойчив ли результат.',
        ]],
        ['Админ: улучшить агента', [
          'Лаборатория → Версии: выбрать текущую.', 'Прогнать тесты, открыть Issues.', 'Авто-исправить или собрать свою версию.',
          'Сравнение: новая против родителя.', 'Promote кандидата, закоммитить agent.py вручную.',
        ]],
      ] as const).map(([t, items]) => (
        <Card key={t} className="gap-3 bg-default/40 p-4 shadow-none">
          <h4 className="text-sm font-semibold">{t}</h4>
          <Steps items={[...items]} />
        </Card>
      ))}
    </div>,
  },
  {
    id: 'screens', icon: Boxes, title: 'Экраны', roles: EXPERT,
    body: ({ tabs, onOpen }) => (
      <ul className="grid gap-2 md:grid-cols-2">
        {tabs.filter((t) => SCREEN[t.id]).map((t) => (
          <li key={t.id} className="flex gap-3 rounded-xl bg-default/60 p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-default"><t.icon className="size-4" aria-hidden /></span>
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <b className="font-medium">{t.label}{t.lab && <span className="ml-1.5 text-xs font-normal text-muted">лаборатория</span>}</b>
                {onOpen && <Button size="sm" variant="ghost" onPress={() => onOpen(t.id)}>Открыть</Button>}
              </div>
              <p className="text-muted">{SCREEN[t.id]}</p>
            </div>
          </li>
        ))}
      </ul>
    ),
  },
  {
    id: 'lab', icon: GitBranch, title: 'Лаборатория версий', roles: ['admin'],
    body: () => <Steps items={[
      <><b>Версия</b> — настройки из allowlist поверх <code>agent.py</code>: константы (LCB_K, PRIOR_STD, размер пилотов…),
        флаги эвристик, режим privacy и дополнение к промпту. Статусы: draft → candidate | failed → promoted.</>,
      <><b>Матрица тестов:</b> мок на 1 и 10 seed, 10 стресс-миров, жёсткие миры keep=0 (30) и keep=0.5 (10), валидация
        кампаний, бюджет и охват, время, прогон без LLM, сбой и мусор LLM. Около 10 с на версию.</>,
      <><b>Детекторы</b> находят проблемы с доказательствами, например «медиана +6.8M, но 4/10 миров в минусе».</>,
      <><b>Ремедиация:</b> issues превращаются в ограниченный патч от LLM (через тот же privacy gateway) или шаблона.
        Новая версия проходит ту же матрицу.</>,
      <><b>Gate:</b> must-have тесты пройдены; медиана keep=0 не упала; keep=0.5 и стресс — не больше −3%; худший мир keep=0
        не хуже; 0 отброшенных кампаний. Прошла — candidate.</>,
      <><b>Promote</b> — только кнопкой и только из candidate: константы переписываются в <code>agent.py</code>,
        <code>submission.csv</code> пересобирается. Коммит — вручную.</>,
    ]} />,
  },
  {
    id: 'privacy', icon: ShieldCheck, title: 'Privacy: что видит LLM', roles: EXPERT,
    body: () => <>
      <p>В LLM никогда не уходят строки абонентов — только ячейки и медианы разрешённых полей. Ячейки меньше порога
        K_MIN идут без статистик, поле вне allowlist блокирует запрос, каждый вызов пишется в аудит.</p>
      <dl className="grid gap-2 sm:grid-cols-[160px_1fr]">
        <dt className="num font-medium">aggregate_only</dt><dd className="text-muted">агрегаты по ячейкам (по умолчанию)</dd>
        <dt className="num font-medium">synthetic_only</dt><dd className="text-muted">агрегаты с шумом, округлённые размеры</dd>
        <dt className="num font-medium">debug_safe</dt><dd className="text-muted">ни одного числа об абонентах</dd>
      </dl>
    </>,
  },
  {
    id: 'glossary', icon: Lightbulb, title: 'Глоссарий',
    body: () => (
      <dl className="grid gap-x-4 gap-y-2.5 sm:grid-cols-[170px_1fr]">
        {GLOSSARY.map(([k, v]) => <Fragment key={k}><dt className="font-medium">{k}</dt><dd className="text-muted">{v}</dd></Fragment>)}
      </dl>
    ),
  },
  {
    id: 'run', icon: Terminal, title: 'Запуск и деплой', roles: EXPERT,
    body: () => <>
      <p>Одной командой (API и собранный фронт на :8000, ключи LLM — из <code>.env</code>):</p>
      <pre className="num overflow-x-auto rounded-xl bg-default/60 p-3 text-xs">docker compose up --build</pre>
      <p>Для разработки:</p>
      <pre className="num overflow-x-auto rounded-xl bg-default/60 p-3 text-xs">{[
        'docker compose up -d db              # Postgres :5432',
        'uvicorn server:app --port 8000       # API',
        'cd web && npm i && npm run dev       # http://localhost:5173',
        "python3 auth.py add boss@corp.ru 'пароль' manager   # пользователь",
        'python local_eval.py --runs 10       # мок, 10 прогонов',
        'python stress_eval.py                # стресс-миры',
      ].join('\n')}</pre>
      <p className="text-muted">Пользователи на пустой БД берутся из <code>AUTH_USERS</code>; ключ LLM — <code>OPENROUTER_API_KEY</code> или <code>OPENAI_API_KEY</code>.</p>
    </>,
  },
]

/** Страница документации: оглавление + разделы, отфильтрованные по роли */
export function Docs({ role, tabs = [], onOpen }: { role: Role; tabs?: DocTab[]; onOpen?: (id: string) => void }) {
  const docs = DOCS.filter((d) => !d.roles || d.roles.includes(role))
  // ponytail: скролл кнопками, а не <a href="#…"> — hash уже занят роутингом вкладок
  const jump = (id: string) => document.getElementById(`doc-${id}`)?.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start',
  })
  return (
    <div className="grid gap-5 lg:grid-cols-[200px_1fr]">
      <nav aria-label="Разделы документации" className="flex gap-1 overflow-x-auto lg:sticky lg:top-5 lg:flex-col lg:self-start">
        {docs.map((d) => (
          <button key={d.id} type="button" onClick={() => jump(d.id)}
            className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm whitespace-nowrap text-muted transition-colors hover:bg-default hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus">
            <d.icon className="size-3.5 shrink-0" aria-hidden />{d.title}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-col gap-5">
        {docs.map((d) => (
          <div key={d.id} id={`doc-${d.id}`} className="scroll-mt-5">
            <Section icon={d.icon} title={d.title}>
              <div className="flex flex-col gap-3 text-sm leading-relaxed [&_b]:font-medium">{d.body({ tabs, onOpen })}</div>
            </Section>
          </div>
        ))}
        <p className="flex items-center gap-2 text-xs text-muted"><Cog className="size-3.5" aria-hidden />Подробности алгоритма и замеры — в README.md репозитория.</p>
      </div>
    </div>
  )
}
