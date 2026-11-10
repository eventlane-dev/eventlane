import type {
  ConsumerEventStatus,
  ConsumerStats,
  PendingEvent,
  RetryingEvent,
  TopicResponse,
} from '@eventlane/board-api';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ConfirmDialog, EmitDialog, ReplayDialog, useAction } from './actions';
import { actions, api } from './api';
import { Async, Badge, CopyButton, Count, Drawer, Json, Mono } from './components';
import { useSettings } from './context';
import { formatNumber, formatRelative, formatSize, formatTime } from './format';
import { useLoad } from './hooks';
import { type Tab, topicHref } from './route';
import type { DeadLetterSummary, EventSummary, TopicOverview } from './types';

/** An instance idle this long while holding events is probably dead (claimIdleMs defaults to 60 s). */
const IDLE_WARNING_MS = 60_000;

const stateTone: Record<ConsumerEventStatus['state'], string> = {
  'not-read': 'neutral',
  pending: 'warn',
  retrying: 'warn',
  'dead-letter': 'bad',
  done: 'good',
};

// ---------------------------------------------------------------------------------------------
// Topics

export function TopicsView() {
  const { bus, refreshMs } = useSettings();
  const loaded = useLoad(() => api.topics(bus), [bus], refreshMs);
  const [query, setQuery] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);

  return (
    <section>
      <div class="toolbar">
        <h1>Topics</h1>
        <input
          type="search"
          placeholder="Filter by name"
          aria-label="Filter topics by name"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <label class="check">
          <input
            type="checkbox"
            checked={attentionOnly}
            onChange={(e) => setAttentionOnly(e.currentTarget.checked)}
          />
          Needs attention
        </label>
      </div>
      <Async loaded={loaded} empty={(d) => d.topics.length === 0}>
        {(data) => {
          const topics = data.topics
            .filter((t) => t.topicName.includes(query.trim()))
            .filter((t) => !attentionOnly || t.needsAttention)
            .sort(
              (a, b) =>
                Number(b.needsAttention) - Number(a.needsAttention) ||
                a.topicName.localeCompare(b.topicName),
            );
          return <TopicsTable topics={topics} />;
        }}
      </Async>
    </section>
  );
}

function TopicsTable({ topics }: { topics: TopicOverview[] }) {
  if (topics.length === 0) return <p class="muted">No topic matches.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Topic</th>
          <th class="num">Events</th>
          <th class="num">Consumers</th>
          <th class="num">Lag</th>
          <th class="num">Pending</th>
          <th class="num">Retrying</th>
          <th class="num">Dead letters</th>
          <th>Newest event</th>
        </tr>
      </thead>
      <tbody>
        {topics.map((t) => (
          <tr key={t.topicName}>
            <td>
              <a href={topicHref(t.topicName)}>{t.topicName}</a>
              {t.needsAttention && <Badge tone="warn">attention</Badge>}
            </td>
            <td class="num">{formatNumber(t.length)}</td>
            <td class="num">{t.consumers}</td>
            <td class="num">
              <Count value={t.lag} warn />
            </td>
            <td class="num">
              <Count value={t.pending} warn />
            </td>
            <td class="num">
              <Count value={t.retrying} warn />
            </td>
            <td class="num">
              <Count value={t.deadLetters} warn />
            </td>
            <td title={formatTime(t.newest)}>{formatRelative(t.newest)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// One topic

export function TopicView({ topic, tab }: { topic: string; tab: Tab }) {
  const { bus, refreshMs, config } = useSettings();
  const run = useAction();
  const [deleting, setDeleting] = useState(false);
  const stats = useLoad(() => api.topic(bus, topic), [bus, topic], refreshMs);
  const tabs: Array<[Tab, string]> = [
    ['events', 'Events'],
    ['consumers', 'Consumers'],
    ['dlq', 'Dead letters'],
  ];
  const dead = stats.data?.topic.deadLetters ?? 0;

  return (
    <section>
      <p class="crumbs">
        <a href="#/">Topics</a> / <strong>{topic}</strong>
      </p>
      <div class="toolbar">
        <h1>{topic}</h1>
        {stats.data && <span class="muted">{formatNumber(stats.data.topic.length)} events</span>}
        {!config.readOnly && (
          <button type="button" class="danger-outline" onClick={() => setDeleting(true)}>
            Delete topic…
          </button>
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          title={`Delete ${topic}`}
          confirmLabel="Delete topic"
          danger
          typed={topic}
          onClose={() => setDeleting(false)}
          onConfirm={() =>
            run(async () => {
              await actions.deleteTopic(bus, topic);
              window.location.hash = '#/';
              return `Topic ${topic} deleted`;
            })
          }
        >
          <p>
            Deletes all events of <strong>{topic}</strong>, its dead letters, the retries of every
            consumer and the idempotency keys. Consumers that listen to it start again from an empty
            topic. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
      {stats.error && !stats.data && (
        <p class="error" role="alert">
          {stats.error.message}
        </p>
      )}
      <div class="tabs" role="tablist" aria-label="Topic sections">
        {tabs.map(([id, label]) => (
          <a
            key={id}
            href={topicHref(topic, id)}
            role="tab"
            aria-selected={tab === id}
            class={tab === id ? 'tab active' : 'tab'}
          >
            {label}
            {id === 'dlq' && dead > 0 && <Badge tone="bad">{dead}</Badge>}
          </a>
        ))}
      </div>
      {tab === 'events' && <EventsTab topic={topic} />}
      {tab === 'consumers' && <ConsumersTab topic={topic} stats={stats} />}
      {tab === 'dlq' && <DeadLettersTab topic={topic} />}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Events

/** A `datetime-local` value to milliseconds since epoch, or undefined when it is empty. */
function toMs(value: string): number | undefined {
  if (value === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

interface EventQuery {
  eventName: string;
  search: string;
  from: string;
  to: string;
  /** An exact start (from "Go to"); a `datetime-local` value cannot hold milliseconds. */
  fromMs: number | undefined;
  newestFirst: boolean;
}

export function EventsTab({ topic }: { topic: string }) {
  const { bus, refreshMs, version, config } = useSettings();
  const writable = !config.readOnly;
  const [query, setQuery] = useState<EventQuery>({
    eventName: '',
    search: '',
    from: '',
    to: '',
    fromMs: undefined,
    newestFirst: true,
  });
  const [draft, setDraft] = useState(query);
  const [extra, setExtra] = useState<EventSummary[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState<string | undefined>();

  const params = (extraParams: Record<string, string> = {}) => ({
    limit: 50,
    eventName: query.eventName,
    search: query.search,
    from: query.fromMs ?? toMs(query.from),
    to: toMs(query.to),
    reverse: query.newestFirst,
    ...extraParams,
  });

  // browsing older pages pauses the refresh, so the list does not jump under the reader
  const head = useLoad(
    () => api.events(bus, topic, params()),
    [bus, topic, query],
    extra.length === 0 ? refreshMs : 0,
  );
  useEffect(() => {
    setExtra([]);
    setCursor(undefined);
  }, [bus, topic, query, version]);

  const next = cursor === undefined ? head.data?.next : cursor;
  const events = [...(head.data?.events ?? []), ...extra];
  const searching = query.search !== '';

  const loadMore = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const page = await api.events(bus, topic, params({ cursor: next }));
      setExtra((e) => [...e, ...page.events]);
      setCursor(page.next);
    } finally {
      setBusy(false);
    }
  };

  /** An event id opens that event; a timestamp (ms) lists the events from that moment on. */
  const goTo = () => {
    const text = jump.trim();
    setJumpError(undefined);
    if (/^\d+-\d+$/.test(text)) {
      setOpen(text);
    } else if (/^\d{10,}$/.test(text)) {
      const moved = { ...query, from: '', fromMs: Number(text), newestFirst: false };
      setDraft({ ...draft, from: '', newestFirst: false });
      setQuery(moved);
    } else {
      setJumpError('Enter an event id like 1762725960000-0, or a timestamp in milliseconds');
    }
  };

  return (
    <div>
      <form
        class="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({
            ...draft,
            eventName: draft.eventName.trim(),
            search: draft.search.trim(),
            fromMs: undefined,
          });
        }}
      >
        <input
          type="search"
          placeholder="Event name, e.g. user.created"
          aria-label="Filter by event name"
          value={draft.eventName}
          onInput={(e) => setDraft({ ...draft, eventName: e.currentTarget.value })}
        />
        <input
          type="search"
          placeholder="Search payloads and headers"
          aria-label="Search in payloads"
          value={draft.search}
          disabled={config.hidePayloads}
          title={config.hidePayloads ? 'Payloads are hidden by the server' : undefined}
          onInput={(e) => setDraft({ ...draft, search: e.currentTarget.value })}
        />
        <label class="check">
          From
          <input
            type="datetime-local"
            aria-label="From"
            value={draft.from}
            onInput={(e) => setDraft({ ...draft, from: e.currentTarget.value })}
          />
        </label>
        <label class="check">
          To
          <input
            type="datetime-local"
            aria-label="To"
            value={draft.to}
            onInput={(e) => setDraft({ ...draft, to: e.currentTarget.value })}
          />
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={draft.newestFirst}
            onChange={(e) => setDraft({ ...draft, newestFirst: e.currentTarget.checked })}
          />
          Newest first
        </label>
        <button type="submit">Apply</button>
        {writable && (
          <button type="button" class="primary push" onClick={() => setSending(true)}>
            Send test event…
          </button>
        )}
      </form>
      <form
        class="filters"
        onSubmit={(e) => {
          e.preventDefault();
          goTo();
        }}
      >
        <input
          type="text"
          placeholder="Event id or timestamp (ms)"
          aria-label="Go to an event"
          value={jump}
          onInput={(e) => setJump(e.currentTarget.value)}
        />
        <button type="submit">Go to</button>
        {jumpError && <span class="error">{jumpError}</span>}
        {query.fromMs !== undefined && (
          <span class="muted">listing from {formatTime(query.fromMs)}</span>
        )}
        {extra.length > 0 && <span class="muted">refresh paused while browsing older events</span>}
      </form>
      <Async loaded={head} empty={() => events.length === 0}>
        {() => (
          <>
            {searching && head.data?.scanned !== undefined && (
              <p class="muted">
                {events.length} match{events.length === 1 ? '' : 'es'} among the{' '}
                {formatNumber(head.data.scanned)} events looked at
                {next ? '; there may be more, load more continues the search' : ''}.
              </p>
            )}
            <table class="clickable">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Id</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr
                    key={e.id}
                    tabIndex={0}
                    onClick={() => setOpen(e.id)}
                    onKeyDown={(k) => k.key === 'Enter' && setOpen(e.id)}
                  >
                    <td class="nowrap">{formatTime(e.timestamp)}</td>
                    <td>
                      <Badge>{e.eventName}</Badge>
                    </td>
                    <td>
                      <Mono>{e.id}</Mono>
                    </td>
                    <td class="preview">
                      {e.payloadHidden ? <span class="muted">hidden</span> : e.preview}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {next && (
              <p>
                <button type="button" onClick={loadMore} disabled={busy}>
                  {busy ? 'Loading…' : 'Load more'}
                </button>
              </p>
            )}
          </>
        )}
      </Async>
      {open && <EventDrawer topic={topic} id={open} onClose={() => setOpen(undefined)} />}
      {sending && <EmitDialog topic={topic} onClose={() => setSending(false)} />}
    </div>
  );
}

function EventDrawer({ topic, id, onClose }: { topic: string; id: string; onClose: () => void }) {
  const { bus, refreshMs } = useSettings();
  const loaded = useLoad(() => api.event(bus, topic, id), [bus, topic, id], refreshMs);
  return (
    <Drawer title="Event" onClose={onClose}>
      <Async loaded={loaded}>
        {({ event, consumers }) => (
          <>
            <dl>
              <dt>Id</dt>
              <dd>
                <Mono>{id}</Mono> <CopyButton text={id} />
              </dd>
              {event && (
                <>
                  <dt>Event</dt>
                  <dd>
                    <Badge>{event.eventName}</Badge>
                  </dd>
                  <dt>Time</dt>
                  <dd>
                    {formatTime(event.timestamp)}{' '}
                    <span class="muted">({formatRelative(event.timestamp)})</span>
                  </dd>
                  <dt>Size</dt>
                  <dd>{formatSize(event.size)}</dd>
                </>
              )}
            </dl>
            {!event && (
              <p class="muted">
                This event is no longer in the topic (it was trimmed or never existed).
              </p>
            )}
            {event && (
              <>
                <h3>Payload</h3>
                {event.payloadHidden ? (
                  <p class="muted">Payloads are hidden by the server.</p>
                ) : event.payloadTruncated ? (
                  <p class="muted">The payload is too large to show ({formatSize(event.size)}).</p>
                ) : (
                  <Json value={event.payload} />
                )}
                <h3>Headers</h3>
                {Object.keys(event.headers).length === 0 ? (
                  <p class="muted">None.</p>
                ) : (
                  <Json value={event.headers} />
                )}
              </>
            )}
            <h3>Consumers</h3>
            {consumers.length === 0 ? (
              <p class="muted">No consumer has been created for this topic yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Consumer</th>
                    <th>State</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {consumers.map((c) => (
                    <tr key={c.consumerName}>
                      <td>{c.consumerName}</td>
                      <td>
                        <Badge tone={stateTone[c.state]}>{c.state}</Badge>
                      </td>
                      <td class="muted">{consumerDetail(c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Async>
    </Drawer>
  );
}

function consumerDetail(c: ConsumerEventStatus): ComponentChildren {
  switch (c.state) {
    case 'pending':
      return `held by ${c.instanceName}, idle ${Math.round((c.idleMs ?? 0) / 1000)} s, delivered ${c.deliveries}×`;
    case 'retrying':
      return `attempt ${c.attempt}, next retry ${formatRelative(c.dueAt)}`;
    case 'dead-letter':
      return `after ${c.attempt} attempts: ${c.error}`;
    case 'not-read':
      return 'not reached yet';
    default:
      return 'nothing is waiting for this consumer';
  }
}

// ---------------------------------------------------------------------------------------------
// Consumers

function ConsumersTab({
  topic,
  stats,
}: {
  topic: string;
  stats: ReturnType<typeof useLoad<TopicResponse>>;
}) {
  const [selected, setSelected] = useState<string | undefined>();
  return (
    <Async loaded={stats} empty={(d) => d.topic.consumers.length === 0}>
      {({ topic: t }) => {
        const chosen = t.consumers.find((c) => c.consumerName === selected);
        return (
          <>
            <table class="clickable">
              <thead>
                <tr>
                  <th>Consumer</th>
                  <th class="num">Instances</th>
                  <th class="num">Pending</th>
                  <th class="num">Lag</th>
                  <th class="num">Retrying</th>
                </tr>
              </thead>
              <tbody>
                {t.consumers.map((c) => (
                  <tr
                    key={c.consumerName}
                    tabIndex={0}
                    class={selected === c.consumerName ? 'selected' : ''}
                    onClick={() => setSelected(c.consumerName)}
                    onKeyDown={(k) => k.key === 'Enter' && setSelected(c.consumerName)}
                  >
                    <td>{c.consumerName}</td>
                    <td class="num">{c.instances}</td>
                    <td class="num">
                      <Count value={c.pending} warn />
                    </td>
                    <td class="num">
                      <Count value={c.lag} warn />
                    </td>
                    <td class="num">
                      <Count value={c.retrying} warn />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {chosen ? (
              <ConsumerDetail topic={topic} consumer={chosen} />
            ) : (
              <p class="muted">
                Select a consumer to see its instances, pending and retrying events.
              </p>
            )}
          </>
        );
      }}
    </Async>
  );
}

export function ConsumerDetail({ topic, consumer }: { topic: string; consumer: ConsumerStats }) {
  const { bus, config } = useSettings();
  const name = consumer.consumerName;
  const [open, setOpen] = useState<string | undefined>();
  const [dialog, setDialog] = useState<'replay' | 'remove' | undefined>();
  const writable = !config.readOnly;
  const run = useAction();

  return (
    <div class="detail">
      <div class="toolbar">
        <h2>{name}</h2>
        {writable && (
          <>
            <button type="button" onClick={() => setDialog('replay')}>
              Replay…
            </button>
            <button type="button" class="danger-outline" onClick={() => setDialog('remove')}>
              Remove consumer…
            </button>
          </>
        )}
      </div>
      <h3>Instances</h3>
      {(consumer.instanceDetails ?? []).length === 0 ? (
        <p class="muted">No instance is attached.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Instance</th>
              <th class="num">Pending</th>
              <th>Idle</th>
            </tr>
          </thead>
          <tbody>
            {(consumer.instanceDetails ?? []).map((i) => (
              <tr key={i.instanceName}>
                <td>
                  <Mono>{i.instanceName}</Mono>
                </td>
                <td class="num">{i.pending}</td>
                <td>
                  {Math.round(i.idleMs / 1000)} s
                  {i.pending > 0 && i.idleMs > IDLE_WARNING_MS && (
                    <span
                      title={`Idle for more than ${IDLE_WARNING_MS / 1000} s while holding events: probably dead. Other instances claim its events once they have been idle for claimIdleMs (60 s by default).`}
                    >
                      <Badge tone="warn">probably dead</Badge>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Pending ({consumer.pending})</h3>
      <PendingList topic={topic} consumer={name} onOpen={setOpen} />

      <h3>Retrying ({consumer.retrying})</h3>
      <RetryingList topic={topic} consumer={name} onOpen={setOpen} />
      {open && <EventDrawer topic={topic} id={open} onClose={() => setOpen(undefined)} />}
      {dialog === 'replay' && (
        <ReplayDialog topic={topic} consumer={name} onClose={() => setDialog(undefined)} />
      )}
      {dialog === 'remove' && (
        <ConfirmDialog
          title={`Remove ${name}`}
          confirmLabel="Remove consumer"
          danger
          typed={name}
          onClose={() => setDialog(undefined)}
          onConfirm={() =>
            run(async () => {
              await actions.removeConsumer(bus, topic, name);
              return `Consumer ${name} removed`;
            })
          }
        >
          <p>
            Removes the read position, the pending list and the retries of <strong>{name}</strong>.
            The events stay in the topic. If instances of this consumer are still running, they
            create it again at the end of the topic, so stop them first.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

const PAGE = 50;

/** Events delivered to a consumer and not acknowledged; a full page offers "Load more". */
export function PendingList({
  topic,
  consumer,
  onOpen,
}: {
  topic: string;
  consumer: string;
  onOpen: (id: string) => void;
}) {
  const { bus, refreshMs, version } = useSettings();
  const [extra, setExtra] = useState<PendingEvent[]>([]);
  const [more, setMore] = useState<boolean | undefined>();
  const [busy, setBusy] = useState(false);
  const head = useLoad(
    () => api.pending(bus, topic, consumer, { limit: PAGE }),
    [bus, topic, consumer],
    extra.length === 0 ? refreshMs : 0,
  );
  useEffect(() => {
    setExtra([]);
    setMore(undefined);
  }, [bus, topic, consumer, version]);

  const events = [...(head.data?.events ?? []), ...extra];
  const hasMore = more ?? (head.data?.events.length ?? 0) >= PAGE;
  const loadMore = async () => {
    setBusy(true);
    try {
      const page = await api.pending(bus, topic, consumer, {
        limit: PAGE,
        after: events[events.length - 1]?.id,
      });
      setExtra((e) => [...e, ...page.events]);
      setMore(page.events.length >= PAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Async loaded={head} empty={() => events.length === 0}>
      {() => (
        <>
          <table class="clickable">
            <thead>
              <tr>
                <th>Id</th>
                <th>Event</th>
                <th>Held by</th>
                <th>Idle</th>
                <th class="num">Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  tabIndex={0}
                  onClick={() => onOpen(e.id)}
                  onKeyDown={(k) => k.key === 'Enter' && onOpen(e.id)}
                >
                  <td>
                    <Mono>{e.id}</Mono>
                  </td>
                  <td>
                    {e.eventName ? (
                      <Badge>{e.eventName}</Badge>
                    ) : (
                      <span class="muted">trimmed</span>
                    )}
                  </td>
                  <td>
                    <Mono>{e.instanceName}</Mono>
                  </td>
                  <td class={e.idleMs > IDLE_WARNING_MS ? 'warn-text' : ''}>
                    {Math.round(e.idleMs / 1000)} s
                  </td>
                  <td class="num">{e.deliveries}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <p>
              <button type="button" onClick={loadMore} disabled={busy}>
                {busy ? 'Loading…' : 'Load more'}
              </button>
            </p>
          )}
        </>
      )}
    </Async>
  );
}

/** Failed events waiting for a retry, soonest first; a full page offers "Load more". */
export function RetryingList({
  topic,
  consumer,
  onOpen,
}: {
  topic: string;
  consumer: string;
  onOpen: (id: string) => void;
}) {
  const { bus, refreshMs, version } = useSettings();
  const [extra, setExtra] = useState<RetryingEvent[]>([]);
  const [more, setMore] = useState<boolean | undefined>();
  const [busy, setBusy] = useState(false);
  const head = useLoad(
    () => api.retrying(bus, topic, consumer, { limit: PAGE }),
    [bus, topic, consumer],
    extra.length === 0 ? refreshMs : 0,
  );
  useEffect(() => {
    setExtra([]);
    setMore(undefined);
  }, [bus, topic, consumer, version]);

  const events = [...(head.data?.events ?? []), ...extra];
  const hasMore = more ?? (head.data?.events.length ?? 0) >= PAGE;
  const loadMore = async () => {
    setBusy(true);
    try {
      const page = await api.retrying(bus, topic, consumer, { limit: PAGE, offset: events.length });
      setExtra((e) => [...e, ...page.events]);
      setMore(page.events.length >= PAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Async loaded={head} empty={() => events.length === 0}>
      {() => (
        <>
          <table class="clickable">
            <thead>
              <tr>
                <th>Id</th>
                <th>Event</th>
                <th class="num">Attempt</th>
                <th>Next retry</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={`${e.id}-${e.attempt}`}
                  tabIndex={0}
                  onClick={() => onOpen(e.id)}
                  onKeyDown={(k) => k.key === 'Enter' && onOpen(e.id)}
                >
                  <td>
                    <Mono>{e.id}</Mono>
                  </td>
                  <td>
                    <Badge>{e.eventName}</Badge>
                  </td>
                  <td class="num">{e.attempt}</td>
                  <td title={formatTime(e.dueAt)}>{formatRelative(e.dueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <p>
              <button type="button" onClick={loadMore} disabled={busy}>
                {busy ? 'Loading…' : 'Load more'}
              </button>
            </p>
          )}
        </>
      )}
    </Async>
  );
}

// ---------------------------------------------------------------------------------------------
// Dead letters

type DlqAction = 'retry-selected' | 'purge-selected' | 'retry-all' | 'purge-all';

export function DeadLettersTab({ topic }: { topic: string }) {
  const { bus, refreshMs, version, config } = useSettings();
  const writable = !config.readOnly;
  const run = useAction();
  const [consumer, setConsumer] = useState('');
  const [eventName, setEventName] = useState('');
  const [draft, setDraft] = useState({ consumer: '', eventName: '' });
  const [extra, setExtra] = useState<DeadLetterSummary[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<DlqAction | undefined>();

  const head = useLoad(
    () => api.deadLetters(bus, topic, { limit: 50, consumer, eventName }),
    [bus, topic, consumer, eventName],
    extra.length === 0 && selected.size === 0 ? refreshMs : 0,
  );
  useEffect(() => {
    setExtra([]);
    setCursor(undefined);
    setSelected(new Set());
  }, [bus, topic, consumer, eventName, version]);

  const next = cursor === undefined ? head.data?.next : cursor;
  const entries = [...(head.data?.entries ?? []), ...extra];
  const filtered = consumer !== '' || eventName !== '';
  const chosen = [...selected];
  const allSelected = entries.length > 0 && entries.every((d) => selected.has(d.id));
  const total = head.data?.total ?? 0;
  const scope = {
    consumer: consumer || undefined,
    eventName: eventName || undefined,
    all: !filtered,
  };

  const loadMore = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const page = await api.deadLetters(bus, topic, {
        limit: 50,
        consumer,
        eventName,
        cursor: next,
      });
      setExtra((e) => [...e, ...page.entries]);
      setCursor(page.next);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const copy = new Set(current);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });

  const confirmation = ():
    | {
        title: string;
        label: string;
        danger: boolean;
        text: string;
        task: () => Promise<string>;
      }
    | undefined => {
    const matching = filtered ? 'matching the filters' : `of the topic (${formatNumber(total)})`;
    switch (ask) {
      case 'retry-selected':
        return {
          title: `Retry ${chosen.length} dead letter${chosen.length === 1 ? '' : 's'}`,
          label: 'Retry',
          danger: false,
          text: 'Each one goes back to the consumer that failed it, with a fresh attempt count.',
          task: async () => {
            const r = await actions.retryDeadLetters(bus, topic, { ids: chosen });
            return `${r.retried} dead letter(s) sent back to their consumers`;
          },
        };
      case 'purge-selected':
        return {
          title: `Delete ${chosen.length} dead letter${chosen.length === 1 ? '' : 's'}`,
          label: 'Delete',
          danger: true,
          text: 'They are removed for good: the events are not retried and cannot be recovered.',
          task: async () => {
            const r = await actions.purgeDeadLetters(bus, topic, { ids: chosen });
            return `${r.purged} dead letter(s) deleted`;
          },
        };
      case 'retry-all':
        return {
          title: 'Retry all dead letters',
          label: 'Retry all',
          danger: false,
          text: `Every dead letter ${matching} goes back to the consumer that failed it, with a fresh attempt count.`,
          task: async () => {
            const r = await actions.retryDeadLetters(bus, topic, scope);
            return `${r.retried} dead letter(s) sent back to their consumers`;
          },
        };
      case 'purge-all':
        return {
          title: 'Delete all dead letters',
          label: 'Delete all',
          danger: true,
          text: `Every dead letter ${matching} is removed for good.`,
          task: async () => {
            const r = await actions.purgeDeadLetters(bus, topic, scope);
            return `${r.purged} dead letter(s) deleted`;
          },
        };
      default:
        return undefined;
    }
  };
  const dialog = confirmation();

  return (
    <div>
      <form
        class="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setConsumer(draft.consumer.trim());
          setEventName(draft.eventName.trim());
        }}
      >
        <input
          type="search"
          placeholder="Consumer"
          aria-label="Filter by consumer"
          value={draft.consumer}
          onInput={(e) => setDraft({ ...draft, consumer: e.currentTarget.value })}
        />
        <input
          type="search"
          placeholder="Event name"
          aria-label="Filter by event name"
          value={draft.eventName}
          onInput={(e) => setDraft({ ...draft, eventName: e.currentTarget.value })}
        />
        <button type="submit">Filter</button>
        {head.data && <span class="muted">{formatNumber(head.data.total)} in total</span>}
      </form>
      {writable && (
        <div class="bulk">
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={() => setAsk('retry-selected')}
          >
            Retry selected ({chosen.length})
          </button>
          <button
            type="button"
            class="danger-outline"
            disabled={chosen.length === 0}
            onClick={() => setAsk('purge-selected')}
          >
            Delete selected ({chosen.length})
          </button>
          <span class="spacer" />
          <button type="button" disabled={total === 0} onClick={() => setAsk('retry-all')}>
            {filtered ? 'Retry all matching' : 'Retry all'}
          </button>
          <button
            type="button"
            class="danger-outline"
            disabled={total === 0}
            onClick={() => setAsk('purge-all')}
          >
            {filtered ? 'Delete all matching' : 'Delete all'}
          </button>
        </div>
      )}
      <Async loaded={head} empty={() => entries.length === 0}>
        {() => (
          <>
            <table class="clickable">
              <thead>
                <tr>
                  {writable && (
                    <th class="check-cell">
                      <input
                        type="checkbox"
                        aria-label="Select all loaded dead letters"
                        checked={allSelected}
                        onChange={() =>
                          setSelected(allSelected ? new Set() : new Set(entries.map((d) => d.id)))
                        }
                      />
                    </th>
                  )}
                  <th>Failed</th>
                  <th>Consumer</th>
                  <th>Event</th>
                  <th class="num">Attempts</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((d) => (
                  <tr
                    key={d.id}
                    tabIndex={0}
                    onClick={() => setOpen(d.id)}
                    onKeyDown={(k) => k.key === 'Enter' && setOpen(d.id)}
                  >
                    {writable && (
                      <td class="check-cell">
                        <input
                          type="checkbox"
                          aria-label={`Select dead letter ${d.id}`}
                          checked={selected.has(d.id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggle(d.id)}
                        />
                      </td>
                    )}
                    <td class="nowrap" title={formatTime(d.failedAt)}>
                      {formatRelative(d.failedAt)}
                    </td>
                    <td>{d.consumerName}</td>
                    <td>
                      <Badge>{d.eventName}</Badge>
                    </td>
                    <td class="num">{d.attempt}</td>
                    <td class="preview error-text">{d.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {next && (
              <p>
                <button type="button" onClick={loadMore} disabled={busy}>
                  {busy ? 'Loading…' : 'Load more'}
                </button>
              </p>
            )}
          </>
        )}
      </Async>
      {open && <DeadLetterDrawer topic={topic} id={open} onClose={() => setOpen(undefined)} />}
      {dialog && (
        <ConfirmDialog
          title={dialog.title}
          confirmLabel={dialog.label}
          danger={dialog.danger}
          onClose={() => setAsk(undefined)}
          onConfirm={() => run(dialog.task)}
        >
          <p>{dialog.text}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function DeadLetterDrawer({
  topic,
  id,
  onClose,
}: {
  topic: string;
  id: string;
  onClose: () => void;
}) {
  const { bus, config } = useSettings();
  const writable = !config.readOnly;
  const run = useAction();
  const [deleting, setDeleting] = useState(false);
  const loaded = useLoad(() => api.deadLetter(bus, topic, id), [bus, topic, id], 0);
  return (
    <Drawer title="Dead letter" onClose={onClose}>
      <Async loaded={loaded}>
        {({ deadLetter: d }) => (
          <>
            {writable && (
              <div class="bulk">
                <button
                  type="button"
                  class="primary"
                  onClick={() =>
                    run(async () => {
                      const r = await actions.retryDeadLetters(bus, topic, { ids: [id] });
                      onClose();
                      return `${r.retried} dead letter sent back to ${d.consumerName}`;
                    }).catch(() => {})
                  }
                >
                  Retry
                </button>
                <button type="button" class="danger-outline" onClick={() => setDeleting(true)}>
                  Delete
                </button>
              </div>
            )}
            <dl>
              <dt>Consumer</dt>
              <dd>{d.consumerName}</dd>
              <dt>Event</dt>
              <dd>
                <Badge>{d.eventName}</Badge>
              </dd>
              <dt>Original event</dt>
              <dd>
                <a href={topicHref(topic, 'events')} onClick={onClose}>
                  <Mono>{d.originalId}</Mono>
                </a>{' '}
                <CopyButton text={d.originalId} />
              </dd>
              <dt>Failed</dt>
              <dd>
                {formatTime(d.failedAt)} <span class="muted">({formatRelative(d.failedAt)})</span>
              </dd>
              <dt>Attempts</dt>
              <dd>{d.attempt}</dd>
            </dl>
            <h3>Error</h3>
            <p class="error-text">{d.error}</p>
            {d.stack && <pre class="stack">{d.stack}</pre>}
            <h3>Payload</h3>
            {d.payloadHidden ? (
              <p class="muted">Payloads are hidden by the server.</p>
            ) : d.payloadTruncated ? (
              <p class="muted">The payload is too large to show ({formatSize(d.size)}).</p>
            ) : (
              <Json value={d.payload} />
            )}
            <h3>Headers</h3>
            {Object.keys(d.headers).length === 0 ? (
              <p class="muted">None.</p>
            ) : (
              <Json value={d.headers} />
            )}
            {deleting && (
              <ConfirmDialog
                title="Delete dead letter"
                confirmLabel="Delete"
                danger
                onClose={() => setDeleting(false)}
                onConfirm={() =>
                  run(async () => {
                    await actions.purgeDeadLetters(bus, topic, { ids: [id] });
                    onClose();
                    return 'Dead letter deleted';
                  })
                }
              >
                <p>It is removed for good: the event is not retried and cannot be recovered.</p>
              </ConfirmDialog>
            )}
          </>
        )}
      </Async>
    </Drawer>
  );
}
