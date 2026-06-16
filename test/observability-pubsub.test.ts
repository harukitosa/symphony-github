import { describe, expect, test } from "bun:test";
import { ObservabilityPubSub, broadcastObservabilityUpdate, subscribeObservability } from "../src/observability-pubsub";

describe("observability pubsub", () => {
  test("subscribe and broadcastUpdate deliver dashboard updates", () => {
    const pubsub = new ObservabilityPubSub();
    const events: string[] = [];

    const unsubscribe = pubsub.subscribe((event) => events.push(event));
    expect(pubsub.broadcastUpdate()).toBeUndefined();
    expect(events).toEqual(["observability_updated"]);

    unsubscribe();
    pubsub.broadcastUpdate();
    expect(events).toEqual(["observability_updated"]);
  });

  test("broadcastUpdate is a no-op when there are no subscribers", () => {
    const pubsub = new ObservabilityPubSub();
    expect(pubsub.broadcastUpdate()).toBeUndefined();
  });

  test("default pubsub helpers share a process-local bus", () => {
    const events: string[] = [];
    const unsubscribe = subscribeObservability((event) => events.push(event));

    broadcastObservabilityUpdate();
    expect(events).toEqual(["observability_updated"]);

    unsubscribe();
  });
});
