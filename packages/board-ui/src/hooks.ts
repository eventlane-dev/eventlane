import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { SettingsContext } from './context';

export interface Loaded<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data when `deps` change and then every `refreshMs` (0 = never). A refresh keeps showing
 * the previous data while the new request is in flight; a change of `deps` clears it.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], refreshMs: number): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({
    loading: true,
  });
  const [tick, setTick] = useState(0);
  // a write elsewhere on the page asks every list to load again
  const version = useContext(SettingsContext)?.version ?? 0;
  const loadRef = useRef(load);
  loadRef.current = load;
  const previous = useRef<unknown[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const data = await loadRef.current();
        if (!cancelled) setState({ data, loading: false });
      } catch (error) {
        if (!cancelled) setState((s) => ({ data: s.data, error: error as Error, loading: false }));
      } finally {
        if (!cancelled && refreshMs > 0) timer = setTimeout(run, refreshMs);
      }
    };
    // only a different subject (another topic, a new filter) clears what is shown; a changed
    // interval or a reload after a write keeps it until the new data arrives
    const before = previous.current;
    const same = before?.length === deps.length && before.every((d, i) => Object.is(d, deps[i]));
    previous.current = deps;
    setState((s) => (same ? { ...s, loading: true } : { loading: true }));
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [...deps, refreshMs, tick, version]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** A value kept in localStorage; works (without persistence) when storage is unavailable. */
export function useStored<T extends string | number>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(`eventlane-board:${key}`);
      if (stored === null) return initial;
      return (typeof initial === 'number' ? Number(stored) : stored) as T;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(`eventlane-board:${key}`, String(next));
    } catch {
      // storage can be blocked; the setting then lasts for this page only
    }
  };
  return [value, set];
}

/** The current location hash, updated on navigation. */
export function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}
