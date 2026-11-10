---
layout: home

hero:
  name: EventLane
  text: A persistent event bus on Redis Streams
  tagline: Kafka-like topics and consumers with an EventEmitter-like API, for Node.js and NestJS. Use the Redis you already run for BullMQ.
  actions:
    - theme: brand
      text: Core (any Node.js app)
      link: /core/getting-started
    - theme: alt
      text: NestJS
      link: /nestjs/getting-started
    - theme: alt
      text: Dashboard
      link: /dashboard/overview

features:
  - title: Topics and consumers
    details: Emit to a topic; every consumer gets its own copy, and the instances of one consumer share the work.
    link: /core/concepts
    linkText: Concepts
  - title: Reliable by default
    details: At-least-once delivery with retry and backoff, a dead-letter stream, crash recovery, deduplication and idempotent emits.
    link: /core/reliability
    linkText: Reliability
  - title: Persistent and inspectable
    details: Events stay in Redis Streams. Read them, replay a consumer, trim by size or age, and look at lag and pending events.
    link: /core/operations
    linkText: Operations
  - title: NestJS integration
    details: A module, an injectable emitter and an @OnLaneEvent decorator. A module is a consumer.
    link: /nestjs/guide
    linkText: NestJS guide
  - title: Dashboard
    details: A Bull Board style web UI to browse events, watch consumers and inspect dead letters. Mounts into NestJS, Express or Fastify; read-only by default, with opt-in actions.
    link: /dashboard/getting-started
    linkText: Dashboard
  - title: Why not BullMQ or Kafka?
    details: BullMQ runs jobs, Kafka is heavy for a small system. EventLane fills the gap for domain events on Redis.
    link: /comparison
    linkText: Comparison
---

## How the documentation is organized

- **Core**: the framework-independent library and its concepts. Read this first, whatever framework you use.
- **NestJS**: the integration package, built on the core. Start with its getting started page.
- **Dashboard**: a web UI as separate packages that mounts into NestJS, Express or Fastify.
- **Project**: how EventLane compares to alternatives.
