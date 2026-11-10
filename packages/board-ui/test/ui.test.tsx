import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/actions';
import { Async, Drawer } from '../src/components';
import { type Settings, SettingsContext } from '../src/context';
import { useLoad } from '../src/hooks';
import { DeadLettersTab, TopicsView } from '../src/views';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  config: { readOnly: true, hidePayloads: false, buses: ['default'] },
  bus: 'default',
  refreshMs: 0,
  version: 0,
  bump: () => {},
  notify: () => {},
  ...overrides,
});

const withSettings = (value: Settings, children: ComponentChildren) => (
  <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
);

/** Answers fetch() by path; each answer is the JSON body. */
function stubApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input), 'http://board.test/');
      calls.push(`${url.pathname}${url.search}`);
      const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
      return new Response(JSON.stringify(key ? routes[key] : { error: 'not found' }), {
        status: key ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('useLoad', () => {
  function Probe({
    topic,
    refreshMs,
    load,
  }: {
    topic: string;
    refreshMs: number;
    load: (t: string) => Promise<string>;
  }) {
    const loaded = useLoad(() => load(topic), [topic], refreshMs);
    return (
      <p data-testid="out">
        {loaded.data ?? 'no data'}|{loaded.loading ? 'loading' : 'idle'}
      </p>
    );
  }

  it('loads, then keeps showing data while a changed interval reloads, and clears it for a new subject', async () => {
    let release: (() => void) | undefined;
    const load = vi.fn(
      (topic: string) =>
        new Promise<string>((resolve) => {
          release = () => resolve(`data of ${topic}`);
        }),
    );
    const { rerender } = render(<Probe topic="users" refreshMs={0} load={load} />);
    expect(screen.getByTestId('out').textContent).toBe('no data|loading');
    release?.();
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('data of users|idle'));

    // another interval: the old data stays while the new request is in flight
    rerender(<Probe topic="users" refreshMs={5000} load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('out').textContent).toBe('data of users|loading');
    release?.();
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('data of users|idle'));

    // another subject: nothing of the old one is shown
    rerender(<Probe topic="orders" refreshMs={5000} load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('out').textContent).toBe('no data|loading');
    release?.();
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('data of orders|idle'));
  });

  it('polls on the interval and reloads when the settings version changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const load = vi.fn(async () => 'ok');
    const Tree = ({ version }: { version: number }) =>
      withSettings(settings({ version }), <Probe topic="users" refreshMs={1000} load={load} />);
    const { rerender } = render(<Tree version={0} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2100);
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);

    const before = load.mock.calls.length;
    rerender(<Tree version={1} />);
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('components', () => {
  it('Async shows loading, errors with stale data, and the empty state', () => {
    const { rerender } = render(
      <Async loaded={{ data: undefined, error: undefined, loading: true, reload() {} }}>
        {() => 'x'}
      </Async>,
    );
    expect(screen.getByText('Loading…')).toBeTruthy();
    rerender(
      <Async loaded={{ data: undefined, error: new Error('boom'), loading: false, reload() {} }}>
        {() => 'x'}
      </Async>,
    );
    expect(screen.getByRole('alert').textContent).toBe('boom');
    rerender(
      <Async
        loaded={{ data: [], error: undefined, loading: false, reload() {} }}
        empty={(d) => d.length === 0}
      >
        {() => 'x'}
      </Async>,
    );
    expect(screen.getByText('Nothing here.')).toBeTruthy();
    rerender(
      <Async loaded={{ data: [1], error: new Error('later'), loading: false, reload() {} }}>
        {(d) => `rows ${d.length}`}
      </Async>,
    );
    expect(screen.getByRole('alert').textContent).toContain('showing the last data');
    expect(screen.getByText('rows 1')).toBeTruthy();
  });

  it('a drawer closes with Escape and with the button', () => {
    const onClose = vi.fn();
    render(
      <Drawer title="Event" onClose={onClose}>
        body
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Event' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a confirm dialog needs the typed name, runs the action and closes, or shows its error', async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Remove x"
        confirmLabel="Remove"
        typed="reporting"
        onConfirm={onConfirm}
        onClose={onClose}
      >
        <p>sure?</p>
      </ConfirmDialog>,
    );
    const button = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'report' } });
    expect(button.disabled).toBe(true);
    fireEvent.input(input, { target: { value: 'reporting' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a failing action keeps the dialog open and shows why', async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Delete"
        confirmLabel="Delete"
        onConfirm={async () => {
          throw new Error('forbidden');
        }}
        onClose={onClose}
      >
        <p>sure?</p>
      </ConfirmDialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('forbidden'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('views', () => {
  const topic = (name: string, extra: Record<string, unknown> = {}) => ({
    topicName: name,
    length: 10,
    deadLetters: 0,
    consumers: 1,
    lag: 0,
    pending: 0,
    retrying: 0,
    oldest: 1,
    newest: Date.now() - 5000,
    needsAttention: false,
    ...extra,
  });

  it('lists topics with the ones needing attention first, and filters them', async () => {
    stubApi({
      '/api/topics': {
        bus: 'default',
        topics: [
          topic('billing'),
          topic('orders', { needsAttention: true, deadLetters: 3 }),
          topic('users'),
        ],
      },
    });
    render(withSettings(settings(), <TopicsView />));
    await waitFor(() => expect(screen.getByRole('link', { name: 'orders' })).toBeTruthy());
    const rows = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('orders');
    expect(rows[0]).toContain('attention');
    expect(rows[1]).toContain('billing');

    fireEvent.input(screen.getByLabelText('Filter topics by name'), { target: { value: 'us' } });
    expect(screen.queryByRole('link', { name: 'billing' })).toBeNull();
    expect(screen.getByRole('link', { name: 'users' })).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Filter topics by name'), { target: { value: 'zzz' } });
    expect(screen.getByText('No topic matches.')).toBeTruthy();
  });

  const deadLetters = {
    entries: [
      {
        id: '1-0',
        eventName: 'user.deleted',
        consumerName: 'notifications',
        attempt: 3,
        error: 'mail down',
        originalId: '1-1',
        failedAt: Date.now(),
        preview: '{}',
        size: 2,
        payloadHidden: false,
      },
    ],
    next: null,
    total: 1,
  };

  it('dead letters are read-only by default: no checkboxes, no actions', async () => {
    stubApi({ '/dlq': deadLetters });
    render(withSettings(settings(), <DeadLettersTab topic="users" />));
    await waitFor(() => expect(screen.getByText('mail down')).toBeTruthy());
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('with writes enabled the dead letters can be selected and the actions follow the selection', async () => {
    stubApi({ '/dlq': deadLetters });
    render(
      withSettings(
        settings({ config: { readOnly: false, hidePayloads: false, buses: ['default'] } }),
        <DeadLettersTab topic="users" />,
      ),
    );
    await waitFor(() => expect(screen.getByText('mail down')).toBeTruthy());
    const retrySelected = screen.getByRole('button', {
      name: /Retry selected/,
    }) as HTMLButtonElement;
    expect(retrySelected.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Select dead letter 1-0'));
    expect(retrySelected.disabled).toBe(false);
    expect(retrySelected.textContent).toContain('(1)');
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }));
    expect(screen.getByRole('alertdialog', { name: /Delete 1 dead letter/ })).toBeTruthy();
  });

  it('keeps the selection state in a stateful parent (smoke for hooks inside views)', () => {
    function Counter() {
      const [n, setN] = useState(0);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {n}
        </button>
      );
    }
    render(<Counter />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('1');
  });
});

beforeEach(() => {
  window.location.hash = '';
});

describe('modal focus', () => {
  it('moves focus in, keeps Tab inside and gives focus back on close', async () => {
    const Page = () => {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <button type="button">outside</button>
          {open && (
            <Drawer title="Details" onClose={() => setOpen(false)}>
              <button type="button">inner</button>
            </Drawer>
          )}
        </div>
      );
    };
    render(<Page />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByLabelText('Close');
    await waitFor(() => expect(document.activeElement).toBe(close));

    const inner = screen.getByText('inner');
    inner.focus();
    fireEvent.keyDown(window, { key: 'Tab' }); // last element: wraps to the first
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true }); // first element: wraps to the last
    expect(document.activeElement).toBe(inner);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Close')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
