import { EventEmitter } from 'node:events';
import { initI18n } from '@kross/core';

// Tests assert default Chinese chrome unless a case switches locale.
initI18n('zh');

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
