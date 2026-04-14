import { createApp } from './app.js';
import { env } from './config.js';
import { MilvusManager } from './core/milvus-manager.js';
import { initDb } from './models.js';

const bootstrap = async (): Promise<void> => {
  const milvusManager = new MilvusManager();
  await initDb();
  await milvusManager.ensureCollection();
  const app = createApp();
  app.listen(env.port, env.host, () => {
    console.log(`Cute Cat Bot API listening on http://${env.host}:${env.port}`);
  });
};

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
