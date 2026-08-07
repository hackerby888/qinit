export class QpiIncompleteReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QpiIncompleteReadError";
  }
}

export class QpiContainerConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QpiContainerConsistencyError";
  }
}
