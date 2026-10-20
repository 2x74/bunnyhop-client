// Optional desktop transport. No DOM or Node dependency: server/worker simulations stay WASM.
export interface NativeSession {
  exports: string[];
  call(name: string, args: number[]): number;
  read(pointer: number, length: number): Uint8Array;
  write(pointer: number, bytes: Uint8Array): void;
  dispose(): void;
}
export interface NativeRuntime {
  build: string;
  compatibleWasm: string;
  platform: string;
  createSession(): NativeSession;
}
export function nativeRuntime(): NativeRuntime | undefined {
  return (globalThis as typeof globalThis & { bunnyhopNative?: NativeRuntime }).bunnyhopNative;
}

interface MemoryTransport {
  memory: { buffer: ArrayBufferLike };
  nativeRead?: NativeSession["read"];
  nativeWrite?: NativeSession["write"];
}
export function coreBytes(x: MemoryTransport, ptr: number, length: number): Uint8Array {
  return x.nativeRead ? new Uint8Array(x.nativeRead(ptr, length)) : new Uint8Array(x.memory.buffer, ptr, length);
}
export function coreWrite(x: MemoryTransport, ptr: number, bytes: Uint8Array): void {
  if (x.nativeWrite) x.nativeWrite(ptr, bytes);
  else new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
}
export function coreF32(x: MemoryTransport, ptr: number, length: number): Float32Array {
  if (!x.nativeRead) return new Float32Array(x.memory.buffer, ptr, length);
  const bytes = coreBytes(x, ptr, length * 4);
  return new Float32Array(bytes.buffer, bytes.byteOffset, length);
}
export function coreU32(x: MemoryTransport, ptr: number, length: number): Uint32Array {
  if (!x.nativeRead) return new Uint32Array(x.memory.buffer, ptr, length);
  const bytes = coreBytes(x, ptr, length * 4);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, length);
}
