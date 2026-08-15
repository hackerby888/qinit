import type { VirtualNode } from "../transport";

// Drives a VirtualNode on an interval. The first failure stops the interval so a faulted node is not
// retried every tick; a fault is expected, so only an unexpected error is reported.
export class NodeTicker {
    private handle: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly engine: VirtualNode,
        private readonly label: string,
    ) {}

    get running(): boolean {
        return this.handle !== null;
    }

    stop(): void {
        if (this.handle) {
            clearInterval(this.handle);
            this.handle = null;
        }
    }

    advance(count = 1): void {
        try {
            this.engine.advanceTick(count);
        } catch (error) {
            this.stop();

            if (!this.engine.sim.isFaulted()) {
                console.error(`${this.label} ticker stopped:`, error);
            }
        }
    }

    // Replaces any running interval, so callers can restart at a new cadence.
    start(tickMs: number): void {
        this.stop();
        this.handle = setInterval(() => this.advance(), tickMs);
    }
}
