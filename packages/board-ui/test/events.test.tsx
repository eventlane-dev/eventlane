import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Settings, SettingsContext } from '../src/context';
import { ConsumerDetail, EventsTab, PendingList, RetryingList } from '../src/views';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings = (overrides: Partial<Settings['config']> = {}): Settings => ({
  config: { readOnly: true, hidePayloads: false, buses: ['default'], ...overrides },
  bus: 'default',
  refreshMs: 0,
  version: 0,
  bump: () => {},
  notify: () => {},
});

const wrap = (value: Settings, children: ComponentChildren) => (
  <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
);

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/** Answers fetch() with the first route whose suffix matches the path; records every call. */
function stubApi(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://board.test/');
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
      const answer = key ? routes[key] : { error: 'not found' };
      const body = typeof answer === 'function' ? answer(call) : answer;
      return new Response(JSON.stringify(body), {
        status: key ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const summary = (id: string, eventName = 'user.created') => ({
  id,
  eventName,
  timestamp: 1_000,
  preview: '{}',
  size: 2,
  payloadHidden: false,
});

describe('events tab', () => {
  const lastEventsCall = (calls: Call[]) =>
    [...calls].reverse().find((c) => c.path.endsWith('/events'));

  it('applies the name, search and time range filters as query parameters', async () => {
    const calls = stubApi({ '/events': { events: [summary('1-0')], next: null, scanned: 1 } });
    render(wrap(settings(), <EventsTab topic="users" />));
    await waitFor(() => expect(screen.getByText('1-0')).toBeTruthy());

    fireEvent.input(screen.getByLabelText('Filter by event name'), {
      target: { value: ' user.created ' },
    });
    fireEvent.input(screen.getByLabelText('Search in payloads'), { target: { value: 'ada@' } });
    fireEvent.input(screen.getByLabelText('From'), { target: { value: '2026-11-10T12:00' } });
    fireEvent.input(screen.getByLabelText('To'), { target: { value: '2026-11-10T13:30' } });
    fireEvent.click(screen.getByLabelText('Newest first'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(lastEventsCall(calls)?.query.get('search')).toBe('ada@'));
    const query = lastEventsCall(calls)?.query;
    expect(query?.get('eventName')).toBe('user.created');
    expect(query?.get('from')).toBe(String(new Date('2026-11-10T12:00').getTime()));
    expect(query?.get('to')).toBe(String(new Date('2026-11-10T13:30').getTime()));
    expect(query?.get('reverse')).toBe('false');
    await waitFor(() => expect(screen.getByText(/among the/)).toBeTruthy());
  });

  it('"Go to" opens an event by id, lists from a timestamp, and rejects anything else', async () => {
    const calls = stubApi({
      '/events/1762725960000-0': { event: null, consumers: [] },
      '/events': { events: [summary('1-0')], next: null },
    });
    render(wrap(settings(), <EventsTab topic="users" />));
    await waitFor(() => expect(screen.getByText('1-0')).toBeTruthy());

    const input = screen.getByLabelText('Go to an event');
    fireEvent.input(input, { target: { value: '1762725960000-0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Event' })).toBeTruthy());
    expect(calls.some((c) => c.path.endsWith('/events/1762725960000-0'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.input(input, { target: { value: '1762725960000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to' }));
    await waitFor(() => expect(lastEventsCall(calls)?.query.get('from')).toBe('1762725960000'));
    expect(lastEventsCall(calls)?.query.get('reverse')).toBe('false');
    expect(screen.getByText(/listing from/)).toBeTruthy();

    fireEvent.input(input, { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to' }));
    expect(screen.getByText(/Enter an event id/)).toBeTruthy();
  });

  it('disables the search while payloads are hidden', async () => {
    stubApi({ '/events': { events: [], next: null } });
    render(wrap(settings({ hidePayloads: true }), <EventsTab topic="users" />));
    expect((screen.getByLabelText('Search in payloads') as HTMLInputElement).disabled).toBe(true);
  });

  it('offers a test event only when writes are enabled, and sends valid JSON', async () => {
    stubApi({ '/events': { events: [], next: null } });
    const { unmount } = render(wrap(settings(), <EventsTab topic="users" />));
    expect(screen.queryByRole('button', { name: /Send test event/ })).toBeNull();
    unmount();

    const calls = stubApi({
      '/events': (call: Call) =>
        call.method === 'POST' ? { id: '9-0' } : { events: [], next: null },
    });
    render(wrap(settings({ readOnly: false }), <EventsTab topic="users" />));
    fireEvent.click(screen.getByRole('button', { name: /Send test event/ }));
    const dialog = screen.getByRole('alertdialog');
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(dialog.textContent).toContain('every consumer of users receives it');
    expect(send.disabled).toBe(true); // no event name yet

    fireEvent.input(screen.getByPlaceholderText('user.created'), {
      target: { value: 'user.created' },
    });
    expect(send.disabled).toBe(false);
    const payload = screen.getByLabelText('Payload (JSON)');
    fireEvent.input(payload, { target: { value: '{ broken' } });
    expect(send.disabled).toBe(true);
    expect(dialog.textContent).toMatch(/JSON|Expected|Unexpected/i);

    fireEvent.input(payload, { target: { value: '{"id": 7}' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toMatch(/\/topics\/users\/events$/);
    expect(post?.body).toEqual({ eventName: 'user.created', payload: { id: 7 } });
  });
});

describe('consumer lists', () => {
  const pending = (n: number, idleMs = 1000) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${1000 + i}-0`,
      eventName: 'user.created',
      instanceName: 'inst-a',
      idleMs,
      deliveries: 1,
      timestamp: 1,
    }));

  it('pending: a full page offers Load more, which continues after the last id', async () => {
    const calls = stubApi({
      '/pending': (call: Call) => ({
        events: call.query.get('after')
          ? pending(3).map((e) => ({ ...e, id: `${2000 + Number(e.id.split('-')[0]) - 1000}-0` }))
          : pending(50),
      }),
    });
    render(wrap(settings(), <PendingList topic="users" consumer="c" onOpen={() => {}} />));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(51));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(54));
    const second = calls.filter((c) => c.path.endsWith('/pending'))[1];
    expect(second?.query.get('after')).toBe('1049-0');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull(); // the last page was short
  });

  it('pending: marks events held longer than a minute', async () => {
    stubApi({ '/pending': { events: [...pending(1, 120_000), { ...pending(1)[0], id: '5-0' }] } });
    render(wrap(settings(), <PendingList topic="users" consumer="c" onOpen={() => {}} />));
    await waitFor(() => expect(screen.getByText('120 s').className).toContain('warn-text'));
    expect(screen.getByText('1 s').className).not.toContain('warn-text');
  });

  it('retrying: Load more continues with the offset', async () => {
    const calls = stubApi({
      '/retrying': (call: Call) => ({
        events: Array.from({ length: call.query.get('offset') ? 2 : 50 }, (_, i) => ({
          id: `${i}-0`,
          eventName: 'e',
          attempt: 1,
          dueAt: Date.now() + 5000,
          timestamp: 1,
        })),
      }),
    });
    render(wrap(settings(), <RetryingList topic="users" consumer="c" onOpen={() => {}} />));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(51));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/retrying'))).toHaveLength(2));
    expect(calls.filter((c) => c.path.endsWith('/retrying'))[1]?.query.get('offset')).toBe('50');
  });

  it('flags an idle instance that holds events as probably dead', async () => {
    stubApi({ '/pending': { events: [] }, '/retrying': { events: [] } });
    const consumer = {
      consumerName: 'c',
      instances: 2,
      pending: 3,
      lag: 0,
      retrying: 0,
      instanceDetails: [
        { instanceName: 'alive', pending: 0, idleMs: 120_000 },
        { instanceName: 'stuck', pending: 3, idleMs: 120_000 },
        { instanceName: 'busy', pending: 2, idleMs: 500 },
      ],
    };
    render(wrap(settings(), <ConsumerDetail topic="users" consumer={consumer} />));
    expect(screen.getAllByText('probably dead')).toHaveLength(1);
    const row = screen.getByText('stuck').closest('tr');
    expect(row?.textContent).toContain('probably dead');
  });
});
