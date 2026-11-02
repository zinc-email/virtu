import { mkdtemp, open, rm, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Temporary, unaccepted DATA. The unlinked file disappears even on process crash. */
export class DataSpool {
  private closed = false;
  private constructor(private readonly file: FileHandle) {}

  static async create(): Promise<DataSpool> {
    const dir = await mkdtemp(join(process.env.SMTP_SPOOL_DIRECTORY ?? tmpdir(), "virtu-data-"));
    let file: FileHandle | undefined;
    try {
      const path = join(dir, "message");
      file = await open(path, "wx+", 0o600);
      // Linux/macOS keep the open file accessible through its descriptor.
      // No pathname containing private mail survives a crash.
      await unlink(path);
      await rm(dir, { recursive: true, force: true });
      return new DataSpool(file);
    } catch (error) {
      await file?.close().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.file.writeFile(chunk);
  }

  /** Called only while holding the process-wide materialization slot. */
  async read(): Promise<Buffer> {
    const { size } = await this.file.stat();
    const raw = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await this.file.read(raw, offset, size - offset, offset);
      if (bytesRead === 0) throw new Error("Unexpected end of DATA spool");
      offset += bytesRead;
    }
    return raw;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.file.close();
  }
}

// Verification/signing currently require whole-message buffers. Only one
// inbound transaction may materialize them; waiting messages stay on disk.
let processing: Promise<void> = Promise.resolve();
export async function withDataProcessing<T>(work: () => Promise<T>): Promise<T> {
  const previous = processing;
  let release!: () => void;
  processing = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
