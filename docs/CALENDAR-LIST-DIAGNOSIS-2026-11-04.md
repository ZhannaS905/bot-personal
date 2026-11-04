# Диагностика CALENDAR_LIST в Training Test

Исходная ветка: refactor/training-test-remove-bridge, HEAD db8c7cecaa25f9c4445bd9abf9fbee1bba707588.
Проверка fetch подтвердила совпадение локального и удалённого HEAD.
Пользователь разрешил отдельный коммит диагностики и push в эту ветку.
Деплой Amvera не выполнялся и требует отдельного подтверждения.
Облачные Firebase/MAX и production не вызывались.

## Что означает ошибка

До этой диагностической правки один stage=CALENDAR_LIST обозначает:

1. Autopost.tick -> calendarPlan -> combinedCalendar.day -> regular.day и additional.day -> planDay.
2. Autopost.tick / refreshCalendarPolls -> calendarPollStore.listPublished.

Список опубликованных опросов — отдельная коллекция, это не список тренировок.
Из имеющейся строки невозможно выбрать одну из этих двух ветвей вызова.

fitpp-direct-diagnostic.classify разрешает вывод только фиксированных причин и
SDK-кодов. Локальные коды календаря отсутствовали в allow-list. Например,
TRAINER_CALENDAR_MISSING, GROUP_CALENDAR_REFUSED, GROUP_CALENDAR_LINK_MISSING,
COMBINED_CALENDAR_CONFLICT и CALENDAR_POLL_DOCUMENT_REFUSED превращались в UNKNOWN.
Неожиданный TypeError или произвольная внешняя ошибка также дают UNKNOWN.
Обычные SDK permission-denied/unauthenticated/unavailable уже распознаются;
UNKNOWN само по себе не доказывает ошибку Firebase permissions или сети.

## Подключения и настройки

Основной процесс: fitpp-direct-runtime.prepare -> fitpp-direct-session.connect.
Firebase Client SDK из direct-sdk, email/password Auth, in-memory persistence,
getDocFromServer/getDocsFromServer без подстановки локального кэша.
SDK управляет обновлением Auth-токена; перед чтением проверяются UID и claims.

Для чтения нужны действующие настройки (значения секретов не печатать):

- BOT_MODE=test, FITPP_DIRECT_ENABLED=true, FIREBASE_PROJECT_ID=fitpp-test.
- FIREBASE_API_KEY, FIREBASE_BOT_EMAIL, FIREBASE_BOT_PASSWORD, FIREBASE_BOT_UID.
  UID должен совпадать с уже заданным OWNER_UID в fitpp-direct-session.js;
  claims aud/iss/sub должны соответствовать проекту fitpp-test и этой учётной записи.
- OWNER_DIALOG_ENABLED отсутствует или false.
- AUTO_PUBLISH, TEST_ALLOW_SEND, TEST_ALLOW_EDIT, TEST_ALLOW_DELETE равны false.
- TRAINING_TEST_AUTOPOST_ENABLED=true и TRAINING_TEST_CALENDAR_POLLS_ENABLED=true
  включают данный календарный процесс; TEST_EXPECTED_BOT_ID задаёт область опросов.
- Для подготовки MAX capability также нужны действующие TEST_BOT_TOKEN,
  WEBHOOK_SECRET и CHAT_IDS тестовой группы; они не используются для Auth Firebase.

FITPP_DIRECT_WRITES_ENABLED не требуется включать ради чтения календаря.
TRAINING_TEST_BOOKING_SYNC_ENABLED управляет отдельной синхронизацией записей,
не чтением тренировок. Переменные notification watcher не заменяют настройки
основного Firebase Client SDK процесса.

Необходимые документы и права существующих Firestore rules:

- trainers/{OWNER_UID}: groupScheduleV1 (schemaVersion=1, projectId=fitpp-test,
  массивы groups, periods, workouts, links); workouts нужен при links.source=trainers.
- fitppTestWorkspaces/synthetic-v1/states/main: datasetId=synthetic-v1,
  schemaVersion=1, workouts — объект. Дополнительный календарь читает main даже
  при отсутствии дополнительных тренировок; main также используется для links.source=main.
- trainingTestCalendarPolls/{TEST_EXPECTED_BOT_ID}/polls: разрешённый list/read,
  документы опросов должны проходить validate (MID, UUID, key, revision и т. п.).
- Подготовка также читает trainingTestAutopostBots/{botId}/polls/{сегодня}.

Ссылки должны вести на существующие занятия и периоды, группа/место/время/дата
должны удовлетворять валидаторам. Несовпадение одного ID в двух календарях
по дате, времени или месту вызывает COMBINED_CALENDAR_CONFLICT.
Развёрнутые rules, значения переменных и документы Amvera/Firebase в этой работе
не проверялись; расширять права или пересоздавать данные без точной причины не нужно.

## Влияние на пятиминутное обновление

Исключение прерывает текущий tick до refreshCalendarPolls и PUT.
lastCalendarPlan выставляется до чтения: после ошибки плана следующий tick
через 5 минут пропускает план до следующего часа и может обновлять опросы.
Если не читается/не проходит валидацию listPublished, refresh не выполняется
на каждом tick. Если общая проблема находится в данных календаря, она может
снова проявиться при findById в refresh. Очередь run восстанавливается через
catch, attach сбрасывает busy в finally; таймер не останавливается навсегда.

FITPP_RECOVERY_RESULT stale и FITPP_NOTIFICATION_CANDIDATES 0 выдаются другим
процессом личных уведомлений и не подтверждают успешное чтение календаря/опросов.

## Минимальная безопасная диагностическая правка

- CALENDAR_PLAN: план публикации и объединение календарей.
- CALENDAR_GROUP_READ: regular.day/findById, чтение и проверка группового источника.
- CALENDAR_EXTRA_READ: additional.day/findById, чтение и проверка states/main.
- CALENDAR_POLL_LIST: чтение и валидация опубликованных опросов.
- Только точные фиксированные календарные коды добавлены в allow-list.

Пример будущего лога:
Training Test: autopost tick refused stage=CALENDAR_GROUP_READ reason=GROUP_CALENDAR_LINK_MISSING

Не выводятся error.message/stack/cause целиком, документы, URL запросов,
идентификаторы клиентов, имена, токены, пароли и ключи. Неизвестные причины
остаются UNKNOWN. Вложенный безопасный stage сохраняется при внешнем catch.
Расписание, права, обработка тренировок, голосование и MAX API не изменены.

Локальные тесты воспроизводят невалидный groupScheduleV1, отсутствие календаря,
битые ссылки, отсутствие/невалидность main, permission-denied, конфликт календарей,
отказ плана и постоянный отказ списка опросов. Проверяется фильтрация секретов и
поддельных полей диагностики. Адресный набор: 106 тестов, все прошли.

Перед коммитом повторены проверки: адресный набор — 106/106; полный набор —
422 теста, 421 прошёл, 0 ошибок, 1 пропущен (Linux abstract socket на macOS).
Проверки node --check для трёх изменённых модулей и git diff --check прошли.
