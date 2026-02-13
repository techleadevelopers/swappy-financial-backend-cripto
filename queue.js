import { EventEmitter } from 'events';

const bus = new EventEmitter();
bus.setMaxListeners(50);

export function publish(event, payload) {
  bus.emit(event, payload);
}

export function subscribe(event, handler) {
  bus.on(event, handler);
  return () => bus.off(event, handler);
}
