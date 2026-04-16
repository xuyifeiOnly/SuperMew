import multer from '@koa/multer';
import Router from '@koa/router';
import { requireAdmin } from '../middleware/index.js';
import {
  deleteDocument,
  importDocumentsFromFolder,
  listDocuments,
  resetDocumentCollection,
  type UploadedDocumentFile,
  uploadDocument,
} from '../services/document-service.js';
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
  const body = (ctx.request as { body?: { allowed_roles?: unknown } }).body;
  ctx.body = await uploadDocument(file, body?.allowed_roles);
});

router.post('/documents/import-folder', async (ctx) => {
  await requireAdmin(ctx);
  const body = (ctx.request as { body?: { folderPath?: string; allowed_roles?: unknown } }).body;
  ctx.body = await importDocumentsFromFolder(String(body?.folderPath ?? ''), body?.allowed_roles);
});

router.delete('/documents/:filename', async (ctx) => {
  await requireAdmin(ctx);
  ctx.body = await deleteDocument(String(ctx.params.filename ?? ''));
});

router.delete('/documents', async (ctx) => {
  await requireAdmin(ctx);
  ctx.body = await resetDocumentCollection();
});

export default router;
