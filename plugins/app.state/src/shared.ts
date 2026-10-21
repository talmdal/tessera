// Types shared by the app.state plugin's privileged and renderer code.

/** Payload of the 'app.state:get' request. */
export interface GetRequest<T = unknown> {
  key: string
  /** Returned (and stored) when the key has no value yet. Must be structured-cloneable. */
  defaultValue?: T
}
