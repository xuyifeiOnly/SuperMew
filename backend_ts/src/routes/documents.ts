import multer from '@koa/multer';
import Router from '@koa/router';
import { requireAdmin } from '../middleware/index.js';
import { deleteDocument, listDocuments, type UploadedDocumentFile, uploadDocument } from '../services/document-service.js';
import type { AppState } from '../types/koa.js';

const upload = multer({
  storage: multer.memoryStorage(),
});

const router = new Router<AppState>();

router.get('/documents', async (ctx) => {
  await requireAdmin(ctx);
  ctx.body = { documents: await listDocuments() };
});

router.post('/documents/upload', upload.single('file'), async (ctx) => {
  await requireAdmin(ctx);
  const file = (ctx.request as { file?: UploadedDocumentFile }).file;
  ctx.body = await uploadDocument(file);
});

router.delete('/documents/:filename', async (ctx) => {
  await requireAdmin(ctx);
  ctx.body = await deleteDocument(String(ctx.params.filename ?? ''));
});

export default router;
