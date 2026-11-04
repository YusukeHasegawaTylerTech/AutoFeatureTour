# Platform: TodoMVC (reference)

The simplest platform, and the one to copy: [TodoMVC](https://todomvc.com), no login, data kept in the browser's
localStorage (so every run starts with an empty list).

| Environment | baseUrl | Notes |
|---|---|---|
| `demo` (default) | https://demo.playwright.dev/todomvc/ | Playwright's public demo; attach-only (a run never starts it) |
| `local` | http://localhost:8080/ | any TodoMVC you serve yourself |

| File | What |
|---|---|
| `fragments/add-todo.json` | `{ "use": "add-todo", "with": { "text": "…" } }`: type a task and press Enter |
| `fragments/todo-count.mjs` | code step: `{ "use": "todo-count", "with": { "count": 2, "completed": true } }` checks the list (CRITERION if wrong) |
| `fixtures/three-tasks.json` | three tasks, the second completed, added off camera; `{data.first}`, `{data.second}`, `{data.third}` |
| test ids | `todo-item` (each task), `todo-title`, `todo-count` (the "N items left" counter, which has no ARIA name): target them with `{ "testId": … }` |
| `tours/TODO-202.tour.json` | story TODO-202: clear completed (written by an agent from the docs alone) |
| `tours/smoke.tour.json` | what `aft platform check todomvc` runs |
| `tours/track-and-filter.tour.json` | story TODO-101: add, complete, filter |
| `tours/fixture-demo.tour.json` | starts from the fixture |

```
aft platform check todomvc
aft run platforms/todomvc/tours/track-and-filter.tour.json --speech silent
```
