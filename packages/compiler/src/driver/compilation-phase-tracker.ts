import type { CompileOptions } from "./types";

export class CompilationPhaseTracker {
    readonly timings: Record<string, number> = {};

    private currentPhase = "";
    private currentPhaseStartedAt = 0;

    constructor(private readonly onPhase: CompileOptions["onPhase"]) {}

    async enter(phaseName: string): Promise<void> {
        this.recordCurrentPhase(this.now());

        if (this.onPhase) {
            await this.onPhase(phaseName);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        this.currentPhase = phaseName;
        this.currentPhaseStartedAt = this.now();
    }

    close(): void {
        this.recordCurrentPhase(this.now());
        this.currentPhase = "";
    }

    private recordCurrentPhase(finishedAt: number): void {
        if (!this.currentPhase) {
            return;
        }

        this.timings[this.currentPhase] = finishedAt - this.currentPhaseStartedAt;
    }

    private now(): number {
        return typeof performance !== "undefined"
            ? performance.now()
            : Date.now();
    }
}
