/** Injection tokens and metadata keys. Strings, so duplicate installs of the package still agree. */
export const EVENT_LANE_OPTIONS = 'EVENT_LANE_OPTIONS';
export const EVENT_LANE_BUS = 'EVENT_LANE_BUS';
export const EVENT_LANE_FEATURE = 'EVENT_LANE_FEATURE';
export const ON_LANE_EVENT_METADATA = 'eventlane:on-lane-event';

export const getEventLaneEmitterToken = (topicName: string): string =>
  `EVENT_LANE_EMITTER:${topicName}`;
