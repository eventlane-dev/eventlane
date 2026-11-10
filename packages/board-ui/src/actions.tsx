import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { actions } from './api';
import { useModal } from './components';
import { useSettings } from './context';
import { formatNumber } from './format';

/** Runs a write; on success shows its message and reloads the lists, on failure rethrows. */
export function useAction() {
  const { notify, bump } = useSettings();
  return async (task: () => Promise<string>): Promise<void> => {
    try {
      notify(await task(), 'good');
      bump();
    } catch (error) {
      notify((error as Error).message, 'bad');
      throw error;
    }
  };
}

/** A modal that asks before a write; a dangerous one can ask to type a name first. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  typed,
  disabled,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  /** The text the user must type to enable the button. */
  typed?: string;
  disabled?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const typedInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, onClose);
  useEffect(() => typedInput.current?.focus(), []);
  const ready = (typed === undefined || value === typed) && !disabled;

  return (
    <div class="drawer-layer centered">
      <button
        type="button"
        class="drawer-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div class="dialog" ref={dialog} role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {typed !== undefined && (
          <label class="field">
            <span>
              Type <strong>{typed}</strong> to confirm
            </span>
            <input
              ref={typedInput}
              type="text"
              autoComplete="off"
              value={value}
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          </label>
        )}
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <div class="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            class={danger ? 'danger' : 'primary'}
            disabled={!ready || busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

type Where = 'beginning' | 'end' | 'time' | 'id';

/** Moves a consumer's read position, after showing how many events that makes it read again. */
export function ReplayDialog({
  topic,
  consumer,
  onClose,
}: {
  topic: string;
  consumer: string;
  onClose: () => void;
}) {
  const { bus } = useSettings();
  const run = useAction();
  const [where, setWhere] = useState<Where>('beginning');
  const [time, setTime] = useState('');
  const [eventId, setEventId] = useState('');
  const [preview, setPreview] = useState<{ affected: number; capped: boolean } | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  const position = (): string | number | undefined => {
    if (where === 'beginning') return '0';
    if (where === 'end') return '$';
    if (where === 'time') {
      const ms = new Date(time).getTime();
      return Number.isNaN(ms) ? undefined : ms;
    }
    return /^\d+-\d+$/.test(eventId.trim()) ? eventId.trim() : undefined;
  };
  const from = position();
  // a different position makes the preview stale
  useEffect(() => setPreview(undefined), [where, time, eventId]);

  const showPreview = async () => {
    if (from === undefined) return;
    setProblem(undefined);
    try {
      const result = await actions.replay(bus, topic, consumer, from, true);
      setPreview(result);
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <ConfirmDialog
      title={`Replay ${consumer}`}
      confirmLabel="Replay"
      danger
      disabled={from === undefined}
      onClose={onClose}
      onConfirm={() =>
        run(async () => {
          if (from === undefined) throw new Error('Choose where to continue');
          const result = await actions.replay(bus, topic, consumer, from, false);
          return `${consumer} will read ${formatNumber(result.affected)}${result.capped ? '+' : ''} event(s) again`;
        })
      }
    >
      <p class="muted">
        Moves the read position of <strong>{consumer}</strong>. Its running instances follow at
        once. Handlers see old events again, so make sure they can take that.
      </p>
      <fieldset>
        <legend>Continue from</legend>
        {(
          [
            ['beginning', 'The beginning of the topic'],
            ['end', 'The end (skip everything stored so far)'],
            ['time', 'A point in time'],
            ['id', 'An event id'],
          ] as Array<[Where, string]>
        ).map(([id, label]) => (
          <label key={id} class="choice">
            <input type="radio" name="where" checked={where === id} onChange={() => setWhere(id)} />
            {label}
          </label>
        ))}
        {where === 'time' && (
          <input
            type="datetime-local"
            aria-label="Point in time"
            value={time}
            onInput={(e) => setTime(e.currentTarget.value)}
          />
        )}
        {where === 'id' && (
          <input
            type="text"
            placeholder="1762725960000-0"
            aria-label="Event id"
            value={eventId}
            onInput={(e) => setEventId(e.currentTarget.value)}
          />
        )}
      </fieldset>
      <p>
        <button type="button" onClick={showPreview} disabled={from === undefined}>
          Preview
        </button>{' '}
        {preview && (
          <span>
            {preview.affected === 0
              ? 'Nothing will be read again.'
              : `${formatNumber(preview.affected)}${preview.capped ? '+' : ''} event(s) will be read again.`}
          </span>
        )}
        {problem && <span class="error">{problem}</span>}
      </p>
    </ConfirmDialog>
  );
}

/** Stores a test event in a topic, after showing what that does. */
export function EmitDialog({ topic, onClose }: { topic: string; onClose: () => void }) {
  const { bus } = useSettings();
  const run = useAction();
  const [eventName, setEventName] = useState('');
  const [payload, setPayload] = useState('{\n  \n}');
  let parsed: { value: unknown } | { error: string };
  try {
    parsed = { value: JSON.parse(payload) };
  } catch (error) {
    parsed = { error: (error as Error).message };
  }

  return (
    <ConfirmDialog
      title={`Send a test event to ${topic}`}
      confirmLabel="Send"
      disabled={eventName.trim() === '' || 'error' in parsed}
      onClose={onClose}
      onConfirm={() =>
        run(async () => {
          if ('error' in parsed) throw new Error('The payload is not valid JSON');
          const result = await actions.emitEvent(bus, topic, {
            eventName: eventName.trim(),
            payload: parsed.value,
          });
          return `Event ${result.id} stored in ${topic}`;
        })
      }
    >
      <p class="muted">
        The event is stored for real: every consumer of <strong>{topic}</strong> receives it and
        runs its handlers.
      </p>
      <label class="field">
        <span>Event name</span>
        <input
          type="text"
          placeholder="user.created"
          value={eventName}
          onInput={(e) => setEventName(e.currentTarget.value)}
        />
      </label>
      <label class="field">
        <span>Payload (JSON)</span>
        <textarea
          rows={6}
          spellcheck={false}
          value={payload}
          onInput={(e) => setPayload(e.currentTarget.value)}
        />
      </label>
      {'error' in parsed && <p class="error">{parsed.error}</p>}
    </ConfirmDialog>
  );
}
