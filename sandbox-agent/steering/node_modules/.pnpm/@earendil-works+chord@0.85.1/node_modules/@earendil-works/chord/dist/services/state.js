import { BACKGROUND_CONTEXT } from "../context/index.js";
import { applyImmutable, isBase, track } from "../delta/index.js";
import { registerReplicatedStateInternals } from "./state-internals.js";
export class MutableReplicatedStateImpl {
    #listeners = new Set();
    #sourceListeners = new Set();
    #tracker;
    #publishedValue;
    #sequence = 0;
    constructor(initial) {
        this.#tracker = track(initial);
        this.#publishedValue = applyImmutable(undefined, this.#tracker.flush());
        const thisSource = this;
        registerReplicatedStateInternals(this, {
            get sequence() {
                return thisSource.#sequence;
            },
            get value() {
                return thisSource.#publishedValue;
            },
            publish: (context) => thisSource.publish(context),
            subscribe: (listener) => {
                thisSource.#sourceListeners.add(listener);
                return () => thisSource.#sourceListeners.delete(listener);
            },
        });
    }
    get value() {
        return this.#publishedValue;
    }
    get state() {
        return this.#tracker.state;
    }
    publish(context) {
        const ops = this.#tracker.flush();
        if (ops.length === 0)
            return;
        this.#sequence += 1;
        this.#publishedValue = applyImmutable(this.#publishedValue, ops);
        for (const listener of [...this.#sourceListeners])
            listener(ops, this.#sequence, context);
        const delivery = { kind: "update", sequence: this.#sequence };
        for (const listener of [...this.#listeners])
            listener(this.#publishedValue, context, delivery);
    }
    subscribe(listener) {
        const context = serviceDeliveryContext();
        this.publish(context);
        this.#listeners.add(listener);
        listener(this.#publishedValue, context, { kind: "hydrate", sequence: this.#sequence });
        return () => this.#listeners.delete(listener);
    }
}
/** A cold read-only state used by service consumers until a complete snapshot arrives. */
export class ReplicatedStateReplica {
    #listeners = new Set();
    #reportError;
    #value;
    #sequence;
    constructor(reportError) {
        this.#reportError = reportError;
    }
    get value() {
        return this.#value;
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        if (this.#value !== undefined) {
            this.#deliver(listener, this.#value, serviceDeliveryContext(), {
                kind: "hydrate",
                sequence: this.#sequence,
            });
        }
        return () => this.#listeners.delete(listener);
    }
    hydrate(sequence, ops, context) {
        if (!isBase(ops))
            throw new Error("Replicated state snapshot is not a base operation batch");
        const value = applyImmutable(undefined, ops);
        this.#sequence = sequence;
        this.#value = value;
        this.#deliverAll(context, { kind: "hydrate", sequence });
    }
    update(sequence, ops, context) {
        if (this.#sequence === undefined || this.#value === undefined) {
            throw new Error("Replicated state received an update before hydration");
        }
        if (sequence !== this.#sequence + 1) {
            this.clear();
            throw new Error("Replicated state update sequence has a gap");
        }
        const value = applyImmutable(this.#value, ops);
        this.#sequence = sequence;
        this.#value = value;
        this.#deliverAll(context, { kind: "update", sequence });
    }
    clear() {
        this.#value = undefined;
        this.#sequence = undefined;
    }
    #deliverAll(context, delivery) {
        if (this.#value === undefined)
            return;
        for (const listener of this.#listeners)
            this.#deliver(listener, this.#value, context, delivery);
    }
    #deliver(listener, value, context, delivery) {
        try {
            listener(value, context, delivery);
        }
        catch (error) {
            this.#reportError(toError(error));
        }
    }
}
/** @internal Context for synthetic service deliveries without a caller. */
export function serviceDeliveryContext() {
    // TODO: Add delivery-scoped cancellation or metadata if deliveries gain an owned lifecycle.
    return BACKGROUND_CONTEXT;
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=state.js.map