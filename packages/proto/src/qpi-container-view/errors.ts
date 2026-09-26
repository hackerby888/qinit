// the source could not supply the bytes, e.g. "HashMap needs 88 bytes, source has 64"
export class QpiIncompleteReadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QpiIncompleteReadError";
    }
}

// the bytes arrived but disagree with each other, e.g. "HashMap has 3 occupied slots but population 2"
export class QpiContainerConsistencyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QpiContainerConsistencyError";
    }
}
