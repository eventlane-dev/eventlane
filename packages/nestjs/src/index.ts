export type { EmitOptions, EventMetadata, Handler } from '@eventlane/core';
// handy re-exports so applications import everything from one place
export { EventLaneBus, EventLaneError, TopicEmitter } from '@eventlane/core';
export { EVENT_LANE_BUS, getEventLaneEmitterToken } from './constants';
export { InjectEventLaneBus, InjectLaneEmitter, OnLaneEvent } from './decorators';
export { EventLaneModule } from './event-lane.module';
export { EventLaneEmitter } from './event-lane-emitter';
export type {
  EventLaneFeatureOptions,
  EventLaneModuleAsyncOptions,
  EventLaneModuleOptions,
  OnLaneEventOptions,
} from './types';
