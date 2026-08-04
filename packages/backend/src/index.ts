import { buildServer } from './app.ts';
import { config } from './config.ts';
import { closePool } from './pool.ts';

/** Process entry point: build the server, listen, and shut down cleanly. */
async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ host: config.host, port: config.port });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        await closePool();
        process.exit(0);
      })();
    });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
