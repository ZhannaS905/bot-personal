# Подключение FitPP Personal в Amvera

Подготовка основана на `bot-personal` от `c229c25` и `FitPP-Personal` от
`1245d39501bb7c5778061f75de20bde80c6d31a6`. В репозитории точка входа
`Dockerfile` запускает `training-test-supervisor.cjs`, который запускает
`direct-training-test.cjs`. Фактические настройки контейнера проверяются в
Amvera при согласовании подключения.

Personal использует клиентский Firebase SDK с отдельной учётной записью
бота. Устройство транзакции соответствует действию `booking` в
`docs/operations.js` версии приложения выше. Транзакция обновляет
`entries`, `versions` и `revision` в `states/bookings`, создаёт квитанцию в
`operations` и обновляет только служебные поля `_fitppRevision` и
`lastOperation` в `states/main`. В той же транзакции отмечается обработанный
голос. Для календаря используется копия `docs/group-period-model.js` из той же
версии. Бот использует локации действующего календарного режима
`zarya`, `pole` и `online`.

До переключения:

1. Проверить действующие правила Firestore `fitpp-personal` для отдельного
   Firebase Auth UID бота. Нужны чтение `trainers/{ownerUid}`,
   `states/main` и `states/bookings` в рабочей области Personal,
   чтение и запись реестра `notificationBindings/training-test` для ручной
   привязки и доступ к собственным календарным опросам и их событиям в
   `trainingTestCalendarPolls/{botId}`. Для записи нужны атомарное обновление
   `states/bookings`, изменение только служебных полей `states/main` и
   создание квитанции `operations/{id}`. Если правила не дают такой доступ,
   отдельно согласовать и локально проверить узкие правила для этого UID.
   Права владельца и Admin SDK для этого режима не используются.
2. В Amvera сверить источник и версию сборки, точку входа и флаги
   `TRAINING_TEST_CALENDAR_POLLS_ENABLED`,
   `TRAINING_TEST_AUTOPOST_ENABLED` и `TRAINING_TEST_BOOKING_SYNC_ENABLED`.
   Проверить настройки действующего webhook и ожидаемые ID бота и чата.
   Надзор за старым процессом уведомлений
   `FITPP_NOTIFICATION_SUPERVISED` несовместим с режимом Personal.
3. После согласования задать `FIREBASE_PROJECT_ID=fitpp-personal` и
   параметры `FIREBASE_API_KEY`, `FIREBASE_BOT_UID`, `FIREBASE_BOT_EMAIL`,
   `FIREBASE_BOT_PASSWORD` через конфигурацию Amvera. Использовать штатную
   ручную привязку через MAX. Опросы и привязки старого проекта не копируются.
   После переключения проверить один опрос с тестовым клиентом и сверить
   появление и отмену записи в журнале.

Шесть локальных проверок:

```sh
FITPP_PERSONAL_SOURCE=/absolute/path/to/FitPP-Personal/docs node --test test/fitpp-personal-booking.test.js
```

Для проверки журнала используется модель из указанного checkout приложения.
