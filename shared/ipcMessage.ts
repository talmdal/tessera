// shared/ipcMessage.ts

export class IPCMessage<T = unknown> {
  constructor(
    public readonly module: string,
    public readonly event: string,
    public readonly data: T,
    public readonly correlationId?: string
  ) {}

  get channel() {
    return `${this.module}:${this.event}`
  }
}

export type IpcHandler<TReq = unknown, TRes = unknown> =
  (msg: IPCMessage<TReq>) => Promise<TRes>
