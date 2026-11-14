# Using the board

What each screen of the dashboard shows and what its actions do. To mount it first, see [Getting started](getting-started.md); the settings behind it (`readOnly`, `authorize`, `redact`) are in [Options and security](options.md).

## What you see

- **Topics**: every topic with its size, consumers, lag, pending, retrying and dead letters, and the age of the newest event. Topics that need a look (lag, pending or dead letters) are marked and listed first; filter by name or by "needs attention".
- **Topic, Events**: the events of a topic, newest first, 50 at a time with *Load more*.
  - Filter by **event name** or a **time range** (From and To), or **search** payloads and headers for a text (case-insensitive).
  - **Go to** takes an event id (opens that event) or a timestamp in milliseconds (lists from that moment on).
  - Click an event for its payload, headers and, for **every consumer**, where it stands: `not-read`, `pending` (and on which instance), `retrying` (with the next retry time), `dead-letter` or `done`.
  - The search is bounded: it looks at no more than 10 000 events per request and says how many it looked at; *Load more* continues it. It searches what the board would show, after `redact`, so it can never find a value that you hide, and it is switched off while `hidePayloads` is on.
- **Topic, Consumers**: each consumer's instances (with how long each has been idle), pending, lag and retrying counts.
  - An instance that holds events and has been idle for over a minute is flagged **probably dead**; the other instances claim its events after `claimIdleMs` (60 s by default).
  - Click a consumer to list its pending events (who holds them, for how long, how many deliveries; held longer than a minute is highlighted) and its retrying events (attempt, next retry). Both load 50 at a time.
- **Topic, Dead letters**: failed events with the consumer, the number of attempts and the error; filter by consumer or event name. Click one for the stack trace, payload and headers.

With writes enabled (see [Making changes](#making-changes)) the same screens also let you change things.

The page refreshes by polling (every 5 s by default; pick another interval or pause it in the header). While you browse older events the refresh is paused so the list does not move under you. The theme follows your system (light or dark).

## Making changes

The board is read-only until you pass `readOnly: false`; the header then shows a "writes enabled" badge. Every action asks for confirmation first:

| Where | Action | Confirmation |
|---|---|---|
| Events | **Send test event…**: stores an event with a name and a JSON payload (every consumer of the topic receives it) | A dialog that says so; nothing is sent until you press Send |
| Dead letters | **Retry** or **Delete** the selected ones (checkboxes), or all (matching the filters) | A dialog that states what will happen and how many |
| A dead letter | **Retry** or **Delete** it | Retry at once; delete asks |
| Consumers, a consumer | **Replay…**: continue from the beginning, the end (skip), a time or an event id, with a **preview** of how many events it will read again | A dialog; nothing changes until you press Replay |
| Consumers, a consumer | **Remove consumer…**: its read position, pending list and retries (the events stay) | You type the consumer's name |
| Topic | **Delete topic…**: the events, dead letters, retries and idempotency keys | You type the topic's name |

A retried dead letter goes back to the consumer that failed it (not to the others) with a fresh attempt count. Deleting dead letters, removing consumers and deleting topics cannot be undone. Details of what each action does are in the core's [Operations](../core/operations.md) and [Reliability](../core/reliability.md#dead-letters).

The server enforces what the UI shows: a bulk action needs an explicit scope, and removing a consumer or a topic needs its name as `confirm`.
