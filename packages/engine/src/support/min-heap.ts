// core's lib/platform_common/sorting.h MinHeap, step for step: which of two equal elements comes out first follows from these exact swaps.
export class MinHeap<T> {
    private data: T[] = [];

    constructor(
        private readonly heapCapacity: number,
        private compare: (lhs: T, rhs: T) => boolean = (lhs, rhs) => lhs < rhs,
    ) {}

    init(compare?: (lhs: T, rhs: T) => boolean): void {
        this.data = [];
        if (compare) {
            this.compare = compare;
        }
    }

    insert(newElement: T): boolean {
        if (this.data.length >= this.heapCapacity) {
            return false;
        }

        this.data.push(newElement);
        this.upHeap(this.data.length - 1);
        return true;
    }

    drop(): boolean {
        if (this.data.length === 0) {
            return false;
        }

        const last = this.data.pop()!;
        if (this.data.length > 0) {
            this.data[0] = last;
            this.downHeap(0);
        }
        return true;
    }

    // swaps the minimum for a new element in one step; returns the old minimum.
    replace(newElement: T): T | undefined {
        if (this.data.length === 0) {
            return undefined;
        }

        const minElement = this.data[0];
        this.data[0] = newElement;
        this.downHeap(0);
        return minElement;
    }

    removeFirstMatch(elementToRemove: T): boolean {
        const index = this.data.indexOf(elementToRemove);
        if (index < 0) {
            return false;
        }

        const last = this.data.pop()!;
        if (index < this.data.length) {
            this.data[index] = last;
            this.downHeap(this.upHeap(index));
        }
        return true;
    }

    peek(): T | undefined {
        return this.data[0];
    }

    size(): number {
        return this.data.length;
    }

    // the elements in heap order, not sorted
    elements(): readonly T[] {
        return this.data;
    }

    capacity(): number {
        return this.heapCapacity;
    }

    private swap(first: number, second: number): void {
        const held = this.data[first];
        this.data[first] = this.data[second];
        this.data[second] = held;
    }

    private upHeap(index: number): number {
        while (index !== 0) {
            const parentIndex = (index - 1) >> 1;
            if (!this.compare(this.data[index], this.data[parentIndex])) {
                break;
            }

            this.swap(index, parentIndex);
            index = parentIndex;
        }
        return index;
    }

    private downHeap(index: number): void {
        for (;;) {
            const firstChild = index * 2 + 1;
            const secondChild = firstChild + 1;
            if (firstChild >= this.data.length) {
                return;
            }

            let minChild = firstChild;
            if (secondChild < this.data.length && this.compare(this.data[secondChild], this.data[firstChild])) {
                minChild = secondChild;
            }
            if (!this.compare(this.data[minChild], this.data[index])) {
                return;
            }

            this.swap(index, minChild);
            index = minChild;
        }
    }
}
