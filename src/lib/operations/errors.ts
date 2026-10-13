export class OperationsError extends Error {
  constructor(public readonly code: "validation" | "conflict" | "not_found" | "forbidden" | "idempotency" | "immutable", message: string) {
    super(message);
    this.name = "OperationsError";
  }
}
