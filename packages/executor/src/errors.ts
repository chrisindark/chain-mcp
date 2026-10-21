/** Internal error kinds mapped to safe RuntimeError messages by the executor. */
export class DestinationPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DestinationPolicyError";
  }
}

export class RequestBuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequestBuildError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(options?: ErrorOptions) {
    super("Upstream response exceeded the size limit", options);
    this.name = "ResponseTooLargeError";
  }
}

export class UnsupportedResponseError extends Error {
  constructor(
    message = "Upstream response is not supported",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UnsupportedResponseError";
  }
}

export class InvalidResponseError extends Error {
  constructor(
    message = "Upstream response was invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InvalidResponseError";
  }
}

export class RedirectLimitError extends Error {
  constructor(options?: ErrorOptions) {
    super("Upstream redirect limit exceeded", options);
    this.name = "RedirectLimitError";
  }
}

export class UpstreamStatusError extends Error {
  constructor(
    public readonly status: number,
    options?: ErrorOptions,
  ) {
    super(`Upstream request failed with status ${status}`, options);
    this.name = "UpstreamStatusError";
  }
}
