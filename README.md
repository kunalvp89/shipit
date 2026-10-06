# Credit Card Reminder PWA

A mobile-first credit card bill tracker built with Node.js + Express + HTML/CSS/JavaScript.

## Current version

- Browser `localStorage` is the database.
- No card numbers beyond last 4 digits should be stored.
- Add/edit/delete credit cards.
- Create billing cycles / statements.
- Mark bills paid.
- Dashboard with swipeable card tiles.
- Upcoming payment view.
- Browser notification support when available.
- PWA manifest + service worker.
- Responsive mobile UI.

## Run

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

For Android installation and reliable browser notifications, serve the app over HTTPS when deployed. `localhost` is treated as a secure context for development.

## Important

The current notification implementation is intentionally local/browser based. A production push-notification system will require a push service/backend and is a later phase.

## Data

All application data is stored in the browser's localStorage. Clearing site data will remove the stored cards and bills. A backup/export feature should be added before relying on this for important records.
