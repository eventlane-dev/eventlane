import type { InferEvents } from '@eventlane/core';
import { z } from 'zod';

// One schema per event: topicName -> eventName -> schema. Share this file between services.
export const schemas = {
  users: {
    'user.created': z.object({
      id: z.number().int(),
      // a transform: the stored (and handled) e-mail address is always lower case
      email: z.string().email().toLowerCase(),
    }),
    'user.deleted': z.object({ id: z.number().int() }),
  },
};

// The event map for the compiler, taken from the schemas (payload types are the schemas' output).
export type AppEvents = InferEvents<typeof schemas>;
