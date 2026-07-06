import { EventEmitter } from 'node:events';

const streamLikePrototype = EventEmitter.prototype as EventEmitter & {
  ref?: () => EventEmitter;
  unref?: () => EventEmitter;
};

streamLikePrototype.ref ??= function ref() {
  return this;
};

streamLikePrototype.unref ??= function unref() {
  return this;
};
