export type FailureContext = {effect?:'none'|'unknown'|'accepted';field?:string;actual?:unknown;expected?:unknown;recovery?:string;retryable?:boolean};
export class MemoryError extends Error {
  constructor(readonly code:string,message:string,readonly context:FailureContext={effect:'none'}){super(message);this.name='MemoryError';}
}
export function failure(code:string,message:string,context:FailureContext={}):never {throw new MemoryError(code,message,{effect:'none',...context});}
