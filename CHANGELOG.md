# Dropwave — Changelog / История изменений

## v0.3.1 — Russian / English localization
- RU: Добавлено переключение языка **RU / EN** в компактном popup, настройка сохраняется.
- EN: Added a persistent **RU / EN** language switch in the compact popup.
- RU: Переведены интерфейс, журнал, история раздач, статусы и системные уведомления.
- EN: Localized the UI, claim journal, giveaway history, statuses, and notifications.
- RU: Язык по умолчанию определяется по языку браузера; механизм выдачи лицензий не изменялся.
- EN: Browser UI language is used by default; the Steam license-claiming logic was not modified.


## v0.3.0
- RU: Добавлена вкладка **«Журнал»** для ручных и автоматических операций; до 150 записей на Steam-аккаунт.
- EN: Added a **Journal** tab for manual and automatic claim attempts; up to 150 entries per Steam account.
- RU: Компактная статистика, очистка журнала с подтверждением и перенос старого `lastClaimResult`.
- EN: Compact statistics, confirmation before clearing the journal, and migration of previous `lastClaimResult`.
- RU: Улучшены уведомления о результатах автополучения; добавлены оригинальные иконки.
- EN: Improved auto-claim status notifications and included original icons.

## v0.2.8
- RU: Защита от ложных пустых результатов и повторные проверки после сетевых ошибок.
- EN: Safeguards against misleading empty Steam results and retries after network errors.
- RU: Предотвращение параллельных проверок; разделение подтверждённых лицензий и ручных отметок.
- EN: Deduplicated concurrent checks; separated verified ownership from manual marks.
- RU: Отдельные данные для разных Steam-аккаунтов, промежуточный статус неподтверждённых лицензий.
- EN: Account-specific records and a pending/unverified license state.

## v0.2.7
- RU: Надёжнее распознаётся авторизация Steam Store; получение лицензии по Steam SubID.
- EN: Improved Steam Store session detection; acquiring free licenses using Steam SubID.

## v0.2.6
- RU: Резервные способы загрузки результатов поиска и раздельная диагностика авторизации.
- EN: Fallback Steam search transports and separate login/search error diagnostics.

## v0.2.5
- RU: Компактное меню, светлая/тёмная темы и фирменная иконка.
- EN: Compact popup, light/dark themes, and branded app icon.
