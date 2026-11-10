import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Loaded } from './hooks';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: string;
  children: ComponentChildren;
}) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}

export function Count({ value, warn }: { value: number; warn?: boolean }) {
  return (
    <span class={warn && value > 0 ? 'count warn' : 'count'}>{value.toLocaleString('en-US')}</span>
  );
}

/** Shows the loading, error or empty state of a request, otherwise its content. */
export function Async<T>({
  loaded,
  empty,
  children,
}: {
  loaded: Loaded<T>;
  empty?: (data: T) => boolean;
  children: (data: T) => ComponentChildren;
}) {
  const { data, error, loading } = loaded;
  if (data === undefined) {
    if (error)
      return (
        <p class="error" role="alert">
          {error.message}
        </p>
      );
    return <p class="muted">{loading ? 'Loading…' : ''}</p>;
  }
  return (
    <>
      {error && (
        <p class="error" role="alert">
          {error.message} (showing the last data)
        </p>
      )}
      {empty?.(data) ? <p class="muted">Nothing here.</p> : children(data)}
    </>
  );
}

export function Mono({ children }: { children: ComponentChildren }) {
  return <span class="mono">{children}</span>;
}

/** A 16 px line icon that takes the color of the text around it. */
function Icon({ children }: { children: ComponentChildren }) {
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

/** A copy-to-clipboard button: an icon that turns into a check mark for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class={done ? 'icon-button done' : 'icon-button'}
      aria-label={label}
      title={done ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          // the clipboard needs a secure context; nothing to do otherwise
        }
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return (
    <div class="json">
      <div class="json-bar">
        <CopyButton text={text} />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openModals: object[] = [];

/**
 * Behaviour of a modal dialog: focus moves into it, Tab stays inside, Escape closes the top-most
 * one, and focus returns to the element that opened it.
 */
export function useModal(container: { current: HTMLElement | null }, onClose: () => void): void {
  // callers pass a new function on every render; the effect must not restart (and move focus) then
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const token = {};
    openModals.push(token);
    const opener = document.activeElement as HTMLElement | null;
    const root = container.current;
    if (root && !root.contains(document.activeElement)) {
      (root.querySelector<HTMLElement>(FOCUSABLE) ?? root).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== token) return;
      if (e.key === 'Escape') return close.current();
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return e.preventDefault();
      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openModals.splice(openModals.indexOf(token), 1);
      if (opener?.isConnected) opener.focus();
    };
  }, [container]);
}

/** A panel that slides in from the right; closes with the button or Escape. */
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);
  return (
    <div class="drawer-layer">
      <button
        type="button"
        class="drawer-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div class="drawer" ref={panel} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button
            type="button"
            class="icon-button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
