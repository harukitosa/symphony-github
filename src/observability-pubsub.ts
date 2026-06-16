export type ObservabilityEvent = "observability_updated";
export type ObservabilitySubscriber = (event: ObservabilityEvent) => void;

export class ObservabilityPubSub {
  readonly #subscribers = new Set<ObservabilitySubscriber>();

  subscribe(subscriber: ObservabilitySubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  broadcastUpdate(): void {
    for (const subscriber of this.#subscribers) {
      subscriber("observability_updated");
    }
  }
}

const defaultPubSub = new ObservabilityPubSub();

export function subscribeObservability(subscriber: ObservabilitySubscriber): () => void {
  return defaultPubSub.subscribe(subscriber);
}

export function broadcastObservabilityUpdate(): void {
  defaultPubSub.broadcastUpdate();
}
