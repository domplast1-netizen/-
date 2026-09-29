# Domplast Kaspi — Railway direct test

Минимальный сервис для проверки цепочки:

`Railway -> Kaspi storefront offers`

Пока не подключайте его к основной Google-таблице. Цель первого теста — понять, пропускает ли Kaspi запросы с IP Railway.

## 1. Загрузите в GitHub

Создайте новый репозиторий и положите в корень все файлы этой папки.

## 2. Создайте сервис Railway

- New Project -> Deploy from GitHub repo
- выберите репозиторий
- Railway сам установит Node.js зависимости и запустит `npm start`

`railway.json` задаёт `/health` как healthcheck. Railway использует переменную `PORT`, а сервер слушает её автоматически.

## 3. Добавьте Variables

В Railway -> Service -> Variables:

- `API_KEY` = длинный случайный секрет, придумайте сами
- `REQUEST_TIMEOUT_MS` = `25000` (необязательно)
- `UPSTREAM_PROXY_URL` НЕ добавляйте на первом тесте

Не используйте Kaspi API token как `API_KEY`.

## 4. Создайте публичный домен

Service -> Settings / Networking -> Generate Domain.

Откройте полученный URL. Появится простая тестовая страница.

## 5. Проверка

На странице введите:

- Product ID, например товар из тестовой базы
- `API_KEY`, который вы создали в Railway

Нажмите `Проверить Kaspi`.

### Успех

Если увидите:

- HTTP 200
- `ok: true`
- `upstreamStatus: 200`
- данные офферов

то Railway может обращаться к Kaspi напрямую, и ReefAPI для мониторинга потенциально можно убрать.

### Если Kaspi заблокировал Railway

Если увидите:

- HTTP 502
- `error: kaspi_forbidden`
- `upstreamStatus: 403`

значит Kaspi блокирует исходящий IP Railway. В этом случае переносить весь мониторинг на Railway напрямую смысла нет.

## API

### Health

`GET /health`

Публичный, чтобы Railway healthcheck работал без заголовков.

### Offers

`GET /offers?productId=137135273&cityId=351010000&limit=50`

Заголовок:

`X-API-Key: YOUR_API_KEY`

По умолчанию cityId = `351010000` (Караганда).
