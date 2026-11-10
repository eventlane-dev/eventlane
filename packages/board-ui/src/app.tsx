import { useState } from 'preact/hooks';
import { api } from './api';
import { Badge } from './components';
import { type Settings, SettingsContext } from './context';
import { useHash, useLoad, useStored } from './hooks';
import { parseRoute } from './route';
import { TopicsView, TopicView } from './views';

const REFRESH_CHOICES: Array<[number, string]> = [
  [0, 'Paused'],
  [2000, '2 s'],
  [5000, '5 s'],
  [10_000, '10 s'],
  [30_000, '30 s'],
];

export function App() {
  const config = useLoad(() => api.config(), [], 0);
  const [bus, setBus] = useStored<string>('bus', '');
  const [refreshMs, setRefreshMs] = useStored<number>('refreshMs', 5000);
  const route = parseRoute(useHash());
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<{ text: string; tone: 'good' | 'bad' } | undefined>();

  if (!config.data) {
    return (
      <main>
        {config.error ? (
          <p class="error" role="alert">
            Cannot reach the board API: {config.error.message}
          </p>
        ) : (
          <p class="muted">Loading…</p>
        )}
      </main>
    );
  }
  const selected = config.data.buses.includes(bus) ? bus : (config.data.buses[0] ?? 'default');
  const settings: Settings = {
    config: config.data,
    bus: selected,
    refreshMs,
    version,
    bump: () => setVersion((v) => v + 1),
    notify: (text, tone = 'good') => setNotice({ text, tone }),
  };

  return (
    <SettingsContext.Provider value={settings}>
      <header class="top">
        <a class="brand" href="#/">
          EventLane <span>board</span>
        </a>
        <div class="controls">
          {config.data.buses.length > 1 && (
            <label>
              Bus
              <select value={selected} onChange={(e) => setBus(e.currentTarget.value)}>
                {config.data.buses.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Refresh
            <select value={refreshMs} onChange={(e) => setRefreshMs(Number(e.currentTarget.value))}>
              {REFRESH_CHOICES.map(([ms, label]) => (
                <option key={ms} value={ms}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {config.data.readOnly ? (
            <Badge tone="good">read-only</Badge>
          ) : (
            <Badge tone="warn">writes enabled</Badge>
          )}
          {config.data.hidePayloads && <Badge tone="warn">payloads hidden</Badge>}
        </div>
      </header>
      {notice && (
        <div
          class={`notice notice-${notice.tone}`}
          role={notice.tone === 'bad' ? 'alert' : 'status'}
        >
          <span>{notice.text}</span>
          <button type="button" class="link" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      <main>
        {route.view === 'topics' ? (
          <TopicsView />
        ) : (
          <TopicView key={route.topic} topic={route.topic} tab={route.tab} />
        )}
      </main>
    </SettingsContext.Provider>
  );
}
