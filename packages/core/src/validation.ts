import { assertName, EventLaneError, ValidationError } from './errors';
import type { OnInvalid, StandardSchemaV1, ValidationIssue, ValidationMode } from './types';

const MODES: ValidationMode[] = ['both', 'emit', 'receive', false];
const ON_INVALID: OnInvalid[] = ['dead-letter', 'drop'];

type Outcome = { ok: true; value: unknown } | { ok: false; issues: readonly ValidationIssue[] };

/** Looks up the schema of an event and runs it. Holds the `schemas`, `validate` and `onInvalid` options. */
export class Validator {
  readonly onInvalid: OnInvalid;
  private readonly schemas = new Map<string, Map<string, StandardSchemaV1>>();
  private readonly mode: ValidationMode;

  constructor(
    schemas: object | undefined,
    mode: ValidationMode | undefined,
    onInvalid: OnInvalid | undefined,
  ) {
    this.mode = mode ?? 'both';
    if (!MODES.includes(this.mode)) {
      throw new EventLaneError('validate must be "both", "emit", "receive" or false');
    }
    this.onInvalid = onInvalid ?? 'dead-letter';
    if (!ON_INVALID.includes(this.onInvalid)) {
      throw new EventLaneError('onInvalid must be "dead-letter" or "drop"');
    }
    for (const [topicName, events] of Object.entries(schemas ?? {})) {
      assertName('topicName', topicName);
      const byEvent = new Map<string, StandardSchemaV1>();
      for (const [eventName, schema] of Object.entries(
        (events ?? {}) as Record<string, StandardSchemaV1 | undefined>,
      )) {
        if (schema === undefined) continue;
        if (typeof schema?.['~standard']?.validate !== 'function') {
          throw new EventLaneError(
            `schemas.${topicName}.${eventName} is not a Standard Schema (zod, valibot, ArkType, ...)`,
          );
        }
        byEvent.set(eventName, schema);
      }
      this.schemas.set(topicName, byEvent);
    }
  }

  /** True when `emit` of this event is checked. */
  checksEmit(topicName: string, eventName: string): boolean {
    return (this.mode === 'both' || this.mode === 'emit') && this.has(topicName, eventName);
  }

  /** True when a received event is checked. */
  checksReceive(topicName: string, eventName: string): boolean {
    return (this.mode === 'both' || this.mode === 'receive') && this.has(topicName, eventName);
  }

  private has(topicName: string, eventName: string): boolean {
    return this.schemas.get(topicName)?.has(eventName) === true;
  }

  /** Validates a payload and returns the schema's output. Throws `ValidationError` when it is invalid. */
  async parse(topicName: string, eventName: string, payload: unknown): Promise<unknown> {
    const outcome = await this.run(topicName, eventName, payload);
    if (!outcome.ok) throw new ValidationError(topicName, eventName, outcome.issues);
    return outcome.value;
  }

  /** Like `parse` for received events: `null` (how a missing payload is stored) also matches `undefined`. */
  async check(topicName: string, eventName: string, payload: unknown): Promise<Outcome> {
    const outcome = await this.run(topicName, eventName, payload);
    if (outcome.ok || payload !== null) return outcome;
    const retry = await this.run(topicName, eventName, undefined);
    return retry.ok ? retry : outcome;
  }

  private async run(topicName: string, eventName: string, payload: unknown): Promise<Outcome> {
    const schema = this.schemas.get(topicName)?.get(eventName) as StandardSchemaV1;
    try {
      const result = await schema['~standard'].validate(payload);
      if (result.issues === undefined) return { ok: true, value: result.value };
      return { ok: false, issues: result.issues };
    } catch (error) {
      return { ok: false, issues: [{ message: (error as Error)?.message ?? String(error) }] };
    }
  }
}
